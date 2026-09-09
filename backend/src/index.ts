import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { prisma } from "./lib/db";
import { env, pushConfigured } from "./lib/env";
import { errorHandler } from "./lib/errors";
import { authRouter } from "./modules/auth/auth.routes";
import { platformRouter } from "./modules/platform/platform.routes";
import { customersRouter } from "./modules/customers/customers.routes";
import { ordersRouter } from "./modules/orders/orders.routes";
import { notificationsRouter, pushRouter } from "./modules/notifications/notifications.routes";
import { publicRouter } from "./modules/public/public.routes";
import { referenceRouter } from "./modules/reference/reference.routes";
import { staffRouter } from "./modules/staff/staff.routes";
import { ensureBucket } from "./lib/storage";
import { ensurePlatformOwner } from "./services/bootstrap";
import { startOverdueWatch } from "./services/overdue";

const app = express();

// За nginx: без этого в лог и в счётчик попыток входа попадёт IP прокси, а не клиента.
app.set("trust proxy", 1);

app.use(helmet());
app.use(
  cors({
    origin: env.corsOrigin === "*" ? true : env.corsOrigin.split(","),
    credentials: true,
  })
);
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use(pinoHttp({ level: env.nodeEnv === "production" ? "info" : "debug" }));

app.get("/api/health", async (_req, res) => {
  await prisma.$queryRaw`SELECT 1`;
  res.json({ ok: true, ts: new Date().toISOString() });
});

// Публичные маршруты подключаются до staffRouter: тот требует авторизацию для всего,
// что до него доходит, и заявка на регистрацию упиралась бы в 401.
app.use("/api/public", publicRouter);
app.use("/api/auth", authRouter);
app.use("/api/platform", platformRouter);
app.use("/api/orders", ordersRouter);
app.use("/api/customers", customersRouter);
app.use("/api/reference", referenceRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/push", pushRouter);
app.use("/api", staffRouter);

app.use("/api", (_req, res) => res.status(404).json({ error: "Метод не найден" }));
app.use(errorHandler);

ensurePlatformOwner().catch((err) => console.error("Не удалось создать собственника платформы:", err));
// Бакет создаётся при старте: иначе первая же загрузка фотографии упала бы
// на пустом месте, и разбираться пришлось бы приёмщику у стойки.
ensureBucket().catch((err) => console.error("Не удалось подготовить хранилище файлов:", err));

if (pushConfigured) startOverdueWatch();
else console.warn("Оповещения выключены: не заданы VAPID_PUBLIC_KEY и VAPID_PRIVATE_KEY");

const server = app.listen(env.port, () => {
  console.log(`RepairShop API слушает порт ${env.port}`);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    server.close(async () => {
      await prisma.$disconnect();
      process.exit(0);
    });
  });
}
