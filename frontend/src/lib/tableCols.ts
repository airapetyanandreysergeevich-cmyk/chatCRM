import { formatDate, shortName } from "./format";
import { ORDER_KIND_LABEL, money } from "./orders";
import type { ColWidth, TableColPrefs, TableRow, TableViewPrefs } from "./workshop";

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

/** Пределы своей ширины — те же, что на сервере (summary/prefs.ts). */
export const MIN_PX = 48;
export const MAX_PX = 1000;

/** Отступ у крайних столбцов: у первого и последнего поля ячейки шире (pl-4/pr-4). */
const EDGE = 8;

/** Уже этого столбец не сжимается вместе с окном — дальше прокрутка внутри таблицы. */
function floorPx(key: string, pref: number) {
  const f =
    key === "number" ? 118 // «Р-2026-00113» целиком
    : key === "status" ? 120 // таблетка статуса читается
    : key === "labels" ? 56
    : key === "created" || key === "due" || key === "ready" ? 84
    : key === "master" ? 88
    : COL.get(key)?.money ? 72
    : 72;
  return Math.min(pref, f);
}

export interface ColsLayout {
  /** Ширина каждого столбца; null — резиновый, делит свободное место. */
  widths: Array<number | null>;
  /** Ширина таблицы, если она шире окна (тогда прокрутка внутри); null — по окну. */
  table: number | null;
  /** Во сколько раз сжаты столбцы под окно (1 — не сжаты). */
  scale: number;
}

/**
 * Ширины столбцов под ширину окна (Андрей, 22.10.2026: «таблицу бы чтобы она
 * с окном браузера расширялась или сужалась»).
 *
 * Места хватает — у столбцов их ширина, резиновые («широкие» без своей
 * ширины) забирают остальное. Не хватает — все сжимаются в одной пропорции,
 * но не уже floorPx; только когда и так не влезает — прокрутка внутри таблицы.
 * live — столбец, который сейчас тянут мышью: его ширина ровно такая, как тянут.
 */
export function layoutCols(cols: TableColPrefs[], avail: number, live?: { k: string; px: number } | null): ColsLayout {
  const last = cols.length - 1;
  const edge = (i: number) => (i === 0 ? EDGE : 0) + (i === last ? EDGE : 0);
  const items = cols.map((c, i) => {
    const isLive = live?.k === c.k;
    const flex = !isLive && !c.px && colFlex(c.k, c.w);
    const pref = isLive ? live!.px : c.px ?? colPx(c.k, c.w);
    return { k: c.k, flex, live: isLive, pref, edge: edge(i) };
  });
  const total = items.reduce((n, x) => n + x.pref + x.edge, 0) + 2;
  // Резиновых нет — свободное место забирает самый широкий (не тот, что тянут):
  // иначе браузер раздаёт его всем поровну, и тянутый столбец «отстаёт» от мыши.
  if (!items.some((x) => x.flex)) {
    const big = items.filter((x) => !x.live && !SPECIAL.has(x.k)).sort((a, b) => b.pref - a.pref)[0];
    if (big) big.flex = true;
  }
  if (!avail || total <= avail) return { widths: items.map((x) => (x.flex ? null : x.pref + x.edge)), table: null, scale: 1 };
  // Сжимаем в одной пропорции; кто упёрся в наименьшую ширину — стоит на ней,
  // остальные сжимаются чуть сильнее (пара проходов). Округляем вниз: копейки
  // от округления иначе давали прокрутку на 5 пикселей.
  const pinned = new Set<number>();
  let scale = 1;
  let widths: number[] = [];
  for (let pass = 0; pass < 4; pass++) {
    const fixed = items.reduce((n, x, i) => n + x.edge + (x.live ? x.pref : pinned.has(i) ? floorPx(x.k, x.pref) : 0), 0);
    const rest = items.reduce((n, x, i) => n + (x.live || pinned.has(i) ? 0 : x.pref), 0);
    scale = Math.max(0.05, Math.min(1, (avail - 2 - fixed) / Math.max(1, rest)));
    let changed = false;
    widths = items.map((x, i) => {
      if (x.live) return x.pref + x.edge;
      const f = floorPx(x.k, x.pref);
      const w = pinned.has(i) ? f : Math.floor(x.pref * scale);
      if (!pinned.has(i) && w < f) {
        pinned.add(i);
        changed = true;
        return f + x.edge;
      }
      return w + x.edge;
    });
    if (!changed) break;
  }
  const sum = widths.reduce((n, w) => n + w, 0) + 2;
  return { widths, table: sum > avail ? sum : null, scale };
}

/** Деньги в ячейке и в «Итого». */
export const moneyText = (v: number | null | undefined) => (v === null || v === undefined ? "" : money(v));

/** Стандартный вид — как была таблица до конфигуратора. */
export const DEFAULT_VIEW: TableViewPrefs = {
  id: "main",
  name: "Все в работе",
  cols: ["number", "created", "device", "status", "customer", "complaint", "master", "due", "total"].map((k) => ({ k })),
};
