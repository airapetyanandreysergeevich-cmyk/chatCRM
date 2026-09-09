import type { Prisma } from "@prisma/client";
import { DATASETS, type DatasetKey } from "./dataset";
import type { SheetData } from "./tableFile";

/**
 * Сбор данных мастерской для выгрузки.
 *
 * Читаем через переданный tx — то есть внутри withTenant, под изоляцией.
 * Ограничение сверху есть у каждой таблицы: выгрузка не должна превращаться
 * в способ положить сервер, случайно или намеренно.
 */

const MAX_ROWS = 20000;

const num = (v: Prisma.Decimal | number | null | undefined): number =>
  v === null || v === undefined ? 0 : Number(v);

const ORDER_KIND_LABEL: Record<string, string> = {
  REPAIR: "Ремонт",
  DIAGNOSTICS: "Диагностика",
  WARRANTY: "Гарантийный возврат",
  REPEAT: "Повторное обращение",
};

const CUSTOMER_TYPE_LABEL: Record<string, string> = {
  INDIVIDUAL: "Физлицо",
  COMPANY: "Организация",
};

async function customersSheet(tx: Prisma.TransactionClient): Promise<SheetData> {
  const def = DATASETS.customers;
  const rows = await tx.customer.findMany({
    where: { deletedAt: null },
    orderBy: { name: "asc" },
    take: MAX_ROWS,
    include: {
      devices: { select: { kind: true, brand: true, model: true, serial: true } },
      _count: { select: { orders: true } },
    },
  });

  return {
    name: def.sheet,
    columns: def.columns.map((c) => ({ title: c.title, width: c.width })),
    rows: rows.map((c) => [
      CUSTOMER_TYPE_LABEL[c.type] ?? c.type,
      c.name,
      c.phone,
      c.phone2,
      c.email,
      c.address,
      c.inn,
      c.source,
      num(c.discountPercent),
      c.note,
      // Формат такой же, какой ждёт загрузка: «вид Бренд Модель (серийный)».
      c.devices
        .map((d) =>
          [d.kind, d.brand, d.model].filter(Boolean).join(" ") + (d.serial ? ` (${d.serial})` : "")
        )
        .join("; "),
      c._count.orders,
      c.createdAt,
    ]),
  };
}

async function ordersSheet(tx: Prisma.TransactionClient): Promise<SheetData> {
  const def = DATASETS.orders;
  const rows = await tx.order.findMany({
    where: { deletedAt: null },
    orderBy: { acceptedAt: "desc" },
    take: MAX_ROWS,
    include: {
      customer: { select: { name: true, phone: true } },
      device: { select: { kind: true, brand: true, model: true, serial: true } },
      status: { select: { name: true } },
      assignedMaster: { select: { fullName: true } },
    },
  });

  return {
    name: def.sheet,
    columns: def.columns.map((c) => ({ title: c.title, width: c.width })),
    rows: rows.map((o) => [
      o.number,
      o.acceptedAt,
      o.status?.name ?? "",
      ORDER_KIND_LABEL[o.kind] ?? o.kind,
      o.isUrgent ? "да" : "",
      o.customer?.name ?? "",
      o.customer?.phone ?? "",
      o.device?.kind ?? "",
      o.device?.brand ?? "",
      o.device?.model ?? "",
      o.device?.serial ?? "",
      o.complaint,
      o.receptionNote,
      o.diagnosis,
      o.assignedMaster?.fullName ?? "",
      o.dueAt,
      o.completedAt,
      o.issuedAt,
      num(o.totalWork),
      num(o.totalParts),
      num(o.discount),
      num(o.total),
      o.warrantyUntil,
    ]),
  };
}

async function stockSheet(tx: Prisma.TransactionClient): Promise<SheetData> {
  const def = DATASETS.stock;
  const items = await tx.stockItem.findMany({
    orderBy: { name: "asc" },
    take: MAX_ROWS,
    include: {
      balances: { include: { warehouse: { select: { name: true } } } },
    },
  });

  return {
    name: def.sheet,
    columns: def.columns.map((c) => ({ title: c.title, width: c.width })),
    rows: items.map((i) => {
      // Остаток по нескольким складам складываем, а название берём у того,
      // где товар лежит: строка на позицию нужна одна, иначе файл не
      // загрузится обратно без дублей.
      const qty = i.balances.reduce((acc, b) => acc + num(b.qty), 0);
      const main = i.balances.find((b) => num(b.qty) > 0) ?? i.balances[0];
      return [
        i.sku,
        i.name,
        i.category,
        i.unit,
        qty,
        main ? num(main.avgCost) : 0,
        num(i.minQty),
        main?.warehouse?.name ?? "",
      ];
    }),
  };
}

export async function buildSheets(
  tx: Prisma.TransactionClient,
  keys: DatasetKey[]
): Promise<SheetData[]> {
  const out: SheetData[] = [];
  for (const key of keys) {
    if (key === "customers") out.push(await customersSheet(tx));
    if (key === "orders") out.push(await ordersSheet(tx));
    if (key === "stock") out.push(await stockSheet(tx));
  }
  return out;
}
