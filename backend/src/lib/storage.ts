import { env } from "./env";
import * as local from "./storage.local";
import * as s3 from "./storage.s3";

/**
 * Хранилище фотографий — единое лицо для двух устройств.
 *
 * В облаке файлы лежат в приватном бакете MinIO, в локальной версии — в папке
 * рядом с базой мастерской. Остальному коду разница не видна: он кладёт файл,
 * получает ключ и просит по ключу временную ссылку.
 *
 * Выбор делается один раз при старте по настройке, а не по «получилось ли
 * подключиться к S3»: молчаливое переключение на диск, когда хранилище
 * недоступно, разложило бы половину снимков в одном месте, половину в другом.
 */

export const isLocalStorage = env.storageDriver === "local";

const driver = isLocalStorage ? local : s3;

/** Что разрешено загружать. Расширение в ключе берём отсюда же. */
const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "application/pdf": "pdf",
};

/** Обратное соответствие — нужно локальной раздаче, чтобы назвать тип файла. */
const MIME: Record<string, string> = Object.fromEntries(
  Object.entries(EXT).map(([mime, ext]) => [ext, mime])
);

export const isAllowedUpload = (mime: string): boolean => mime in EXT;

export const mimeOfKey = (key: string): string =>
  MIME[key.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";

/** Подготовка хранилища при старте: бакет или папка. */
export const ensureBucket = (): Promise<void> => driver.ensure();

export function putOrderFile(params: {
  tenantId: string;
  orderId: string;
  buffer: Buffer;
  mimeType: string;
}): Promise<string> {
  const ext = EXT[params.mimeType] ?? "bin";
  return driver.put({ ...params, ext });
}

export const signedUrl = (key: string, seconds = 900): Promise<string> =>
  Promise.resolve(driver.url(key, seconds));

export const removeFile = (key: string): Promise<void> => driver.remove(key);

// Локальной раздаче нужны разбор ключа и проверка подписи; в облаке этим
// занимается сам S3, и наружу они не нужны.
export const localFile = { resolveKey: local.resolveKey, verify: local.verify };
