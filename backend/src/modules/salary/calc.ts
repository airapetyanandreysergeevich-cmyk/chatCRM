import type { Prisma } from "@prisma/client";
import { monthBounds, monthOf, monthsBetween, shiftMonth } from "./months";

/**
 * Расчёт зарплаты за месяц.
 *
 * Правила — от владельца мастерской (обсуждение 26.09.2026):
 *  — мастер получает процент **с работ**: база = итог заказа минус запчасти.
 *    С запчастей — ничего: «не мастера заслуга, что мы вложили деньги и
 *    держим запчасти на складе». Итог уже со скидкой, значит процент — от
 *    реально полученных денег, как бы скидка ни давалась;
 *  — заказ попадает в месяц, когда он **выдан и оплачен полностью** (по
 *    платежам заказа). Выдан в сентябре, доплачен в октябре — октябрь;
 *  — два мастера на заказе делят базу по строкам работ: у каждой строки свой
 *    мастер, строка без мастера — мастеру заказа;
 *  — оклад, премия, штраф — записи руками; выплаты — отдельно от кассы;
 *  — остаток переносится из месяца в месяц; начальный вводится руками.
 *
 * Считается на лету: заказы, платежи и проценты берутся как есть. Закрытый
 * месяц хранит снимок, и дальше его цифры не меняются, что бы ни случилось
 * со старыми заказами.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: Prisma.Decimal | number | string | null | undefined) => (v === null || v === undefined ? 0 : Number(v));

export interface OrderShare {
  orderId: string;
  number: string;
  /** Когда заказ заработан: выдан и оплачен полностью — позднее из двух. */
  at: string;
  total: number;
  parts: number;
  /** Итог минус запчасти. */
  base: number;
  /** Доля мастера в базе: 1 — весь заказ его, 0.5 — половина работ. */
  share: number;
  percent: number;
  amount: number;
}

export interface SalaryRow {
  userId: string;
  name: string;
  role: string | null;
  isActive: boolean;
  percent: number;
  /** Остаток на начало месяца: плюс — мастерская должна, минус — выдано вперёд. */
  start: number;
  /** Начальный остаток введён руками в этом месяце. */
  startSet: boolean;
  /** Процент с заказов. */
  accrued: number;
  /** Оклад, премия, штраф. */
  bonus: number;
  paid: number;
  end: number;
  orders: number;
}

export interface SalaryDetail {
  orders: OrderShare[];
  /** Справочно, по базе (итог − запчасти) и доле мастера: готово, выдано, оплачено за месяц. */
  ready: number;
  issued: number;
  earned: number;
}

export interface MonthResult {
  month: string;
  /** С какого месяца ведётся учёт: раньше него остатки не переносятся. */
  since: string;
  rows: SalaryRow[];
  details: Record<string, SalaryDetail>;
}

interface Work {
  orderId: string;
  price: Prisma.Decimal;
  qty: Prisma.Decimal;
  masterId: string | null;
}

/**
 * Доли мастеров в заказе — по строкам работ.
 *
 * Строка засчитывается тому, кто в ней записан, только если он мастер — то
 * есть у него есть процент с работ. Раньше каждая строка записывалась на
 * того, кто нажал «Сохранить», и работы, внесённые приёмщиком или
 * владельцем, числились бы за ними — а мастер заказа получил бы ноль.
 */
export function sharesOf(
  assignedMasterId: string | null,
  works: Array<{ price: number; qty: number; masterId: string | null }>,
  isMaster: (userId: string) => boolean = () => true
) {
  const out = new Map<string, number>();
  const all = works.reduce((n, w) => n + Math.max(0, w.price * w.qty), 0);
  if (all <= 0) {
    if (assignedMasterId) out.set(assignedMasterId, 1);
    return out;
  }
  for (const w of works) {
    const who = w.masterId && isMaster(w.masterId) ? w.masterId : assignedMasterId;
    const part = Math.max(0, w.price * w.qty) / all;
    if (who && part > 0) out.set(who, (out.get(who) ?? 0) + part);
  }
  return out;
}

interface Earned {
  orderId: string;
  number: string;
  at: Date;
  month: string;
  total: number;
  parts: number;
  base: number;
  shares: Map<string, number>;
}

/** Заказы, заработанные мастерами: выданы и оплачены полностью. Весь период. */
async function earnedOrders(
  tx: Prisma.TransactionClient,
  tenantId: string,
  tz: string,
  isMaster: (userId: string) => boolean
): Promise<Earned[]> {
  // Момент полной оплаты — первая оплата, после которой набежавшая сумма
  // покрыла итог. Считаем только заказы, которые и сейчас оплачены: заказ,
  // деньги по которому вернули, мастеру не засчитывается.
  const rows = await tx.$queryRaw<
    Array<{ id: string; number: string; total: string; parts: string; master: string | null; at: Date }>
  >`
    WITH t AS (
      SELECT tr."orderId", tr."createdAt",
             SUM(CASE WHEN tr.direction = 'IN' THEN tr.amount ELSE -tr.amount END)
               OVER (PARTITION BY tr."orderId" ORDER BY tr."createdAt", tr.id) AS running,
             SUM(CASE WHEN tr.direction = 'IN' THEN tr.amount ELSE -tr.amount END)
               OVER (PARTITION BY tr."orderId") AS paid
        FROM "Transaction" tr
       WHERE tr."tenantId" = ${tenantId} AND tr."deletedAt" IS NULL AND tr."orderId" IS NOT NULL
    )
    SELECT o.id, o.number, o.total::text AS total, o."totalParts"::text AS parts,
           o."assignedMasterId" AS master,
           GREATEST(MIN(t."createdAt"), o."issuedAt") AS at
      FROM "Order" o
      JOIN t ON t."orderId" = o.id
     WHERE o."tenantId" = ${tenantId} AND o."deletedAt" IS NULL AND o."issuedAt" IS NOT NULL
       AND o.total > 0 AND t.running >= o.total - 0.005 AND t.paid >= o.total - 0.005
     GROUP BY o.id
  `;
  const works = await worksOf(tx, rows.map((r) => r.id));
  return rows.map((r) => {
    const total = num(r.total);
    const parts = num(r.parts);
    return {
      orderId: r.id,
      number: r.number,
      at: r.at,
      month: monthOf(r.at, tz),
      total,
      parts,
      base: Math.max(0, round2(total - parts)),
      shares: sharesOf(r.master, works.get(r.id) ?? [], isMaster),
    };
  });
}

async function worksOf(tx: Prisma.TransactionClient, ids: string[]) {
  const out = new Map<string, Array<{ price: number; qty: number; masterId: string | null }>>();
  for (let i = 0; i < ids.length; i += 5000) {
    const part: Work[] = await tx.orderWork.findMany({
      where: { orderId: { in: ids.slice(i, i + 5000) } },
      select: { orderId: true, price: true, qty: true, masterId: true },
    });
    for (const w of part) {
      out.set(w.orderId, [...(out.get(w.orderId) ?? []), { price: num(w.price), qty: num(w.qty), masterId: w.masterId }]);
    }
  }
  return out;
}

/** Справочно: база заказов, готовых / выданных в месяце, по мастерам. */
async function referenceSums(
  tx: Prisma.TransactionClient,
  month: string,
  tz: string,
  isMaster: (userId: string) => boolean
) {
  const { from, to } = monthBounds(month, tz);
  const orders = await tx.order.findMany({
    where: {
      deletedAt: null,
      OR: [{ completedAt: { gte: from, lt: to } }, { issuedAt: { gte: from, lt: to } }],
    },
    select: { id: true, total: true, totalParts: true, assignedMasterId: true, completedAt: true, issuedAt: true },
  });
  const works = await worksOf(tx, orders.map((o) => o.id));
  const ready = new Map<string, number>();
  const issued = new Map<string, number>();
  const inMonth = (d: Date | null) => !!d && d >= from && d < to;
  for (const o of orders) {
    const base = Math.max(0, num(o.total) - num(o.totalParts));
    for (const [who, share] of sharesOf(o.assignedMasterId, works.get(o.id) ?? [], isMaster)) {
      if (inMonth(o.completedAt)) ready.set(who, (ready.get(who) ?? 0) + base * share);
      if (inMonth(o.issuedAt)) issued.set(who, (issued.get(who) ?? 0) + base * share);
    }
  }
  return { ready, issued };
}

type Snapshot = { rows: SalaryRow[]; details: Record<string, SalaryDetail> };

/**
 * Ведомость за месяц. Закрытый месяц отдаётся снимком; открытый считается.
 */
export async function computeMonth(
  tx: Prisma.TransactionClient,
  tenantId: string,
  month: string,
  tz: string
): Promise<MonthResult & { closed: { at: Date; byId: string | null } | null }> {
  const closedHere = await tx.salaryMonth.findFirst({ where: { month } });
  const [entries, payouts, closedMonths] = await Promise.all([
    tx.salaryEntry.findMany({ select: { userId: true, month: true, kind: true, amount: true } }),
    tx.salaryPayout.findMany({ where: { deletedAt: null }, select: { userId: true, month: true, amount: true } }),
    tx.salaryMonth.findMany({ select: { month: true, snapshot: true }, orderBy: { month: "asc" } }),
  ]);

  // Учёт начинается с первого месяца, в котором что-то записано руками или
  // закрыт. Без этого перенесённая из старой программы история за восемь лет
  // выглядела бы многомиллионным долгом перед каждым мастером.
  const current = monthOf(new Date(), tz);
  const marks = [...entries.map((e) => e.month), ...payouts.map((p) => p.month), ...closedMonths.map((c) => c.month)];
  const since = marks.length ? marks.reduce((a, b) => (a < b ? a : b)) : current;

  if (closedHere) {
    const snap = closedHere.snapshot as unknown as Snapshot;
    return { month, since, rows: snap.rows, details: snap.details, closed: { at: closedHere.closedAt, byId: closedHere.closedById } };
  }

  const users = await tx.user.findMany({
    select: {
      id: true,
      fullName: true,
      isActive: true,
      isOwner: true,
      deletedAt: true,
      workPercent: true,
      role: { select: { name: true } },
    },
  });
  const percentOf = new Map(users.map((u) => [u.id, num(u.workPercent)]));
  const isMaster = (id: string) => (percentOf.get(id) ?? 0) > 0;
  const earned = await earnedOrders(tx, tenantId, tz, isMaster);

  // Суммы по (сотрудник, месяц).
  const key = (u: string, m: string) => `${u}|${m}`;
  const accruedBy = new Map<string, number>();
  const bonusBy = new Map<string, number>();
  const paidBy = new Map<string, number>();
  const add = (map: Map<string, number>, k: string, v: number) => map.set(k, (map.get(k) ?? 0) + v);
  const monthOrders = new Map<string, OrderShare[]>();

  for (const e of earned) {
    for (const [who, share] of e.shares) {
      const percent = percentOf.get(who) ?? 0;
      const amount = round2((e.base * share * percent) / 100);
      add(accruedBy, key(who, e.month), amount);
      if (e.month === month) {
        monthOrders.set(who, [
          ...(monthOrders.get(who) ?? []),
          {
            orderId: e.orderId,
            number: e.number,
            at: e.at.toISOString(),
            total: e.total,
            parts: e.parts,
            base: e.base,
            share: Math.round(share * 10000) / 10000,
            percent,
            amount,
          },
        ]);
      }
    }
  }
  const openings = new Map<string, Array<{ month: string; amount: number }>>();
  for (const e of entries) {
    if (e.kind === "OPENING") openings.set(e.userId, [...(openings.get(e.userId) ?? []), { month: e.month, amount: num(e.amount) }]);
    else add(bonusBy, key(e.userId, e.month), num(e.amount));
  }
  for (const p of payouts) add(paidBy, key(p.userId, p.month), num(p.amount));

  // Остаток на начало: от последней опоры — закрытого месяца или введённого
  // руками остатка — плюс движение за месяцы между опорой и этим месяцем.
  const lastClosed = [...closedMonths].reverse().find((c) => c.month < month && c.month >= since);
  const closedEnd = new Map<string, number>();
  if (lastClosed) {
    for (const r of (lastClosed.snapshot as unknown as Snapshot).rows) closedEnd.set(r.userId, r.end);
  }
  const startOf = (userId: string): { start: number; startSet: boolean } => {
    if (month < since) return { start: 0, startSet: false };
    let from = lastClosed ? shiftMonth(lastClosed.month, 1) : since;
    let value = lastClosed ? (closedEnd.get(userId) ?? 0) : 0;
    const opening = (openings.get(userId) ?? [])
      .filter((o) => o.month >= from && o.month <= month)
      .sort((a, b) => (a.month < b.month ? 1 : -1))[0];
    if (opening) {
      from = opening.month;
      value = opening.amount;
    }
    for (const m of monthsBetween(from, shiftMonth(month, -1))) {
      value += (accruedBy.get(key(userId, m)) ?? 0) + (bonusBy.get(key(userId, m)) ?? 0) - (paidBy.get(key(userId, m)) ?? 0);
    }
    return { start: round2(value), startSet: opening?.month === month };
  };

  const { ready, issued } = await referenceSums(tx, month, tz, isMaster);

  const rows: SalaryRow[] = [];
  const details: Record<string, SalaryDetail> = {};
  for (const u of users) {
    const k = key(u.id, month);
    const accrued = round2(accruedBy.get(k) ?? 0);
    const bonus = round2(bonusBy.get(k) ?? 0);
    const paid = round2(paidBy.get(k) ?? 0);
    const { start, startSet } = startOf(u.id);
    const percent = percentOf.get(u.id) ?? 0;
    const orders = monthOrders.get(u.id) ?? [];
    // В ведомости — работающие мастера (есть процент) и все, у кого есть
    // хоть какое-то движение. Выключенный или удалённый сотрудник с нулём по
    // всем колонкам — не строка, а шум: после переноса из старой программы их
    // бывает по десятку.
    const moving = accrued || bonus || paid || start || startSet;
    const working = percent > 0 && u.isActive && !u.deletedAt;
    if (!moving && !working) continue;
    rows.push({
      userId: u.id,
      name: u.fullName,
      role: u.role?.name ?? (u.isOwner ? "Владелец" : null),
      isActive: u.isActive && !u.deletedAt,
      percent,
      start,
      startSet,
      accrued,
      bonus,
      paid,
      end: round2(start + accrued + bonus - paid),
      orders: orders.length,
    });
    details[u.id] = {
      orders: orders.sort((a, b) => (a.at < b.at ? -1 : 1)),
      ready: round2(ready.get(u.id) ?? 0),
      issued: round2(issued.get(u.id) ?? 0),
      earned: round2(orders.reduce((n, o) => n + o.base * o.share, 0)),
    };
  }
  rows.sort((a, b) => b.accrued + b.bonus - (a.accrued + a.bonus) || a.name.localeCompare(b.name, "ru"));
  return { month, since, rows, details, closed: null };
}
