import { Router, type Request } from "express";
import multer from "multer";
import { z } from "zod";
import { prisma, withTenant } from "../../lib/db";
import { env } from "../../lib/env";
import { AppError, ah, badRequest, forbidden } from "../../lib/errors";
import { PERMISSIONS } from "../../lib/permissions";
import { authenticate, currentTenantId, requirePermission, requireTenant } from "../../middleware/auth";
import { enforceTenantStatus } from "../../middleware/tenantStatus";
import { loadDictionary } from "./plate.dictionary";
import { parsePlate, type OcrResult } from "./plate.parse";

/**
 * Распознавание шильдика: снимок с камеры бланка → бренд, модель, серийный.
 *
 * Снимок нигде не сохраняется: он живёт, пока идёт запрос, и уходит только
 * во внутренний сервис ocr на этом же сервере. Приёмщик сам решает, что
 * подставить в бланк, — здесь только предложение.
 */

export const plateRouter = Router();
plateRouter.use(
  authenticate,
  requireTenant,
  enforceTenantStatus,
  requirePermission(PERMISSIONS.ORDERS_CREATE, PERMISSIONS.ORDERS_EDIT)
);

const tenantOf = (req: Request) => currentTenantId(req)!;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 1 },
});

/**
 * Сколько снимков одновременно может ждать распознавателя. Он обрабатывает
 * их строго по одному; очередь длиннее этой — уже не очередь, а затор, и
 * честнее сразу сказать «занято», чем держать приёмщика минуту.
 */
const MAX_WAITING = 4;
let waiting = 0;

/** Сколько ждём распознаватель: два снимка в очереди плюс свой. */
const TIMEOUT_MS = 30_000;

plateRouter.post(
  "/recognize",
  upload.single("image"),
  ah(async (req, res) => {
    if (!env.ocrUrl) throw new AppError(503, "Распознавание шильдиков на этом сервере не установлено");

    await assertEnabled(req);

    const file = req.file;
    if (!file || !file.buffer.length) throw badRequest("Нет снимка");
    if (!/^image\//.test(file.mimetype)) throw badRequest("Нужна фотография шильдика");

    if (waiting >= MAX_WAITING) {
      throw new AppError(429, "Распознаватель занят другими снимками — повторите через пару секунд");
    }

    waiting += 1;
    let ocr: OcrResult;
    try {
      const reply = await fetch(`${env.ocrUrl}/recognize`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(file.buffer),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const data = (await reply.json().catch(() => ({}))) as Partial<OcrResult> & { error?: string };
      if (!reply.ok) {
        throw new AppError(reply.status === 400 ? 400 : 502, data.error ?? "Распознаватель не справился со снимком");
      }
      ocr = { lines: data.lines ?? [], barcodes: data.barcodes ?? [] };
    } catch (err) {
      if (err instanceof AppError) throw err;
      const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      throw new AppError(
        503,
        timeout
          ? "Распознаватель не ответил вовремя — попробуйте ещё раз"
          : "Распознаватель сейчас недоступен — заполните поля вручную"
      );
    } finally {
      waiting -= 1;
    }

    res.json(await parseFor(req, ocr));
  })
);

/**
 * Разбор строк, распознанных прямо в окне программы (локальная версия).
 *
 * Снимок сюда не приходит — только текст и штрихкоды. Разбор тот же, что у
 * облачного пути: одни правила, один словарь, одни тесты.
 */
const parseSchema = z.object({
  lines: z
    .array(
      z.object({
        text: z.string().max(300),
        score: z.number().optional(),
        box: z.array(z.number()).max(8).optional(),
      })
    )
    .max(400),
  barcodes: z.array(z.object({ format: z.string().max(40), text: z.string().max(500) })).max(20).default([]),
});

plateRouter.post(
  "/parse",
  ah(async (req, res) => {
    await assertEnabled(req);
    res.json(await parseFor(req, parseSchema.parse(req.body)));
  })
);

async function assertEnabled(req: Request): Promise<void> {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantOf(req) }, select: { plateOcr: true } });
  if (!tenant?.plateOcr) throw forbidden("Распознавание шильдиков для мастерской выключено");
}

async function parseFor(req: Request, ocr: OcrResult) {
  // Марки, которые мастерская уже вводила не раз, — тоже словарь: мастерская
  // по кофемашинам знает свои марки лучше любого встроенного списка.
  const [dictionary, hints] = await Promise.all([
    loadDictionary(),
    withTenant(tenantOf(req), (tx) =>
      tx.deviceHint.findMany({
        where: { field: "brand", uses: { gte: 2 } },
        orderBy: { uses: "desc" },
        take: 300,
        select: { value: true },
      })
    ),
  ]);
  return parsePlate(ocr, { dictionary, knownBrands: hints.map((h) => h.value) });
}
