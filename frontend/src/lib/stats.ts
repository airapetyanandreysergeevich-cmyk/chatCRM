import { api } from "./api";

/**
 * Раздел «Статистика»: типы ответов, запросы и период.
 * Считает всё сервер (backend/src/modules/stats), здесь — только показ.
 */

export type Gran = "day" | "week" | "month";
export interface Range {
  from: string;
  to: string;
}

export interface Access {
  full: boolean;
  money: boolean;
  me: string | null;
  firstDay: string | null;
}

export interface Tiles {
  accepted: number;
  issued: number;
  revenue: number | null;
  check: number | null;
  fixRate: number | null;
  readyMedian: number | null;
  warrantyRate: number | null;
}

export interface Overview {
  range: Range;
  prev: Range | null;
  gran: Gran;
  keys: string[];
  money: boolean;
  tiles: { cur: Tiles; prev: Tiles | null };
  outcomes: { ok: number; no: number; work: number };
  series: { accepted: number[]; acceptedPrev: number[] | null; revenue: number[] | null; revenuePrev: number[] | null };
  spark: {
    keys: string[];
    accepted: number[];
    issued: number[];
    check: number[] | null;
    revenue: number[] | null;
    fixRate: number[];
    readyMedian: number[];
    warrantyRate: number[];
  };
  facts: {
    busyDow: number | null;
    calmDow: number | null;
    peakHour: number | null;
    topDevice: { kind: string; brand: string; n: number } | null;
    best: { key: string; n: number } | null;
    idleLong: number;
    returning: { n: number; of: number };
  };
}

export interface Labeled {
  label: string;
  n: number;
}

export interface OrdersStats {
  range: Range;
  gran: Gran;
  keys: string[];
  series: { ok: number[]; no: number[]; work: number[] };
  /** 7 строк (пн…вс) × 24 часа. */
  heat: number[][];
  kinds: Labeled[];
  brands: Labeled[];
  ready: { edges: number[]; bins: number[]; median: number | null };
  wait: { edges: number[]; bins: number[]; median: number | null };
  reasons: Labeled[];
  counts: { accepted: number; urgent: number; returning: number; completed: number; late: number; lateOf: number; warranty: number };
}

export interface MasterRow {
  id: string;
  name: string;
  active: boolean;
  accepted: number;
  ok: number;
  no: number;
  work: number;
  fixRate: number | null;
  warrantyRate: number | null;
  readyMedian: number | null;
  works: number | null;
  check: number | null;
}

export interface MastersStats {
  range: Range;
  money: boolean;
  rows: MasterRow[];
  issued: number;
  receivers: Array<{ id: string; name: string; accepted: number; issued: number }>;
}

export interface MasterCard {
  range: Range;
  gran: Gran;
  keys: string[];
  money: boolean;
  id: string;
  name: string;
  tiles: {
    accepted: number;
    ok: number;
    no: number;
    work: number;
    share: number | null;
    fixRate: number | null;
    warrantyRate: number | null;
    readyMedian: number | null;
  };
  shop: { fixRate: number | null; warrantyRate: number | null; readyMedian: number | null };
  series: { ok: number[]; no: number[]; work: number[]; works: number[] | null };
  kinds: Labeled[];
}

export interface DrillItem {
  id: string;
  number: string;
  acceptedAt: string;
  device: string;
  master: string | null;
  outcome: "ok" | "no" | "work";
  issued: boolean;
  total: number | null;
}

export interface MoneyTiles {
  income: number;
  expense: number;
  left: number;
  check: number;
}

export interface MoneyStats {
  range: Range;
  gran: Gran;
  keys: string[];
  prev: Range | null;
  tiles: { cur: MoneyTiles; prev: MoneyTiles | null; withdrawn: number };
  series: { income: number[]; expense: number[] };
  pay: { kinds: Array<{ kind: "CASH" | "ACQUIRING" | "BANK"; total: number; values: number[] }> };
  expenses: Array<{ label: string; v: number }>;
  checkByKind: Array<{ label: string; n: number; avg: number }>;
  worksParts: { works: number; parts: number; margin: { sale: number; cost: number } | null };
}

export interface ClientTiles {
  people: number;
  newPeople: number;
  returningShare: number | null;
}

export interface ClientsStats {
  range: Range;
  gran: Gran;
  keys: string[];
  money: boolean;
  prev: Range | null;
  tiles: { cur: ClientTiles; prev: ClientTiles | null };
  series: { fresh: number[]; back: number[] };
  top: Array<{ id: string; name: string; company: boolean; number: number; orders: number; sum: number | null }>;
  types: { people: { person: number; company: number }; orders: { person: number; company: number } };
  sources: Labeled[];
}

const qs = (r: Range, extra: Record<string, string | undefined> = {}) => {
  const p = new URLSearchParams({ from: r.from, to: r.to });
  for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
  return `?${p}`;
};

export const statsApi = {
  access: () => api.get<Access>("/stats/access"),
  overview: (r: Range) => api.get<Overview>(`/stats/overview${qs(r)}`),
  orders: (r: Range, gran?: Gran) => api.get<OrdersStats>(`/stats/orders${qs(r, { gran })}`),
  masters: (r: Range) => api.get<MastersStats>(`/stats/masters${qs(r)}`),
  master: (id: string, r: Range) => api.get<MasterCard>(`/stats/masters/${id}${qs(r)}`),
  money: (r: Range, gran?: Gran) => api.get<MoneyStats>(`/stats/money${qs(r, { gran })}`),
  clients: (r: Range, gran?: Gran) => api.get<ClientsStats>(`/stats/clients${qs(r, { gran })}`),
  drill: (r: Range, master?: string) => api.get<{ total: number; items: DrillItem[] }>(`/stats/drill${qs(r, { master })}`),
};

// ---------------------------------------------------------------- период

export type PeriodId = "month" | "quarter" | "year" | "all" | "custom";

export const PERIODS: Array<{ id: PeriodId; label: string }> = [
  { id: "month", label: "Месяц" },
  { id: "quarter", label: "Квартал" },
  { id: "year", label: "Год" },
  { id: "all", label: "Всё время" },
  { id: "custom", label: "Свои даты" },
];

const pad = (n: number) => String(n).padStart(2, "0");
export const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseDay = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};

const MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const MON3 = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
export const DOW_NAMES = ["понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье"];
export const DOW_SHORT = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

export const dayLabel = (s: string) => {
  const d = parseDay(s);
  return `${d.getDate()} ${MONTHS_GEN[d.getMonth()]} ${d.getFullYear()}`;
};

/** Период по кнопке. «Сегодня» — по часам этого компьютера. */
export function periodRange(id: PeriodId, custom: Range | null, firstDay: string | null, today = new Date()): { range: Range; name: string } {
  const t = isoDay(today);
  if (id === "month") return { range: { from: isoDay(new Date(today.getFullYear(), today.getMonth(), 1)), to: t }, name: `${MONTHS[today.getMonth()]} ${today.getFullYear()}` };
  if (id === "quarter") {
    const q = Math.floor(today.getMonth() / 3);
    return { range: { from: isoDay(new Date(today.getFullYear(), q * 3, 1)), to: t }, name: `${q + 1}-й квартал ${today.getFullYear()}` };
  }
  if (id === "year") return { range: { from: `${today.getFullYear()}-01-01`, to: t }, name: `${today.getFullYear()} год` };
  if (id === "custom" && custom && custom.from <= custom.to) return { range: custom, name: `${dayLabel(custom.from)} — ${dayLabel(custom.to)}` };
  const from = firstDay && firstDay <= t ? firstDay : `${today.getFullYear()}-01-01`;
  return { range: { from, to: t }, name: "всё время" };
}

/** Подпись столбика и полное название его периода. */
export function bucketLabels(keys: string[], gran: Gran, range: Range) {
  return keys.map((k, i) => {
    const d = parseDay(k);
    if (gran === "day") return { short: String(d.getDate()), full: dayLabel(k) };
    if (gran === "week") {
      const start = k < range.from ? range.from : k;
      return { short: `${d.getDate()} ${MON3[d.getMonth()]}`, full: `неделя с ${dayLabel(start)}` };
    }
    const year = i === 0 || d.getMonth() === 0 ? ` ${String(d.getFullYear()).slice(2)}` : "";
    return { short: MON3[d.getMonth()] + year, full: `${MONTHS[d.getMonth()]} ${d.getFullYear()}` };
  });
}

/** Период одного столбика — для списка заказов под графиком. */
export function bucketRange(key: string, gran: Gran, range: Range): Range {
  const d = parseDay(key);
  const end = gran === "day" ? d : gran === "week" ? new Date(d.getFullYear(), d.getMonth(), d.getDate() + 6) : new Date(d.getFullYear(), d.getMonth() + 1, 0);
  const from = key < range.from ? range.from : key;
  const to = isoDay(end) > range.to ? range.to : isoDay(end);
  return { from, to };
}

export const monthLabel = (key: string) => {
  const d = parseDay(key);
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
};

// ---------------------------------------------------------------- числа

const nf = new Intl.NumberFormat("ru-RU");
export const num = (v: number) => nf.format(Math.round(v));
export const rub = (v: number) => `${nf.format(Math.round(v))} ₽`;
export const rubShort = (v: number) =>
  Math.abs(v) >= 1e6
    ? `${(v / 1e6).toFixed(Math.abs(v) >= 1e7 ? 0 : 1).replace(".", ",")} млн ₽`
    : Math.abs(v) >= 1e5
      ? `${nf.format(Math.round(v / 1000))} тыс ₽`
      : rub(v);
export const axisRub = (v: number) =>
  v >= 1e6 ? `${String(Math.round(v / 1e5) / 10).replace(".", ",")} млн` : v >= 1000 ? `${nf.format(Math.round(v / 1000))} тыс` : nf.format(v);
export const pct = (v: number | null) => (v === null ? "—" : `${String(Math.round(v * 1000) / 10).replace(".", ",")}%`);
export const days = (v: number | null) => (v === null ? "—" : `${String(Math.round(v * 10) / 10).replace(".", ",")} дн`);
