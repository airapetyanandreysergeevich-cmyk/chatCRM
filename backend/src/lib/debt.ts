import type { Prisma } from "@prisma/client";

/**
 * Долг клиента перед мастерской.
 *
 * Отдельного поля «долг» в базе нет и не будет. Долг — это итог заказа минус
 * проведённые по нему деньги, и считается он здесь, в одном месте, для всех:
 * для карточки клиента, для панели просрочки на главной и для погашения.
 *
 * Хранить долг числом было бы быстрее и опаснее. Число живёт отдельно от
 * кассы, и первая же операция мимо него — возврат, правка суммы заказа,
 * платёж, проведённый в «Кассе» руками, — разводит две правды. Через месяц
 * никто не скажет, какая из них настоящая, а клиенту при этом называют
 * сумму. Пересчёт же стоит одного запроса с группировкой.
 */

const num = (v: Prisma.Decimal | number | null | undefined): number =>
  v === null || v === undefined ? 0 : Number(v);

export interface OrderDebt {
  orderId: string;
  number: string;
  total: number;
  paid: number;
  due: number;
  issuedAt: Date | null;
  debtDueAt: Date | null;
  /** Срок обещанного платежа прошёл. */
  overdue: boolean;
  customer: { id: string; number: number; name: string; phone: string } | null;
}

interface Options {
  /** Долги одного клиента. */
  customerId?: string;
  /** Только те, по которым обещанный срок уже прошёл. */
  overdueOnly?: boolean;
  limit?: number;
}

/**
 * Заказы, по которым остались деньги.
 *
 * Берём только выданные: пока техника у нас, неоплаченный заказ — это не
 * долг, а незаконченная работа, и путать их нельзя ни на главной, ни в
 * карточке клиента.
 */
export async function debts(
  tx: Prisma.TransactionClient,
  { customerId, overdueOnly, limit = 200 }: Options = {}
): Promise<OrderDebt[]> {
  const now = new Date();

  // Тип выписан явно: в тернарнике «asc» расширяется до string, и запрос
  // перестаёт сходиться по типам — ошибка непонятная и не по делу.
  const orderBy: Prisma.OrderOrderByWithRelationInput = overdueOnly
    ? { debtDueAt: "asc" }
    : { issuedAt: "desc" };

  const orders = await tx.order.findMany({
    where: {
      deletedAt: null,
      issuedAt: { not: null },
      ...(customerId ? { customerId } : {}),
      ...(overdueOnly ? { debtDueAt: { not: null, lte: now } } : {}),
    },
    orderBy,
    // С запасом: часть заказов отсеется как оплаченные, и брать ровно limit
    // значило бы иногда показывать меньше, чем есть.
    take: limit * 5,
    select: {
      id: true,
      number: true,
      total: true,
      issuedAt: true,
      debtDueAt: true,
      customer: { select: { id: true, number: true, name: true, phone: true } },
    },
  });
  if (orders.length === 0) return [];

  const sums = await tx.transaction.groupBy({
    by: ["orderId", "direction"],
    where: { deletedAt: null, orderId: { in: orders.map((o) => o.id) } },
    _sum: { amount: true },
  });

  const paidBy = new Map<string, number>();
  for (const s of sums) {
    if (!s.orderId) continue;
    // Возврат уменьшает оплаченное: заказ, деньги по которому вернули,
    // снова становится неоплаченным, и это правда, а не ошибка.
    const signed = (s.direction === "IN" ? 1 : -1) * num(s._sum.amount);
    paidBy.set(s.orderId, (paidBy.get(s.orderId) ?? 0) + signed);
  }

  const out: OrderDebt[] = [];
  for (const o of orders) {
    const total = num(o.total);
    const paid = paidBy.get(o.id) ?? 0;
    // Копейки округляем: иначе долг в 0,004 ₽ висит вечно и требует погашения.
    const due = Math.round((total - paid) * 100) / 100;
    if (due <= 0) continue;

    out.push({
      orderId: o.id,
      number: o.number,
      total,
      paid,
      due,
      issuedAt: o.issuedAt,
      debtDueAt: o.debtDueAt,
      overdue: o.debtDueAt !== null && o.debtDueAt <= now,
      customer: o.customer,
    });
    if (out.length >= limit) break;
  }

  return out;
}

/** Сколько всего должен клиент. */
export async function debtOf(tx: Prisma.TransactionClient, customerId: string): Promise<number> {
  const list = await debts(tx, { customerId });
  return Math.round(list.reduce((sum, d) => sum + d.due, 0) * 100) / 100;
}

/**
 * Долги для списка — одним запросом на страницу.
 *
 * Тот же расчёт, что выше (выданный заказ, итог минус проведённые деньги), но
 * для заранее известных заказов или клиентов: ярлык «Задолженность» стоит в
 * каждой строке списка, и считать его по строке значило бы сорок запросов.
 */
export async function debtMap(
  tx: Prisma.TransactionClient,
  by: { orderIds?: string[]; customerIds?: string[] }
): Promise<{ byOrder: Map<string, number>; byCustomer: Map<string, number> }> {
  const byOrder = new Map<string, number>();
  const byCustomer = new Map<string, number>();
  const orderIds = by.orderIds ?? [];
  const customerIds = by.customerIds ?? [];
  if (!orderIds.length && !customerIds.length) return { byOrder, byCustomer };

  const orders = await tx.order.findMany({
    where: {
      deletedAt: null,
      issuedAt: { not: null },
      OR: [
        ...(orderIds.length ? [{ id: { in: orderIds } }] : []),
        ...(customerIds.length ? [{ customerId: { in: customerIds } }] : []),
      ],
    },
    select: { id: true, customerId: true, total: true },
  });
  if (!orders.length) return { byOrder, byCustomer };

  const sums = await tx.transaction.groupBy({
    by: ["orderId", "direction"],
    where: { deletedAt: null, orderId: { in: orders.map((o) => o.id) } },
    _sum: { amount: true },
  });
  const paidBy = new Map<string, number>();
  for (const s of sums) {
    if (!s.orderId) continue;
    const signed = (s.direction === "IN" ? 1 : -1) * num(s._sum.amount);
    paidBy.set(s.orderId, (paidBy.get(s.orderId) ?? 0) + signed);
  }

  for (const o of orders) {
    const due = Math.round((num(o.total) - (paidBy.get(o.id) ?? 0)) * 100) / 100;
    if (due <= 0) continue;
    byOrder.set(o.id, due);
    byCustomer.set(o.customerId, Math.round(((byCustomer.get(o.customerId) ?? 0) + due) * 100) / 100);
  }
  return { byOrder, byCustomer };
}

/**
 * Поля долга для ответа. Сам факт долга — всем, кто видит строку: ярлык
 * «Задолженность» должен бросаться в глаза и приёмщику. Сумма — только тому,
 * кто видит деньги.
 */
export const debtFields = (due: number | undefined, money: boolean) => ({
  inDebt: (due ?? 0) > 0,
  ...(money ? { debt: due ?? 0 } : {}),
});

/**
 * Все заказы мастерской с долгом: номер заказа → сколько должны и до какого
 * числа обещали. Для фильтра «Задолженность» в заказах. Одним запросом с
 * группировкой по кассе — тот же расчёт, что в debts(), только для всех сразу.
 */
export async function debtList(
  tx: Prisma.TransactionClient,
  tenantId: string
): Promise<Map<string, { due: number; debtDueAt: Date | null }>> {
  const rows = await tx.$queryRaw<Array<{ id: string; due: Prisma.Decimal | number; debtDueAt: Date | null }>>`
    SELECT o.id, ROUND(o.total - COALESCE(t.paid, 0), 2) AS due, o."debtDueAt"
      FROM "Order" o
      LEFT JOIN (
        SELECT "orderId", SUM(CASE WHEN direction = 'IN' THEN amount ELSE -amount END) AS paid
          FROM "Transaction"
         WHERE "tenantId" = ${tenantId} AND "deletedAt" IS NULL AND "orderId" IS NOT NULL
         GROUP BY "orderId"
      ) t ON t."orderId" = o.id
     WHERE o."tenantId" = ${tenantId}
       AND o."deletedAt" IS NULL
       AND o."issuedAt" IS NOT NULL
       AND ROUND(o.total - COALESCE(t.paid, 0), 2) > 0
  `;
  return new Map(rows.map((r) => [r.id, { due: num(r.due), debtDueAt: r.debtDueAt }]));
}
