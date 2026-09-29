import { Prisma } from "@prisma/client";
import { prisma, withPlatform } from "../../lib/db";
import { env } from "../../lib/env";
import { cloudBase, readRemoteAccess } from "../relay/remoteAccess";
import { saveCloudKnowledge, type CloudKnowledge } from "./plate.learn";
import type { PlateDictionary } from "./plate.parse";

/**
 * Основа и облако обмениваются знанием о марках.
 *
 * Основа отправляет пары «модель → марка» из своих заказов и модели, у
 * которых марку определить не удалось. В ответ получает словарь платформы и
 * общий итог: какие марки у каких моделей признали мастерские. Всё это
 * Основа хранит у себя и распознаёт по нему и без интернета.
 *
 * Только с доступом из интернета: ключ тот же, что у туннеля. Без него Основа
 * учится на своих заказах и встроенных правилах.
 *
 * Раз в шесть часов: марки моделей не меняются, а правка словаря подождёт.
 */

const EVERY_MS = 6 * 60 * 60_000;
const MAX_MODELS = 5000;
const MAX_MISSES = 500;

export type PlateReport = {
  models: Array<{ model: string; brand: string; uses: number }>;
  misses: Array<{ model: string; uses: number }>;
};

export async function collectReport(): Promise<PlateReport> {
  const models = await withPlatform((tx) =>
    tx.$queryRaw<Array<{ model: string; brand: string; uses: number }>>(Prisma.sql`
      SELECT trim(model) AS model, trim(brand) AS brand, count(*)::int AS uses
      FROM "Device"
      WHERE model IS NOT NULL AND brand IS NOT NULL AND length(trim(model)) >= 3 AND length(trim(brand)) >= 2
        AND length(model) <= 60 AND length(brand) <= 40
      GROUP BY 1, 2
      ORDER BY uses DESC
      LIMIT ${MAX_MODELS}
    `)
  );
  const misses = await prisma.plateMiss.findMany({
    where: { source: "local" },
    orderBy: { lastAt: "desc" },
    take: MAX_MISSES,
    select: { model: true, uses: true },
  });
  return { models, misses };
}

/** Один обмен. Ответ — что получилось, для журнала и проверок. */
export async function syncPlateKnowledge(): Promise<{ ok: boolean; learned?: number; error?: string }> {
  const saved = await readRemoteAccess().catch(() => null);
  if (!saved?.key || saved.enabled === false) return { ok: false, error: "доступ из интернета не подключён" };
  const base = cloudBase(saved.url);
  if (!base) return { ok: false, error: "непонятный адрес облака" };

  try {
    const res = await fetch(`${base}/api/box/plate-knowledge`, {
      method: "PUT",
      headers: { "x-box-key": saved.key, "content-type": "application/json" },
      body: JSON.stringify(await collectReport()),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return { ok: false, error: `облако ответило ${res.status}` };
    const data = (await res.json()) as { dictionary?: PlateDictionary; learned?: Array<[string, string]> };
    const value: CloudKnowledge = {
      dictionary: data.dictionary ?? null,
      learned: Array.isArray(data.learned) ? data.learned : [],
      at: new Date().toISOString(),
    };
    await saveCloudKnowledge(value);
    return { ok: true, learned: value.learned.length };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Только у Основы. Первый обмен — через пару минут после запуска. */
export function startPlateSync(): void {
  if (env.relayEnabled || env.storageDriver !== "local") return;
  const run = () =>
    void syncPlateKnowledge().then((r) => {
      if (r.ok) console.log(`[шильдики] знание о марках обновлено из облака: моделей ${r.learned}`);
      else if (r.error !== "доступ из интернета не подключён") console.warn(`[шильдики] обмен с облаком: ${r.error}`);
    });
  setTimeout(run, 2 * 60_000).unref();
  setInterval(run, EVERY_MS).unref();
}
