import { randomUUID } from "node:crypto";
import { Router, type Request } from "express";
import multer from "multer";
import { z } from "zod";
import { clientIp, writeAudit } from "../../lib/audit";
import { withTenant } from "../../lib/db";
import { ah, badRequest, notFound } from "../../lib/errors";
import { PERMISSIONS } from "../../lib/permissions";
import {
  authenticate,
  actorUserId,
  currentTenantId,
  requirePermission,
  requireTenant,
} from "../../middleware/auth";
import { enforceTenantStatus } from "../../middleware/tenantStatus";
import { applyRows } from "./apply";
import { DATASETS, DATASET_KEYS, isDatasetKey, type DatasetKey } from "./dataset";
import { buildSheets } from "./export";
import { parseRows, type ImportPreview, type ParsedRow } from "./import";
import { formatDate, readTable, writeCsv, writeHtml, writeXlsx } from "./tableFile";

/**
 * Выгрузка и загрузка данных мастерской.
 *
 * Весь раздел под правом «Настройки мастерской»: выгрузка клиентской базы —
 * это персональные данные целиком, такое не должно быть доступно каждому
 * приёмщику просто потому, что он умеет нажимать кнопки.
 */
export const dataRouter = Router();
dataRouter.use(
  authenticate,
  requireTenant,
  enforceTenantStatus,
  requirePermission(PERMISSIONS.SETTINGS_MANAGE)
);

const tenantOf = (req: Request) => currentTenantId(req)!;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
});

/**
 * Разобранный файл живёт между двумя запросами здесь, а не в базе: это
 * черновик, который в половине случаев не станет ничем. Живёт четверть часа
 * и привязан к своему пользователю. Перезапуск бэкенда его теряет —
 * тогда файл придётся выбрать заново, о чём интерфейс и сообщит.
 */
interface Pending {
  tenantId: string;
  userId: string | null;
  dataset: DatasetKey;
  fileName: string;
  rows: ParsedRow[];
  preview: ImportPreview;
  expiresAt: number;
}

const PENDING_TTL_MS = 15 * 60 * 1000;
const pending = new Map<string, Pending>();

function putPending(p: Omit<Pending, "expiresAt">): string {
  const now = Date.now();
  for (const [id, item] of pending) if (item.expiresAt < now) pending.delete(id);
  // Больше двадцати черновиков одновременно не бывает даже у самого
  // деятельного владельца — а вот утечка памяти бывает.
  if (pending.size > 20) {
    const oldest = [...pending.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
    if (oldest) pending.delete(oldest[0]);
  }
  const id = randomUUID();
  pending.set(id, { ...p, expiresAt: now + PENDING_TTL_MS });
  return id;
}

// ------------------------------------------------------------------ справка

dataRouter.get(
  "/",
  ah(async (_req, res) => {
    res.json({
      datasets: DATASET_KEYS.map((key) => ({
        key,
        title: DATASETS[key].title,
        hint: DATASETS[key].hint,
        matchBy: DATASETS[key].matchBy,
        columns: DATASETS[key].columns.map((c) => ({
          title: c.title,
          required: !!c.required,
          readOnly: !!c.readOnly,
        })),
      })),
      formats: [
        { key: "xlsx", title: "Excel (xlsx)", canImport: true },
        { key: "csv", title: "CSV", canImport: true },
        // html — для чтения и печати: обратно его никто не разбирает,
        // и обещать загрузку из него было бы нечестно.
        { key: "html", title: "HTML для печати", canImport: false },
      ],
      maxImportRows: 5000,
    });
  })
);

// ------------------------------------------------------------------ выгрузка

const exportSchema = z.object({
  datasets: z.array(z.string()).min(1),
  format: z.enum(["xlsx", "csv", "html"]),
});

dataRouter.get(
  "/export",
  ah(async (req, res) => {
    const raw = {
      datasets: String(req.query.datasets ?? "").split(",").filter(Boolean),
      format: String(req.query.format ?? "xlsx"),
    };
    const { datasets, format } = exportSchema.parse(raw);

    const keys = datasets.filter(isDatasetKey);
    if (keys.length === 0) throw badRequest("Не выбрано, что выгружать");
    if (format === "csv" && keys.length > 1) {
      throw badRequest("CSV — это один лист. Выберите один раздел или возьмите Excel");
    }

    const sheets = await withTenant(tenantOf(req), (tx) => buildSheets(tx, keys));

    const stamp = new Date().toISOString().slice(0, 10);
    const base = keys.length === 1 ? DATASETS[keys[0]].sheet.toLowerCase() : "finecrm";
    const fileName = `${base}-${stamp}.${format}`;

    let body: Buffer;
    let type: string;
    if (format === "xlsx") {
      body = await writeXlsx(sheets);
      type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    } else if (format === "csv") {
      body = writeCsv(sheets[0]);
      type = "text/csv; charset=utf-8";
    } else {
      body = writeHtml(sheets, "FineCRM — выгрузка данных");
      type = "text/html; charset=utf-8";
    }

    await withTenant(tenantOf(req), (tx) =>
      writeAudit(tx, {
        tenantId: tenantOf(req),
        userId: actorUserId(req),
        entity: "Data",
        entityId: keys.join(","),
        action: "EXPORT",
        diff: { format, rows: sheets.reduce((n, s) => n + s.rows.length, 0) },
        ip: clientIp(req),
      })
    );

    res.setHeader("Content-Type", type);
    // Имя файла двумя способами: старые браузеры читают первое, все
    // остальные — второе, где кириллица переживает пересылку.
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${base}-${stamp}.${format}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
    );
    res.send(body);
  })
);

// ------------------------------------------------------------------ загрузка

dataRouter.post(
  "/import/parse",
  upload.single("file"),
  ah(async (req, res) => {
    const dataset = String(req.body?.dataset ?? "");
    if (!isDatasetKey(dataset)) throw badRequest("Не указано, что загружаем");

    const file = req.file;
    if (!file) throw badRequest("Файл не приложен");
    if (!/\.(xlsx|xlsm|csv|txt|tsv)$/i.test(file.originalname)) {
      throw badRequest("Понимаю только xlsx и csv. HTML читается глазами, но не загружается обратно");
    }

    const table = await readTable(file.buffer, file.originalname);
    if (table.length === 0) throw badRequest("Файл пустой");

    const tenantId = tenantOf(req);
    const { preview, rows } = await withTenant(tenantId, (tx) => parseRows(tx, dataset, table));
    preview.fileName = file.originalname;

    if (preview.missingColumns.length) {
      // Дальше идти незачем: без обязательных колонок строки не разобрать.
      return res.json({ token: null, preview });
    }

    const token = putPending({
      tenantId,
      userId: actorUserId(req),
      dataset,
      fileName: file.originalname,
      rows,
      preview,
    });

    res.json({ token, preview });
  })
);

dataRouter.post(
  "/import/apply",
  ah(async (req, res) => {
    const { token } = z.object({ token: z.string().uuid() }).parse(req.body);
    const item = pending.get(token);

    if (!item || item.expiresAt < Date.now()) {
      pending.delete(token);
      throw notFound("Разбор файла устарел — выберите файл заново");
    }
    // Чужой черновик не применяем, даже если кто-то узнал ключ.
    if (item.tenantId !== tenantOf(req) || item.userId !== actorUserId(req)) {
      throw notFound("Разбор файла не найден");
    }

    pending.delete(token);

    const result = await withTenant(item.tenantId, (tx) =>
      applyRows(tx, item.tenantId, item.dataset, item.rows, item.userId)
    );

    await withTenant(item.tenantId, (tx) =>
      writeAudit(tx, {
        tenantId: item.tenantId,
        userId: item.userId,
        entity: "Data",
        entityId: item.dataset,
        action: "IMPORT",
        diff: {
          file: item.fileName,
          created: result.created,
          updated: result.updated,
          failed: result.failed.length,
        },
        ip: clientIp(req),
      })
    );

    res.json({
      ...result,
      dataset: item.dataset,
      fileName: item.fileName,
      finishedAt: formatDate(new Date()),
    });
  })
);
