import cors from "cors";
import express from "express";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { env } from "./lib/env";
import { prisma } from "./lib/db";

const app = express();

app.use(helmet());
app.use(cors({ origin: env.corsOrigin === "*" ? true : env.corsOrigin.split(","), credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.use(pinoHttp({ level: env.nodeEnv === "production" ? "info" : "debug" }));

app.get("/api/health", async (_req, res) => {
  await prisma.$queryRaw`SELECT 1`;
  res.json({ ok: true, ts: new Date().toISOString() });
});

// TODO: подключить маршруты по мере готовности
// app.use("/api/auth", authRouter);
// app.use("/api/platform", platformRouter);
// app.use("/api/orders", ordersRouter);
// app.use("/api/purchases", purchasesRouter);

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(500).json({ error: env.nodeEnv === "production" ? "Внутренняя ошибка" : err.message });
});

app.listen(env.port, () => {
  console.log(`RepairShop API слушает порт ${env.port}`);
});
