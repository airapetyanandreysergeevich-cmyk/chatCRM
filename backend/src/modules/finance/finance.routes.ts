import type { Prisma } from "@prisma/client";
import { Router, type Request } from "express";
import { z } from "zod";
import { clientIp, writeAudit } from "../../lib/audit";
import { withTenant } from "../../lib/db";
import { ah, badRequest, forbidden, notFound } from "../../lib/errors";
import { PERMISSIONS } from "../../lib/permissions";
import {
  actorUserId,
  authenticate,
  currentTenantId,
  permissionsOf,
  requirePermission,
  requireTenant,
} from "../../middleware/auth";
import { enforceTenantStatus } from "../../middleware/tenantStatus";

/**
 * Касса и деньги.
 *
 * Раздел отвечает на один вопрос: сколько сейчас в кассе и откуда это
 * взялось. Поэтому здесь нет «изменить сумму» и нет удаления задним числом:
 * ошибочную запись гасят обратной, и обе остаются видны. Касса, в которой
 * можно молча поправить вчерашнюю цифру, не касса, а блокнот.
 *
 * Это учёт для владельца, а не фискальный. Онлайн-касса по 54-ФЗ живёт
 * своей жизнью и по своим правилам — мешать их в одну таблицу нельзя,
 * поэтому здесь честно считается только движение денег мастерской.
 */

export const financeRouter = Router();
financeRouter.use(authenticate, requireTenant, enforceTenantStatus);

const tenantOf = (req: Request) => currentTenantId(req)!;
const has = (req: Request, code: string) => permissionsOf(req).includes(code);

const num = (v: Prisma.Decimal | number | null | undefined): number =>
  v === null || v === undefined ? 0 : Number(v);

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

const daysAgo = (n: number) => {
  const d = startOfToday();
  d.setDate(d.getDate() - n);
  return d;
};

/**
 * tenantId в data пишем явно, хотя прокси из lib/db его тоже подставит:
 * прокси работает в рантайме, а типы Prisma требуют поле на этапе сборки.
 */

/**
 * Касса по умолчанию: мастерская, которая ещё не заводила кассы, всё равно
 * должна суметь принять оплату за первый ремонт.
 */
async function defaultRegister(
  tx: Prisma.TransactionClient,
  tenantId: string,
  wanted?: string | null
) {
  if (wanted) {
    const r = await tx.cashRegister.findFirst({ where: { id: wanted, isActive: true } });
    if (!r) throw notFound("Касса не найдена");
    return r;
  }
  return (
    (await tx.cashRegister.findFirst({ where: { isActive: true }, orderBy: { name: "asc" } })) ??
    (await tx.cashRegister.create({ data: { tenantId, name: "Наличные", kind: "CASH" } }))
  );
}

/** Статьи заводятся по мере надобности: заранее придуманный справочник никто не заполняет. */
async function categoryByName(
  tx: Prisma.TransactionClient,
  tenantId: string,
  name: string | null | undefined,
  direction: "IN" | "OUT"
) {
  const clean = (name ?? "").trim();
  if (!clean) return null;
  const found = await tx.transactionCategory.findFirst({ where: { name: clean } });
  if (found) return found;
  return tx.transactionCategory.create({ data: { tenantId, name: clean, direction } });
}

// ------------------------------------------------------------------- кассы

financeRouter.get(
  "/registers",
  requirePermission(PERMISSIONS.FINANCE_VIEW, PERMISSIONS.FINANCE_PAYMENT, PERMISSIONS.FINANCE_MANAGE),
  ah(async (req, res) => {
    const rows = await withTenant(tenantOf(req), async (tx) => {
      const registers = await tx.cashRegister.findMany({
        where: { isActive: true },
        orderBy: { name: "asc" },
      });
      // Остаток кассы — это сумма её движений, а не отдельно хранимое число.
      // Отдельное число рано или поздно разойдётся с движениями, и объяснить
      // расхождение будет нечем.
      const sums = await tx.transaction.groupBy({
        by: ["cashRegisterId", "direction"],
        where: { deletedAt: null },
        _sum: { amount: true },
      });
      return registers.map((r) => {
        const income = sums.find((s) => s.cashRegisterId === r.id && s.direction === "IN");
        const expense = sums.find((s) => s.cashRegisterId === r.id && s.direction === "OUT");
        return {
          id: r.id,
          name: r.name,
          kind: r.kind,
          balance: num(income?._sum.amount) - num(expense?._sum.amount),
        };
      });
    });
    res.json(rows);
  })
);

financeRouter.post(
  "/registers",
  requirePermission(PERMISSIONS.FINANCE_MANAGE),
  ah(async (req, res) => {
    const body = z
      .object({
        name: z.string().trim().min(1, "У кассы должно быть название").max(80),
        kind: z.enum(["CASH", "BANK", "ACQUIRING"]).default("CASH"),
      })
      .parse(req.body);

    const tenantId = tenantOf(req);
    const created = await withTenant(tenantId, (tx) =>
      tx.cashRegister.create({ data: { tenantId, name: body.name, kind: body.kind } })
    );
    res.status(201).json({ id: created.id, name: created.name });
  })
);

// --------------------------------------------------------------- движения

financeRouter.get(
  "/",
  requirePermission(PERMISSIONS.FINANCE_VIEW, PERMISSIONS.FINANCE_MANAGE),
  ah(async (req, res) => {
    const q = z
      .object({
        days: z.coerce.number().int().min(1).max(365).default(30),
        direction: z.enum(["IN", "OUT"]).optional(),
        cashRegisterId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(300).default(100),
      })
      .parse(req.query);

    const from = daysAgo(q.days - 1);

    const data = await withTenant(tenantOf(req), async (tx) => {
      const rows = await tx.transaction.findMany({
        where: {
          deletedAt: null,
          createdAt: { gte: from },
          ...(q.direction ? { direction: q.direction } : {}),
          ...(q.cashRegisterId ? { cashRegisterId: q.cashRegisterId } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: q.limit,
        include: {
          cashRegister: { select: { id: true, name: true } },
          category: { select: { id: true, name: true } },
          order: { select: { id: true, number: true } },
          customer: { select: { id: true, name: true } },
          user: { select: { id: true, fullName: true } },
        },
      });

      const period = await tx.transaction.groupBy({
        by: ["direction"],
        where: { deletedAt: null, createdAt: { gte: from } },
        _sum: { amount: true },
      });
      const today = await tx.transaction.groupBy({
        by: ["direction"],
        where: { deletedAt: null, createdAt: { gte: startOfToday() } },
        _sum: { amount: true },
      });

      const pick = (rowsIn: typeof period, dir: "IN" | "OUT") =>
        num(rowsIn.find((r) => r.direction === dir)?._sum.amount);

      return {
        rows,
        totals: {
          days: q.days,
          income: pick(period, "IN"),
          expense: pick(period, "OUT"),
          todayIncome: pick(today, "IN"),
          todayExpense: pick(today, "OUT"),
        },
      };
    });

    res.json({
      totals: data.totals,
      items: data.rows.map((t) => ({
        id: t.id,
        direction: t.direction,
        amount: num(t.amount),
        register: t.cashRegister,
        category: t.category,
        order: t.order,
        customer: t.customer,
        user: t.user,
        comment: t.comment,
        createdAt: t.createdAt,
      })),
    });
  })
);

const txSchema = z.object({
  direction: z.enum(["IN", "OUT"]),
  amount: z.coerce.number().gt(0, "Сумма должна быть больше нуля").max(100_000_000),
  cashRegisterId: z.string().uuid().optional(),
  category: z.string().trim().max(80).optional(),
  orderId: z.string().uuid().optional(),
  comment: z.string().trim().max(300).optional(),
});

financeRouter.post(
  "/",
  requirePermission(PERMISSIONS.FINANCE_PAYMENT, PERMISSIONS.FINANCE_MANAGE),
  ah(async (req, res) => {
    const body = txSchema.parse(req.body);
    const tenantId = tenantOf(req);
    const userId = actorUserId(req);

    // Принять деньги может и приёмщик, и курьер. Выдать из кассы — только
    // тот, кто отвечает за деньги: расход это уже распоряжение средствами.
    if (body.direction === "OUT" && !has(req, PERMISSIONS.FINANCE_MANAGE)) {
      throw forbidden("Расход из кассы оформляет тот, кто отвечает за деньги");
    }

    const created = await withTenant(tenantId, async (tx) => {
      const register = await defaultRegister(tx, tenantId, body.cashRegisterId ?? null);

      let customerId: string | null = null;
      if (body.orderId) {
        const order = await tx.order.findFirst({
          where: { id: body.orderId, deletedAt: null },
          select: { id: true, customerId: true },
        });
        if (!order) throw notFound("Заказ не найден");
        customerId = order.customerId;
      }

      const category = await categoryByName(tx, tenantId, body.category, body.direction);

      const row = await tx.transaction.create({
        data: {
          tenantId,
          cashRegisterId: register.id,
          categoryId: category?.id ?? null,
          direction: body.direction,
          amount: body.amount,
          orderId: body.orderId ?? null,
          customerId,
          userId,
          comment: body.comment ?? null,
        },
      });

      await writeAudit(tx, {
        tenantId,
        userId,
        entity: "transaction",
        entityId: row.id,
        action: "CREATE",
        diff: { direction: body.direction, amount: body.amount, register: register.name },
        ip: clientIp(req),
      });

      return row;
    });

    res.status(201).json({ id: created.id, amount: num(created.amount) });
  })
);

/**
 * Исправление ошибки. Не редактирование и не удаление: заводим обратную
 * запись на ту же сумму. В журнале остаётся и ошибка, и её исправление —
 * иначе через месяц никто не поймёт, почему касса сходилась, а потом нет.
 */
financeRouter.post(
  "/:id/reverse",
  requirePermission(PERMISSIONS.FINANCE_MANAGE),
  ah(async (req, res) => {
    const body = z
      .object({ reason: z.string().trim().min(1, "Напишите, что исправляем").max(300) })
      .parse(req.body);
    const tenantId = tenantOf(req);
    const userId = actorUserId(req);

    const created = await withTenant(tenantId, async (tx) => {
      const source = await tx.transaction.findFirst({ where: { id: req.params.id, deletedAt: null } });
      if (!source) throw notFound("Запись не найдена");
      if (source.comment?.startsWith("Сторно ")) throw badRequest("Эта запись сама является исправлением");

      const row = await tx.transaction.create({
        data: {
          tenantId,
          cashRegisterId: source.cashRegisterId,
          categoryId: source.categoryId,
          direction: source.direction === "IN" ? "OUT" : "IN",
          amount: source.amount,
          orderId: source.orderId,
          customerId: source.customerId,
          userId,
          comment: `Сторно ${num(source.amount)} ₽: ${body.reason}`,
        },
      });

      await writeAudit(tx, {
        tenantId,
        userId,
        entity: "transaction",
        entityId: row.id,
        action: "UPDATE",
        diff: { reversed: source.id, reason: body.reason },
        ip: clientIp(req),
      });

      return row;
    });

    res.status(201).json({ id: created.id });
  })
);

/**
 * Что по заказу уже заплачено. Нужно на выдаче: приёмщик должен видеть не
 * итог, а остаток к оплате — с учётом предоплаты, внесённой при приёме.
 */
financeRouter.get(
  "/order/:orderId",
  requirePermission(
    PERMISSIONS.FINANCE_VIEW,
    PERMISSIONS.FINANCE_PAYMENT,
    PERMISSIONS.FINANCE_MANAGE,
    PERMISSIONS.ORDERS_ISSUE
  ),
  ah(async (req, res) => {
    const data = await withTenant(tenantOf(req), async (tx) => {
      const order = await tx.order.findFirst({
        where: { id: req.params.orderId, deletedAt: null },
        select: { id: true, number: true, total: true, prepayment: true },
      });
      if (!order) throw notFound("Заказ не найден");

      const paid = await tx.transaction.groupBy({
        by: ["direction"],
        where: { deletedAt: null, orderId: order.id },
        _sum: { amount: true },
      });
      const income = num(paid.find((p) => p.direction === "IN")?._sum.amount);
      const refund = num(paid.find((p) => p.direction === "OUT")?._sum.amount);
      const total = num(order.total);

      return {
        orderId: order.id,
        number: order.number,
        total,
        paid: income - refund,
        due: Math.max(0, total - (income - refund)),
      };
    });

    res.json(data);
  })
);
