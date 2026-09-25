import { randomUUID } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { clientIp, writeAudit } from "../../lib/audit";
import { prisma, withTenant } from "../../lib/db";
import { ah, badRequest, conflict, forbidden, notFound } from "../../lib/errors";
import { originalName } from "../../lib/uploadName";
import { actorUserId, authenticate, currentTenantId, requireTenant } from "../../middleware/auth";
import { enforceTenantStatus } from "../../middleware/tenantStatus";
import { localLoginDomain } from "../relay/remoteAccess";
import { applyMigration, isEmptyForMigration, previewMigration, type DatasetPreview } from "./migrate";
import { SOURCES, detectSource } from "./sources";
import type { Converted } from "./sources/types";
import { BadFile, readTables } from "./sqlite";

/**
 * Перенос из другой программы: «Настройки → Базы → Перенос».
 *
 * Только владельцу: перенос заводит сотрудников, кассу и тысячи заказов —
 * это решение о мастерской целиком, а не правка бланка.
 */
export const migrateRouter = Router();
migrateRouter.use(authenticate, requireTenant, enforceTenantStatus);

function requireOwner(req: Request, _res: Response, next: NextFunction) {
  if (req.auth?.kind === "tenant" && req.auth.isOwner) return next();
  next(forbidden("Перенос базы делает владелец мастерской"));
}
migrateRouter.use(requireOwner);

const tenantOf = (req: Request) => currentTenantId(req)!;

// Лимит — чуть ниже того, что пропускает nginx (60 МБ): иначе человек
// получил бы вместо понятного ответа обрыв соединения.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 55 * 1024 * 1024, files: 1 } });

/** Разобранная база ждёт подтверждения здесь — как черновик загрузки файла. */
interface Pending {
  tenantId: string;
  userId: string | null;
  fileName: string;
  converted: Converted;
  expiresAt: number;
}
const PENDING_TTL_MS = 30 * 60 * 1000;
const pending = new Map<string, Pending>();

function putPending(p: Omit<Pending, "expiresAt">): string {
  const now = Date.now();
  for (const [id, item] of pending) if (item.expiresAt < now) pending.delete(id);
  // Разобранная база весит мегабайты: держим не больше пяти сразу.
  while (pending.size >= 5) {
    const oldest = [...pending.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
    pending.delete(oldest[0]);
  }
  const id = randomUUID();
  pending.set(id, { ...p, expiresAt: now + PENDING_TTL_MS });
  return id;
}

migrateRouter.get(
  "/",
  ah(async (req, res) => {
    const empty = await withTenant(tenantOf(req), (tx) => isEmptyForMigration(tx));
    res.json({ canMigrate: empty, sources: SOURCES.map((s) => s.title) });
  })
);

migrateRouter.post(
  "/parse",
  upload.single("file"),
  ah(async (req, res) => {
    const file = req.file;
    if (!file) throw badRequest("Файл не приложен");
    const name = originalName(file.originalname);

    let tables;
    try {
      tables = readTables(file.buffer);
    } catch (err) {
      if (err instanceof BadFile) throw badRequest(`Не получилось прочитать «${name}»: ${err.message}`);
      throw err;
    }
    const source = detectSource(tables);
    if (!source) {
      throw badRequest(
        `База «${name}» прочиталась, но программу мы не узнали. Пришлите её нам — добавим. ` +
          `Таблицы в ней: ${Object.keys(tables).slice(0, 12).join(", ")}`
      );
    }

    const converted = source.convert(tables);
    const tenantId = tenantOf(req);
    const { empty, previews } = await withTenant(
      tenantId,
      async (tx) => ({ empty: await isEmptyForMigration(tx), previews: await previewMigration(tx, converted) }),
      { timeout: 3 * 60_000, maxWait: 30_000 }
    );

    const token = empty ? putPending({ tenantId, userId: actorUserId(req), fileName: name, converted }) : null;
    res.json({ token, empty, fileName: name, summary: summarize(converted, previews) });
  })
);

function summarize(c: Converted, previews: DatasetPreview[]) {
  const statusCount = new Map<string, number>();
  const head = c.orders[0].cells.map(String);
  const iStatus = head.indexOf("Статус");
  for (const r of c.orders.slice(1)) {
    const s = String(r.cells[iStatus] ?? "") || "Новый";
    statusCount.set(s, (statusCount.get(s) ?? 0) + 1);
  }
  return {
    source: c.source.title,
    staff: c.staff.map((s) => ({ name: s.name, orders: s.orders, lastAt: s.lastAt })),
    customers: c.customers.length - 1,
    stock: c.stock.length - 1,
    orders: c.orders.length - 1,
    statuses: [...statusCount].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
    payments: c.payments.length,
    paymentsSum: Math.round(c.payments.reduce((n, p) => n + p.amount, 0)),
    history: c.history.length,
    passcodes: c.passcodes.size,
    lastNumber: c.lastNumber,
    notes: c.notes,
    previews,
  };
}

migrateRouter.post(
  "/apply",
  ah(async (req, res) => {
    const body = z.object({ token: z.string().uuid(), continueNumbering: z.boolean().default(true) }).parse(req.body);
    const item = pending.get(body.token);
    if (!item || item.expiresAt < Date.now()) {
      pending.delete(body.token);
      throw notFound("Разбор базы устарел — выберите файл заново");
    }
    if (item.tenantId !== tenantOf(req) || item.userId !== actorUserId(req)) throw notFound("Разбор базы не найден");
    pending.delete(body.token);

    const tenantId = item.tenantId;
    const ownerId = actorUserId(req);
    if (!ownerId) throw forbidden("Нужна учётка владельца");
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { slug: true, maxUsers: true } });
    if (!tenant) throw notFound("Мастерская не найдена");
    const loginDomain = await localLoginDomain();

    const started = Date.now();
    const result = await withTenant(
      tenantId,
      async (tx) => {
        if (!(await isEmptyForMigration(tx))) {
          throw conflict("В базе уже есть заказы, клиенты или склад — перенос делается только в пустую базу");
        }
        const r = await applyMigration(tx, tenantId, item.converted, {
          ownerId,
          loginDomain,
          slug: tenant.slug,
          maxUsers: tenant.maxUsers,
          continueNumbering: body.continueNumbering,
        });
        await writeAudit(tx, {
          tenantId,
          userId: ownerId,
          entity: "Data",
          entityId: "migrate",
          action: "IMPORT",
          diff: {
            source: item.converted.source.title,
            file: item.fileName,
            orders: r.orders,
            customers: r.customers,
            stock: r.stock,
            staff: r.staff.length,
            payments: r.payments,
            failed: r.failed.length,
          },
          ip: clientIp(req),
        });
        return r;
      },
      { timeout: 10 * 60_000, maxWait: 30_000 }
    );

    res.json({ ...result, failed: result.failed.slice(0, 200), failedTotal: result.failed.length, seconds: Math.round((Date.now() - started) / 1000) });
  })
);
