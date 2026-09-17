import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "./env";

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

const KEY_RE = /^[0-9a-zA-Z._-]+(?:\/[0-9a-zA-Z._-]+)*$/;

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
  if (!key || key.length > 300 || !KEY_RE.test(key)) return null;
  if (key.split("/").some((part) => part === "." || part === "..")) return null;

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

// ------------------------------------------------------------------- подпись

/**
 * Подпись ссылки.
 *
 * Берём тот же секрет, что у токенов доступа: отдельный ключ здесь ничего не
 * добавил бы — кто добрался до одного, добрался и до второго, они лежат в
 * одном файле настроек.
 */
function sign(key: string, expires: number): string {
  return createHmac("sha256", env.jwtAccessSecret).update(`${key}:${expires}`).digest("hex");
}

/** Ссылка живёт 15 минут: хватает открыть, мало чтобы разойтись по чужим рукам. */
export async function url(key: string, seconds = 900): Promise<string> {
  const expires = Math.floor(Date.now() / 1000) + seconds;
  const sig = sign(key, expires);
  // Относительный адрес: программа живёт то на localhost, то на адресе
  // Основы в локальной сети, и вписывать туда имя хоста неоткуда.
  return `/api/files/${key}?e=${expires}&s=${sig}`;
}

/** Проверка подписи. Сравнение постоянного времени — чтобы подпись не подбиралась побайтно. */
export function verify(key: string, expires: number, sig: string): boolean {
  if (!Number.isFinite(expires) || expires < Math.floor(Date.now() / 1000)) return false;

  const expected = Buffer.from(sign(key, expires), "utf8");
  const given = Buffer.from(String(sig), "utf8");
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}
