import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { prisma } from "./lib/db";
import { env } from "./lib/env";
import { errorHandler } from "./lib/errors";
import { authRouter } from "./modules/auth/auth.routes";
import { platformRouter } from "./modules/platform/platform.routes";
import { staffRouter } from "./modules/staff/staff.routes";

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

app.use("/api/auth", authRouter);
app.use("/api/platform", platformRouter);
app.use("/api", staffRouter);

app.use("/api", (_req, res) => res.status(404).json({ error: "Метод не найден" }));
app.use(errorHandler);

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
