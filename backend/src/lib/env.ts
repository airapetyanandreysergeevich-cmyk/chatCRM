import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Не задана переменная окружения ${name}`);
  return v;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: required("DATABASE_URL"),

  jwtAccessSecret: required("JWT_ACCESS_SECRET"),
  jwtRefreshSecret: required("JWT_REFRESH_SECRET"),
  accessTokenTtl: process.env.ACCESS_TOKEN_TTL ?? "15m",
  refreshTokenTtlDays: Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 30),
  corsOrigin: process.env.CORS_ORIGIN ?? "*",

  s3Endpoint: process.env.S3_ENDPOINT ?? "http://minio:9000",
  s3Bucket: process.env.S3_BUCKET ?? "repairshop",
  s3AccessKey: process.env.S3_ACCESS_KEY ?? "",
  s3SecretKey: process.env.S3_SECRET_KEY ?? "",
  maxFileSizeMb: Number(process.env.MAX_FILE_SIZE_MB ?? 50),

  // Ключи Web Push. Без них оповещения просто не включаются: приложение
  // работает как обычно, а кнопка подписки честно говорит, что канал не настроен.
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY ?? "",
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY ?? "",
  vapidSubject: process.env.VAPID_SUBJECT ?? "mailto:admin@finecrm.ru",
};

export const pushConfigured = Boolean(env.vapidPublicKey && env.vapidPrivateKey);
