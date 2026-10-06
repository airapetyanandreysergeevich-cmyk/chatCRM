import { statfs } from "fs/promises";
import { Router, type Request } from "express";
import { z } from "zod";
import { prisma, withPlatform } from "../../lib/db";
import { ah, badRequest, conflict, forbidden, notFound } from "../../lib/errors";
import { monthKey } from "../../lib/usage";
import { relayHub } from "../relay/relay.instance";

/**
 * Панель собственника платформы: клиенты, их категории, оплата и расход
 * ресурсов облака.
 *
 * Клиенты бывают двух видов: облачная мастерская (Tenant — её база у нас) и
 * локальная (Box — база на компьютере мастерской, у нас только доступ из
 * интернета). Что внутри мастерских — заказы, клиенты, деньги — сюда не
 * попадает: собственнику видно, жив ли клиент, сколько он занимает и
 * заплатил ли, но не чем он занят.
 */

export const clientsRouter = Router();

/** «В сети» у облачной мастерской: кто-то работал последние пять минут. */
export const ONLINE_MS = 5 * 60_000;
const DAY = 24 * 60 * 60_000;

export const isOnline = (lastSeenAt: Date | null) => !!lastSeenAt && Date.now() - lastSeenAt.getTime() < ONLINE_MS;

function requireOwnerRole(req: Request) {
  if (req.auth?.kind !== "platform" || req.auth.role !== "OWNER") {
    throw forbidden("Цены и оплату меняет только собственник");
  }
}

// ---------------------------------------------------------------- категории

export async function defaultCategory() {
  return (
    (await prisma.clientCategory.findFirst({ where: { isDefault: true } })) ??
    (await prisma.clientCategory.findFirst({ orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] }))
  );
}

const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);

/** Лимиты категории — те поля мастерской, что она задаёт. */
const limitsOf = (c: { maxUsers: number; maxStorageMb: number; plateOcr: boolean }) => ({
  maxUsers: c.maxUsers,
  maxStorageMb: c.maxStorageMb,
  plateOcr: c.plateOcr,
});

/**
 * Новый клиент — в категорию по умолчанию, с её лимитами и пробным сроком.
 * Пробный срок 0 — срок оплаты не ставим: собственник поставит сам.
 */
export async function startTenant(tenantId: string) {
  const cat = await defaultCategory();
  if (!cat) return;
  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      categoryId: cat.id,
      ...limitsOf(cat),
      customLimits: false,
      paidUntil: cat.trialDays > 0 ? addDays(new Date(), cat.trialDays) : null,
    },
  });
}

export async function startBox(boxId: string) {
  const cat = await defaultCategory();
  if (!cat) return;
  await prisma.box.update({
    where: { id: boxId },
    data: { categoryId: cat.id, paidUntil: cat.trialDays > 0 ? addDays(new Date(), cat.trialDays) : null },
  });
}

/** Условия категории — всем её мастерским, кроме тех, кому лимиты ставили руками. */
export async function spreadLimits(categoryId: string) {
  const cat = await prisma.clientCategory.findUnique({ where: { id: categoryId } });
  if (!cat) return;
  await prisma.tenant.updateMany({ where: { categoryId, customLimits: false }, data: limitsOf(cat) });
}

const categorySchema = z.object({
  name: z.string().trim().min(2, "Название от 2 знаков").max(40),
  color: z.string().trim().max(20).default("blue"),
  note: z.string().trim().max(300).optional().nullable(),
  cloudPrice: z.number().int().min(0).max(1_000_000),
  remotePrice: z.number().int().min(0).max(1_000_000),
  trialDays: z.number().int().min(0).max(365),
  maxUsers: z.number().int().min(1).max(500),
  maxStorageMb: z.number().int().min(0).max(10_000_000),
  plateOcr: z.boolean(),
  showAds: z.boolean(),
  isDefault: z.boolean().optional(),
});

clientsRouter.get(
  "/categories",
  ah(async (_req, res) => {
    const cats = await prisma.clientCategory.findMany({
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      include: { _count: { select: { tenants: { where: { deletedAt: null } }, boxes: true } } },
    });
    res.json(
      cats.map(({ _count, ...c }) => ({ ...c, tenantCount: _count.tenants, boxCount: _count.boxes }))
    );
  })
);

clientsRouter.post(
  "/categories",
  ah(async (req, res) => {
    requireOwnerRole(req);
    const body = categorySchema.parse(req.body);
    if (await prisma.clientCategory.findUnique({ where: { name: body.name } })) {
      throw conflict("Категория с таким названием уже есть");
    }
    const last = await prisma.clientCategory.aggregate({ _max: { sortOrder: true } });
    const cat = await prisma.$transaction(async (tx) => {
      if (body.isDefault) await tx.clientCategory.updateMany({ data: { isDefault: false } });
      return tx.clientCategory.create({ data: { ...body, sortOrder: (last._max.sortOrder ?? 0) + 1 } });
    });
    res.status(201).json(cat);
  })
);

clientsRouter.patch(
  "/categories/:id",
  ah(async (req, res) => {
    requireOwnerRole(req);
    const body = categorySchema.partial().parse(req.body);
    const cat = await prisma.clientCategory.findUnique({ where: { id: req.params.id } });
    if (!cat) throw notFound("Категория не найдена");
    if (body.name && body.name !== cat.name && (await prisma.clientCategory.findUnique({ where: { name: body.name } }))) {
      throw conflict("Категория с таким названием уже есть");
    }
    // Категория по умолчанию нужна всегда: снять отметку можно, только
    // поставив её другой категории.
    if (body.isDefault === false && cat.isDefault) throw badRequest("Отметьте «для новых» другую категорию — эта снимется сама");
    const next = await prisma.$transaction(async (tx) => {
      if (body.isDefault) await tx.clientCategory.updateMany({ where: { id: { not: cat.id } }, data: { isDefault: false } });
      return tx.clientCategory.update({ where: { id: cat.id }, data: body });
    });
    await spreadLimits(cat.id);
    res.json(next);
  })
);

/** Удалить категорию: её клиенты переходят в категорию по умолчанию. */
clientsRouter.delete(
  "/categories/:id",
  ah(async (req, res) => {
    requireOwnerRole(req);
    const cat = await prisma.clientCategory.findUnique({ where: { id: req.params.id } });
    if (!cat) throw notFound("Категория не найдена");
    if (cat.isDefault) throw badRequest("В эту категорию попадают новые клиенты — сначала отметьте для них другую");
    const fallback = await defaultCategory();
    await prisma.$transaction([
      prisma.tenant.updateMany({ where: { categoryId: cat.id }, data: { categoryId: fallback?.id ?? null } }),
      prisma.box.updateMany({ where: { categoryId: cat.id }, data: { categoryId: fallback?.id ?? null } }),
      prisma.clientCategory.delete({ where: { id: cat.id } }),
    ]);
    if (fallback) await spreadLimits(fallback.id);
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------- оплата

const paymentSchema = z
  .object({
    tenantId: z.string().optional(),
    boxId: z.string().optional(),
    amount: z.number().int().min(0).max(10_000_000),
    /** Продлить на столько месяцев — от сегодня или от прежнего срока, что позже. */
    months: z.number().int().min(1).max(36).optional(),
    /** Или прямо до этого дня: «2026-12-31». */
    until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    note: z.string().trim().max(300).optional(),
  })
  .refine((b) => !!b.tenantId !== !!b.boxId, { message: "Укажите одного клиента" })
  .refine((b) => !!b.months || !!b.until, { message: "Укажите, на сколько месяцев или до какого дня", path: ["months"] });

function addMonths(from: Date, months: number): Date {
  const d = new Date(from);
  const day = d.getDate();
  d.setMonth(d.getMonth() + months);
  // 31 января + месяц — это 28 февраля, а не 3 марта.
  if (d.getDate() < day) d.setDate(0);
  return d;
}

/** Конец дня по Москве: «оплачено до 12 ноября» включает 12 ноября. */
const endOfDayMsk = (iso: string) => new Date(`${iso}T23:59:59+03:00`);

clientsRouter.post(
  "/payments",
  ah(async (req, res) => {
    requireOwnerRole(req);
    const body = paymentSchema.parse(req.body);
    const client = body.tenantId
      ? await prisma.tenant.findUnique({ where: { id: body.tenantId }, select: { id: true, name: true, paidUntil: true } })
      : await prisma.box.findUnique({ where: { id: body.boxId! }, select: { id: true, name: true, email: true, paidUntil: true } });
    if (!client) throw notFound("Клиент не найден");

    const now = new Date();
    const base = client.paidUntil && client.paidUntil > now ? client.paidUntil : now;
    const paidUntil = body.until ? endOfDayMsk(body.until) : addMonths(base, body.months!);
    const clientName =
      "email" in client ? (client.name ? `${client.name} (${client.email})` : client.email) : client.name;

    const payment = await prisma.$transaction(async (tx) => {
      const row = await tx.clientPayment.create({
        data: {
          tenantId: body.tenantId ?? null,
          boxId: body.boxId ?? null,
          clientName,
          amount: body.amount,
          months: body.months ?? null,
          paidUntil,
          prevPaidUntil: client.paidUntil,
          note: body.note || null,
          createdById: req.auth?.kind === "platform" ? req.auth.platformUserId : null,
        },
      });
      if (body.tenantId) await tx.tenant.update({ where: { id: body.tenantId }, data: { paidUntil } });
      else await tx.box.update({ where: { id: body.boxId! }, data: { paidUntil } });
      return row;
    });
    res.status(201).json(payment);
  })
);

clientsRouter.get(
  "/payments",
  ah(async (req, res) => {
    const q = z.object({ tenantId: z.string().optional(), boxId: z.string().optional() }).parse(req.query);
    const rows = await prisma.clientPayment.findMany({
      where: q.tenantId ? { tenantId: q.tenantId } : q.boxId ? { boxId: q.boxId } : {},
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    res.json(rows);
  })
);

/**
 * Убрать ошибочную оплату. Срок откатывается к прежнему, только если это
 * последняя оплата клиента — иначе поверх неё уже продлевали.
 */
clientsRouter.delete(
  "/payments/:id",
  ah(async (req, res) => {
    requireOwnerRole(req);
    const p = await prisma.clientPayment.findUnique({ where: { id: req.params.id } });
    if (!p) throw notFound("Оплата не найдена");
    const where = p.tenantId ? { tenantId: p.tenantId } : p.boxId ? { boxId: p.boxId } : null;
    const latest = where ? await prisma.clientPayment.findFirst({ where, orderBy: { createdAt: "desc" } }) : null;
    await prisma.$transaction(async (tx) => {
      await tx.clientPayment.delete({ where: { id: p.id } });
      if (latest?.id !== p.id) return;
      if (p.tenantId) await tx.tenant.update({ where: { id: p.tenantId }, data: { paidUntil: p.prevPaidUntil } });
      else if (p.boxId) await tx.box.update({ where: { id: p.boxId }, data: { paidUntil: p.prevPaidUntil } });
    });
    res.json({ ok: true, reverted: latest?.id === p.id });
  })
);

// ---------------------------------------------------------------- расход

/** Байты фотографий по мастерским — одним запросом на всех. */
export async function storageByTenant(): Promise<Map<string, number>> {
  const rows = await withPlatform((tx) =>
    tx.attachment.groupBy({ by: ["tenantId"], _sum: { sizeBytes: true } })
  );
  return new Map(rows.map((r) => [r.tenantId, r._sum.sizeBytes ?? 0]));
}

/** Счётчики месяца: по субъекту ("t:id", "b:id"). */
export async function usageThisMonth(): Promise<Map<string, { plateOcr: number; relayBytes: number; relayRequests: number }>> {
  const rows = await prisma.usageMonth.findMany({ where: { month: monthKey() } });
  return new Map(
    rows.map((r) => [r.subject, { plateOcr: r.plateOcr, relayBytes: Number(r.relayBytes), relayRequests: r.relayRequests }])
  );
}

async function diskInfo(): Promise<{ totalBytes: number; freeBytes: number } | null> {
  try {
    const s = await statfs("/");
    return { totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize };
  } catch {
    return null;
  }
}

/** Последние 12 месяцев: ключи "2025-11" … "2026-10". */
function lastMonths(n = 12): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) out.push(monthKey(new Date(now.getFullYear(), now.getMonth() - i, 15)));
  return out;
}

type Activity = "online" | "day" | "week" | "month" | "long" | "never";
function activityOf(online: boolean, lastSeenAt: Date | null): Activity {
  if (online) return "online";
  if (!lastSeenAt) return "never";
  const ago = Date.now() - lastSeenAt.getTime();
  if (ago < DAY) return "day";
  if (ago < 7 * DAY) return "week";
  if (ago < 30 * DAY) return "month";
  return "long";
}

type Pay = "paid" | "soon" | "overdue" | "none" | "free";
/** Что с оплатой: «скоро» — меньше недели. Бесплатным срок не нужен. */
export function payStateOf(paidUntil: Date | null, price: number): Pay {
  if (price <= 0) return "free";
  if (!paidUntil) return "none";
  const left = paidUntil.getTime() - Date.now();
  if (left < 0) return "overdue";
  if (left < 7 * DAY) return "soon";
  return "paid";
}

clientsRouter.get(
  "/overview",
  ah(async (_req, res) => {
    const [tenants, boxes, cats, storage, usage, payments, disk, users] = await Promise.all([
      prisma.tenant.findMany({
        where: { deletedAt: null },
        select: {
          id: true, name: true, slug: true, status: true, createdAt: true, lastSeenAt: true, paidUntil: true,
          price: true, categoryId: true, maxStorageMb: true,
        },
      }),
      prisma.box.findMany({
        select: { id: true, code: true, name: true, email: true, isActive: true, createdAt: true, lastSeenAt: true, paidUntil: true, price: true, categoryId: true },
      }),
      prisma.clientCategory.findMany({ orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] }),
      storageByTenant(),
      usageThisMonth(),
      prisma.clientPayment.findMany({
        where: { createdAt: { gte: new Date(new Date().getFullYear() - 1, new Date().getMonth(), 1) } },
        select: { amount: true, createdAt: true },
      }),
      diskInfo(),
      withPlatform((tx) => tx.user.groupBy({ by: ["tenantId"], _count: { _all: true }, where: { deletedAt: null } })),
    ]);
    const hub = relayHub();
    const catBy = new Map(cats.map((c) => [c.id, c]));
    const months = lastMonths();

    const cloud = tenants.map((t) => {
      const cat = t.categoryId ? catBy.get(t.categoryId) : undefined;
      const price = t.price ?? cat?.cloudPrice ?? 0;
      const online = isOnline(t.lastSeenAt);
      return {
        kind: "cloud" as const,
        id: t.id,
        name: t.name,
        sub: t.slug,
        categoryId: t.categoryId,
        price,
        paidUntil: t.paidUntil,
        pay: payStateOf(t.paidUntil, price),
        online,
        activity: activityOf(online, t.lastSeenAt),
        lastSeenAt: t.lastSeenAt,
        createdAt: t.createdAt,
        storageBytes: storage.get(t.id) ?? 0,
        maxStorageMb: t.maxStorageMb,
      };
    });
    const local = boxes.map((b) => {
      const cat = b.categoryId ? catBy.get(b.categoryId) : undefined;
      const price = b.price ?? cat?.remotePrice ?? 0;
      const online = hub?.online(b.code) ?? false;
      return {
        kind: "local" as const,
        id: b.id,
        isActive: b.isActive,
        name: b.name ?? b.email,
        sub: b.name ? b.email : b.code,
        categoryId: b.categoryId,
        price,
        paidUntil: b.paidUntil,
        pay: b.isActive ? payStateOf(b.paidUntil, price) : ("free" as Pay),
        online,
        activity: activityOf(online, b.lastSeenAt),
        lastSeenAt: b.lastSeenAt,
        createdAt: b.createdAt,
      };
    });
    const all = [...cloud, ...local];

    const byMonth = (dates: Date[]) => {
      const m = new Map(months.map((k) => [k, 0]));
      for (const d of dates) {
        const k = monthKey(d);
        if (m.has(k)) m.set(k, m.get(k)! + 1);
      }
      return months.map((k) => m.get(k)!);
    };
    const income = new Map(months.map((k) => [k, 0]));
    for (const p of payments) {
      const k = monthKey(p.createdAt);
      if (income.has(k)) income.set(k, income.get(k)! + p.amount);
    }

    let ocr = 0, relayBytes = 0, relayRequests = 0;
    for (const [subject, u] of usage) {
      if (subject.startsWith("t:")) ocr += u.plateOcr;
      relayBytes += u.relayBytes;
      relayRequests += u.relayRequests;
    }

    const storageUsed = cloud.reduce((a, t) => a + t.storageBytes, 0);
    const storageLimit = cloud.reduce((a, t) => a + Math.max(0, t.maxStorageMb), 0) * 1024 * 1024;
    // Сколько приносят в месяц: цена всех, у кого она есть и доступ не выключен.
    const monthly = cloud.reduce((a, t) => a + t.price, 0) + local.filter((b) => b.isActive).reduce((a, b) => a + b.price, 0);

    res.json({
      months,
      counts: {
        cloud: cloud.length,
        local: local.length,
        localActive: boxes.filter((b) => b.isActive).length,
        onlineCloud: cloud.filter((c) => c.online).length,
        onlineLocal: local.filter((c) => c.online).length,
        users: users.reduce((a, u) => a + u._count._all, 0),
      },
      money: {
        monthly,
        income: months.map((k) => income.get(k)!),
        thisMonth: income.get(months[months.length - 1]) ?? 0,
      },
      pay: {
        paid: all.filter((c) => c.pay === "paid").length,
        soon: all.filter((c) => c.pay === "soon").length,
        overdue: all.filter((c) => c.pay === "overdue").length,
        none: all.filter((c) => c.pay === "none").length,
        free: all.filter((c) => c.pay === "free").length,
      },
      growth: {
        cloud: byMonth(tenants.map((t) => t.createdAt)),
        local: byMonth(boxes.map((b) => b.createdAt)),
      },
      categories: cats.map((c) => ({
        id: c.id,
        name: c.name,
        color: c.color,
        cloud: cloud.filter((t) => t.categoryId === c.id).length,
        local: local.filter((b) => b.categoryId === c.id).length,
      })),
      activity: (["online", "day", "week", "month", "long", "never"] as Activity[]).map((a) => ({
        id: a,
        cloud: cloud.filter((c) => c.activity === a).length,
        local: local.filter((c) => c.activity === a).length,
      })),
      storage: {
        usedBytes: storageUsed,
        limitBytes: storageLimit,
        disk,
        top: [...cloud]
          .sort((a, b) => b.storageBytes - a.storageBytes)
          .slice(0, 8)
          .map((t) => ({ id: t.id, name: t.name, bytes: t.storageBytes, limitMb: t.maxStorageMb })),
      },
      usage: { month: monthKey(), plateOcr: ocr, relayBytes, relayRequests },
      // Кому платить: просрочено и меньше недели — сначала самые срочные.
      due: all
        .filter((c) => c.pay === "overdue" || c.pay === "soon" || c.pay === "none")
        .sort((a, b) => (a.paidUntil?.getTime() ?? 0) - (b.paidUntil?.getTime() ?? 0))
        .slice(0, 30)
        .map((c) => ({ kind: c.kind, id: c.id, name: c.name, sub: c.sub, price: c.price, paidUntil: c.paidUntil, pay: c.pay, categoryId: c.categoryId })),
      // Кто в сети сейчас и кто заходил недавно.
      recent: all
        .filter((c) => c.lastSeenAt || c.online)
        .sort((a, b) => Number(b.online) - Number(a.online) || (b.lastSeenAt?.getTime() ?? 0) - (a.lastSeenAt?.getTime() ?? 0))
        .slice(0, 12)
        .map((c) => ({ kind: c.kind, id: c.id, name: c.name, sub: c.sub, online: c.online, lastSeenAt: c.lastSeenAt, categoryId: c.categoryId })),
    });
  })
);

/** Для значка в меню: сколько клиентов пора продлить. */
export async function dueCount(): Promise<number> {
  const cats = await prisma.clientCategory.findMany({ select: { id: true, cloudPrice: true, remotePrice: true } });
  const catBy = new Map(cats.map((c) => [c.id, c]));
  const soon = new Date(Date.now() + 7 * DAY);
  const [tenants, boxes] = await Promise.all([
    prisma.tenant.findMany({ where: { deletedAt: null, OR: [{ paidUntil: null }, { paidUntil: { lt: soon } }] }, select: { price: true, categoryId: true, paidUntil: true } }),
    prisma.box.findMany({ where: { isActive: true, OR: [{ paidUntil: null }, { paidUntil: { lt: soon } }] }, select: { price: true, categoryId: true, paidUntil: true } }),
  ]);
  const n1 = tenants.filter((t) => (t.price ?? catBy.get(t.categoryId ?? "")?.cloudPrice ?? 0) > 0 && t.paidUntil).length;
  const n2 = boxes.filter((b) => (b.price ?? catBy.get(b.categoryId ?? "")?.remotePrice ?? 0) > 0 && b.paidUntil).length;
  return n1 + n2;
}
