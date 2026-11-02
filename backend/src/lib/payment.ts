import type { PayMethod, Prisma } from "@prisma/client";
import { monthOf } from "../modules/salary/months";

/**
 * Приём денег за заказ — на выдаче, при погашении долга и в продаже.
 *
 * Одно место на все случаи: это буквально одно и то же действие, и если
 * развести его по модулям, они разойдутся в мелочах — в названии статьи,
 * в выборе кассы, в том, привязан ли платёж к клиенту. Разойдутся молча, а
 * заметит это бухгалтер через квартал.
 *
 * С 03.11.2026 (batch55) способов больше, чем «наличные / безнал»: мастерская
 * заводит свои («Банковский перевод», «Криптовалюта»). У своего способа:
 *  — вид расчёта для акта (наличный / безналичный);
 *  — касса, куда идут деньги;
 *  — комиссия, % — расходом в ту же кассу;
 *  — сотрудники, которые могут принять деньги на себя. Тогда приход в кассу
 *    и сразу расход «Выплата сотруднику», а в зарплате — выплата, которую
 *    получатель подтверждает (💵 в шапке).
 */

export type PaidBy = "CASH" | "CARD";

/** Что приходит от интерфейса: CASH, CARD, TRANSFER (старые продажи) или id своего способа. */
export type PayHow = string;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isOwnMethod = (how: string) => UUID.test(how);

/** Ошибка, которую вызывающий превращает в 400: здесь нет express. */
export class PayError extends Error {}

/**
 * Куда положить деньги.
 *
 * Наличные идут в наличную кассу, безнал — в эквайринговую. Эквайринговой у
 * мастерской поначалу нет: при создании заводится только «Касса». Заводим её
 * сама, когда первый раз приняли картой, а не требуем сходить в настройки —
 * приёмщик в этот момент стоит с клиентом у стойки.
 */
export async function registerFor(tx: Prisma.TransactionClient, tenantId: string, how: PaidBy | "TRANSFER") {
  // Перевод на счёт (старые продажи) — в банковскую кассу; нет её — заводим «Переводы».
  if (how === "TRANSFER") {
    return (
      (await tx.cashRegister.findFirst({ where: { isActive: true, kind: "BANK" }, orderBy: { name: "asc" } })) ??
      (await tx.cashRegister.create({ data: { tenantId, name: "Переводы", kind: "BANK" } }))
    );
  }
  if (how === "CASH") {
    return (
      (await tx.cashRegister.findFirst({ where: { isActive: true, kind: "CASH" }, orderBy: { name: "asc" } })) ??
      (await tx.cashRegister.findFirst({ where: { isActive: true }, orderBy: { name: "asc" } })) ??
      (await tx.cashRegister.create({ data: { tenantId, name: "Касса", kind: "CASH" } }))
    );
  }

  return (
    (await tx.cashRegister.findFirst({
      where: { isActive: true, kind: { in: ["ACQUIRING", "BANK"] } },
      orderBy: { name: "asc" },
    })) ?? (await tx.cashRegister.create({ data: { tenantId, name: "Эквайринг", kind: "ACQUIRING" } }))
  );
}

/** Статья кассы по имени. Заводится по надобности — как и везде в кассе. */
export async function categoryNamed(tx: Prisma.TransactionClient, tenantId: string, name: string, direction: "IN" | "OUT") {
  return (
    (await tx.transactionCategory.findFirst({ where: { name, direction } })) ??
    (await tx.transactionCategory.create({ data: { tenantId, name, direction } }))
  );
}

export const BUILTIN_LABEL: Record<string, string> = { CASH: "Наличные", CARD: "Безнал", TRANSFER: "Перевод" };

export interface Way {
  /** CASH | CARD | TRANSFER — для движения кассы и акта. */
  kind: PaidBy;
  /** Что пишем в движение: CASH, CARD, TRANSFER или null у своего способа. */
  method: string;
  label: string;
  payMethod: PayMethod | null;
  registerId: string;
}

/** Способ оплаты по коду или id. Выключенный свой способ не принимаем. */
export async function resolveWay(tx: Prisma.TransactionClient, tenantId: string, how: PayHow): Promise<Way> {
  if (how === "CASH" || how === "CARD" || how === "TRANSFER") {
    const r = await registerFor(tx, tenantId, how);
    return { kind: how === "CASH" ? "CASH" : "CARD", method: how, label: BUILTIN_LABEL[how], payMethod: null, registerId: r.id };
  }
  if (!isOwnMethod(how)) throw new PayError("Неизвестный способ оплаты");
  const pm = await tx.payMethod.findFirst({ where: { id: how, isActive: true } });
  if (!pm) throw new PayError("Такого способа оплаты больше нет — обновите страницу");
  const kind: PaidBy = pm.actKind === "CASH" ? "CASH" : "CARD";
  const own = pm.cashRegisterId
    ? await tx.cashRegister.findFirst({ where: { id: pm.cashRegisterId, isActive: true }, select: { id: true } })
    : null;
  const registerId = own?.id ?? (await registerFor(tx, tenantId, kind)).id;
  return { kind, method: kind, label: pm.name, payMethod: pm, registerId };
}

/** Деньги ушли сотруднику: для оповещения после транзакции. */
export interface PayoutNote {
  id: string;
  userId: string;
  takenById: string | null;
  amount: number;
  label: string;
  orderId: string | null;
  orderNumber: string | null;
  saleId: string | null;
  confirmed: boolean;
}

export interface ReceiveParams {
  amount: number;
  how: PayHow;
  /** Сотрудник, который принял деньги на себя (только у своего способа). */
  recipientId?: string | null;
  orderId?: string | null;
  orderNumber?: string | null;
  saleId?: string | null;
  customerId?: string | null;
  /** Кто провёл (выдал заказ, продал). */
  userId: string | null;
  comment?: string;
  category: string;
  /** Когда. Нужно только тестовым данным: у живой оплаты время — сейчас. */
  at?: Date;
  /** Часовой пояс мастерской — для месяца выплаты. */
  tz?: string;
}

export interface Received {
  amount: number;
  registerId: string;
  way: Way;
  payout: PayoutNote | null;
}

/**
 * Принять деньги одним способом.
 *
 * Получатель указан → приход и сразу расход «Выплата сотруднику» той же
 * суммы (касса в ноль: денег в ней нет, они у сотрудника) и выплата в его
 * зарплату. Сам себе — подтверждена сразу, иначе ждёт его «Принять».
 * Комиссия способа — только когда деньги легли в кассу.
 */
export async function receiveMoney(tx: Prisma.TransactionClient, tenantId: string, p: ReceiveParams): Promise<Received> {
  const amount = Math.round(p.amount * 100) / 100;
  const way = await resolveWay(tx, tenantId, p.how);
  if (amount <= 0) return { amount: 0, registerId: way.registerId, way, payout: null };

  let recipient: { id: string; fullName: string } | null = null;
  if (p.recipientId) {
    if (!way.payMethod || !way.payMethod.recipientIds.includes(p.recipientId)) {
      throw new PayError("Этим способом нельзя принять деньги на этого сотрудника");
    }
    recipient = await tx.user.findFirst({ where: { id: p.recipientId, isActive: true, deletedAt: null }, select: { id: true, fullName: true } });
    if (!recipient) throw new PayError("Сотрудник не найден или отключён");
  }

  const category = await categoryNamed(tx, tenantId, p.category, "IN");
  const at = p.at ?? new Date();
  const inTx = await tx.transaction.create({
    data: {
      tenantId,
      cashRegisterId: way.registerId,
      categoryId: category.id,
      direction: "IN",
      amount,
      orderId: p.orderId ?? null,
      saleId: p.saleId ?? null,
      customerId: p.customerId ?? null,
      userId: p.userId,
      method: way.payMethod ? null : way.method,
      payMethodId: way.payMethod?.id ?? null,
      comment: [p.comment, way.payMethod ? way.label : null, recipient ? `деньги у: ${recipient.fullName}` : null].filter(Boolean).join(" · ") || null,
      createdAt: at,
    },
  });

  let payout: PayoutNote | null = null;
  if (recipient && way.payMethod) {
    const outCat = await categoryNamed(tx, tenantId, "Выплата сотруднику", "OUT");
    // Расход без заказа: иначе заказ выглядел бы неоплаченным — приход минус расход.
    const outTx = await tx.transaction.create({
      data: {
        tenantId,
        cashRegisterId: way.registerId,
        categoryId: outCat.id,
        direction: "OUT",
        amount,
        userId: p.userId,
        method: "PAYOUT",
        payMethodId: way.payMethod.id,
        comment: `${recipient.fullName}: деньги клиента (${way.label})${p.orderNumber ? `, заказ ${p.orderNumber}` : ""}`,
        createdAt: at,
      },
    });
    const self = p.userId === recipient.id;
    const tenant = p.tz ? null : await tx.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } });
    const month = monthOf(at, p.tz ?? tenant?.timezone ?? "Europe/Moscow");
    const row = await tx.salaryPayout.create({
      data: {
        tenantId,
        userId: recipient.id,
        amount,
        paidAt: at,
        month,
        comment: `${way.label}${p.orderNumber ? ` · заказ ${p.orderNumber}` : p.saleId ? " · продажа" : ""}`,
        createdById: p.userId,
        source: "CLIENT",
        orderId: p.orderId ?? null,
        saleId: p.saleId ?? null,
        payMethodId: way.payMethod.id,
        takenById: p.userId,
        inTxId: inTx.id,
        outTxId: outTx.id,
        status: self ? "CONFIRMED" : "PENDING",
        confirmedAt: self ? at : null,
      },
    });
    payout = {
      id: row.id,
      userId: recipient.id,
      takenById: p.userId,
      amount,
      label: way.label,
      orderId: p.orderId ?? null,
      orderNumber: p.orderNumber ?? null,
      saleId: p.saleId ?? null,
      confirmed: self,
    };
  } else if (way.payMethod?.commissionPct && Number(way.payMethod.commissionPct) > 0) {
    const fee = Math.round(amount * Number(way.payMethod.commissionPct)) / 100;
    if (fee > 0) {
      const feeCat = await categoryNamed(tx, tenantId, "Комиссия за приём оплаты", "OUT");
      await tx.transaction.create({
        data: {
          tenantId,
          cashRegisterId: way.registerId,
          categoryId: feeCat.id,
          direction: "OUT",
          amount: fee,
          userId: p.userId,
          method: "FEE",
          payMethodId: way.payMethod.id,
          comment: `${way.label}: ${Number(way.payMethod.commissionPct)}% с ${amount} ₽${p.orderNumber ? `, заказ ${p.orderNumber}` : ""}`,
          createdAt: at,
        },
      });
    }
  }

  return { amount, registerId: way.registerId, way, payout };
}

/** Часть оплаты: способ, сумма, кому. */
export interface PayPart {
  method: PayHow;
  amount: number;
  recipientId?: string | null;
}

/**
 * Провести оплату по заказу — одним способом или частями.
 *
 * Возвращает проведённую сумму и выплаты сотрудникам (для оповещений). Ноль
 * и отрицательное не проводим вовсе: запись «принято 0 ₽» в кассе — это
 * мусор, который потом приходится объяснять.
 */
export async function takePayment(
  tx: Prisma.TransactionClient,
  tenantId: string,
  params: {
    orderId: string;
    orderNumber?: string | null;
    customerId: string | null;
    amount: number;
    how: PayHow;
    recipientId?: string | null;
    userId: string | null;
    comment?: string;
    at?: Date;
  }
): Promise<number> {
  const r = await takeOrderPayment(tx, tenantId, params);
  return r.amount;
}

export async function takeOrderPayment(
  tx: Prisma.TransactionClient,
  tenantId: string,
  params: {
    orderId: string;
    orderNumber?: string | null;
    customerId: string | null;
    amount: number;
    how: PayHow;
    recipientId?: string | null;
    userId: string | null;
    comment?: string;
    at?: Date;
  }
): Promise<{ amount: number; payouts: PayoutNote[] }> {
  const r = await receiveMoney(tx, tenantId, {
    amount: params.amount,
    how: params.how,
    recipientId: params.recipientId,
    orderId: params.orderId,
    orderNumber: params.orderNumber,
    customerId: params.customerId,
    userId: params.userId,
    comment: params.comment,
    category: "Оплата заказа",
    at: params.at,
  });
  return { amount: r.amount, payouts: r.payout ? [r.payout] : [] };
}

/**
 * Части оплаты против суммы к оплате. Больше суммы не берём (лишнее
 * повисло бы переплатой), пустые части отбрасываем.
 */
export function normalizeParts(parts: PayPart[], due: number): PayPart[] {
  const out: PayPart[] = [];
  let left = Math.round(due * 100) / 100;
  for (const p of parts) {
    const a = Math.min(Math.round(p.amount * 100) / 100, left);
    if (a <= 0) continue;
    out.push({ ...p, amount: a });
    left = Math.round((left - a) * 100) / 100;
  }
  return out;
}

/** Вид расчёта для акта: CASH → «наличный расчёт», остальное — «безналичный». */
export const ACT_LABEL: Record<PaidBy, string> = { CASH: "наличный расчёт", CARD: "безналичный расчёт" };

/**
 * Оплаты заказа по способам: приходы минус возвраты без разбора, по способу
 * прихода. Вид расчёта для акта — у своего способа его «в акте», у старых
 * движений — по кассе (миграция pay_methods проставила method).
 */
export async function orderPayments(tx: Prisma.TransactionClient, orderId: string) {
  const rows = await tx.transaction.findMany({
    where: { orderId, direction: "IN", deletedAt: null },
    select: { amount: true, method: true, createdAt: true, payMethod: { select: { name: true, actKind: true } } },
    orderBy: { createdAt: "asc" },
  });
  const out = new Map<string, { label: string; act: "CASH" | "CARD"; amount: number }>();
  for (const r of rows) {
    const act: "CASH" | "CARD" = (r.payMethod?.actKind ?? r.method) === "CASH" ? "CASH" : "CARD";
    const label = r.payMethod?.name ?? BUILTIN_LABEL[r.method ?? ""] ?? (act === "CASH" ? "Наличные" : "Безнал");
    const k = label + "|" + act;
    const cur = out.get(k) ?? { label, act, amount: 0 };
    cur.amount = Math.round((cur.amount + Number(r.amount)) * 100) / 100;
    out.set(k, cur);
  }
  return [...out.values()];
}

