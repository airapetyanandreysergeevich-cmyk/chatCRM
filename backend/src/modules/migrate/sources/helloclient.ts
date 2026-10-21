import { realSerial } from "../../../lib/serial";
import type { TableRow } from "../../data/tableFile";
import type { SqlRow, SqlTable } from "../sqlite";
import { latin, phones } from "./catalog";
import type { Converted, MigrationPayment, MigrationSource, MigrationStaff } from "./types";

/**
 * HelloClient: отчёт «Прибыль по заказам», выгруженный в Excel (Андрей,
 * 21.10.2026). Один лист, строка на заказ: клиент с телефоном и реквизитами,
 * техника, причина обращения, комплектация, исполнитель, суммы услуг и
 * товаров, платежи и скидка.
 *
 * Чего в отчёте нет — того и не переносим: склада, истории статусов, состава
 * работ по строкам, зарплаты. Работы и товары переезжают двумя строками
 * состава с суммами из отчёта, чтобы итог заказа сходился с HelloClient.
 *
 * Правила денег выведены из настоящей выгрузки: в 1631 заказе из 1643
 * «Платежи» = «Позиции цена» − «Скидка». Остальные двенадцать — это
 * «Закрыт (не успешно)», «Отказ от ремонта», гарантия и «Выдан без оплаты».
 * Долгом остаётся только «Выдан без оплаты» и обычный «Закрыт» с недоплатой;
 * у неуспешных и гарантийных сумма заказа — то, что заплатили, а цена из
 * HelloClient записывается в примечание: долга там никто не ждёт.
 */

const trim = (v: unknown) => (v === null || v === undefined ? "" : String(v)).replace(/ /g, " ").replace(/\s+/g, " ").trim();
const clean = (v: unknown) => {
  const s = trim(v);
  return s === "-" || s === "—" || s === "?" ? "" : s;
};
const num = (v: unknown) => {
  const n = typeof v === "number" ? v : Number(trim(v).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

/** «2023-12-15T17:54» (так даты отдаёт чтение Excel) → местная дата. */
function toDate(v: unknown): Date | null {
  const m = trim(v).match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0));
  const r = trim(v).match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[ T,]+(\d{1,2}):(\d{2}))?/);
  if (r) return new Date(Number(r[3]), Number(r[2]) - 1, Number(r[1]), Number(r[4] ?? 0), Number(r[5] ?? 0));
  return null;
}

const p2 = (n: number) => String(n).padStart(2, "0");
const ru = (d: Date | null) => (d ? `${p2(d.getDate())}.${p2(d.getMonth() + 1)}.${d.getFullYear()} ${p2(d.getHours())}:${p2(d.getMinutes())}` : "");

/** Список «Коробка, Ноутбук, Зарядное устройство (блок),» — без пустых кусков. */
const list = (v: unknown) =>
  clean(v)
    .split(/[,\n\r]+/)
    .map((s) => s.trim())
    .filter((s) => s && s !== "-")
    .join(", ");

const money = (n: number) => `${n.toLocaleString("ru-RU")} ₽`;

/** Статусы HelloClient → наши. Все заказы в отчёте закрыты. */
type Outcome = "issued" | "unpaid" | "refused" | "warranty";
function outcomeOf(raw: string): { status: string; outcome: Outcome } | null {
  const s = raw.toLowerCase().replace(/\s+/g, "");
  if (s === "закрыт") return { status: "Выдан", outcome: "issued" };
  if (s === "выданбезоплаты") return { status: "Выдан", outcome: "unpaid" };
  if (s.startsWith("закрыт(гарант")) return { status: "Выдан", outcome: "warranty" };
  if (s.startsWith("закрыт(неуспеш") || s.startsWith("отказ") || s.startsWith("выданбезремонт")) {
    return { status: "Возврат без ремонта", outcome: "refused" };
  }
  return null;
}

const CUSTOMER_HEAD = ["Номер", "Тип", "Имя", "Телефон", "Email", "Адрес", "ИНН", "Примечание", "Техника"];
const ORDER_HEAD = [
  "Номер", "Принят", "Статус", "Тип обращения", "Клиент", "Номер клиента", "Телефон клиента",
  "Техника", "Бренд", "Модель", "Серийный номер", "Неисправность", "Комплектность", "Внешнее состояние",
  "Примечание приёмщика", "Диагноз", "Мастер", "Завершён", "Выдан",
  "Работы, ₽", "Состав работ", "Запчасти, ₽", "Состав запчастей", "Скидка, ₽", "Итого, ₽",
];

const table = (head: string[], rows: Array<Array<string | number>>): TableRow[] => [
  { n: 1, cells: head },
  ...rows.map((cells, i) => ({ n: i + 2, cells: cells.map((c) => (c === "" ? null : c)) })),
];

const REQUIRED = ["Заказ", "Статус", "Создан", "Причина обращения", "Вид устройства", "Клиент", "Телефон", "Позиции цена", "Платежи"];

function sheetOf(tables: Record<string, SqlTable>): SqlTable | null {
  return Object.values(tables).find((t) => REQUIRED.every((c) => t.columns.includes(c))) ?? null;
}

function convert(tables: Record<string, SqlTable>): Converted {
  const sheet = sheetOf(tables)!;
  const notes: string[] = [];
  const rows = sheet.rows.filter((r) => trim(r["Заказ"]));
  const col = (r: SqlRow, name: string) => r[name] ?? null;

  // ------------------------------------------------------------- клиенты
  // Своего номера клиента у HelloClient в отчёте нет — даём свой. Одна
  // карточка на телефон; без телефона — на имя.
  const customerRows: Array<Array<string | number>> = [];
  const keyOf = (r: SqlRow) => {
    const tel = phones(col(r, "Телефон"))[0] ?? "";
    return tel ? `t:${tel}` : `n:${trim(col(r, "Клиент")).toLowerCase()}`;
  };
  const byKey = new Map<string, { number: number; row: Array<string | number>; devices: string[] }>();
  let noPhone = 0;
  // Свежие строки первыми: у клиента берём последние известные имя и адрес.
  const newestFirst = [...rows].sort((a, b) => (toDate(col(b, "Создан"))?.getTime() ?? 0) - (toDate(col(a, "Создан"))?.getTime() ?? 0));
  for (const r of newestFirst) {
    const key = keyOf(r);
    const kind = clean(col(r, "Вид устройства"));
    const what = [kind.toLowerCase(), clean(col(r, "Бренд")), clean(col(r, "Модель"))].filter(Boolean).join(" ");
    const serial = realSerial(clean(col(r, "IMEI / SN"))) ?? "";
    const device = what ? (serial ? `${what} (${serial})` : what).replace(/;/g, ",") : "";
    const had = byKey.get(key);
    if (had) {
      if (device && !had.devices.includes(device)) had.devices.push(device);
      continue;
    }
    const tel = phones(col(r, "Телефон"));
    if (!tel.length) noPhone += 1;
    const company = trim(col(r, "Тип")).toLowerCase().startsWith("комп");
    const note = [
      clean(col(r, "Директор")) && `Директор: ${clean(col(r, "Директор"))}`,
      clean(col(r, "Расчетный счет")) && `Расчётный счёт: ${clean(col(r, "Расчетный счет"))}`,
    ]
      .filter(Boolean)
      .join(". ");
    const entry = {
      number: byKey.size + 1,
      devices: device ? [device] : [],
      row: [
        byKey.size + 1,
        company ? "Организация" : "Физлицо",
        trim(col(r, "Клиент")) || "Без имени",
        tel[0] ?? "",
        clean(col(r, "Почта")),
        clean(col(r, "Адрес")),
        clean(col(r, "ИНН")).split("/")[0],
        note,
        "",
      ] as Array<string | number>,
    };
    byKey.set(key, entry);
  }
  for (const c of byKey.values()) {
    c.row[8] = c.devices.slice(0, 20).join("; ");
    customerRows.push(c.row);
  }
  customerRows.sort((a, b) => Number(a[0]) - Number(b[0]));
  const merged = rows.length - byKey.size;
  if (merged > 0) notes.push(`Клиентов — ${byKey.size}: заказы одного телефона собраны в одну карточку.`);
  if (noPhone) notes.push(`Клиенты без телефона заведены по имени: ${noPhone}.`);

  // --------------------------------------------------------------- заказы
  const orderRows: Array<Array<string | number>> = [];
  const payments: MigrationPayment[] = [];
  const passcodes = new Map<string, string>();
  const staffBy = new Map<string, MigrationStaff>();
  const unknown = new Map<string, number>();
  let lastNumber: number | null = null;
  let debtCount = 0;
  let debtSum = 0;
  let priceNoted = 0;

  const sorted = [...rows].sort((a, b) => num(trim(a["Заказ"]).replace(/\D/g, "")) - num(trim(b["Заказ"]).replace(/\D/g, "")));
  for (const r of sorted) {
    const number = trim(col(r, "Заказ")).replace(/^#/, "");
    if (/^\d+$/.test(number)) lastNumber = Math.max(lastNumber ?? 0, Number(number));
    const rawStatus = trim(col(r, "Статус"));
    const st = outcomeOf(rawStatus);
    if (!st) unknown.set(rawStatus, (unknown.get(rawStatus) ?? 0) + 1);
    const accepted = toDate(col(r, "Создан"));
    const closed = toDate(col(r, "Закрыт"));
    const issued = st ? (closed ?? accepted) : null;

    // Деньги
    const services = Math.max(0, num(col(r, "Услуги цена")));
    const goods = Math.max(0, num(col(r, "Товары цена")));
    const discount = Math.max(0, num(col(r, "Скидка")));
    const paid = Math.max(0, num(col(r, "Платежи")));
    const price = Math.max(0, services + goods - discount);
    let work = services;
    let parts = goods;
    let disc = discount;
    let total = price;
    const extra: string[] = [];
    if (paid + 0.009 < price && st && st.outcome !== "issued" && st.outcome !== "unpaid") {
      // Не чинили или по гарантии: долга нет, сумма заказа — что заплатили.
      extra.push(`В HelloClient стоимость ${money(price)}, оплачено ${money(paid)}`);
      priceNoted += 1;
      total = paid;
      disc = 0;
      parts = Math.min(goods, paid);
      work = Math.max(0, paid - parts);
    } else if (paid + 0.009 < price) {
      debtCount += 1;
      debtSum += price - paid;
    }

    const master = trim(col(r, "Исполнитель"));
    if (master) {
      const s = staffBy.get(master) ?? { name: master, local: latin(master), orders: 0, lastAt: null };
      s.orders += 1;
      if (accepted && (!s.lastAt || accepted > s.lastAt)) s.lastAt = accepted;
      staffBy.set(master, s);
    }
    const manager = trim(col(r, "Менеджер"));
    const created = trim(col(r, "Создал"));
    const kindRaw = trim(col(r, "Тип заказа")).toLowerCase();
    const pass = clean(col(r, "Пароль"));
    if (pass && pass !== "0") passcodes.set(number, pass.slice(0, 100));

    const receptionNote = [
      kindRaw.startsWith("выезд") && "Выездной заказ",
      created && `Принял: ${created}`,
      manager && manager !== master && manager !== created && `Менеджер: ${manager}`,
      !st && rawStatus && `Статус в HelloClient: ${rawStatus}`,
      ...extra,
    ]
      .filter(Boolean)
      .join("\n");

    const key = keyOf(r);
    const customer = byKey.get(key)!;
    orderRows.push([
      number,
      ru(accepted),
      st?.status ?? "",
      kindRaw.startsWith("гарант") ? "Гарантийный возврат" : "Ремонт",
      trim(col(r, "Клиент")) || "Без имени",
      customer.number,
      phones(col(r, "Телефон"))[0] ?? "",
      clean(col(r, "Вид устройства")),
      clean(col(r, "Бренд")),
      clean(col(r, "Модель")),
      realSerial(clean(col(r, "IMEI / SN"))) ?? "",
      clean(col(r, "Причина обращения")) || "не указана",
      list(col(r, "Комплектация")),
      list(col(r, "Внешний вид")),
      receptionNote,
      clean(col(r, "Комментарий специалиста")),
      master,
      st?.outcome === "refused" ? "" : ru(issued),
      ru(issued),
      work,
      work > 0 ? `Услуги по заказу — ${work}` : "",
      parts,
      parts > 0 ? `Товары по заказу — ${parts}` : "",
      disc,
      total,
    ]);

    // Оплата — одним платежом в день закрытия, сколько заплатили.
    const pay = Math.min(paid, total);
    if (pay > 0 && issued) payments.push({ number, amount: pay, at: issued, comment: "Оплата (HelloClient)" });
  }

  const statusCount = new Map<string, number>();
  for (const r of rows) statusCount.set(trim(r["Статус"]), (statusCount.get(trim(r["Статус"])) ?? 0) + 1);
  const open = [...statusCount.keys()].filter((s) => !outcomeOf(s));
  if (!open.length) {
    notes.push("В выгрузке только закрытые заказы. Те, что сейчас в работе, в отчёт «Прибыль по заказам» не попадают — их нужно выгрузить отдельно или завести руками.");
  }
  if (unknown.size) {
    notes.push(
      "Статусы, которых у нас нет, — такие заказы встанут на начальный статус: " +
        [...unknown].map(([s, n]) => `«${s}» (${n})`).join(", ") + "."
    );
  }
  if (priceNoted) notes.push(`Неуспешные и гарантийные заказы без полной оплаты (${priceNoted}) долгом не считаются: их цена из HelloClient — в примечании.`);
  notes.push("Себестоимость, зарплата и прибыль из отчёта не переносятся: у нас они считаются по своим правилам.");

  return {
    source: { id: SOURCE.id, title: SOURCE.title },
    staff: [...staffBy.values()].sort((a, b) => b.orders - a.orders),
    customers: table(CUSTOMER_HEAD, customerRows),
    stock: table(["Наименование", "Остаток"], []),
    orders: table(ORDER_HEAD, orderRows),
    payments,
    prepayments: new Map(),
    estimates: new Map(),
    passcodes,
    history: [],
    lastNumber,
    colors: new Map(),
    notes,
    debts: debtCount ? { count: debtCount, sum: Math.round(debtSum) } : undefined,
  };
}

export const SOURCE: MigrationSource = {
  id: "helloclient",
  title: "HelloClient",
  file: "Excel-отчёт «Прибыль по заказам» (.xlsx)",
  accept: ".xlsx",
  detect: (t) => sheetOf(t) !== null,
  convert,
};
