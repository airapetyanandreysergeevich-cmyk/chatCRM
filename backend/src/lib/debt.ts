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
