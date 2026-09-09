import type { Prisma } from "@prisma/client";
import { parseNumber, type ParsedRow, type RowIssue } from "./import";
import type { DatasetKey } from "./dataset";

/**
 * Запись разобранных строк в базу.
 *
 * Правила, общие для всех таблиц:
 *  — пустая ячейка ничего не затирает. Файл почти всегда неполный, и
 *    «обновить» не должно означать «стереть то, чего в файле не было»;
 *  — строка, упавшая на записи, не отменяет остальные: возвращаем список
 *    неудач, а не одну общую ошибку;
 *  — ничего не удаляем. Загрузка добавляет и обновляет, и только.
 */

export interface ApplyResult {
  created: number;
  updated: number;
  failed: RowIssue[];
}

/** Значение из файла или undefined — тогда поле не трогаем. */
const val = (v: string | undefined): string | undefined => {
  const s = (v ?? "").trim();
  return s === "" ? undefined : s;
};

const numOrUndef = (v: string | undefined): number | undefined => {
  const s = val(v);
  if (s === undefined) return undefined;
  const n = parseNumber(s);
  return n === null ? undefined : n;
};

export async function applyRows(
  tx: Prisma.TransactionClient,
  tenantId: string,
  dataset: DatasetKey,
  rows: ParsedRow[],
  userId: string | null
): Promise<ApplyResult> {
  const result: ApplyResult = { created: 0, updated: 0, failed: [] };

  for (const row of rows) {
    try {
      if (dataset === "customers") await applyCustomer(tx, tenantId, row, userId);
      else if (dataset === "stock") await applyStock(tx, tenantId, row);
      else await applyOrder(tx, tenantId, row, userId);

      if (row.action === "update") result.updated += 1;
      else result.created += 1;
    } catch (err) {
      result.failed.push({ row: row.row, message: (err as Error).message });
    }
  }

  return result;
}

// ------------------------------------------------------------------ клиенты

async function applyCustomer(
  tx: Prisma.TransactionClient,
  tenantId: string,
  row: ParsedRow,
  userId: string | null
): Promise<void> {
  const v = row.values;
  const typeRaw = (v["Тип"] ?? "").toLowerCase();
  const type = typeRaw.startsWith("орг") || typeRaw.startsWith("юр") ? "COMPANY" : "INDIVIDUAL";

  const data = {
    type: type as "COMPANY" | "INDIVIDUAL",
    name: val(v["Имя"]) ?? "Без имени",
    phone: val(v["Телефон"]) ?? "",
    phone2: val(v["Ещё телефон"]),
    email: val(v["Email"]),
    address: val(v["Адрес"]),
    inn: val(v["ИНН"]),
    source: val(v["Источник"]),
    discountPercent: numOrUndef(v["Скидка, %"]),
    note: val(v["Примечание"]),
  };

  const customerId = row.existingId
    ? (await tx.customer.update({ where: { id: row.existingId }, data })).id
    : (await tx.customer.create({ data: { ...data, tenantId, createdById: userId } })).id;

  await applyDevices(tx, tenantId, customerId, v["Техника"] ?? "");
}

/**
 * «ноутбук Lenovo IdeaPad 5 (PF2XK9LM); ПК HP» — то, что выгружаем сами.
 * Разбираем без фанатизма: вид техники это первое слово, серийный номер —
 * то, что в скобках. Уже существующую технику не задваиваем.
 */
async function applyDevices(
  tx: Prisma.TransactionClient,
  tenantId: string,
  customerId: string,
  raw: string
): Promise<void> {
  const parts = raw.split(";").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return;

  const existing = await tx.device.findMany({
    where: { customerId },
    select: { id: true, kind: true, brand: true, model: true, serial: true },
  });

  for (const part of parts.slice(0, 20)) {
    const serialMatch = part.match(/\(([^)]+)\)\s*$/);
    const serial = serialMatch ? serialMatch[1].trim() : null;
    const words = part.replace(/\([^)]*\)\s*$/, "").trim().split(/\s+/);
    const kind = words.shift() || "техника";
    const brand = words.shift() ?? null;
    const model = words.length ? words.join(" ") : null;

    const already = existing.some((d) =>
      serial
        ? (d.serial ?? "").toLowerCase() === serial.toLowerCase()
        : d.kind === kind && (d.brand ?? "") === (brand ?? "") && (d.model ?? "") === (model ?? "")
    );
    if (already) continue;

    await tx.device.create({ data: { tenantId, customerId, kind, brand, model, serial } });
  }
}

// ------------------------------------------------------------------ склад

async function applyStock(
  tx: Prisma.TransactionClient,
  tenantId: string,
  row: ParsedRow
): Promise<void> {
  const v = row.values;
  const data = {
    sku: val(v["Артикул"]),
    name: val(v["Наименование"]) ?? "Без названия",
    category: val(v["Категория"]),
    unit: val(v["Единица"]) ?? "шт",
    minQty: numOrUndef(v["Минимальный остаток"]),
  };

  const itemId = row.existingId
    ? (await tx.stockItem.update({ where: { id: row.existingId }, data })).id
    : (await tx.stockItem.create({ data: { ...data, tenantId } })).id;

  const qty = numOrUndef(v["Остаток"]);
  const cost = numOrUndef(v["Себестоимость, ₽"]);
  if (qty === undefined && cost === undefined) return;

  // Склад берём названный в файле, иначе первый попавшийся. Если складов
  // нет вовсе, заводим основной: без него остаток некуда положить.
  const wanted = val(v["Склад"]);
  const warehouse =
    (wanted ? await tx.warehouse.findFirst({ where: { name: wanted } }) : null) ??
    (await tx.warehouse.findFirst({ orderBy: { createdAt: "asc" } })) ??
    (await tx.warehouse.create({ data: { tenantId, name: "Основной склад" } }));

  const balance = await tx.stockBalance.findFirst({
    where: { warehouseId: warehouse.id, stockItemId: itemId },
  });

  if (balance) {
    await tx.stockBalance.update({
      where: { id: balance.id },
      data: { qty: qty ?? undefined, avgCost: cost ?? undefined },
    });
  } else {
    await tx.stockBalance.create({
      data: {
        tenantId,
        warehouseId: warehouse.id,
        stockItemId: itemId,
        qty: qty ?? 0,
        avgCost: cost ?? 0,
      },
    });
  }
}

// ------------------------------------------------------------------ заказы

const ORDER_KIND_BY_LABEL: Record<string, string> = {
  ремонт: "REPAIR",
  диагностика: "DIAGNOSTICS",
  "гарантийный возврат": "WARRANTY",
  гарантия: "WARRANTY",
  "повторное обращение": "REPEAT",
};

function parseDate(raw: string | undefined): Date | undefined {
  const s = val(raw);
  if (!s) return undefined;
  // Сначала «31.12.2026», потом всё остальное: русский формат даты
  // Date разбирает как месяц-день и молча даёт не ту дату.
  const ru = s.match(/^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})/);
  if (ru) {
    const d = new Date(Number(ru[3]), Number(ru[2]) - 1, Number(ru[1]));
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

async function applyOrder(
  tx: Prisma.TransactionClient,
  tenantId: string,
  row: ParsedRow,
  userId: string | null
): Promise<void> {
  const v = row.values;

  const common = {
    complaint: val(v["Неисправность"]) ?? "",
    receptionNote: val(v["Примечание приёмщика"]),
    diagnosis: val(v["Диагноз"]),
    isUrgent: /^(да|1|true|yes)$/i.test(v["Срочный"] ?? "") || undefined,
    dueAt: parseDate(v["Срок готовности"]),
    completedAt: parseDate(v["Завершён"]),
    issuedAt: parseDate(v["Выдан"]),
    warrantyUntil: parseDate(v["Гарантия до"]),
    totalWork: numOrUndef(v["Работы, ₽"]),
    totalParts: numOrUndef(v["Запчасти, ₽"]),
    discount: numOrUndef(v["Скидка, ₽"]),
    total: numOrUndef(v["Итого, ₽"]),
  };

  if (row.existingId) {
    await tx.order.update({ where: { id: row.existingId }, data: common });
    return;
  }

  // Новый заказ тянет за собой клиента, технику и статус. Ничего из этого
  // не выдумываем молча: если статуса с таким названием нет, берём начальный.
  const customer = await findOrCreateCustomer(tx, tenantId, v, userId);
  const device = await findOrCreateDevice(tx, tenantId, customer.id, v);

  const statusName = val(v["Статус"]);
  const status =
    (statusName ? await tx.orderStatus.findFirst({ where: { name: statusName } }) : null) ??
    (await tx.orderStatus.findFirst({ where: { isInitial: true } })) ??
    (await tx.orderStatus.findFirst({ orderBy: { sortOrder: "asc" } }));
  if (!status) throw new Error("в мастерской нет ни одного статуса заказа");

  const branch = await tx.branch.findFirst({ orderBy: { createdAt: "asc" } });
  if (!branch) throw new Error("в мастерской нет ни одного филиала");

  const masterName = val(v["Мастер"]);
  const master = masterName
    ? await tx.user.findFirst({ where: { fullName: masterName, deletedAt: null } })
    : null;

  const kindLabel = (v["Тип обращения"] ?? "").trim().toLowerCase();

  await tx.order.create({
    data: {
      ...common,
      tenantId,
      branchId: branch.id,
      number: (v["Номер"] ?? "").trim(),
      kind: (ORDER_KIND_BY_LABEL[kindLabel] ?? "REPAIR") as "REPAIR",
      customerId: customer.id,
      deviceId: device?.id ?? null,
      statusId: status.id,
      acceptedById: userId,
      acceptedAt: parseDate(v["Принят"]) ?? new Date(),
      completeness: [],
      appearance: [],
    },
  });
}

async function findOrCreateCustomer(
  tx: Prisma.TransactionClient,
  tenantId: string,
  v: Record<string, string>,
  userId: string | null
): Promise<{ id: string }> {
  const phone = val(v["Телефон клиента"]) ?? "";
  const digits = phone.replace(/\D/g, "").slice(-10);

  const found = digits
    ? await tx.customer.findFirst({
        where: { deletedAt: null, phone: { contains: digits } },
        select: { id: true },
      })
    : null;
  if (found) return found;

  return tx.customer.create({
    data: {
      tenantId,
      name: val(v["Клиент"]) ?? "Без имени",
      phone,
      createdById: userId,
    },
    select: { id: true },
  });
}

async function findOrCreateDevice(
  tx: Prisma.TransactionClient,
  tenantId: string,
  customerId: string,
  v: Record<string, string>
): Promise<{ id: string } | null> {
  const kind = val(v["Техника"]);
  const serial = val(v["Серийный номер"]);
  if (!kind && !serial) return null;

  if (serial) {
    const found = await tx.device.findFirst({ where: { serial }, select: { id: true } });
    if (found) return found;
  }

  return tx.device.create({
    data: {
      tenantId,
      customerId,
      kind: kind ?? "техника",
      brand: val(v["Бренд"]),
      model: val(v["Модель"]),
      serial: serial ?? null,
    },
    select: { id: true },
  });
}
