import { randomUUID } from "node:crypto";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { env } from "./env";
import { link, validKey } from "./storage.sign";

/**
 * Хранилище файлов в S3 (у нас — MinIO) для облачной версии.
 *
 * Фотографии техники лежат в приватном бакете и наружу отдаются только
 * по подписанной ссылке с коротким сроком жизни. Прямой раздачи каталога нет:
 * иначе снимки чужой техники доставались бы по угаданному адресу.
 */
export const s3 = new S3Client({
  region: "us-east-1",
  endpoint: env.s3Endpoint,
  forcePathStyle: true, // MinIO не умеет адресацию бакета через поддомен
  credentials: { accessKeyId: env.s3AccessKey, secretAccessKey: env.s3SecretKey },
});

export async function ensure(): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: env.s3Bucket }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: env.s3Bucket }));
    console.log(`Создан бакет ${env.s3Bucket}`);
  }
}

/** Ключ всегда начинается с tenantId — по одному пути видно, чьё это. */
export async function put(params: {
  tenantId: string;
  orderId: string;
  buffer: Buffer;
  mimeType: string;
  ext: string;
}): Promise<string> {
  const key = `${params.tenantId}/${params.orderId}/${randomUUID()}.${params.ext}`;
  await s3.send(
    new PutObjectCommand({
      Bucket: env.s3Bucket,
      Key: key,
      Body: params.buffer,
      ContentType: params.mimeType,
    })
  );
  return key;
}

/**
 * Ссылка — на наш сервер, а не на MinIO: адрес MinIO внутренний, браузеру он
 * неизвестен (см. storage.sign.ts). Подписанные ссылки самого S3 больше не
 * выдаём.
 */
export async function url(key: string, seconds = 900): Promise<string> {
  return link(key, seconds);
}

/** Открыть файл для отдачи через наш сервер. null — нет такого. */
export async function open(key: string): Promise<{ body: NodeJS.ReadableStream; size?: number } | null> {
  if (!validKey(key)) return null;
  try {
    const out = await s3.send(new GetObjectCommand({ Bucket: env.s3Bucket, Key: key }));
    if (!out.Body) return null;
    return { body: out.Body as NodeJS.ReadableStream, size: out.ContentLength };
  } catch {
    return null;
  }
}

export async function remove(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: env.s3Bucket, Key: key }));
}
