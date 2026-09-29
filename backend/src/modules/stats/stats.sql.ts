import { Prisma } from "@prisma/client";

/**
 * Запросы раздела «Статистика». Всё считает PostgreSQL.
 *
 * Время. Колонки Prisma — timestamp без пояса, в них лежит UTC. Мастерская
 * живёт в своём поясе (Tenant.timezone), и заказ, принятый в 23:30, должен
 * попасть в свой день, а не в завтрашний по Гринвичу. Поэтому каждая дата
 * переводится в местное время: (col AT TIME ZONE 'UTC') AT TIME ZONE tz.
 * Индексы при этом не работают, но строк одной мастерской — тысячи, а не
 * миллионы, и запросы укладываются в десятки миллисекунд (проверено на базе
 * в 4000 заказов).
 *
 * Итог заказа — три вида, и одно правило на весь раздел:
 *   • отремонтирован — есть completedAt и заказ не в группе «Отменён»;
 *   • без ремонта — группа «Отменён» («Возврат без ремонта») или выдан без
 *     готовности (выдача с причиной, см. orders.routes → /issue);
 *   • в работе — всё остальное.
 *
 * Выручка — деньги по заказам в кассе: приход минус возвраты, по дате
 * движения. Так цифра сходится с кассой и не зависит от того, когда заказ
 * выдали.
 */

import type { Gran, Range } from "./dates";
export type { Gran, Range };

export interface Ctx {
  tx: Prisma.TransactionClient;
  tenantId: string;
  tz: string;
}


const local = (tz: string, col: string) => Prisma.sql`((${Prisma.raw(col)} AT TIME ZONE 'UTC') AT TIME ZONE ${tz})`;

/** Колонка в пределах периода, по местному времени. */
export const within = (c: Ctx, col: string, r: Range) =>
  Prisma.sql`${local(c.tz, col)} >= ${r.from}::date AND ${local(c.tz, col)} < (${r.to}::date + 1)`;

/** Корзина: начало дня, недели (с понедельника) или месяца — строкой YYYY-MM-DD. «all» — одна корзина на весь период. */
export const bucket = (c: Ctx, col: string, gran: Gran | "all") =>
  gran === "all"
    ? Prisma.sql`'all'`
    : Prisma.sql`to_char(date_trunc(${gran}, ${local(c.tz, col)}), 'YYYY-MM-DD')`;

const OK = Prisma.sql`(o."completedAt" IS NOT NULL AND s."group" <> 'CANCELLED')`;
const NO = Prisma.sql`(s."group" = 'CANCELLED' OR (o."issuedAt" IS NOT NULL AND o."completedAt" IS NULL))`;

/**
 * Заказы, по которым потом приходили по гарантии. Соединением, а не
 * подзапросом на каждую строку: так в десятки раз быстрее на всей истории.
 */
const WARRANTY_JOIN = (c: Ctx) => Prisma.sql`
  LEFT JOIN (SELECT DISTINCT "parentOrderId" AS pid FROM "Order"
             WHERE "tenantId" = ${c.tenantId} AND kind = 'WARRANTY' AND "deletedAt" IS NULL AND "parentOrderId" IS NOT NULL) wr
    ON wr.pid = o.id`;

type Row = Record<string, unknown>;
const q = <T extends Row>(c: Ctx, sql: Prisma.Sql) => c.tx.$queryRaw<T[]>(sql);
const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

/** Необязательный фильтр по мастеру заказа. */
const byMaster = (master?: string | null) => (master ? Prisma.sql`AND o."assignedMasterId" = ${master}` : Prisma.empty);

// ---------------------------------------------------------------- заказы по приёму

/** Принятые заказы по корзинам, с разбивкой по итогу. */
export async function acceptedByOutcome(c: Ctx, r: Range, gran: Gran | "all", master?: string | null) {
  const rows = await q<{ b: string; total: bigint; ok: bigint; no: bigint }>(c, Prisma.sql`
    SELECT ${bucket(c, 'o."acceptedAt"', gran)} AS b, count(*) AS total,
           count(*) FILTER (WHERE ${OK}) AS ok, count(*) FILTER (WHERE ${NO} AND NOT ${OK}) AS no
    FROM "Order" o JOIN "OrderStatus" s ON s.id = o."statusId"
    WHERE o."tenantId" = ${c.tenantId} AND o."deletedAt" IS NULL AND ${within(c, 'o."acceptedAt"', r)} ${byMaster(master)}
    GROUP BY 1`);
  const out = new Map<string, { total: number; ok: number; no: number; work: number }>();
  for (const x of rows) {
    const total = n(x.total), ok = n(x.ok), no = n(x.no);
    out.set(x.b, { total, ok, no, work: total - ok - no });
  }
  return out;
}

/** Выданные заказы по корзинам: сколько и средний чек (по заказам с суммой). */
export async function issued(c: Ctx, r: Range, gran: Gran | "all", master?: string | null) {
  const rows = await q<{ b: string; n: bigint; paid: bigint; sum: string | null }>(c, Prisma.sql`
    SELECT ${bucket(c, 'o."issuedAt"', gran)} AS b, count(*) AS n,
           count(*) FILTER (WHERE o.total > 0) AS paid, sum(o.total) FILTER (WHERE o.total > 0) AS sum
    FROM "Order" o
    WHERE o."tenantId" = ${c.tenantId} AND o."deletedAt" IS NULL AND o."issuedAt" IS NOT NULL
      AND ${within(c, 'o."issuedAt"', r)} ${byMaster(master)}
    GROUP BY 1`);
  return new Map(rows.map((x) => [x.b, { n: n(x.n), check: n(x.paid) ? n(x.sum) / n(x.paid) : 0 }]));
}

/** Деньги по заказам в кассе: приход минус возвраты, по дате движения. */
export async function revenue(c: Ctx, r: Range, gran: Gran | "all") {
  const rows = await q<{ b: string; v: string | null }>(c, Prisma.sql`
    SELECT ${bucket(c, 't."createdAt"', gran)} AS b,
           sum(CASE WHEN t.direction = 'IN' THEN t.amount ELSE -t.amount END) AS v
    FROM "Transaction" t
    WHERE t."tenantId" = ${c.tenantId} AND t."deletedAt" IS NULL AND t."orderId" IS NOT NULL
      AND ${within(c, 't."createdAt"', r)}
    GROUP BY 1`);
  return new Map(rows.map((x) => [x.b, n(x.v)]));
}

/**
 * Готовые за период: медиана срока ремонта (дни от приёма до готовности) и
 * доля гарантийных возвратов — сколько из них потом вернулись по гарантии.
 */
export async function completed(c: Ctx, r: Range, gran: Gran | "all", master?: string | null) {
  const rows = await q<{ b: string; n: bigint; med: number | null; warranty: bigint; late: bigint; lateOf: bigint }>(c, Prisma.sql`
    SELECT ${bucket(c, 'o."completedAt"', gran)} AS b, count(*) AS n,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM o."completedAt" - o."acceptedAt") / 86400) AS med,
           count(*) FILTER (WHERE wr.pid IS NOT NULL) AS warranty,
           count(*) FILTER (WHERE o."dueAt" IS NOT NULL AND o."completedAt" > o."dueAt") AS late,
           count(*) FILTER (WHERE o."dueAt" IS NOT NULL) AS "lateOf"
    FROM "Order" o JOIN "OrderStatus" s ON s.id = o."statusId" ${WARRANTY_JOIN(c)}
    WHERE o."tenantId" = ${c.tenantId} AND o."deletedAt" IS NULL AND o."completedAt" IS NOT NULL AND s."group" <> 'CANCELLED'
      AND o."completedAt" >= o."acceptedAt"
      AND ${within(c, 'o."completedAt"', r)} ${byMaster(master)}
    GROUP BY 1`);
  return new Map(rows.map((x) => [x.b, {
    n: n(x.n), median: x.med === null ? null : Number(x.med),
    warranty: n(x.warranty), late: n(x.late), lateOf: n(x.lateOf),
  }]));
}

// ---------------------------------------------------------------- разрезы

/** Приём по дню недели (1 — понедельник) и часу. */
export async function heat(c: Ctx, r: Range) {
  return q<{ dow: number; hour: number; n: bigint }>(c, Prisma.sql`
    SELECT extract(isodow FROM ${local(c.tz, 'o."acceptedAt"')})::int AS dow,
           extract(hour FROM ${local(c.tz, 'o."acceptedAt"')})::int AS hour, count(*) AS n
    FROM "Order" o
    WHERE o."tenantId" = ${c.tenantId} AND o."deletedAt" IS NULL AND ${within(c, 'o."acceptedAt"', r)}
    GROUP BY 1, 2`).then((rows) => rows.map((x) => ({ dow: x.dow, hour: x.hour, n: n(x.n) })));
}

/**
 * Разрез принятых заказов по полю техники: тип или марка. Написания
 * склеиваются без учёта регистра и пробелов, подпись — самое частое.
 */
export async function byDevice(c: Ctx, r: Range, field: "kind" | "brand", limit: number, master?: string | null) {
  const col = Prisma.raw(field === "kind" ? 'd.kind' : 'd.brand');
  const rows = await q<{ label: string | null; n: bigint }>(c, Prisma.sql`
    SELECT mode() WITHIN GROUP (ORDER BY btrim(${col})) AS label, count(*) AS n
    FROM "Order" o LEFT JOIN "Device" d ON d.id = o."deviceId"
    WHERE o."tenantId" = ${c.tenantId} AND o."deletedAt" IS NULL AND ${within(c, 'o."acceptedAt"', r)} ${byMaster(master)}
    GROUP BY lower(regexp_replace(btrim(coalesce(${col}, '')), '\\s+', ' ', 'g'))
    ORDER BY 2 DESC
    LIMIT ${limit}`);
  return rows.map((x) => ({ label: x.label && x.label.trim() ? x.label : field === "kind" ? "Без типа" : "Без марки", n: n(x.n) }));
}

/** Самая частая пара «тип + марка». */
export async function topDevice(c: Ctx, r: Range) {
  const rows = await q<{ kind: string | null; brand: string | null; n: bigint }>(c, Prisma.sql`
    SELECT mode() WITHIN GROUP (ORDER BY btrim(d.kind)) AS kind, mode() WITHIN GROUP (ORDER BY btrim(d.brand)) AS brand, count(*) AS n
    FROM "Order" o JOIN "Device" d ON d.id = o."deviceId"
    WHERE o."tenantId" = ${c.tenantId} AND o."deletedAt" IS NULL AND ${within(c, 'o."acceptedAt"', r)}
      AND coalesce(btrim(d.brand), '') <> ''
    GROUP BY lower(btrim(coalesce(d.kind, ''))), lower(btrim(d.brand))
    ORDER BY 3 DESC LIMIT 1`);
  return rows[0] ? { kind: rows[0].kind ?? "", brand: rows[0].brand ?? "", n: n(rows[0].n) } : null;
}

/** Сколько дней от приёма до готовности — по корзинам гистограммы. */
export async function readyHistogram(c: Ctx, r: Range, edges: number[]) {
  return histogram(c, Prisma.sql`
    SELECT extract(epoch FROM o."completedAt" - o."acceptedAt") / 86400 AS v
    FROM "Order" o JOIN "OrderStatus" s ON s.id = o."statusId"
    WHERE o."tenantId" = ${c.tenantId} AND o."deletedAt" IS NULL AND o."completedAt" IS NOT NULL AND s."group" <> 'CANCELLED'
      AND o."completedAt" >= o."acceptedAt" AND ${within(c, 'o."completedAt"', r)}`, edges);
}

/** Сколько дней готовая техника ждала клиента — для выданных за период. */
export async function waitHistogram(c: Ctx, r: Range, edges: number[]) {
  return histogram(c, Prisma.sql`
    SELECT extract(epoch FROM o."issuedAt" - o."completedAt") / 86400 AS v
    FROM "Order" o
    WHERE o."tenantId" = ${c.tenantId} AND o."deletedAt" IS NULL AND o."issuedAt" IS NOT NULL AND o."completedAt" IS NOT NULL
      AND o."issuedAt" >= o."completedAt" AND ${within(c, 'o."issuedAt"', r)}`, edges);
}

async function histogram(c: Ctx, inner: Prisma.Sql, edges: number[]) {
  // width_bucket по краям: 0 — меньше первого края, len — больше последнего.
  const rows = await q<{ k: number; n: bigint; med: number | null }>(c, Prisma.sql`
    WITH v AS (${inner})
    SELECT width_bucket(v.v, ${edges}::float8[]) AS k, count(*) AS n, NULL::float8 AS med FROM v GROUP BY 1
    UNION ALL
    SELECT -1, count(*), percentile_cont(0.5) WITHIN GROUP (ORDER BY v.v) FROM v`);
  const bins = edges.map(() => 0);
  let median: number | null = null;
  for (const x of rows) {
    if (x.k === -1) { median = x.med === null ? null : Number(x.med); continue; }
    const i = Math.min(edges.length - 1, Math.max(0, x.k - 1));
    bins[i] += n(x.n);
  }
  return { bins, median };
}

/**
 * Почему без ремонта: причина из выдачи («Выдано без ремонта: …») или
 * комментарий перехода в «Отменён». По заказам, закрытым за период.
 */
export async function reasons(c: Ctx, r: Range, limit: number) {
  const rows = await q<{ label: string; n: bigint }>(c, Prisma.sql`
    WITH x AS (
      SELECT DISTINCT ON (h."orderId") h."orderId",
             btrim(regexp_replace(coalesce(h.comment, ''), '^Выдано без ремонта:\\s*', '')) AS reason
      FROM "OrderStatusHistory" h
      JOIN "OrderStatus" s ON s.id = h."toStatusId"
      JOIN "Order" o ON o.id = h."orderId"
      WHERE h."tenantId" = ${c.tenantId} AND o."deletedAt" IS NULL AND ${within(c, 'h."createdAt"', r)}
        AND (h.comment LIKE 'Выдано без ремонта:%' OR s."group" = 'CANCELLED')
      ORDER BY h."orderId", h."createdAt" DESC
    )
    SELECT mode() WITHIN GROUP (ORDER BY reason) AS label, count(*) AS n
    FROM x GROUP BY lower(reason) ORDER BY 2 DESC LIMIT ${limit}`);
  return rows.map((x) => ({ label: x.label || "Причина не указана", n: n(x.n) }));
}

/**
 * Срочные и от постоянных клиентов — у кого был заказ раньше этого. Первый
 * заказ клиента берётся окном по всей истории, а не подзапросом на строку.
 */
export async function flags(c: Ctx, r: Range) {
  const [x] = await q<{ urgent: bigint; returning: bigint; total: bigint }>(c, Prisma.sql`
    WITH f AS (
      SELECT o."isUrgent", o."acceptedAt", min(o."acceptedAt") OVER (PARTITION BY o."customerId") AS first
      FROM "Order" o WHERE o."tenantId" = ${c.tenantId} AND o."deletedAt" IS NULL
    )
    SELECT count(*) FILTER (WHERE f."isUrgent") AS urgent, count(*) FILTER (WHERE f."acceptedAt" > f.first) AS returning, count(*) AS total
    FROM f WHERE ${within(c, 'f."acceptedAt"', r)}`);
  return { urgent: n(x?.urgent), returning: n(x?.returning), total: n(x?.total) };
}

/**
 * Выданные, пролежавшие готовыми дольше двух недель.
 *
 * ::int обязателен: настоящий движок Prisma передаёт число из JS как bigint,
 * а make_interval(days => bigint) в PostgreSQL нет — «Внутренняя ошибка» на
 * всём «Обзоре». В песочнице (adapter-pg) параметр уходит без типа, и
 * ошибка не видна (см. «Грабли»).
 */
export async function idleLong(c: Ctx, r: Range, days = 14) {
  const [x] = await q<{ n: bigint }>(c, Prisma.sql`
    SELECT count(*) AS n FROM "Order" o
    WHERE o."tenantId" = ${c.tenantId} AND o."deletedAt" IS NULL AND o."issuedAt" IS NOT NULL AND o."completedAt" IS NOT NULL
      AND o."issuedAt" - o."completedAt" > make_interval(days => ${days}::int) AND ${within(c, 'o."issuedAt"', r)}`);
  return n(x?.n);
}

// ---------------------------------------------------------------- мастера

export interface MasterRow {
  id: string;
  accepted: number;
  ok: number;
  no: number;
  work: number;
}

/** Принятые за период по мастерам и итогу. */
export async function mastersAccepted(c: Ctx, r: Range) {
  const rows = await q<{ id: string; total: bigint; ok: bigint; no: bigint }>(c, Prisma.sql`
    SELECT o."assignedMasterId" AS id, count(*) AS total,
           count(*) FILTER (WHERE ${OK}) AS ok, count(*) FILTER (WHERE ${NO} AND NOT ${OK}) AS no
    FROM "Order" o JOIN "OrderStatus" s ON s.id = o."statusId"
    WHERE o."tenantId" = ${c.tenantId} AND o."deletedAt" IS NULL AND o."assignedMasterId" IS NOT NULL
      AND ${within(c, 'o."acceptedAt"', r)}
    GROUP BY 1`);
  return rows.map((x) => ({ id: x.id, accepted: n(x.total), ok: n(x.ok), no: n(x.no), work: n(x.total) - n(x.ok) - n(x.no) }));
}

/** Готовые за период по мастерам: медиана срока и гарантийные возвраты. */
export async function mastersCompleted(c: Ctx, r: Range) {
  const rows = await q<{ id: string; n: bigint; med: number | null; warranty: bigint }>(c, Prisma.sql`
    SELECT o."assignedMasterId" AS id, count(*) AS n,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM o."completedAt" - o."acceptedAt") / 86400) AS med,
           count(*) FILTER (WHERE wr.pid IS NOT NULL) AS warranty
    FROM "Order" o JOIN "OrderStatus" s ON s.id = o."statusId" ${WARRANTY_JOIN(c)}
    WHERE o."tenantId" = ${c.tenantId} AND o."deletedAt" IS NULL AND o."assignedMasterId" IS NOT NULL
      AND o."completedAt" IS NOT NULL AND s."group" <> 'CANCELLED' AND o."completedAt" >= o."acceptedAt"
      AND ${within(c, 'o."completedAt"', r)}
    GROUP BY 1`);
  return new Map(rows.map((x) => [x.id, { n: n(x.n), median: x.med === null ? null : Number(x.med), warranty: n(x.warranty) }]));
}

/**
 * Работы по выданным за период — на того, кто их сделал: мастер строки
 * работ, без него — мастер заказа (как в зарплате). Со скидкой клиента на
 * работы.
 */
export async function worksByMaster(c: Ctx, r: Range, gran: Gran | "all", master?: string | null) {
  const rows = await q<{ id: string; b: string; v: string | null }>(c, Prisma.sql`
    SELECT coalesce(w."masterId", o."assignedMasterId") AS id, ${bucket(c, 'o."issuedAt"', gran)} AS b,
           sum(w.qty * w.price * (1 - o."workDiscountPercent" / 100)) AS v
    FROM "OrderWork" w JOIN "Order" o ON o.id = w."orderId"
    WHERE w."tenantId" = ${c.tenantId} AND o."deletedAt" IS NULL AND o."issuedAt" IS NOT NULL
      AND ${within(c, 'o."issuedAt"', r)}
      ${master ? Prisma.sql`AND coalesce(w."masterId", o."assignedMasterId") = ${master}` : Prisma.empty}
    GROUP BY 1, 2`);
  return rows.filter((x) => x.id).map((x) => ({ id: x.id, b: x.b, v: n(x.v) }));
}

/** Приёмщики: кто сколько принял и выдал. */
export async function receivers(c: Ctx, r: Range) {
  return q<{ id: string; accepted: bigint; issued: bigint }>(c, Prisma.sql`
    WITH a AS (
      SELECT o."acceptedById" AS id, count(*) AS n FROM "Order" o
      WHERE o."tenantId" = ${c.tenantId} AND o."deletedAt" IS NULL AND ${within(c, 'o."acceptedAt"', r)} GROUP BY 1
    ), i AS (
      SELECT o."issuedById" AS id, count(*) AS n FROM "Order" o
      WHERE o."tenantId" = ${c.tenantId} AND o."deletedAt" IS NULL AND o."issuedById" IS NOT NULL AND ${within(c, 'o."issuedAt"', r)} GROUP BY 1
    )
    SELECT coalesce(a.id, i.id) AS id, coalesce(a.n, 0) AS accepted, coalesce(i.n, 0) AS issued
    FROM a FULL JOIN i ON i.id = a.id`).then((rows) => rows.map((x) => ({ id: x.id, accepted: n(x.accepted), issued: n(x.issued) })));
}

// ---------------------------------------------------------------- список для провала

/** Заказы, принятые в периоде: для списка под графиком. */
export async function drill(c: Ctx, r: Range, master: string | null, limit: number) {
  return q<{
    id: string; number: string; acceptedAt: Date; kind: string | null; brand: string | null; model: string | null;
    master: string | null; total: string; outcome: string; issued: boolean;
  }>(c, Prisma.sql`
    SELECT o.id, o.number, o."acceptedAt", d.kind, d.brand, d.model, u."fullName" AS master, o.total,
           CASE WHEN ${OK} THEN 'ok' WHEN ${NO} THEN 'no' ELSE 'work' END AS outcome, o."issuedAt" IS NOT NULL AS issued
    FROM "Order" o JOIN "OrderStatus" s ON s.id = o."statusId"
    LEFT JOIN "Device" d ON d.id = o."deviceId" LEFT JOIN "User" u ON u.id = o."assignedMasterId"
    WHERE o."tenantId" = ${c.tenantId} AND o."deletedAt" IS NULL AND ${within(c, 'o."acceptedAt"', r)} ${byMaster(master)}
    ORDER BY o."acceptedAt" DESC LIMIT ${limit}`);
}

export async function countAccepted(c: Ctx, r: Range, master: string | null) {
  const [x] = await q<{ n: bigint }>(c, Prisma.sql`
    SELECT count(*) AS n FROM "Order" o
    WHERE o."tenantId" = ${c.tenantId} AND o."deletedAt" IS NULL AND ${within(c, 'o."acceptedAt"', r)} ${byMaster(master)}`);
  return n(x?.n);
}

/** Первый день, с которого в мастерской есть заказы, — начало «всего времени». */
export async function firstDay(c: Ctx) {
  const [x] = await q<{ d: string | null }>(c, Prisma.sql`
    SELECT to_char(min(${local(c.tz, 'o."acceptedAt"')}), 'YYYY-MM-DD') AS d FROM "Order" o
    WHERE o."tenantId" = ${c.tenantId} AND o."deletedAt" IS NULL`);
  return x?.d ?? null;
}
