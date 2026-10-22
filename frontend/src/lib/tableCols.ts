import { formatDate, shortName } from "./format";
import { ORDER_KIND_LABEL, money } from "./orders";
import type { ColWidth, TableRow, TableViewPrefs } from "./workshop";

/**
 * Каталог столбцов главной-таблицы — для конфигуратора (Андрей, 22.10.2026:
 * «чтобы люди сами под себя выстроили удобную таблицу»). Ключи — те же, что
 * знает сервер (backend/src/modules/summary/prefs.ts, TABLE_COLS).
 *
 * text — значение строкой или числом: им ищут, копируют, выгружают в Excel
 * и считают «Итого». Как ячейка выглядит на экране — DashboardTable; там, где
 * особого вида нет, рисуется text.
 */

export type ColGroup = "Заказ" | "Техника" | "Клиент" | "Работа" | "Деньги";

export interface ColSpec {
  key: string;
  label: string;
  /** Короче для заголовка таблицы, если название в каталоге длинное. */
  head?: string;
  group: ColGroup;
  /** Ширина по умолчанию. */
  w: ColWidth;
  right?: boolean;
  /** Только тем, кто видит деньги заказов. */
  money?: boolean;
  /** Только тем, кто видит контакты клиентов. */
  contacts?: boolean;
  /** Значение для сортировки по щелчку на заголовке. Нет — не сортируется. */
  sort?: (r: TableRow) => number | string;
  /** Складывать в строке «Итого». */
  sum?: boolean;
  text: (r: TableRow) => string | number | null;
  /** Как назвать в «Копировать …». */
  what?: string;
}

const DAY = 86_400_000;
const days = (iso: string | null | undefined) => (iso ? Math.floor((Date.now() - new Date(iso).getTime()) / DAY) : 0);
const t = (v: string | null | undefined) => (v ? new Date(v).getTime() : Number.POSITIVE_INFINITY);
export const deviceLine = (r: TableRow) =>
  [r.device?.kind, r.device?.brand, r.device?.model].filter(Boolean).join(" ") || "Техника не указана";
const num = (v: number | null | undefined) => (v === null || v === undefined ? null : v);

export const COLS: ColSpec[] = [
  // ---------------------------------------------------------------- заказ
  { key: "number", label: "Номер", group: "Заказ", w: "s", sort: (r) => Number(r.number.replace(/\D+/g, "")) || 0, text: (r) => r.number, what: "номер заказа" },
  { key: "created", label: "Создан", group: "Заказ", w: "s", sort: (r) => new Date(r.acceptedAt).getTime(), text: (r) => formatDate(r.acceptedAt), what: "дату приёма" },
  { key: "kind", label: "Тип обращения", group: "Заказ", w: "m", text: (r) => (r.kind ? ORDER_KIND_LABEL[r.kind] : null), what: "тип обращения" },
  { key: "urgent", label: "Срочный", group: "Заказ", w: "s", sort: (r) => Number(r.isUrgent), text: (r) => (r.isUrgent ? "срочный" : null) },
  { key: "status", label: "Статус", group: "Заказ", w: "m", sort: (r) => r.status.name, text: (r) => (r.issuedAt ? "Выдан" : r.status.name), what: "статус" },
  { key: "since", label: "В статусе, дней", group: "Заказ", w: "s", sort: (r) => new Date(r.statusSince).getTime(), text: (r) => days(r.statusSince) },
  { key: "due", label: "Срок", group: "Заказ", w: "m", sort: (r) => t(r.dueAt), text: (r) => (r.dueAt ? formatDate(r.dueAt) : null), what: "срок" },
  { key: "ready", label: "Готов с", group: "Заказ", w: "s", sort: (r) => t(r.completedAt), text: (r) => (r.completedAt ? formatDate(r.completedAt) : null), what: "дату готовности" },
  { key: "acceptedBy", label: "Принял", group: "Заказ", w: "m", sort: (r) => r.acceptedBy ?? "", text: (r) => r.acceptedBy ?? null, what: "кто принял" },
  { key: "master", label: "Мастер", group: "Заказ", w: "m", sort: (r) => r.master?.fullName ?? "я", text: (r) => (r.master ? shortName(r.master.fullName) : null), what: "мастера" },
  { key: "outsource", label: "Номер аутсорса", group: "Заказ", w: "m", text: (r) => r.outsource ?? null, what: "номер аутсорса" },
  { key: "labels", label: "Ярлыки", group: "Заказ", w: "s", sort: (r) => r.labels?.length ?? 0, text: () => null },
  { key: "age", label: "Дней в работе", group: "Заказ", w: "s", sort: (r) => new Date(r.acceptedAt).getTime(), text: (r) => days(r.acceptedAt) },
  { key: "storage", label: "Место хранения", group: "Заказ", w: "m", sort: (r) => r.storage ?? "", text: (r) => r.storage ?? null, what: "место хранения" },
  // -------------------------------------------------------------- техника
  { key: "device", label: "Устройство целиком", head: "Устройство", group: "Техника", w: "l", sort: (r) => deviceLine(r), text: (r) => deviceLine(r) },
  { key: "dkind", label: "Тип техники", group: "Техника", w: "m", sort: (r) => r.device?.kind ?? "", text: (r) => r.device?.kind ?? null, what: "тип техники" },
  { key: "brand", label: "Бренд", group: "Техника", w: "s", sort: (r) => r.device?.brand ?? "", text: (r) => r.device?.brand ?? null, what: "бренд" },
  { key: "model", label: "Модель", group: "Техника", w: "m", sort: (r) => r.device?.model ?? "", text: (r) => r.device?.model ?? null, what: "модель" },
  { key: "serial", label: "Серийный №", group: "Техника", w: "m", text: (r) => r.device?.serial ?? null, what: "серийный номер" },
  { key: "completeness", label: "Комплектность", group: "Техника", w: "l", text: (r) => r.completeness.join(", ") || null, what: "комплектность" },
  { key: "appearance", label: "Внешний вид", group: "Техника", w: "l", text: (r) => (r.appearance ?? []).join(", ") || null, what: "внешний вид" },
  { key: "passcode", label: "Пароль устройства", group: "Техника", w: "s", text: (r) => r.passcode ?? null, what: "пароль" },
  // --------------------------------------------------------------- клиент
  { key: "customer", label: "Клиент и телефон", head: "Клиент", group: "Клиент", w: "l", contacts: true, sort: (r) => r.customer.name ?? "", text: (r) => [r.customer.name, r.customer.phone].filter(Boolean).join(", ") || null },
  { key: "cname", label: "Имя клиента", group: "Клиент", w: "m", contacts: true, sort: (r) => r.customer.name ?? "", text: (r) => r.customer.name ?? null, what: "имя" },
  { key: "phone", label: "Телефон", group: "Клиент", w: "m", contacts: true, text: (r) => r.customer.phone ?? null, what: "телефон" },
  { key: "phone2", label: "Второй телефон", group: "Клиент", w: "m", contacts: true, text: (r) => r.customer.phone2 ?? null, what: "телефон" },
  { key: "email", label: "Почта", group: "Клиент", w: "m", contacts: true, text: (r) => r.customer.email ?? null, what: "почту" },
  { key: "address", label: "Адрес", group: "Клиент", w: "l", contacts: true, text: (r) => r.customer.address ?? null, what: "адрес" },
  { key: "source", label: "Источник", group: "Клиент", w: "m", contacts: true, sort: (r) => r.customer.source ?? "", text: (r) => r.customer.source ?? null, what: "источник" },
  { key: "corders", label: "Заказов у клиента", group: "Клиент", w: "s", contacts: true, right: true, sort: (r) => r.customer.orders ?? 0, text: (r) => r.customer.orders ?? null },
  // --------------------------------------------------------------- работа
  { key: "complaint", label: "Неисправность", group: "Работа", w: "l", text: (r) => r.complaint || null, what: "неисправность" },
  { key: "note", label: "Примечание приёмщика", group: "Работа", w: "l", text: (r) => r.receptionNote ?? null, what: "примечание" },
  { key: "diagnosis", label: "Диагноз", group: "Работа", w: "l", text: (r) => r.diagnosis ?? null, what: "диагноз" },
  { key: "mcomment", label: "Комментарий мастера", group: "Работа", w: "l", text: (r) => r.masterComment ?? null, what: "комментарий мастера" },
  { key: "lastmsg", label: "Последнее в истории ремонта", group: "Работа", w: "l", text: (r) => r.lastMessage ?? null, what: "сообщение" },
  // ---------------------------------------------------------------- деньги
  { key: "estimate", label: "Предварительно", group: "Деньги", w: "s", right: true, money: true, sum: true, sort: (r) => r.estimate ?? 0, text: (r) => num(r.estimate) },
  { key: "prepay", label: "Предоплата", group: "Деньги", w: "s", right: true, money: true, sum: true, sort: (r) => r.prepay ?? 0, text: (r) => num(r.prepay) },
  { key: "works", label: "Работы", group: "Деньги", w: "s", right: true, money: true, sum: true, sort: (r) => r.works ?? 0, text: (r) => num(r.works) },
  { key: "parts", label: "Запчасти", group: "Деньги", w: "s", right: true, money: true, sum: true, sort: (r) => r.parts ?? 0, text: (r) => num(r.parts) },
  { key: "discount", label: "Скидка", group: "Деньги", w: "s", right: true, money: true, sum: true, sort: (r) => r.discount ?? 0, text: (r) => num(r.discount) },
  { key: "total", label: "Сумма", group: "Деньги", w: "s", right: true, money: true, sum: true, sort: (r) => r.total ?? 0, text: (r) => num(r.total) },
  { key: "paid", label: "Оплачено", group: "Деньги", w: "s", right: true, money: true, sum: true, sort: (r) => r.paid ?? 0, text: (r) => num(r.paid) },
  { key: "debt", label: "Долг", group: "Деньги", w: "s", right: true, money: true, sum: true, sort: (r) => r.debt ?? 0, text: (r) => num(r.debt) },
];

export const COL = new Map(COLS.map((c) => [c.key, c]));
export const GROUPS: ColGroup[] = ["Заказ", "Техника", "Клиент", "Работа", "Деньги"];

const SPECIAL = new Set(["status", "number", "labels"]);

/**
 * Ширина столбца в пикселях. Особые — по содержимому: таблетка статуса, номер.
 * Широкие обычные столбцы («Устройство», «Неисправность») резиновые: делят
 * между собой всё свободное место, а это — их наименьшая ширина.
 */
export function colPx(key: string, w: ColWidth | undefined): number {
  const width = w ?? COL.get(key)?.w ?? "m";
  if (key === "status") return width === "s" ? 132 : width === "l" ? 200 : 156;
  if (key === "number") return width === "s" ? 120 : width === "l" ? 170 : 140;
  if (key === "labels") return width === "s" ? 86 : width === "l" ? 150 : 116;
  return width === "s" ? 92 : 120;
}

/** Резиновый столбец — без ширины в <col>, забирает свободное место. */
export const colFlex = (key: string, w: ColWidth | undefined) => !SPECIAL.has(key) && (w ?? COL.get(key)?.w ?? "m") === "l";

/** Деньги в ячейке и в «Итого». */
export const moneyText = (v: number | null | undefined) => (v === null || v === undefined ? "" : money(v));

/** Стандартный вид — как была таблица до конфигуратора. */
export const DEFAULT_VIEW: TableViewPrefs = {
  id: "main",
  name: "Все в работе",
  cols: ["number", "created", "device", "status", "customer", "complaint", "master", "due", "total"].map((k) => ({ k })),
};
