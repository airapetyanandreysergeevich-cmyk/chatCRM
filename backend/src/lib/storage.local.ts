import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "./env";
import { link, validKey } from "./storage.sign";

/**
 * Хранилище файлов на диске — для локальной версии, где нет ни S3, ни MinIO.
 *
 * Свойство, ради которого в облаке стоит приватный бакет с подписанными
 * ссылками, здесь сохраняем: каталог наружу не раздаётся, а ссылка на снимок
 * действует недолго и подписана. Разница только в том, что подпись проверяем
 * сами, а файл отдаёт наш же бэкенд.
 *
 * Почему не отдать папку статикой: тогда снимок чужой техники доставался бы
 * по угаданному адресу, а в мастерской по одной сети сидят и приёмщик, и
 * клиент с гостевым вайфаем.
 */

/** Корень хранилища. Абсолютный путь из настроек — рядом с базой мастерской. */
const root = () => path.resolve(env.storageDir);

/**
 * Превращает ключ в путь на диске.
 *
 * Возвращает null на всём, что выглядит как попытка выйти из папки: точки,
 * обратные косые, абсолютные пути. Проверяем дважды — сначала по виду ключа,
 * потом по итоговому пути, потому что придумать обход одной проверки всегда
 * проще, чем двух.
 */
export function resolveKey(key: string): string | null {
  if (!validKey(key)) return null;

  const full = path.resolve(root(), key);
  const base = root() + path.sep;
  return full.startsWith(base) ? full : null;
}

export async function ensure(): Promise<void> {
  await mkdir(root(), { recursive: true });
}

export async function put(params: {
  tenantId: string;
  orderId: string;
  buffer: Buffer;
  ext: string;
}): Promise<string> {
  const key = `${params.tenantId}/${params.orderId}/${randomUUID()}.${params.ext}`;
  const full = resolveKey(key);
  if (!full) throw new Error("Недопустимый путь файла");

  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, params.buffer);
  return key;
}

export async function remove(key: string): Promise<void> {
  const full = resolveKey(key);
  if (!full) return;
  await rm(full, { force: true });
}

// ------------------------------------------------------------------- чтение

/** Открыть файл для отдачи. null — нет такого. */
export async function open(key: string): Promise<{ body: NodeJS.ReadableStream; size: number } | null> {
  const full = resolveKey(key);
  if (!full) return null;
  try {
    const st = await stat(full);
    if (!st.isFile()) return null;
    return { body: createReadStream(full), size: st.size };
  } catch {
    return null;
  }
}

/** Подписанная ссылка — общая с облаком, см. storage.sign.ts. */
export async function url(key: string, seconds = 900): Promise<string> {
  return link(key, seconds);
}
