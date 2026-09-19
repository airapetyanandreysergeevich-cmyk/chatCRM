import { randomUUID } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { clientIp, writeAudit } from "../../lib/audit";
import { withTenant } from "../../lib/db";
import { ah, badRequest, conflict, forbidden, notFound } from "../../lib/errors";
import { PERMISSIONS } from "../../lib/permissions";
import { removeFile } from "../../lib/storage";
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
import { sortDatasets, wipeBlocker, wipeDatasets, wipeFiles } from "./wipe";
import { MAX_IMPORT_ROWS, parseRows, type ImportPreview, type ParsedRow } from "./import";
import { contentDisposition, formatDate, readTable, writeCsv, writeHtml, writeXlsx } from "./tableFile";

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

/**
 * Имя приложенного файла по-человечески.
 *
 * В многочастной форме имя едет байтами в utf-8, а разбор формы отдаёт его
 * побайтово как latin1 — и «Заказы-2026-09-18.csv» превращается в
 * «Ð—Ð°ÐºÐ°Ð·Ñ‹-2026-09-18.csv». Сам файл при этом цел, испорчено только имя,
 * но человек видит на экране кракозябры и справедливо решает, что программа
 * не поняла его файл.
 *
 * Чиним только то, что действительно приехало побайтово: в такой строке нет
 * ни одного символа выше 0xFF, потому что каждый байт стал отдельным
 * символом. Имя, дошедшее целым, содержит кириллицу настоящими буквами — та
 * же починка превратила бы его в мусор, и это было бы хуже исходной беды.
 */
function originalName(raw: string): string {
  if (/[^\u0000-\u00ff]/.test(raw)) return raw;
  const fixed = Buffer.from(raw, "latin1").toString("utf8");
  return fixed.includes("\ufffd") ? raw : fixed;
}

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
  ah(async (req, res) => {
    // Сколько записей в каждом разделе. Нужны не для красоты: без них
    // «сотрём Заказы» — это обещание неизвестно чего, а «сотрём 4039
    // заказов» — то, на что человек действительно отвечает «да».
    const counts = await withTenant(tenantOf(req), async (tx) => {
      const [orders, customers, stock, services] = await Promise.all([
        tx.order.count({ where: { deletedAt: null } }),
        tx.customer.count({ where: { deletedAt: null } }),
        tx.stockItem.count(),
        tx.service.count(),
      ]);
      return { orders, customers, stock, services } as Record<DatasetKey, number>;
    });

    res.json({
      datasets: DATASET_KEYS.map((key) => ({
        key,
        title: DATASETS[key].title,
        hint: DATASETS[key].hint,
        matchBy: DATASETS[key].matchBy,
        count: counts[key] ?? 0,
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
      maxImportRows: MAX_IMPORT_ROWS,
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

    // Срок задаём явно и с запасом — как у загрузки. База мастерской, в
    // которой несколько тысяч заказов, собирается дольше пяти секунд, а
    // отведено по умолчанию именно пять: транзакция закрывалась изнутри, и
    // наружу выходила «Внутренняя ошибка», из которой причину не узнать.
    const sheets = await withTenant(
      tenantOf(req),
      async (tx) => {
        const built = await buildSheets(tx, keys);
        // Запись в журнал — в той же транзакции: вторая ради одной строки
        // означала бы второе соединение и второй набор задержек на ровном месте.
        await writeAudit(tx, {
          tenantId: tenantOf(req),
          userId: actorUserId(req),
          entity: "Data",
          entityId: keys.join(","),
          action: "EXPORT",
          diff: { format, rows: built.reduce((n, s) => n + s.rows.length, 0) },
          ip: clientIp(req),
        });
        return built;
      },
      { timeout: 5 * 60_000, maxWait: 30_000 }
    );

    const stamp = new Date().toISOString().slice(0, 10);
    // Человеку файл достаётся с русским именем, а в заголовок ответа
    // кириллица не пролезает вовсе — см. contentDisposition.
    const base = keys.length === 1 ? DATASETS[keys[0]].sheet.toLowerCase() : "finecrm";
    const asciiBase = keys.length === 1 ? keys[0] : "finecrm";
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

    res.setHeader("Content-Type", type);
    res.setHeader("Content-Disposition", contentDisposition(fileName, `${asciiBase}-${stamp}.${format}`));
    res.send(body);
  })
);

// ------------------------------------------------------------------ стирание

/**
 * Слово подтверждения. Не «да» и не галочка: набрать семь букв — это
 * действие, которое нельзя совершить мимоходом, а именно мимоходом и
 * случаются беды такого размера.
 */
const CONFIRM_WORD = "УДАЛИТЬ";

/**
 * Стирать базу может только владелец.
 *
 * Право «Настройки мастерской» дают и старшему приёмщику, чтобы он правил
 * статусы и бланки. Выгрузка и загрузка под ним же — они поправимы. Стирание
 * не поправимо ничем, и раздавать его вместе с бланками нельзя.
 */
function requireOwner(req: Request, _res: Response, next: NextFunction) {
  if (req.auth?.kind === "tenant" && req.auth.isOwner) return next();
  next(forbidden("Стирать базу может только владелец мастерской"));
}

const wipeSchema = z.object({
  datasets: z.array(z.string()).min(1),
  confirm: z.string(),
});

dataRouter.delete(
  "/",
  requireOwner,
  ah(async (req, res) => {
    const { datasets, confirm } = wipeSchema.parse(req.body);
    const keys = datasets.filter(isDatasetKey);
    if (keys.length === 0) throw badRequest("Не выбрано, что стирать");

    // Слово сверяем на сервере, а не только в окне: окно — это удобство, а
    // запрет должен стоять там, где его нельзя обойти.
    if (confirm.trim().toUpperCase() !== CONFIRM_WORD) {
      throw badRequest(`Слово не совпадает — стирание отменено. Нужно ввести ${CONFIRM_WORD}`);
    }

    const tenantId = tenantOf(req);
    const ordered = sortDatasets(keys);

    // Отказ — раньше первой удалённой строки.
    const blocker = await withTenant(tenantId, (tx) => wipeBlocker(tx, ordered));
    if (blocker) throw conflict(blocker);

    // Фотографии убираем до транзакции: хранилище — это сеть, и четыре
    // тысячи запросов к нему внутри транзакции держали бы её открытой всё
    // это время. Оборвётся на середине — строки ещё на месте, повторим.
    let files = 0;
    if (ordered.includes("orders")) {
      const objectKeys = await withTenant(tenantId, (tx) => wipeFiles(tx));
      for (const key of objectKeys) {
        try {
          await removeFile(key);
          files += 1;
        } catch {
          // Файла может уже не быть — это не повод останавливать стирание,
          // которое владелец затеял осознанно.
        }
      }
    }

    const wiped = await withTenant(
      tenantId,
      async (tx) => {
        const out = await wipeDatasets(tx, ordered);
        out.files = files;
        // Журнал пишем в той же транзакции: откатится стирание — уйдёт и
        // запись о нём, и в журнале не останется следа от того, чего не было.
        await writeAudit(tx, {
          tenantId,
          userId: actorUserId(req),
          entity: "Data",
          entityId: ordered.join(","),
          action: "DELETE",
          diff: { datasets: ordered, rows: out.rows, files: out.files },
          ip: clientIp(req),
        });
        return out;
      },
      // Стирание четырёх тысяч заказов в пять секунд не укладывается — как и
      // загрузка, ради которой этот срок однажды уже пришлось задавать.
      { timeout: 10 * 60_000, maxWait: 30_000 }
    );

    res.json({
      datasets: ordered,
      titles: ordered.map((k) => DATASETS[k].title),
      rows: wiped.rows,
      files: wiped.files,
      finishedAt: formatDate(new Date()),
    });
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
    const name = originalName(file.originalname);
    if (!/\.(xlsx|xlsm|csv|txt|tsv)$/i.test(name)) {
      throw badRequest("Понимаю только xlsx и csv. HTML читается глазами, но не загружается обратно");
    }

    const table = await readTable(file.buffer, name);
    if (table.length === 0) throw badRequest("Файл пустой");

    const tenantId = tenantOf(req);
    const { preview, rows } = await withTenant(
      tenantId,
      (tx) => parseRows(tx, dataset, table),
      // Разбор ничего не пишет, но на десяти тысячах строк успевает упереться
      // в тот же пятисекундный срок — и человек не поймёт, чем провинился файл.
      { timeout: 2 * 60_000, maxWait: 30_000 }
    );
    preview.fileName = name;

    if (preview.missingColumns.length) {
      // Дальше идти незачем: без обязательных колонок строки не разобрать.
      return res.json({ token: null, preview });
    }

    const token = putPending({
      tenantId,
      userId: actorUserId(req),
      dataset,
      fileName: name,
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

    // Загрузка пишет до десяти тысяч строк одной транзакцией, и пяти секунд,
    // которые Prisma даёт по умолчанию, ей не хватает даже на сотню. Десять
    // минут — с запасом к тому, что успевает записаться, пока человек ждёт
    // ответа; дольше него всё равно ждёт только nginx.
    const result = await withTenant(
      item.tenantId,
      (tx) => applyRows(tx, item.tenantId, item.dataset, item.rows, item.userId),
      { timeout: 10 * 60_000, maxWait: 30_000 }
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
          restored: result.restored,
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
