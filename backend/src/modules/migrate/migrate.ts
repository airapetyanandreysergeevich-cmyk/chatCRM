import { randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import { hashPassword } from "../../lib/password";
import { applyRows } from "../data/apply";
import type { DatasetKey } from "../data/dataset";
import { parseRows, type RowIssue } from "../data/import";
import type { TableRow } from "../data/tableFile";
import { freeLogin } from "../staff/login";
import type { Converted } from "./sources/types";

/**
 * Перенос базы из другой программы: предпросмотр и запись.
 *
 * Всё, что источник разложил по нашим таблицам, заходит обычной загрузкой
 * «Баз» (parseRows → applyRows) — с теми же проверками строк, слиянием и
 * правилами, что у файлов. Сверх неё здесь только то, чего в файлах нет:
 * сотрудники-мастера, деньги старой программы, история статусов, пароли
 * устройств и продолжение нумерации.
 *
 * Перенос — только в пустую базу и одной транзакцией: либо мастерская
 * получает всё, либо ничего. Наполовину перенесённая база хуже любой другой:
 * по ней нельзя ни работать, ни повторить перенос.
 */

/** Загрузка режет файл на куски: в один разбор больше десяти тысяч строк не берётся. */
const CHUNK = 5000;

const chunks = (rows: TableRow[]): TableRow[][] => {
  const [head, ...body] = rows;
  const out: TableRow[][] = [];
  for (let i = 0; i < body.length; i += CHUNK) out.push([head, ...body.slice(i, i + CHUNK)]);
  return out.length ? out : [[head]];
};

export interface DatasetPreview {
  key: DatasetKey;
  total: number;
  issuesTotal: number;
  issues: RowIssue[];
}

export async function isEmptyForMigration(tx: Prisma.TransactionClient): Promise<boolean> {
  const [orders, customers, stock] = await Promise.all([tx.order.count(), tx.customer.count(), tx.stockItem.count()]);
  return orders + customers + stock === 0;
}

/** Предпросмотр: что загрузка скажет о каждой таблице. Ничего не пишет. */
export async function previewMigration(tx: Prisma.TransactionClient, conv: Converted): Promise<DatasetPreview[]> {
  const out: DatasetPreview[] = [];
  for (const key of ["customers", "stock", "orders"] as const) {
    const all = conv[key];
    const preview: DatasetPreview = { key, total: all.length - 1, issuesTotal: 0, issues: [] };
    for (const part of chunks(all)) {
      if (part.length < 2) continue;
      const p = await parseRows(tx, key, part);
      preview.issuesTotal += p.preview.issuesTotal;
      preview.issues.push(...p.preview.issues);
    }
    preview.issues = preview.issues.slice(0, 100);
    out.push(preview);
  }
  return out;
}

export interface MigrationResult {
  staff: Array<{ name: string; login: string }>;
  staffSkipped: string[];
  customers: number;
  stock: number;
  orders: number;
  payments: number;
  paymentsSum: number;
  history: number;
  failed: Array<RowIssue & { table: string }>;
  nextNumber: string | null;
}

export async function applyMigration(
  tx: Prisma.TransactionClient,
  tenantId: string,
  conv: Converted,
  opts: { ownerId: string; loginDomain: string; slug: string; maxUsers: number; continueNumbering: boolean }
): Promise<MigrationResult> {
  if (!(await isEmptyForMigration(tx))) {
    throw new Error("В базе уже есть заказы, клиенты или склад — перенос делается только в пустую базу");
  }
  const result: MigrationResult = {
    staff: [],
    staffSkipped: [],
    customers: 0,
    stock: 0,
    orders: 0,
    payments: 0,
    paymentsSum: 0,
    history: 0,
    failed: [],
    nextNumber: null,
  };

  // ---- мастера: выключенными и без пароля, который кто-то знает.
  // Кто из них ещё работает, знает только владелец: он включит нужных и
  // задаст им пароли в «Сотрудниках». Выдать входы всем, кто когда-то чинил
  // технику в этой мастерской, значило бы раздать ключи и уволенным.
  const master = await tx.role.findFirst({ where: { code: "MASTER" }, select: { id: true } });
  const existing = new Map(
    (await tx.user.findMany({ where: { deletedAt: null }, select: { fullName: true } })).map((u) => [
      u.fullName.trim().toLowerCase(),
      true,
    ])
  );
  let seats = opts.maxUsers - (await tx.user.count({ where: { deletedAt: null } }));
  const tail = opts.loginDomain || `${opts.slug}.local`;
  const used = new Set<string>();
  const unknownHash = await hashPassword(randomBytes(24).toString("base64url"));
  for (const s of conv.staff) {
    if (existing.has(s.name.toLowerCase())) continue; // уже есть — заказы найдут его по имени
    if (seats <= 0) {
      result.staffSkipped.push(s.name);
      continue;
    }
    const login = await freeLogin(s.local, tail, used);
    await tx.user.create({
      data: {
        tenantId,
        email: login,
        passwordHash: unknownHash,
        fullName: s.name,
        roleId: master?.id ?? null,
        isActive: false,
      },
    });
    result.staff.push({ name: s.name, login });
    seats -= 1;
  }

  // ---- нумерация: следующий заказ — сразу за последним из старой программы.
  if (opts.continueNumbering && conv.lastNumber !== null) {
    const next = conv.lastNumber + 1;
    const template = String(next);
    await tx.tenant.update({
      where: { id: tenantId },
      data: {
        orderNumberTemplate: template,
        orderNumberPrefix: "",
        orderNumberWidth: template.length,
        orderNumberStart: next,
        orderNumberWithYear: false,
        orderNumberNext: next,
        orderNumberYear: null,
      },
    });
    result.nextNumber = template;
  }

  // ---- таблицы — обычной загрузкой
  const load = async (key: DatasetKey, rows: TableRow[]) => {
    let done = 0;
    for (const part of chunks(rows)) {
      if (part.length < 2) continue;
      const parsed = await parseRows(tx, key, part);
      for (const i of parsed.preview.issues) result.failed.push({ ...i, table: key });
      const r = await applyRows(tx, tenantId, key, parsed.rows, opts.ownerId);
      done += r.created + r.updated + r.restored;
      for (const f of r.failed) result.failed.push({ ...f, table: key });
    }
    return done;
  };
  result.customers = await load("customers", conv.customers);
  for (const [number, color] of conv.colors) {
    if (/^\d+$/.test(number)) await tx.customer.updateMany({ where: { number: Number(number) }, data: { color } });
  }
  result.stock = await load("stock", conv.stock);
  result.orders = await load("orders", conv.orders);

  const orders = await tx.order.findMany({ select: { id: true, number: true, customerId: true, statusId: true } });
  const byNumber = new Map(orders.map((o) => [o.number, o]));

  // ---- предоплата, предварительная стоимость и пароли устройств — полями
  // заказа. Пачками одним запросом: по запросу на заказ это тысячи обращений
  // к базе на ровном месте.
  const fields = new Map<string, { prepayment?: number; estimatedCost?: number; devicePasscode?: string }>();
  const put = (number: string, patch: object) => fields.set(number, { ...(fields.get(number) ?? {}), ...patch });
  for (const [number, v] of conv.prepayments) put(number, { prepayment: v });
  for (const [number, v] of conv.estimates) put(number, { estimatedCost: v });
  for (const [number, v] of conv.passcodes) put(number, { devicePasscode: v });
  const updates = [...fields].filter(([number]) => byNumber.has(number));
  for (let i = 0; i < updates.length; i += 1000) {
    const values = updates.slice(i, i + 1000).map(
      ([number, f]) =>
        Prisma.sql`(${byNumber.get(number)!.id}, ${f.prepayment ?? null}::numeric, ${f.estimatedCost ?? null}::numeric, ${f.devicePasscode ?? null}::text)`
    );
    await tx.$executeRaw`
      UPDATE "Order" o
         SET "prepayment" = COALESCE(v.p, o."prepayment"),
             "estimatedCost" = COALESCE(v.e, o."estimatedCost"),
             "devicePasscode" = COALESCE(v.d, o."devicePasscode")
        FROM (VALUES ${Prisma.join(values)}) AS v(id, p, e, d)
       WHERE o.id = v.id AND o."tenantId" = ${tenantId}
    `;
  }

  // ---- деньги старой программы — в свою кассу.
  // Отдельная и выключенная: в ней выручка прошлых лет, а не деньги в ящике.
  // Смешай её с «Кассой» — и остаток, который сверяют с наличными, вырос бы
  // на несколько миллионов. Зато по заказам всё сходится: выданные оплачены,
  // долгов из ниоткуда не появится.
  const payments = conv.payments.filter((p) => byNumber.has(p.number));
  if (payments.length) {
    const register = await tx.cashRegister.create({
      data: { tenantId, name: `Старая программа`, kind: "CASH", isActive: false },
    });
    const name = "Оплата заказа";
    const category =
      (await tx.transactionCategory.findFirst({ where: { name, direction: "IN" } })) ??
      (await tx.transactionCategory.create({ data: { tenantId, name, direction: "IN" } }));
    for (let i = 0; i < payments.length; i += 1000) {
      await tx.transaction.createMany({
        data: payments.slice(i, i + 1000).map((p) => {
          const o = byNumber.get(p.number)!;
          return {
            tenantId,
            cashRegisterId: register.id,
            categoryId: category.id,
            direction: "IN" as const,
            amount: Math.round(p.amount * 100) / 100,
            orderId: o.id,
            customerId: o.customerId,
            comment: p.comment,
            createdAt: p.at,
          };
        }),
      });
    }
    result.payments = payments.length;
    result.paymentsSum = Math.round(payments.reduce((n, p) => n + p.amount, 0));
  }

  // ---- история статусов: по заказу, по времени, «из какого — в какой»
  const statuses = new Map(
    (await tx.orderStatus.findMany({ select: { id: true, name: true } })).map((s) => [s.name.toLowerCase(), s.id])
  );
  const byOrder = new Map<string, typeof conv.history>();
  for (const h of conv.history) {
    if (!byNumber.has(h.number) || !statuses.has(h.status.toLowerCase())) continue;
    byOrder.set(h.number, [...(byOrder.get(h.number) ?? []), h]);
  }
  const historyRows: Prisma.OrderStatusHistoryCreateManyInput[] = [];
  for (const [number, list] of byOrder) {
    const o = byNumber.get(number)!;
    list.sort((a, b) => a.at.getTime() - b.at.getTime());
    let from: string | null = null;
    for (const h of list) {
      const to = statuses.get(h.status.toLowerCase())!;
      if (to === from) continue;
      historyRows.push({
        tenantId,
        orderId: o.id,
        fromStatusId: from,
        toStatusId: to,
        comment: "из старой программы",
        createdAt: h.at,
      });
      from = to;
    }
  }
  for (let i = 0; i < historyRows.length; i += 2000) {
    await tx.orderStatusHistory.createMany({ data: historyRows.slice(i, i + 2000) });
  }
  result.history = historyRows.length;

  return result;
}
