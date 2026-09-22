import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Не задана переменная окружения ${name}`);
  return v;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 4000),
  // Адрес прослушивания. В облаке слушаем всё — снаружи стоит nginx. В
  // локальной версии по умолчанию только себя, пока раздачу по сети не
  // включили явно: иначе база мастерской окажется доступна всему кафе,
  // в чей вайфай воткнули ноутбук.
  bindHost: process.env.BIND_HOST ?? "0.0.0.0",
  databaseUrl: required("DATABASE_URL"),

  jwtAccessSecret: required("JWT_ACCESS_SECRET"),
  jwtRefreshSecret: required("JWT_REFRESH_SECRET"),
  accessTokenTtl: process.env.ACCESS_TOKEN_TTL ?? "15m",
  refreshTokenTtlDays: Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 30),
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  /**
   * Помечать ли печенье сессии как «только по HTTPS».
   *
   * В облаке — да, всегда. В локальной сети мастерской сертификата пока нет,
   * и с этой пометкой браузер просто не сохранит печенье: сотрудник войдёт и
   * через пятнадцать минут вылетит, не сумев продлить сессию. Поэтому
   * локальная версия выключает пометку явно — и знает, что делает.
   */
  cookieSecure: process.env.COOKIE_SECURE
    ? process.env.COOKIE_SECURE === "true"
    : process.env.NODE_ENV === "production",

  // Куда класть фотографии: "s3" в облаке, "local" в коробочной версии.
  storageDriver: process.env.STORAGE_DRIVER === "local" ? "local" : "s3",
  // Папка хранилища для local — задаётся программой рядом с базой мастерской.
  storageDir: process.env.STORAGE_DIR ?? "./files",
  // Собранный интерфейс. В облаке его раздаёт nginx и переменная пуста; в
  // локальной версии его отдаёт сам бэкенд — тогда сотруднику с соседнего
  // компьютера хватит браузера, без установки программы.
  staticDir: process.env.STATIC_DIR ?? "",

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

  // Распознаватель шильдиков (сервис ocr). Пусто — функции нет вовсе: кнопка
  // с камерой на бланке не показывается. Так в локальной версии, где своего
  // распознавателя нет.
  ocrUrl: (process.env.OCR_URL ?? "").replace(/\/+$/, ""),
  // Папка с моделями распознавателя для локальной версии. Задана — модели
  // раздаются по /ocr-models/, и снимок распознаётся прямо в окне программы.
  ocrModelsDir: process.env.OCR_MODELS_DIR ?? "",
};

export const pushConfigured = Boolean(env.vapidPublicKey && env.vapidPrivateKey);
