import path from "node:path";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import pinoHttp from "pino-http";
import { prisma } from "./lib/db";
import { env, pushConfigured } from "./lib/env";
import { errorHandler } from "./lib/errors";
import { securityHeaders } from "./lib/security";
import { authRouter } from "./modules/auth/auth.routes";
import { platformRouter } from "./modules/platform/platform.routes";
import { customersRouter } from "./modules/customers/customers.routes";
import { dataRouter } from "./modules/data/data.routes";
import { financeRouter } from "./modules/finance/finance.routes";
import { ordersRouter } from "./modules/orders/orders.routes";
import { messagesRouter } from "./modules/orders/messages.routes";
import { purchasesRouter } from "./modules/purchases/purchases.routes";
import { stockRouter } from "./modules/stock/stock.routes";
import { summaryRouter } from "./modules/summary/summary.routes";
import { notificationsRouter, pushRouter } from "./modules/notifications/notifications.routes";
import { publicRouter } from "./modules/public/public.routes";
import { referenceRouter } from "./modules/reference/reference.routes";
import { feedbackRouter } from "./modules/feedback/feedback.routes";
import { filesRouter } from "./modules/files/files.routes";
import { hintsRouter } from "./modules/hints/hints.routes";
import { quickPicksRouter } from "./modules/quickpicks/quickpicks.routes";
import { plateRouter } from "./modules/plate/plate.routes";
import { servicesRouter } from "./modules/services/services.routes";
import { settingsRouter } from "./modules/settings/settings.routes";
import { staffRouter } from "./modules/staff/staff.routes";
import { ensureBucket } from "./lib/storage";
import { ensurePlatformOwner } from "./services/bootstrap";
import { startOverdueWatch } from "./services/overdue";
import { relayHub, startRelayAgent, startRelayHub } from "./modules/relay/relay.instance";

const app = express();

// За nginx: без этого в лог и в счётчик попыток входа попадёт IP прокси, а не клиента.
app.set("trust proxy", 1);

/**
 * Доступ к коробочным Основам: /b/<код>/…
 *
 * Стоит первым, раньше разбора тела и заголовков безопасности, и это важно:
 * тело запроса надо переслать в мастерскую как есть, а не разобранным в
 * объект, а заголовки ответа (в том числе правила безопасности) должна
 * задавать сама Основа, а не облако.
 */
app.use("/b/:code", (req, res, next) => {
  const hub = relayHub();
  if (!hub) return next();
  const code = String(req.params.code ?? "");
  if (!/^[a-z0-9-]{3,40}$/.test(code)) return next();
  hub.handleRequest(code, req.url || "/", req, res);
});

app.use(securityHeaders());
app.use(
  cors({
    origin: env.corsOrigin === "*" ? true : env.corsOrigin.split(","),
    credentials: true,
  })
);
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use(
  pinoHttp({
    level: env.nodeEnv === "production" ? "info" : "debug",
    // Журнал читают при разборе сбоев и пересылают друг другу — токены и
    // куки в нём не нужны никому, кроме того, кто их украдёт. Токен живёт
    // 15 минут, куки обновления — недели: этого хватает, чтобы войти от
    // чужого имени по строчке из присланного журнала.
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        'req.headers["x-api-key"]',
        'res.headers["set-cookie"]',
      ],
      censor: "[скрыто]",
    },
  })
);

app.get("/api/health", async (req, res) => {
  await prisma.$queryRaw`SELECT 1`;
  const ts = new Date().toISOString();

  // В коробке эта же проверка — визитная карточка для автопоиска: программа
  // сотрудника находит Основу в сети и показывает название мастерской, а по
  // номеру находит её снова, когда роутер выдаст Основе другой адрес.
  //
  // Только в локальной сети. Запрос, пришедший через туннель из интернета,
  // несёт x-forwarded-for от узла связи — таким название не отдаём: снаружи
  // адрес случайный как раз затем, чтобы ничего о мастерской не говорить.
  if (env.storageDriver === "local" && !req.headers["x-forwarded-for"]) {
    const tenant = await prisma.tenant.findFirst({ select: { id: true, name: true }, orderBy: { createdAt: "asc" } });
    return res.json({ ok: true, ts, app: "finecrm", workshop: tenant ? { id: tenant.id, name: tenant.name } : null });
  }

  res.json({ ok: true, ts });
});

// Публичные маршруты подключаются до staffRouter: тот требует авторизацию для всего,
// что до него доходит, и заявка на регистрацию упиралась бы в 401.
app.use("/api/public", publicRouter);
app.use("/api/auth", authRouter);
app.use("/api/platform", platformRouter);
// История ремонта — раньше заказов: иначе /:id заказа перехватил бы адрес.
app.use("/api/orders/:id/messages", messagesRouter);
app.use("/api/orders", ordersRouter);
app.use("/api/customers", customersRouter);
app.use("/api/summary", summaryRouter);
app.use("/api/stock", stockRouter);
app.use("/api/purchases", purchasesRouter);
app.use("/api/finance", financeRouter);
app.use("/api/reference", referenceRouter);
// Только в локальной версии: в облаке файлы отдаёт S3, и открытого
// маршрута к ним быть не должно.
// Файлы по подписанным ссылкам — и в облаке, и в локальной версии: браузер
// получает их от нас, а не от хранилища напрямую.
app.use("/api/files", filesRouter);
app.use("/api/feedback", feedbackRouter);
app.use("/api/hints", hintsRouter);
app.use("/api/quick-picks", quickPicksRouter);
app.use("/api/plate", plateRouter);
app.use("/api/services", servicesRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/push", pushRouter);
app.use("/api/data", dataRouter);
app.use("/api", staffRouter);

app.use("/api", (_req, res) => res.status(404).json({ error: "Метод не найден" }));

// Интерфейс отдаём сами — только в локальной версии, где нет nginx.
// Файлы приложения кэшируются надолго: их имена содержат отпечаток сборки.
// index.html — никогда, иначе после обновления останется старая страница,
// ссылающаяся на файлы, которых уже нет.
// Модели распознавателя шильдиков — только в локальной версии (см. lib/plate
// во фронтенде). Раньше интерфейса: иначе запрос модели получил бы index.html.
if (env.ocrModelsDir) {
  app.use("/ocr-models", express.static(env.ocrModelsDir, { index: false, maxAge: "30d", fallthrough: false }));
}

if (env.staticDir) {
  app.use(express.static(env.staticDir, { index: false, maxAge: "365d", immutable: true }));
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(path.join(env.staticDir, "index.html"));
  });
}

app.use(errorHandler);

ensurePlatformOwner().catch((err) => console.error("Не удалось создать собственника платформы:", err));
// Бакет создаётся при старте: иначе первая же загрузка фотографии упала бы
// на пустом месте, и разбираться пришлось бы приёмщику у стойки.
ensureBucket().catch((err) => console.error("Не удалось подготовить хранилище файлов:", err));

if (pushConfigured) startOverdueWatch();
else console.warn("Оповещения выключены: не заданы VAPID_PUBLIC_KEY и VAPID_PRIVATE_KEY");

const server = app.listen(env.port, env.bindHost, () => {
  console.log(`RepairShop API слушает ${env.bindHost}:${env.port}`);
  // Сторона мастерской — только после того, как свой сервер поднялся:
  // запросы из интернета пойдут в него же.
  startRelayAgent();
});

// Облачная сторона туннеля — на том же сервере, отдельным путём.
startRelayHub(server);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    server.close(async () => {
      await prisma.$disconnect();
      process.exit(0);
    });
  });
}
