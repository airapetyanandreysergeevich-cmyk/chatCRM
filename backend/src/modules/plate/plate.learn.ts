import { Prisma } from "@prisma/client";
import { prisma, withPlatform, withTenant } from "../../lib/db";
import { env } from "../../lib/env";
import { modelKeys, type PlateDictionary } from "./plate.parse";
import { decide, type Knowledge, type Pair } from "./plate.vote";

/**
 * Марка по модели — из того, что мастерские уже вписывали в заказы.
 *
 * Правила словаря знают серии, а не каждую модель. Зато каждая принятая
 * техника — готовая пара «модель → марка»: приёмщик вписал её руками, когда
 * шильдик марку не показал. В следующий раз эта модель узнаётся сама.
 *
 * Два круга, и доверие к ним разное:
 *
 *  1. Своя мастерская. Хватает одного заказа: это её же данные, и если в них
 *     ошибка, она ошибётся так же, как ошиблась в прошлый раз, — и поправит.
 *
 *  2. Все мастерские платформы. Здесь одной мастерской мало: опечатка одной
 *     разошлась бы по всем. Марка принимается, когда её вписали хотя бы две
 *     мастерские и против неё почти никто: за неё втрое больше мастерских,
 *     чем за любую другую. Каждая мастерская голосует один раз — той маркой,
 *     которую сама вписывала чаще, — сколько бы таких аппаратов у неё ни было.
 *
 * В общий круг идут только пары «модель → марка», без клиентов и заказов.
 * Коробочные Основы присылают свои пары в облако и получают обратно общий
 * итог (plate.sync.ts); без доступа из интернета Основа учится только на себе.
 *
 * Само голосование — в plate.vote.ts, без базы, чтобы его проверяли тесты.
 */

/** Как часто пересчитывать общий итог: пары копятся медленно. */
const TTL_MS = 30 * 60_000;

/** Где лежит итог, полученный Основой из облака. */
export const CLOUD_KEY = "plateCloud";

const tidyBrand = (s: string) => s.replace(/\s+/g, " ").trim();
const brandKey = (s: string) => tidyBrand(s).toUpperCase();

/**
 * Пары всех мастерских этого сервера и присланные Основами.
 *
 * Режим платформы здесь ради одного запроса, который читает только модель и
 * марку техники, сгруппированные, — ни клиента, ни заказа он не видит.
 */
async function collectPairs(): Promise<Pair[]> {
  const own = await withPlatform((tx) =>
    tx.$queryRaw<Array<{ source: string; model: string; brand: string; uses: number }>>(Prisma.sql`
      SELECT "tenantId" AS source, model, brand, count(*)::int AS uses
      FROM "Device"
      WHERE model IS NOT NULL AND brand IS NOT NULL AND length(trim(model)) >= 3 AND length(trim(brand)) >= 2
      GROUP BY 1, 2, 3
    `)
  );
  const boxes = await prisma.plateBoxModel.findMany({ select: { boxId: true, model: true, brand: true, uses: true } });
  return [...own, ...boxes.map((b) => ({ source: `box:${b.boxId}`, model: b.model, brand: b.brand, uses: b.uses }))];
}

let cache: { value: Knowledge; at: number } | null = null;
let building: Promise<Knowledge> | null = null;

/** Общий итог, пересчитанный не чаще раза в полчаса. */
export async function platformKnowledge(): Promise<Knowledge> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  building ??= (async () => {
    try {
      const value = decide(await collectPairs());
      cache = { value, at: Date.now() };
      return value;
    } finally {
      building = null;
    }
  })();
  return building;
}

/** После отправки Основы — пересчитать при следующем запросе. */
export function forgetKnowledge() {
  cache = null;
}

// ------------------------------------------------------------ Основа: итог облака

export type CloudKnowledge = {
  dictionary: PlateDictionary | null;
  /** [ключ модели, марка] */
  learned: Array<[string, string]>;
  at: string;
};

let cloudCache: { value: { dictionary: PlateDictionary | null; learned: Map<string, string> }; at: number } | null = null;

/** Что Основа последний раз получила из облака. В облаке — ничего. */
export async function cloudKnowledge(): Promise<{ dictionary: PlateDictionary | null; learned: Map<string, string> }> {
  const none = { dictionary: null, learned: new Map<string, string>() };
  if (env.relayEnabled) return none;
  if (cloudCache && Date.now() - cloudCache.at < 60_000) return cloudCache.value;
  const row = await prisma.platformSetting.findUnique({ where: { key: CLOUD_KEY } }).catch(() => null);
  const raw = (row?.value ?? null) as Partial<CloudKnowledge> | null;
  const value = {
    dictionary: raw?.dictionary ?? null,
    learned: new Map(Array.isArray(raw?.learned) ? raw!.learned.filter((x) => Array.isArray(x) && x.length === 2) : []),
  };
  cloudCache = { value, at: Date.now() };
  return value;
}

export async function saveCloudKnowledge(value: CloudKnowledge): Promise<void> {
  const json = value as unknown as Prisma.InputJsonObject;
  await prisma.platformSetting.upsert({
    where: { key: CLOUD_KEY },
    create: { key: CLOUD_KEY, value: json },
    update: { value: json },
  });
  cloudCache = null;
}

// ------------------------------------------------------------ поиск марки

/**
 * Марка для моделей-кандидатов: своя мастерская, потом общий итог сервера,
 * потом итог облака (у Основы). Первый найденный ответ.
 */
export async function brandFromHistory(
  tenantId: string,
  models: string[]
): Promise<{ brand: string; options: string[] } | null> {
  const keysPerModel = models.map((m) => modelKeys(m)).filter((k) => k.length);
  if (!keysPerModel.length) return null;
  const allKeys = [...new Set(keysPerModel.flat())];

  // 1. Своя мастерская: ключ записи начинается с ключа кандидата — так
  // «X515EA» находит и «X515EA-BQ1234». Точное совпадение ключей сверяем уже здесь.
  const prefixes = allKeys.map((k) => `${k}%`);
  const rows = await withTenant(tenantId, (tx) =>
    tx.$queryRaw<Array<{ model: string; brand: string; uses: number }>>(Prisma.sql`
      SELECT model, brand, count(*)::int AS uses
      FROM "Device"
      WHERE "tenantId" = ${tenantId}
        AND brand IS NOT NULL AND length(trim(brand)) >= 2
        AND model IS NOT NULL
        AND regexp_replace(upper(model), '[^A-Z0-9]', '', 'g') LIKE ANY(${prefixes})
      GROUP BY 1, 2
    `)
  );
  for (const keys of keysPerModel) {
    const score = new Map<string, { brand: string; uses: number }>();
    for (const r of rows) {
      const theirs = modelKeys(r.model);
      if (!theirs.some((k) => keys.includes(k))) continue;
      const bk = brandKey(r.brand);
      const cur = score.get(bk);
      if (cur) cur.uses += r.uses;
      else score.set(bk, { brand: tidyBrand(r.brand), uses: r.uses });
    }
    const ranked = [...score.values()].sort((a, b) => b.uses - a.uses);
    if (ranked.length) return { brand: ranked[0].brand, options: ranked.map((x) => x.brand) };
  }

  // 2. Все мастерские этого сервера, 3. итог облака у Основы.
  const [known, cloud] = await Promise.all([platformKnowledge(), cloudKnowledge()]);
  for (const keys of keysPerModel) {
    for (const k of keys) {
      const b = known.decided.get(k) ?? cloud.learned.get(k);
      if (b) return { brand: b, options: [b] };
    }
  }
  return null;
}

// ------------------------------------------------------------ промахи

/** Откуда промахи этого сервера: в облаке — «cloud», у Основы — «local». */
export const localMissSource = () => (env.relayEnabled || env.storageDriver !== "local" ? "cloud" : "local");

/**
 * Запомнить модель, у которой марка не нашлась. Ошибку не пускаем наружу:
 * это заметка для словаря, а не часть распознавания.
 */
export async function recordMiss(model: string, source = localMissSource()): Promise<void> {
  const keys = modelKeys(model);
  if (!keys.length) return;
  const modelKey = keys[keys.length - 1];
  const shown = model.replace(/\s+/g, " ").trim().slice(0, 60);
  try {
    await prisma.plateMiss.upsert({
      where: { source_modelKey: { source, modelKey } },
      create: { source, modelKey, model: shown },
      update: { uses: { increment: 1 }, lastAt: new Date(), model: shown },
    });
  } catch {
    /* список промахов — подсказка собственнику, не больше */
  }
}
