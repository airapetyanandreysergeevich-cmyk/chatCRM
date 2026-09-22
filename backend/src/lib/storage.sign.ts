import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "./env";

/**
 * Подписанные ссылки на файлы — одни и те же в облаке и в локальной версии.
 *
 * Раньше облако отдавало ссылку, подписанную самим S3. Она вела прямо на
 * MinIO — по внутреннему адресу http://minio:9000, которого браузер не
 * знает. Снимки загружались, а показать их было нечем: вместо фотографии —
 * пустой квадрат. Теперь файл всегда отдаёт наш же сервер по /api/files/…,
 * а MinIO наружу не выставлен вовсе.
 *
 * Секрет — тот же, что у токенов доступа: отдельный ключ ничего не добавил
 * бы, они лежат в одном файле настроек.
 */

function sign(key: string, expires: number): string {
  return createHmac("sha256", env.jwtAccessSecret).update(`${key}:${expires}`).digest("hex");
}

/**
 * Ссылка живёт 15 минут: хватает открыть, мало чтобы разойтись по чужим рукам.
 * Адрес относительный: программа живёт то на finecrm.ru, то на localhost, то
 * на адресе Основы в локальной сети.
 */
export function link(key: string, seconds = 900): string {
  const expires = Math.floor(Date.now() / 1000) + seconds;
  return `/api/files/${key}?e=${expires}&s=${sign(key, expires)}`;
}

/** Проверка подписи. Сравнение постоянного времени — чтобы подпись не подбиралась побайтно. */
export function verify(key: string, expires: number, sig: string): boolean {
  if (!Number.isFinite(expires) || expires < Math.floor(Date.now() / 1000)) return false;
  const expected = Buffer.from(sign(key, expires), "utf8");
  const given = Buffer.from(String(sig), "utf8");
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}

/** Ключ файла: только «папка/папка/имя.расш», без точек-переходов. */
const KEY_RE = /^[0-9a-zA-Z._-]+(?:\/[0-9a-zA-Z._-]+)*$/;
export const validKey = (key: string): boolean =>
  !!key && key.length <= 300 && KEY_RE.test(key) && !key.split("/").some((p) => p === "." || p === "..");
