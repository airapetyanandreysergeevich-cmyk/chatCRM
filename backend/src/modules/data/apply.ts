import type { Prisma } from "@prisma/client";
import { createWithNumber } from "../../lib/customerNumber";
import { parseNumber, phoneKey, type ParsedRow, type RowIssue } from "./import";
import type { DatasetKey } from "./dataset";

/**
 * Запись разобранных строк в базу.
 *
 * Правила, общие для всех таблиц:
 *  — пустая ячейка ничего не затирает. Файл почти всегда неполный, и
 *    «обновить» не должно означать «стереть то, чего в файле не было»;
 *  — строка, упавшая на записи, не отменяет остальные;
 *  — ничего не удаляем. Загрузка добавляет и обновляет, и только.
 *
 * Второе правило держится на точке возврата вокруг каждой строки, и без неё
 * оно было бы обещанием, а не правилом. Вся загрузка идёт одной транзакцией,
 * а в PostgreSQL первая же упавшая команда помечает транзакцию сбойной:
 * дальше любая команда отвечает «current transaction is aborted». Поймать
 * ошибку в try и пойти дальше в такой транзакции нельзя — на 663 строках это
 * выглядело как 663 ошибки, из которых настоящей была одна, а остальные 662
 * были её эхом. Точка возврата откатывает только свою строку.
 */

export interface ApplyResult {
  created: number;
  updated: number;
  failed: RowIssue[];
}

/**
 * Ошибка базы человеческим языком.
 *
 * Prisma на нарушении уникальности говорит «Unique constraint failed on the
 * (not available)» — по этой строке владелец мастерской не поймёт ничего и
 * пришлёт снимок экрана. Разбираем хотя бы то, что разобрать можно.
 */
function humanMessage(err: unknown): string {
  const e = err as { code?: string; meta?: { target?: unknown }; message?: string };
  if (e?.code === "P2002") {
    const target = Array.isArray(e.meta?.target) ? e.meta?.target.join(", ") : String(e.meta?.target ?? "");
    return target ? `такая запись уже есть (${target})` : "такая запись уже есть";
  }
  if (e?.code === "P2003") return "ссылка на запись, которой нет";
  return e?.message ?? String(err);
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

/**
 * Справочники мастерской, прочитанные один раз на всю загрузку.
 *
 * Раньше статус, филиал, мастер и владелец искались заново для каждой строки:
 * на файле в четыре тысячи заказов это сорок тысяч запросов в одной
 * транзакции. Она не то чтобы падала — она шла дольше, чем nginx готов ждать
 * ответа, и человек видел обрыв связи, не зная, записалось хоть что-то.
 *
 * Справочники маленькие и за время загрузки не меняются: их читает та же
 * транзакция, которая пишет.
 */
interface Lookups {
  statusByName: Map<string, string>;
  defaultStatusId: string | null;
  branchId: string | null;
  masterByName: Map<string, string>;
  ownerId: string | null;
  /**
   * Клиенты, уже заведённые в мастерской.
   *
   * По номеру — все, включая удалённых: номер удалённой карточки остаётся
   * занятым, и не увидев её здесь, загрузка пошла бы заводить вторую с тем же
   * номером. По телефону — только живые: совпадение телефона не повод
   * возвращать в базу того, кого владелец убрал намеренно.
   */
  customerByNumber: Map<number, { id: string; deleted: boolean }>;
  customerByPhone: Map<string, string>;
}

const nameKey = (s: string) => s.trim().toLowerCase();

async function readLookups(tx: Prisma.TransactionClient): Promise<Lookups> {
  const [statuses, branch, users, customers] = await Promise.all([
    tx.orderStatus.findMany({ orderBy: { sortOrder: "asc" } }),
    tx.branch.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true } }),
    tx.user.findMany({ where: { deletedAt: null }, select: { id: true, fullName: true, isOwner: true } }),
    tx.customer.findMany({ select: { id: true, number: true, phone: true, deletedAt: true } }),
  ]);

  const statusByName = new Map(statuses.map((s) => [nameKey(s.name), s.id]));
  const initial = statuses.find((s) => s.isInitial) ?? statuses[0];

  return {
    statusByName,
    defaultStatusId: initial?.id ?? null,
    branchId: branch?.id ?? null,
    masterByName: new Map(users.map((u) => [nameKey(u.fullName), u.id])),
    ownerId: users.find((u) => u.isOwner)?.id ?? null,
    customerByNumber: new Map(customers.map((c) => [c.number, { id: c.id, deleted: c.deletedAt !== null }])),
    customerByPhone: new Map(
      customers.filter((c) => c.phone && !c.deletedAt).map((c) => [phoneKey(c.phone), c.id])
    ),
  };
}

export async function applyRows(
  tx: Prisma.TransactionClient,
  tenantId: string,
  dataset: DatasetKey,
  rows: ParsedRow[],
  userId: string | null
): Promise<ApplyResult> {
  const result: ApplyResult = { created: 0, updated: 0, failed: [] };
  const lookups = await readLookups(tx);

  for (const row of rows) {
    // Заведённое строкой попадает в справочники только после её успеха:
    // строка, откатившаяся к точке возврата, не оставила в базе ничего, и
    // запомненный от неё клиент отравил бы все следующие строки ссылкой на
    // запись, которой нет.
    const staged: Array<() => void> = [];

    await tx.$executeRawUnsafe("SAVEPOINT import_row");
    try {
      if (dataset === "customers") await applyCustomer(tx, tenantId, row, userId);
      else if (dataset === "stock") await applyStock(tx, tenantId, row);
      else if (dataset === "services") await applyService(tx, tenantId, row);
      else await applyOrder(tx, tenantId, row, userId, lookups, staged);

      await tx.$executeRawUnsafe("RELEASE SAVEPOINT import_row");
      for (const remember of staged) remember();
      if (row.action === "update") result.updated += 1;
      else result.created += 1;
    } catch (err) {
      await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT import_row");
      await tx.$executeRawUnsafe("RELEASE SAVEPOINT import_row");
      result.failed.push({ row: row.row, message: humanMessage(err) });
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

  // Номер из файла сохраняем как есть — по нему следующая загрузка узнает
  // карточку. Своего номера в файле нет — выдаём очередной. Счётчик трогаем
  // только когда карточку заводим: на обновлении номер уже есть, и жечь на
  // него очередное значение незачем.
  const wanted = Number((v["Номер"] ?? "").trim());

  const customerId = row.existingId
    ? (
        await tx.customer.update({
          where: { id: row.existingId },
          // Карточку, удалённую раньше, загрузка возвращает к жизни: файл с
          // этим клиентом владелец принёс сам, и оставить её удалённой значило
          // бы принять строку и не показать её нигде, а заказы привязать к
          // невидимой карточке.
          data: row.existingDeleted ? { ...data, deletedAt: null } : data,
        })
      ).id
    : (
        await createWithNumber(
          tx,
          tenantId,
          Number.isInteger(wanted) && wanted > 0 ? wanted : null,
          (number) => tx.customer.create({ data: { ...data, tenantId, number, createdById: userId } })
        )
      ).id;

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
    (await tx.warehouse.findFirst({ orderBy: [{ isDefault: "desc" }, { name: "asc" }] })) ??
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

// ------------------------------------------------------------------ услуги

async function applyService(
  tx: Prisma.TransactionClient,
  tenantId: string,
  row: ParsedRow
): Promise<void> {
  const v = row.values;
  // Цену пустой ячейкой не затираем — как и везде. Но у новой услуги цены
  // может не быть вовсе: в схеме там ноль по умолчанию, и это честно
  // означает «договорная», а не «бесплатно».
  const data = {
    price: numOrUndef(v["Цена, ₽"]),
    note: val(v["Примечание"]),
    isPinned: /^(да|1|true|yes|\+)$/i.test((v["В карточке заказа"] ?? "").trim()) || undefined,
  };

  if (row.existingId) {
    await tx.service.update({ where: { id: row.existingId }, data });
    return;
  }

  // Название берём как в файле, а не приведённым к нижнему регистру: ключ
  // нужен для сличения, показывать человеку нужно его собственный текст.
  await tx.service.create({
    data: {
      tenantId,
      name: (val(v["Название"]) ?? "Без названия").replace(/\s+/g, " "),
      price: data.price ?? 0,
      note: data.note,
      isPinned: data.isPinned ?? false,
    },
  });
}

// ------------------------------------------------------------------ заказы

const ORDER_KIND_BY_LABEL: Record<string, string> = {
  ремонт: "REPAIR",
  диагностика: "DIAGNOSTICS",
  "гарантийный возврат": "WARRANTY",
  гарантия: "WARRANTY",
  "повторное обращение": "REPEAT",
};

export function parseDate(raw: string | undefined): Date | undefined {
  const s = val(raw);
  if (!s) return undefined;
  // Сначала «31.12.2026», потом всё остальное: русский формат даты
  // Date разбирает как месяц-день и молча даёт не ту дату.
  //
  // Время забираем, если оно есть. Раньше оно отбрасывалось, и все заказы,
  // перенесённые из другой программы, вставали на полночь — а для заказа,
  // принятого в 18:40, это уже другой рабочий день.
  const ru = s.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})(?:[ T,]+(\d{1,2})[:.-](\d{2}))?/);
  if (ru) {
    const d = new Date(
      Number(ru[3]),
      Number(ru[2]) - 1,
      Number(ru[1]),
      Number(ru[4] ?? 0),
      Number(ru[5] ?? 0)
    );
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

async function applyOrder(
  tx: Prisma.TransactionClient,
  tenantId: string,
  row: ParsedRow,
  userId: string | null,
  lookups: Lookups,
  staged: Array<() => void>
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
  const customer = await findOrCreateCustomer(tx, tenantId, v, userId, lookups, staged);
  const device = await findOrCreateDevice(tx, tenantId, customer.id, v);

  const statusName = val(v["Статус"]);
  const statusId =
    (statusName ? lookups.statusByName.get(nameKey(statusName)) : undefined) ?? lookups.defaultStatusId;
  if (!statusId) throw new Error("в мастерской нет ни одного статуса заказа");

  if (!lookups.branchId) throw new Error("в мастерской нет ни одного филиала");

  const masterName = val(v["Мастер"]);
  const masterId = masterName ? lookups.masterByName.get(nameKey(masterName)) : undefined;

  const kindLabel = (v["Тип обращения"] ?? "").trim().toLowerCase();

  // acceptedById в схеме обязателен: заказ не может быть ничей. Если файл
  // грузит собственник платформы через «войти как», своей учётки внутри
  // мастерской у него нет — записываем приём на владельца.
  const acceptedById = userId ?? lookups.ownerId;
  if (!acceptedById) throw new Error("в мастерской нет владельца, некому записать приём заказа");

  await tx.order.create({
    data: {
      ...common,
      tenantId,
      branchId: lookups.branchId,
      number: (v["Номер"] ?? "").trim(),
      kind: (ORDER_KIND_BY_LABEL[kindLabel] ?? "REPAIR") as "REPAIR",
      customerId: customer.id,
      deviceId: device?.id ?? null,
      statusId,
      acceptedById,
      acceptedAt: parseDate(v["Принят"]) ?? new Date(),
      completeness: [],
      appearance: [],
      // Мастер из файла, если такой сотрудник в мастерской есть. Нет — поле
      // остаётся пустым: заводить сотрудника по строке в чужой выгрузке
      // значит завести ему учётку и доступ.
      assignedMasterId: masterId ?? null,
    },
  });
}

async function findOrCreateCustomer(
  tx: Prisma.TransactionClient,
  tenantId: string,
  v: Record<string, string>,
  userId: string | null,
  lookups: Lookups,
  staged: Array<() => void>
): Promise<{ id: string }> {
  const phone = val(v["Телефон клиента"]) ?? "";

  // Сперва по номеру клиента: он не меняется и не бывает выдуманным. Телефон
  // ищем только потом — в файле заказов он может оказаться дежурным, общим на
  // всю мастерскую, и тогда все заказы слиплись бы на одной карточке.
  //
  // И то и другое ищется в справочнике, прочитанном один раз: в файле на
  // четыре тысячи заказов один и тот же клиент встречается десятки раз, и
  // спрашивать о нём базу каждый раз незачем.
  const wanted = Number(val(v["Номер клиента"]) ?? "");
  if (Number.isInteger(wanted) && wanted > 0) {
    const byNumber = lookups.customerByNumber.get(wanted);
    if (byNumber) {
      // Карточка была удалена — возвращаем её: заказ, привязанный к
      // невидимому клиенту, нельзя ни найти, ни позвонить по нему.
      if (byNumber.deleted) {
        await tx.customer.update({ where: { id: byNumber.id }, data: { deletedAt: null } });
        staged.push(() => {
          byNumber.deleted = false;
        });
      }
      return { id: byNumber.id };
    }
  }

  const key = phone ? phoneKey(phone) : "";
  if (key) {
    const byPhone = lookups.customerByPhone.get(key);
    if (byPhone) return { id: byPhone };
  }

  // Имени может не быть вовсе — и это не повод отказать заказу. Называем
  // карточку номером: «Клиент №1463» видно в списке, его можно найти поиском
  // по номеру, и сразу понятно, что имя ещё предстоит узнать. «Без имени» на
  // сотне карточек так не работает — они сливаются в одну кашу.
  const made = await createWithNumber(
    tx,
    tenantId,
    Number.isInteger(wanted) && wanted > 0 ? wanted : null,
    async (number) => {
      const row = await tx.customer.create({
        data: {
          tenantId,
          number,
          name: val(v["Клиент"]) ?? `Клиент №${number}`,
          phone,
          createdById: userId,
        },
        select: { id: true },
      });
      // Запоминаем только после успеха строки — этим занимается applyRows.
      staged.push(() => {
        lookups.customerByNumber.set(number, { id: row.id, deleted: false });
        if (key) lookups.customerByPhone.set(key, row.id);
      });
      return row;
    }
  );

  return made;
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
