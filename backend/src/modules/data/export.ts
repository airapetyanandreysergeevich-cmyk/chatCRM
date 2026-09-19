import type { Prisma } from "@prisma/client";
import { labelsText } from "../../lib/dictionaries";
import { DATASETS, type DatasetKey } from "./dataset";
import type { SheetData } from "./tableFile";

/**
 * Сбор данных мастерской для выгрузки.
 *
 * Читаем через переданный tx — то есть внутри withTenant, под изоляцией.
 * Ограничение сверху есть у каждой таблицы: выгрузка не должна превращаться
 * в способ положить сервер, случайно или намеренно.
 *
 * Берём ровно те поля, которые попадут в файл: include тянет строку целиком,
 * а в базе мастерской с пятью тысячами заказов это лишние мегабайты и лишние
 * секунды. Секунды здесь не про красоту — транзакция ограничена по сроку, и
 * выгрузка, не уложившаяся в него, падает «Внутренней ошибкой».
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

/** Число без хвоста из нулей: 3500, а не 3500.00 — файл читает человек. */
const plain = (v: Prisma.Decimal | number | null | undefined): string => {
  const n = num(v);
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)));
};

/**
 * Состав работ или запчастей одной строкой: «Замена матрицы — 3500; Чистка ×2 — 500».
 *
 * Количество пишем только когда оно не единица: «×1» у каждой строки — это
 * шум, за которым перестаёт читаться главное. Разбор понимает оба написания.
 *
 * Точку с запятой и тире из названия убираем: ими разделены сами позиции, и
 * работа с названием «Чистка; профилактика» разъехалась бы на две при
 * следующей загрузке этого же файла. Потеря невелика, а тихая порча состава
 * обнаружилась бы через полгода и не здесь.
 */
const composition = (
  rows: Array<{ name: string; qty: Prisma.Decimal | number; price: Prisma.Decimal | number }>
): string =>
  rows
    .map((r) => {
      const name = r.name.replace(/[;\r\n]+/g, ",").replace(/\s[—–-]\s/g, " ").trim();
      const qty = num(r.qty);
      return `${name}${qty === 1 ? "" : ` ×${plain(qty)}`} — ${plain(r.price)}`;
    })
    .join("; ");

async function customersSheet(tx: Prisma.TransactionClient): Promise<SheetData> {
  const def = DATASETS.customers;
  const rows = await tx.customer.findMany({
    where: { deletedAt: null },
    orderBy: { name: "asc" },
    take: MAX_ROWS,
    select: {
      id: true,
      number: true,
      type: true,
      name: true,
      phone: true,
      phone2: true,
      email: true,
      address: true,
      inn: true,
      source: true,
      discountPercent: true,
      note: true,
      createdAt: true,
      devices: { select: { kind: true, brand: true, model: true, serial: true } },
    },
  });

  // Число заказов — одним запросом с группировкой, а не счётчиком на каждую
  // карточку: пять тысяч подсчётов по одному занимают больше времени, чем
  // отведено всей выгрузке.
  const counts = new Map<string, number>();
  if (rows.length) {
    const grouped = await tx.order.groupBy({
      by: ["customerId"],
      where: { deletedAt: null },
      _count: { _all: true },
    });
    for (const g of grouped) counts.set(g.customerId, g._count._all);
  }

  return {
    name: def.sheet,
    columns: def.columns.map((c) => ({ title: c.title, width: c.width })),
    rows: rows.map((c) => [
      c.number,
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
      counts.get(c.id) ?? 0,
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
    select: {
      number: true,
      acceptedAt: true,
      kind: true,
      isUrgent: true,
      complaint: true,
      completeness: true,
      appearance: true,
      receptionNote: true,
      diagnosis: true,
      dueAt: true,
      completedAt: true,
      issuedAt: true,
      totalWork: true,
      totalParts: true,
      discount: true,
      total: true,
      warrantyUntil: true,
      customer: { select: { name: true, number: true, phone: true } },
      device: { select: { kind: true, brand: true, model: true, serial: true } },
      status: { select: { name: true } },
      assignedMaster: { select: { fullName: true } },
      // Себестоимость запчасти не берём намеренно: выгрузку открывают и те,
      // кому её видеть не положено, а обратно она всё равно не грузится.
      works: { select: { name: true, qty: true, price: true }, orderBy: { createdAt: "asc" } },
      parts: { select: { name: true, qty: true, price: true }, orderBy: { createdAt: "asc" } },
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
      o.customer?.number ?? "",
      o.customer?.phone ?? "",
      o.device?.kind ?? "",
      o.device?.brand ?? "",
      o.device?.model ?? "",
      o.device?.serial ?? "",
      o.complaint,
      // Старые заказы лежат чек-листом, новые — списком строк; labelsText
      // читает оба и отдаёт одну строку через запятую.
      labelsText(o.completeness),
      labelsText(o.appearance),
      o.receptionNote,
      o.diagnosis,
      o.assignedMaster?.fullName ?? "",
      o.dueAt,
      o.completedAt,
      o.issuedAt,
      num(o.totalWork),
      composition(o.works),
      num(o.totalParts),
      composition(o.parts),
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
    select: {
      sku: true,
      name: true,
      category: true,
      unit: true,
      minQty: true,
      balances: {
        select: { qty: true, avgCost: true, warehouse: { select: { name: true } } },
      },
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

async function servicesSheet(tx: Prisma.TransactionClient): Promise<SheetData> {
  const def = DATASETS.services;
  const items = await tx.service.findMany({
    orderBy: { name: "asc" },
    take: MAX_ROWS,
    select: { name: true, price: true, note: true, isPinned: true },
  });

  return {
    name: def.sheet,
    columns: def.columns.map((c) => ({ title: c.title, width: c.width })),
    rows: items.map((s) => [s.name, num(s.price), s.note, s.isPinned ? "да" : ""]),
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
    if (key === "services") out.push(await servicesSheet(tx));
  }
  return out;
}
