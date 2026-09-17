import { randomUUID } from "node:crypto";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "./env";

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

/** Ссылка живёт 15 минут: хватает открыть, мало чтобы разойтись по чужим рукам. */
export function url(key: string, seconds = 900): Promise<string> {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: env.s3Bucket, Key: key }), {
    expiresIn: seconds,
  });
}

export async function remove(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: env.s3Bucket, Key: key }));
}
