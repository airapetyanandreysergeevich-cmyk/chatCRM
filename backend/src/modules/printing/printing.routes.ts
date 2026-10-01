import { Prisma } from "@prisma/client";
import { Router, type Request } from "express";
import { z } from "zod";
import { withTenant } from "../../lib/db";
import { AppError, ah, badRequest, conflict, forbidden, notFound } from "../../lib/errors";
import { PERMISSIONS } from "../../lib/permissions";
import { actorUserId, authenticate, currentTenantId, permissionsOf, requireTenant } from "../../middleware/auth";
import { enforceTenantStatus } from "../../middleware/tenantStatus";
import { assertOrderAccess } from "../orders/orders.service";

/**
 * Печать через CRM.
 *
 * Телефон и браузер сами выбрать принтер и печатать молча не умеют. Поэтому
 * печатает компьютер мастерской с программой FineCRM: программа сообщает
 * серверу, какие принтеры видит её Windows (станция печати), и забирает
 * задания. Кто угодно — с телефона, из браузера, из программы — нажимает
 * «Печать», задание встаёт в очередь своей станции, станция печатает и
 * отвечает «напечатано» или «нет бумаги».
 *
 * Принтер мастерской назначает администратор (право «Настройки мастерской»),
 * он общий по умолчанию. Сотрудник может выбрать себе свой — это его личная
 * настройка, у остальных ничего не меняется.
 *
 * Станция забирает задания «долгим опросом»: запрос висит до 25 секунд и
 * возвращается сразу, как только появилось задание. Так печать начинается
 * через секунду после нажатия, а постоянного соединения держать не нужно —
 * ни в облаке, ни через узел связи Основы.
 */

export const printingRouter = Router();
printingRouter.use(authenticate, requireTenant, enforceTenantStatus);

const tenantOf = (req: Request) => currentTenantId(req)!;
const has = (req: Request, code: string) => permissionsOf(req).includes(code);

/** Станция на связи, если отзывалась за это время (опрос — каждые 25 секунд). */
export const ONLINE_MS = 75_000;
/** Задание никто не забрал — компьютер выключен или программа закрыта. */
export const QUEUE_TTL_MS = 90_000;
/** Забрали, но не ответили — программа упала посреди печати. */
export const SENT_TTL_MS = 150_000;
const LONG_POLL_MAX_S = 25;

const target = z.object({
  stationId: z.string().uuid(),
  printer: z.string().trim().min(1).max(200),
  copies: z.number().int().min(1).max(2).default(1),
});
type Target = z.infer<typeof target>;

const INTAKE_MODES = ["ask", "auto", "off"] as const;
type IntakeMode = (typeof INTAKE_MODES)[number];

interface PrintPrefs {
  documents?: Target | null;
  intake?: IntakeMode;
}

const readTarget = (v: unknown): Target | null => {
  const r = target.safeParse(v);
  return r.success ? r.data : null;
};
const readPrefs = (v: unknown): PrintPrefs => {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return {
    documents: readTarget(o.documents),
    intake: INTAKE_MODES.includes(o.intake as IntakeMode) ? (o.intake as IntakeMode) : "ask",
  };
};
const workshopTarget = (settings: unknown): Target | null => {
  const s = (settings && typeof settings === "object" ? settings : {}) as Record<string, unknown>;
  const p = (s.printing && typeof s.printing === "object" ? s.printing : {}) as Record<string, unknown>;
  return readTarget(p.documents);
};

interface PrinterInfo {
  name: string;
  displayName: string;
  isDefault: boolean;
}
const printersOf = (v: unknown): PrinterInfo[] =>
  Array.isArray(v)
    ? v
        .filter((p): p is Record<string, unknown> => !!p && typeof p === "object" && typeof (p as { name?: unknown }).name === "string")
        .map((p) => ({
          name: String(p.name),
          displayName: typeof p.displayName === "string" && p.displayName ? p.displayName : String(p.name),
          isDefault: p.isDefault === true,
        }))
    : [];

type Station = { id: string; name: string; printers: Prisma.JsonValue; lastSeenAt: Date };
const isOnline = (s: { lastSeenAt: Date }, now = Date.now()) => now - s.lastSeenAt.getTime() < ONLINE_MS;

/** Назначение в том виде, в каком его показывает интерфейс. */
function view(t: Target | null, stations: Map<string, Station>) {
  if (!t) return null;
  const st = stations.get(t.stationId);
  const printer = st ? printersOf(st.printers).find((p) => p.name === t.printer) : undefined;
  return {
    ...t,
    stationName: st?.name ?? null,
    printerLabel: printer?.displayName ?? t.printer,
    /** Компьютер убран из списка — назначение надо поменять. */
    stationGone: !st,
    /** Windows этого компьютера больше не видит такой принтер. */
    printerGone: !!st && !printer,
    online: !!st && isOnline(st),
  };
}

/** Просроченные задания — в «не получилось», с понятной причиной. */
async function expire(tx: Prisma.TransactionClient, stationId?: string) {
  const now = Date.now();
  await tx.printJob.updateMany({
    where: { status: "QUEUED", createdAt: { lt: new Date(now - QUEUE_TTL_MS) }, ...(stationId ? { stationId } : {}) },
    data: { status: "FAILED", error: "Компьютер с принтером не забрал задание: он выключен или программа FineCRM на нём закрыта" },
  });
  await tx.printJob.updateMany({
    where: { status: "SENT", updatedAt: { lt: new Date(now - SENT_TTL_MS) }, ...(stationId ? { stationId } : {}) },
    data: { status: "FAILED", error: "Компьютер с принтером не сообщил, напечатано ли — проверьте принтер" },
  });
}

// ------------------------------------------------------------ обзор и настройки

printingRouter.get(
  "/",
  ah(async (req, res) => {
    const tenantId = tenantOf(req);
    const me = actorUserId(req);
    const out = await withTenant(tenantId, async (tx) => {
      const [tenant, list, user] = await Promise.all([
        tx.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } }),
        tx.printStation.findMany({ orderBy: { name: "asc" } }),
        me ? tx.user.findFirst({ where: { id: me }, select: { printPrefs: true } }) : null,
      ]);
      const stations = new Map(list.map((s) => [s.id, s]));
      const prefs = readPrefs(user?.printPrefs);
      const workshop = view(workshopTarget(tenant?.settings), stations);
      const mine = view(prefs.documents ?? null, stations);
      const now = Date.now();
      return {
        stations: list.map((s) => ({
          id: s.id,
          name: s.name,
          online: isOnline(s, now),
          lastSeenAt: s.lastSeenAt,
          printers: printersOf(s.printers),
        })),
        workshop,
        mine,
        effective: mine ? { ...mine, source: "mine" as const } : workshop ? { ...workshop, source: "workshop" as const } : null,
        intake: prefs.intake ?? "ask",
        canManage: has(req, PERMISSIONS.SETTINGS_MANAGE),
        personal: !!me,
      };
    });
    res.json(out);
  })
);

/** Есть ли такой компьютер у мастерской — чужой номер не назначить. */
async function assertStation(tx: Prisma.TransactionClient, t: Target | null) {
  if (!t) return;
  const st = await tx.printStation.findFirst({ where: { id: t.stationId }, select: { id: true } });
  if (!st) throw badRequest("Такого компьютера с принтерами нет — обновите список");
}

printingRouter.put(
  "/workshop",
  ah(async (req, res) => {
    if (!has(req, PERMISSIONS.SETTINGS_MANAGE)) throw forbidden("Общий принтер назначает администратор мастерской");
    const body = z.object({ documents: target.nullable() }).parse(req.body);
    const tenantId = tenantOf(req);
    await withTenant(tenantId, async (tx) => {
      await assertStation(tx, body.documents);
      const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } });
      const settings = (tenant?.settings && typeof tenant.settings === "object" ? tenant.settings : {}) as Record<string, unknown>;
      const printing = (settings.printing && typeof settings.printing === "object" ? settings.printing : {}) as Record<string, unknown>;
      await tx.tenant.update({
        where: { id: tenantId },
        data: { settings: { ...settings, printing: { ...printing, documents: body.documents } } as Prisma.InputJsonObject },
      });
    });
    res.json({ ok: true });
  })
);

printingRouter.put(
  "/mine",
  ah(async (req, res) => {
    const me = actorUserId(req);
    if (!me) throw badRequest("Своя настройка — у сотрудника мастерской");
    const body = z
      .object({ documents: target.nullable().optional(), intake: z.enum(INTAKE_MODES).optional() })
      .parse(req.body);
    await withTenant(tenantOf(req), async (tx) => {
      if (body.documents) await assertStation(tx, body.documents);
      const user = await tx.user.findFirst({ where: { id: me }, select: { printPrefs: true } });
      const prefs = readPrefs(user?.printPrefs);
      const next: PrintPrefs = {
        documents: body.documents === undefined ? (prefs.documents ?? null) : body.documents,
        intake: body.intake ?? prefs.intake ?? "ask",
      };
      await tx.user.update({ where: { id: me }, data: { printPrefs: next as unknown as Prisma.InputJsonObject } });
    });
    res.json({ ok: true });
  })
);

// ------------------------------------------------------------ задания

const jobView = (j: { id: string; status: string; error: string | null; printerName: string; copies: number }, station: { name: string } | null) => ({
  id: j.id,
  status: j.status,
  error: j.error,
  printer: j.printerName,
  copies: j.copies,
  station: station?.name ?? null,
});

printingRouter.post(
  "/jobs",
  ah(async (req, res) => {
    const body = z
      .object({
        doc: z.enum(["intake", "act", "test"]),
        orderId: z.string().uuid().optional(),
        stationId: z.string().uuid().optional(),
        printer: z.string().trim().min(1).max(200).optional(),
        copies: z.number().int().min(1).max(2).optional(),
      })
      .parse(req.body);
    if (body.doc !== "test" && !body.orderId) throw badRequest("Не указан заказ");
    if (body.doc === "test" && !(body.stationId && body.printer)) throw badRequest("Не указан принтер");

    const tenantId = tenantOf(req);
    const me = actorUserId(req);
    const job = await withTenant(tenantId, async (tx) => {
      if (body.orderId) {
        const order = await tx.order.findFirst({
          where: { id: body.orderId, deletedAt: null },
          select: { id: true, assignedMasterId: true },
        });
        if (!order) throw notFound("Заказ не найден");
        assertOrderAccess(req, order);
      }

      // Куда: явно указанный принтер → свой → общий мастерской.
      let t: Target | null = null;
      if (body.stationId && body.printer) {
        t = { stationId: body.stationId, printer: body.printer, copies: body.copies ?? 1 };
      } else {
        const [user, tenant] = await Promise.all([
          me ? tx.user.findFirst({ where: { id: me }, select: { printPrefs: true } }) : null,
          tx.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } }),
        ]);
        t = readPrefs(user?.printPrefs).documents ?? workshopTarget(tenant?.settings);
      }
      if (!t) {
        throw new AppError(409, "Принтер не назначен. Его выбирают в «Настройки → Периферия»", "no-printer");
      }

      const station = await tx.printStation.findFirst({ where: { id: t.stationId } });
      if (!station) throw new AppError(409, "Компьютер с принтером убран из списка — назначьте принтер заново", "no-printer");
      if (!isOnline(station)) {
        throw new AppError(
          409,
          `Компьютер «${station.name}» с принтером сейчас не на связи: он выключен или программа FineCRM на нём закрыта`,
          "offline"
        );
      }

      const created = await tx.printJob.create({
        data: {
          tenantId,
          stationId: station.id,
          printerName: t.printer,
          doc: body.doc,
          orderId: body.orderId ?? null,
          copies: body.doc === "test" ? 1 : (body.copies ?? t.copies ?? 1),
          createdById: me,
        },
      });
      return jobView(created, station);
    });
    res.status(201).json(job);
  })
);

printingRouter.get(
  "/jobs/:id",
  ah(async (req, res) => {
    const out = await withTenant(tenantOf(req), async (tx) => {
      await expire(tx);
      const j = await tx.printJob.findFirst({ where: { id: req.params.id }, include: { station: { select: { name: true } } } });
      if (!j) throw notFound("Задание печати не найдено");
      return jobView(j, j.station);
    });
    res.json(out);
  })
);

// ------------------------------------------------------------ станция печати (программа FineCRM)

printingRouter.post(
  "/stations",
  ah(async (req, res) => {
    const body = z
      .object({
        deviceId: z.string().trim().min(8).max(80),
        name: z.string().trim().min(1).max(80),
        printers: z
          .array(
            z.object({
              name: z.string().min(1).max(200),
              displayName: z.string().max(200).optional(),
              isDefault: z.boolean().optional(),
            })
          )
          .max(60),
      })
      .parse(req.body);
    const tenantId = tenantOf(req);
    const printers = body.printers.map((p) => ({ name: p.name, displayName: p.displayName || p.name, isDefault: !!p.isDefault }));
    const st = await withTenant(tenantId, (tx) =>
      tx.printStation.upsert({
        where: { tenantId_deviceId: { tenantId, deviceId: body.deviceId } },
        create: { tenantId, deviceId: body.deviceId, name: body.name, printers, lastSeenAt: new Date() },
        update: { name: body.name, printers, lastSeenAt: new Date() },
        select: { id: true },
      })
    );
    res.json({ id: st.id });
  })
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Следующее задание станции. Висит до wait секунд; отдаёт задание сразу,
 * как оно появилось. Задание помечается «отправлено» условным обновлением —
 * две копии программы на одном номере не напечатают его дважды.
 */
printingRouter.get(
  "/stations/:id/next",
  ah(async (req, res) => {
    const wait = Math.min(LONG_POLL_MAX_S, Math.max(0, Number(req.query.wait) || 0));
    const tenantId = tenantOf(req);
    const stationId = req.params.id;
    // Программа закрылась посреди ожидания — дальше не ждём и не отмечаем
    // компьютер «на связи».
    let gone = false;
    res.on("close", () => {
      if (!res.writableEnded) gone = true;
    });
    const deadline = Date.now() + wait * 1000;

    for (;;) {
      if (gone) return;
      const job = await withTenant(tenantId, async (tx) => {
        const touched = await tx.printStation.updateMany({ where: { id: stationId }, data: { lastSeenAt: new Date() } });
        if (touched.count === 0) throw notFound("Компьютер не найден — программа зарегистрирует его заново");
        await expire(tx, stationId);
        const next = await tx.printJob.findFirst({
          where: { stationId, status: "QUEUED" },
          orderBy: { createdAt: "asc" },
        });
        if (!next) return null;
        const claimed = await tx.printJob.updateMany({ where: { id: next.id, status: "QUEUED" }, data: { status: "SENT" } });
        return claimed.count === 1 ? next : null;
      });
      if (job) {
        return res.json({
          job: { id: job.id, doc: job.doc, orderId: job.orderId, printer: job.printerName, copies: job.copies },
        });
      }
      if (gone || Date.now() >= deadline) return res.json({ job: null });
      await sleep(1000);
    }
  })
);

printingRouter.post(
  "/jobs/:id/result",
  ah(async (req, res) => {
    const body = z.object({ ok: z.boolean(), error: z.string().trim().max(500).optional() }).parse(req.body);
    await withTenant(tenantOf(req), (tx) =>
      tx.printJob.updateMany({
        where: { id: req.params.id, status: "SENT" },
        data: body.ok ? { status: "DONE", error: null } : { status: "FAILED", error: body.error || "Принтер не напечатал" },
      })
    );
    res.json({ ok: true });
  })
);

/** Убрать компьютер, которого больше нет (продали, переустановили Windows). */
printingRouter.delete(
  "/stations/:id",
  ah(async (req, res) => {
    if (!has(req, PERMISSIONS.SETTINGS_MANAGE)) throw forbidden("Убирать компьютеры может администратор мастерской");
    await withTenant(tenantOf(req), async (tx) => {
      const st = await tx.printStation.findFirst({ where: { id: req.params.id } });
      if (!st) throw notFound("Компьютер не найден");
      if (isOnline(st)) throw conflict("Компьютер на связи — его программа сразу появится снова. Сначала закройте FineCRM на нём");
      await tx.printJob.deleteMany({ where: { stationId: st.id } });
      await tx.printStation.delete({ where: { id: st.id } });
    });
    res.json({ ok: true });
  })
);
