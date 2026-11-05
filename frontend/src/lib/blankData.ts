import { formatDate, formatDateTime } from "./format";
import type { Order } from "./orders";
import type { PrintForms } from "./printForms";
import { warrantyLabel, type Sale } from "./salesApi";
import { rublesWords } from "./words";
import type { ColKey, DocUse, TableSource, Target } from "./blankModel";

/**
 * Данные для бланка редактора (05.11.2026): поля из базы, строки таблиц и
 * тестовый заказ / продажа для «Вида печати» в редакторе.
 *
 * Поле — ключ латиницей (в бланке <span data-f="customer">), подпись
 * по-русски — в списке ниже. Деньги — только тому, кто видит их в системе:
 * у заказа без сумм (order.total не пришёл) денежные поля пустые.
 */

export interface FieldDef {
  key: string;
  label: string;
  group: string;
  /** Пример — подпись поля в редакторе, пока не включён «Вид печати». */
  sample: string;
}

const F = (group: string, list: Array<[key: string, label: string, sample: string]>): FieldDef[] =>
  list.map(([key, label, sample]) => ({ key, label, group, sample }));

export const ORDER_FIELDS: FieldDef[] = [
  ...F("Заказ", [
    ["number", "Номер заказа", "Р-2026-00123"],
    ["kind", "Тип заказа", "Ремонт"],
    ["status", "Статус", "Готов"],
    ["today", "Сегодня", "05.11.2026"],
    ["acceptedAt", "Дата приёма", "03.11.2026"],
    ["acceptedTime", "Дата и время приёма", "03.11.2026, 10:42"],
    ["dueAt", "Срок готовности", "06.11.2026"],
    ["completedAt", "Дата готовности", "05.11.2026, 15:10"],
    ["issuedAt", "Дата выдачи", "05.11.2026"],
    ["issuedTime", "Дата и время выдачи", "05.11.2026, 18:20"],
    ["prevRepair", "По гарантии к заказу", "Р-2026-00098 от 12.10.2026"],
    ["storage", "Место хранения", "Полка 3"],
  ]),
  ...F("Клиент", [
    ["customer", "Клиент", "Иванов Иван Иванович"],
    ["phone", "Телефон", "+7 918 123-45-67"],
    ["phone2", "Второй телефон", "+7 900 765-43-21"],
    ["email", "Эл. почта", "ivanov@mail.ru"],
    ["address", "Адрес клиента", "ул. Ленина, 1"],
    ["outsource", "Номер аутсорса", "А-5521"],
  ]),
  ...F("Техника", [
    ["device", "Устройство", "Ноутбук Lenovo IdeaPad 3"],
    ["deviceKind", "Тип техники", "Ноутбук"],
    ["brand", "Марка", "Lenovo"],
    ["model", "Модель", "IdeaPad 3 15ITL6"],
    ["serial", "Серийный номер", "PF3K9ZQ1"],
    ["passcode", "Пароль устройства", "1234"],
    ["completeness", "Комплектность", "Ноутбук, зарядное устройство"],
    ["appearance", "Внешнее состояние", "Потёртости, скол на крышке"],
    ["complaint", "Неисправность", "Не включается, перегревается"],
    ["diagnosis", "Диагноз", "Залита материнская плата"],
    ["recommendation", "Рекомендации", "Чистка раз в год"],
  ]),
  ...F("Люди", [
    ["acceptedBy", "Принял", "Ольга Смирнова"],
    ["master", "Мастер", "Дмитрий Козлов"],
    ["issuedBy", "Выдал", "Ольга Смирнова"],
  ]),
  ...F("Деньги", [
    ["estimate", "Ориентировочная стоимость", "4 000 ₽"],
    ["limit", "Согласовано клиентом до", "6 000 ₽"],
    ["prepayment", "Предоплата", "1 000 ₽"],
    ["totalWork", "Работы", "3 300 ₽"],
    ["totalParts", "Запчасти", "2 150 ₽"],
    ["workDiscount", "Скидка на работы", "330 ₽"],
    ["discount", "Скидка при выдаче", "200 ₽"],
    ["total", "Итого", "4 920 ₽"],
    ["totalWords", "Итого прописью", "Четыре тысячи девятьсот двадцать рублей 00 копеек"],
    ["paid", "Оплачено", "4 920 ₽"],
    ["toPay", "К оплате", "3 920 ₽"],
    ["payment", "Оплата", "наличный расчёт"],
    ["warranty", "Гарантия", "90 дней"],
    ["warrantyUntil", "Гарантия до", "03.02.2027"],
  ]),
  ...F("Повторная выдача", [
    ["extraPrev", "Выдан ранее", "28.10.2026"],
    ["extraReason", "Причина повторного обращения", "Снова не заряжается"],
    ["extraBefore", "Итог прошлой выдачи", "3 000 ₽"],
    ["extraAmount", "К доплате", "1 920 ₽"],
  ]),
  ...F("Мастерская", [
    ["workshop", "Название мастерской", "Мастерская"],
    ["requisites", "Реквизиты", "г. Город, ул. Мира, 5 · +7 900 000-00-00"],
    ["footer", "Строка внизу листа", "Спасибо, что выбрали нас!"],
  ]),
];

export const SALE_FIELDS: FieldDef[] = [
  ...F("Продажа", [
    ["number", "Номер чека", "П-2026-00012"],
    ["today", "Сегодня", "05.11.2026"],
    ["date", "Дата продажи", "05.11.2026, 12:30"],
    ["customer", "Покупатель", "Иванов Иван"],
    ["phone", "Телефон покупателя", "+7 918 123-45-67"],
    ["seller", "Продавец", "Ольга Смирнова"],
    ["note", "Примечание", "Самовывоз"],
    ["returned", "Отметка о возврате", "Возвращена 06.11.2026"],
  ]),
  ...F("Деньги", [
    ["units", "Товаров, шт.", "3"],
    ["subtotal", "Сумма без скидки", "4 700 ₽"],
    ["discount", "Скидка", "200 ₽"],
    ["total", "Итого", "4 500 ₽"],
    ["totalWords", "Итого прописью", "Четыре тысячи пятьсот рублей 00 копеек"],
    ["payment", "Оплата", "Наличные (наличный расчёт)"],
    ["warranty", "Гарантия", "6 мес."],
    ["warrantyUntil", "Гарантия до", "05.05.2027"],
  ]),
  ...F("Мастерская", [
    ["workshop", "Название мастерской", "Мастерская"],
    ["requisites", "Реквизиты", "г. Город, ул. Мира, 5 · +7 900 000-00-00"],
    ["footer", "Строка внизу листа", "Спасибо за покупку!"],
  ]),
];

export const fieldsOf = (t: Target) => (t === "sale" ? SALE_FIELDS : ORDER_FIELDS);
export const fieldLabel = (t: Target, key: string) => fieldsOf(t).find((f) => f.key === key)?.label ?? key;

export const SOURCES: Record<Target, Array<{ key: TableSource; label: string }>> = {
  order: [
    { key: "lines", label: "Работы и запчасти вместе" },
    { key: "works", label: "Работы" },
    { key: "parts", label: "Запчасти" },
    { key: "extraWorks", label: "Работы, добавленные после выдачи" },
    { key: "extraParts", label: "Запчасти, добавленные после выдачи" },
  ],
  sale: [{ key: "items", label: "Товары" }],
};

export const COL_LABEL: Record<ColKey, string> = {
  no: "№",
  name: "Наименование",
  sku: "Артикул",
  qty: "Кол-во",
  price: "Цена",
  sum: "Сумма",
  warranty: "Гарантия",
};

/** Какие столбцы есть у источника. */
export const COLS_OF: Record<TableSource, ColKey[]> = {
  lines: ["no", "name", "warranty", "qty", "price", "sum"],
  works: ["no", "name", "warranty", "qty", "price", "sum"],
  parts: ["no", "name", "qty", "price", "sum"],
  extraWorks: ["no", "name", "qty", "price", "sum"],
  extraParts: ["no", "name", "qty", "price", "sum"],
  items: ["no", "name", "sku", "qty", "price", "sum"],
};

export type Row = Record<ColKey, string> & { sumNum: number };

export interface BlankData {
  values: Record<string, string>;
  tables: Partial<Record<TableSource, Row[]>>;
  /** Логотип бумаги из «Бланков». */
  logo: string | null;
}

/** 1 500 ₽, 1 500,50 ₽. */
export const money = (v: number | null | undefined) =>
  v === null || v === undefined ? "" : `${v.toLocaleString("ru-RU", { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 })} ₽`;
const qtyText = (n: number) => (Number.isInteger(n) ? String(n) : String(n).replace(".", ","));
const date = (v: string | null | undefined) => (v ? formatDate(v) : "");
const dateTime = (v: string | null | undefined) => (v ? formatDateTime(v) : "");
const days = (d: number | null | undefined) => (d ? warrantyLabel(d) : "");

function rows(list: Array<{ name: string; qty: number; price: number; warrantyDays?: number | null; sku?: string | null }>, showMoney: boolean): Row[] {
  return list.map((x, i) => {
    const sum = Math.round(x.qty * x.price * 100) / 100;
    return {
      no: String(i + 1),
      name: x.name,
      sku: x.sku ?? "",
      qty: qtyText(x.qty),
      price: showMoney ? money(x.price) : "",
      sum: showMoney ? money(sum) : "",
      warranty: x.warrantyDays ? days(x.warrantyDays) : "",
      sumNum: showMoney ? sum : 0,
    };
  });
}

const KIND_LABEL: Record<string, string> = {
  REPAIR: "Ремонт",
  DIAGNOSTICS: "Диагностика",
  WARRANTY: "Гарантийный ремонт",
  REPEAT: "Повторный ремонт",
  BRAND_WARRANTY: "Гарантия производителя",
};

/** Поля заказа. doc — какой документ печатаем: у акта дата выдачи «сегодня», пока не выдан. */
export function orderData(order: Order, forms: PrintForms, workshop: string, doc: DocUse | null): BlankData {
  const showMoney = order.total !== undefined;
  const m = (v: number | null | undefined) => (showMoney ? money(v ?? 0) : "");
  const c = order.customer;
  const worksWarranty = Math.max(0, ...order.works.map((w) => w.warrantyDays ?? 0)) || null;
  const warrantyDays = order.warrantyDays || worksWarranty;
  const base = order.completedAt ?? order.issuedAt ?? null;
  const until =
    order.warrantyDays && order.warrantyUntil
      ? order.warrantyUntil
      : warrantyDays && base
        ? new Date(new Date(base).getTime() + warrantyDays * 86_400_000).toISOString()
        : null;
  const byAct = new Map<string, number>();
  for (const p of order.payments ?? []) byAct.set(p.act, (byAct.get(p.act) ?? 0) + p.amount);
  const payParts = [...byAct.entries()].map(([act, sum]) => `${act === "CASH" ? "наличный" : "безналичный"} расчёт${byAct.size > 1 ? ` ${money(sum)}` : ""}`);
  if (order.paymentMethod === "DEBT") payParts.push(payParts.length ? "остаток — в долг" : "в долг");
  const paid = [...byAct.values()].reduce((a, b) => a + b, 0);
  const issued = order.issuedAt ?? (doc && doc !== "intake" ? new Date().toISOString() : null);
  const total = order.total ?? 0;
  const values: Record<string, string> = {
    number: order.number,
    kind: KIND_LABEL[order.kind] ?? "",
    status: order.status?.name ?? "",
    today: formatDate(new Date().toISOString()),
    acceptedAt: date(order.acceptedAt),
    acceptedTime: dateTime(order.acceptedAt),
    dueAt: date(order.dueAt),
    completedAt: dateTime(order.completedAt),
    issuedAt: date(issued),
    issuedTime: dateTime(issued),
    prevRepair: order.previousRepair ? `${order.previousRepair.number}${order.previousRepair.issuedAt ? ` от ${formatDate(order.previousRepair.issuedAt)}` : ""}` : "",
    storage: order.storageLocation ?? "",
    customer: c.name ?? "",
    phone: c.phone ?? "",
    phone2: c.phone2 ?? "",
    email: c.email ?? "",
    address: c.address ?? "",
    outsource: order.outsourceNumber ?? "",
    device: [order.device?.kind, order.device?.brand, order.device?.model].filter(Boolean).join(" "),
    deviceKind: order.device?.kind ?? "",
    brand: order.device?.brand ?? "",
    model: order.device?.model ?? "",
    serial: order.device?.serial ?? "",
    passcode: order.devicePasscode ?? "",
    completeness: order.completeness.join(", "),
    appearance: [...order.appearance, order.appearanceNote].filter(Boolean).join(", "),
    complaint: order.complaint ?? "",
    diagnosis: order.diagnosis ?? "",
    recommendation: order.recommendation ?? "",
    acceptedBy: order.acceptedBy?.fullName ?? "",
    master: order.assignedMaster?.fullName ?? "",
    issuedBy: order.issuedBy?.fullName ?? "",
    estimate: showMoney && order.estimatedCost ? money(order.estimatedCost) : "",
    limit: showMoney && order.approvedLimit ? money(order.approvedLimit) : "",
    prepayment: showMoney && order.prepayment ? money(order.prepayment) : "",
    totalWork: m(order.totalWork),
    totalParts: m(order.totalParts),
    workDiscount: showMoney && order.workDiscount ? money(order.workDiscount) : "",
    discount: showMoney && order.discount ? money(order.discount) : "",
    total: m(total),
    totalWords: showMoney ? rublesWords(total) : "",
    paid: showMoney && paid ? money(paid) : "",
    toPay: showMoney ? money(Math.max(0, total - (order.prepayment ?? 0))) : "",
    payment: payParts.join(", "),
    warranty: days(warrantyDays),
    warrantyUntil: date(until),
    extraPrev: order.extra ? date(order.extra.prevIssuedAt) : "",
    extraReason: order.extra?.reason ?? "",
    extraBefore: showMoney && order.extra?.totalBefore !== undefined ? money(order.extra.totalBefore) : "",
    extraAmount: showMoney && order.extra?.amount !== undefined ? money(Math.max(0, order.extra.amount)) : "",
    workshop: forms.name || workshop,
    requisites: forms.requisites ?? "",
    footer: forms.footer ?? "",
  };
  const works = order.works.map((w) => ({ name: w.name, qty: w.qty, price: w.price, warrantyDays: w.warrantyDays ?? null }));
  const parts = order.parts.map((p) => ({ name: p.name, qty: p.qty, price: p.price }));
  return {
    values,
    logo: forms.logo,
    tables: {
      works: rows(works, showMoney),
      parts: rows(parts, showMoney),
      lines: rows([...works, ...parts], showMoney),
      extraWorks: rows(order.extra?.works ?? [], showMoney),
      extraParts: rows(order.extra?.parts ?? [], showMoney),
    },
  };
}

export function saleData(sale: Sale, forms: PrintForms, workshop: string): BlankData {
  const values: Record<string, string> = {
    number: sale.number,
    today: formatDate(new Date().toISOString()),
    date: dateTime(sale.createdAt),
    customer: sale.customer?.name ?? "",
    phone: sale.customer?.phone ?? "",
    seller: sale.soldBy?.fullName ?? "",
    note: sale.note ?? "",
    returned: sale.returnedAt ? `Продажа возвращена ${formatDateTime(sale.returnedAt)}${sale.returnReason ? `: ${sale.returnReason}` : ""}` : "",
    units: String(sale.items.reduce((n, i) => n + i.qty, 0)),
    subtotal: money(sale.subtotal),
    discount: sale.discount ? money(sale.discount) : "",
    total: money(sale.total),
    totalWords: rublesWords(sale.total),
    payment: `${sale.paymentLabel ?? sale.payment}${sale.paymentAct ? ` (${sale.paymentAct === "CASH" ? "наличный" : "безналичный"} расчёт)` : ""}`,
    warranty: sale.warrantyDays ? warrantyLabel(sale.warrantyDays) : "",
    warrantyUntil: date(sale.warrantyUntil),
    workshop: forms.name || workshop,
    requisites: forms.requisites ?? "",
    footer: forms.footer ?? "",
  };
  return {
    values,
    logo: forms.logo,
    tables: { items: rows(sale.items.map((i) => ({ name: i.name, qty: i.qty, price: i.price, sku: i.sku })), true) },
  };
}

// ------------------------------------------------------------ тестовые данные

const iso = (daysAgo: number, h = 10, min = 0) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(h, min, 0, 0);
  return d.toISOString();
};

/** Заказ для «Вида печати» в редакторе: всё заполнено, чтобы оценить бланк целиком. */
export function sampleOrder(): Order {
  const works = [
    { id: "w1", name: "Диагностика", qty: 1, price: 500, warrantyDays: null },
    { id: "w2", name: "Чистка системы охлаждения с заменой термопасты", qty: 1, price: 1500, warrantyDays: 30 },
    { id: "w3", name: "Замена разъёма питания", qty: 1, price: 1300, warrantyDays: 90 },
  ];
  const parts = [
    { id: "p1", name: "Разъём питания DC-030", qty: 1, price: 450, source: "STOCK" as const },
    { id: "p2", name: "Термопаста Arctic MX-4, 4 г", qty: 1, price: 700, source: "STOCK" as const },
    { id: "p3", name: "Термопрокладка 1 мм", qty: 2, price: 500, source: "STOCK" as const },
  ];
  return {
    id: "sample",
    number: "Р-2026-00123",
    kind: "REPAIR",
    isUrgent: false,
    status: { id: "s", name: "Выдан", group: "CLOSED", color: null } as unknown as Order["status"],
    branch: null,
    acceptedAt: iso(3, 10, 42),
    dueAt: iso(-1, 18),
    completedAt: iso(1, 15, 10),
    issuedAt: iso(0, 18, 20),
    customer: { id: "c", type: "INDIVIDUAL", name: "Иванов Иван Иванович", phone: "+7 918 123-45-67", phone2: "+7 900 765-43-21", email: "ivanov@mail.ru", address: "г. Краснодар, ул. Ленина, 1, кв. 5" },
    device: { id: "d", kind: "Ноутбук", brand: "Lenovo", model: "IdeaPad 3 15ITL6", serial: "PF3K9ZQ1" },
    complaint: "Не включается после перегрева, шумит вентилятор, разболтан разъём зарядки",
    receptionNote: null,
    devicePasscode: "1234",
    completeness: ["Ноутбук", "Зарядное устройство", "Сумка"],
    appearance: ["Потёртости", "Скол на крышке"],
    appearanceNote: null,
    hasOpenTraces: false,
    hasWaterDamage: false,
    storageLocation: "Полка 3",
    outsourceNumber: null,
    approvedLimit: 6000,
    diagnosis: "Забита система охлаждения, сломан разъём питания",
    masterComment: null,
    internalComment: null,
    recommendation: "Чистка системы охлаждения раз в год",
    warrantyDays: null,
    warrantyUntil: null,
    acceptedBy: { id: "u1", fullName: "Ольга Смирнова" },
    assignedMaster: { id: "u2", fullName: "Дмитрий Козлов" },
    issuedBy: { id: "u1", fullName: "Ольга Смирнова" },
    works,
    parts,
    attachments: [],
    totalWork: 3300,
    totalParts: 2150,
    previousRepair: null,
    extra: { times: 1, reopenedAt: iso(1), reason: "Снова плохо заряжается", prevIssuedAt: iso(8), works: [{ name: "Пайка разъёма питания", qty: 1, price: 800 }], parts: [], totalBefore: 4650, amount: 800 } as unknown as Order["extra"],
    parentOrderId: null,
    estimatedCost: 4000,
    workDiscountPercent: 10,
    workDiscount: 330,
    prepayment: 1000,
    discount: 200,
    total: 4920,
    paymentMethod: "CASH" as Order["paymentMethod"],
    payments: [{ label: "Наличные", act: "CASH", amount: 3920 }],
  } as Order;
}

export function sampleSale(): Sale {
  return {
    id: "sample",
    number: "П-2026-00012",
    createdAt: iso(0, 12, 30),
    payment: "CASH",
    paymentLabel: "Наличные",
    paymentAct: "CASH",
    subtotal: 4700,
    discount: 200,
    total: 4500,
    warrantyDays: 180,
    warrantyUntil: iso(-180),
    note: null,
    customer: { id: "c", name: "Иванов Иван", phone: "+7 918 123-45-67" },
    soldBy: { id: "u1", fullName: "Ольга Смирнова" },
    returnedAt: null,
    returnedBy: null,
    returnReason: null,
    items: [
      { id: "i1", stockItemId: null, name: "Блок питания 19V 3.42A 90W", sku: "BP-1934", qty: 1, price: 1800, sum: 1800 },
      { id: "i2", stockItemId: null, name: "Мышь беспроводная Logitech M185", sku: "LG-185", qty: 1, price: 1200, sum: 1200 },
      { id: "i3", stockItemId: null, name: "Кабель USB-C — USB-C, 1 м", sku: "CB-0101", qty: 2, price: 850, sum: 1700 },
    ],
  };
}
