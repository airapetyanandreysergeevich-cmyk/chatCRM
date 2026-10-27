import { z } from "zod";

/**
 * Настройки главного экрана — у каждого сотрудника свои.
 *
 * Хранятся на сервере, в строке сотрудника, а не в браузере: мастер один раз
 * убрал с доски ноутбуки — и так же будет на телефоне, в программе и на
 * компьютере у стойки. Настройки в браузере потерялись бы при первой же
 * смене устройства, и человек решил бы, что они «слетают».
 *
 * Правило, на котором держится всё остальное: храним не то, что включено, а
 * то, что выключено. Появилась новая панель — она сама встанет на экран; в
 * мастерскую впервые принесли самокат — он сам появится на доске. Список
 * включённого молча прятал бы всё новое, и заказ «пропадал» бы без причины.
 */

/** Колонки главного экрана. Порядок здесь — порядок по умолчанию. */
export const COLUMN_KEYS = ["NEW", "WAITING", "IN_PROGRESS", "DONE", "DEBTORS"] as const;
export type ColumnKey = (typeof COLUMN_KEYS)[number];

export const STAGE_KEYS = ["NEW", "WAITING", "IN_PROGRESS", "DONE"] as const;
export type StageKey = (typeof STAGE_KEYS)[number];

/** Красная полоса просрочки сверху — не колонка, её можно только выключить. */
export const OVERDUE = "OVERDUE";

export const STAGE_SORTS = ["urgent", "due", "old", "new", "number"] as const;
export type StageSort = (typeof STAGE_SORTS)[number];

export const DEBTOR_SORTS = ["sum", "old", "promised"] as const;
export type DebtorSort = (typeof DEBTOR_SORTS)[number];

/** Больше шестидесяти карточек в столбце всё равно никто не просматривает. */
export const MAX_CARDS = 60;

export interface PanelPrefs {
  sort?: string;
  /** Сколько карточек показывать. Пусто — «авто», по высоте экрана. */
  limit?: number | null;
  /** Скрытые типы техники, в нормальном виде (см. kindKey). "" — «без типа». */
  hiddenKinds?: string[];
}

export interface DashboardPrefs {
  order: ColumnKey[];
  /** Выключенные панели, включая полосу просрочки. */
  hidden: string[];
  panels: Partial<Record<ColumnKey, PanelPrefs>>;
  /** Вид главной: доска или таблица. Нет — как задано у мастерской. */
  view?: DashboardView;
  /** Настройки таблицы — только если что-то поменяли. */
  table?: TablePrefs;
  /** История ремонта в карточке заказа прикреплена: слева или справа. Нет — на своём месте. */
  historyDock?: "left" | "right";
}

/**
 * Главная таблицей (Андрей, 21.10.2026: «как в HelloClient»), с 22.10.2026 —
 * с конфигуратором: несколько своих «видов» вкладками, в каждом — свой набор
 * столбцов по порядку, ширина и перенос у каждого, сортировка, плотность,
 * строка «Итого». Столбцы — ключи каталога (TABLE_COLS); что в них рисовать —
 * знает интерфейс (frontend/src/lib/tableCols.ts).
 */
export const DASHBOARD_VIEWS = ["board", "table"] as const;
export type DashboardView = (typeof DASHBOARD_VIEWS)[number];

export const TABLE_COLS = [
  // заказ
  "number", "created", "kind", "urgent", "status", "since", "due", "ready", "acceptedBy", "master", "outsource", "labels", "age", "storage",
  // техника
  "device", "dkind", "brand", "model", "serial", "completeness", "appearance", "passcode",
  // клиент
  "customer", "cname", "phone", "phone2", "email", "address", "source", "corders",
  // работа
  "complaint", "note", "diagnosis", "mcomment", "lastmsg",
  // деньги
  "estimate", "prepay", "works", "parts", "discount", "total", "paid", "debt",
] as const;
export type TableCol = (typeof TABLE_COLS)[number];

/** Столбцы вида по умолчанию — те, что были до конфигуратора. */
export const DEFAULT_COLS: readonly TableCol[] = ["number", "created", "device", "status", "customer", "complaint", "master", "due", "total"];
/** Выключенные по умолчанию столбцы первой таблицы (batch48) — для перевода старых настроек. */
const LEGACY_OFF: readonly TableCol[] = ["serial", "note", "since"];

export type ColWidth = "s" | "m" | "l";
export interface TableColPrefs {
  k: TableCol;
  w?: ColWidth;
  /** Своя ширина в пикселях — потянули за край заголовка в таблице. Важнее w. */
  px?: number;
  /** Переносить текст на вторую строку. */
  wrap?: boolean;
}
export interface TableViewPrefs {
  id: string;
  name: string;
  cols: TableColPrefs[];
  /** «created» — по возрастанию, «-created» — по убыванию. */
  sort?: string;
  dense?: boolean;
  /** Строка «Итого» внизу. */
  totals?: boolean;
  /** Фильтр «Аутсорс ▾»: any — только аутсорс, none — без аутсорса, иначе id компании-аутсорса. */
  out?: string;
  /** Фильтр «Тип ▾»: платные или гарантийные заказы. */
  okind?: "paid" | "warranty";
}
export interface TablePrefs {
  views: TableViewPrefs[];
  active?: string;
}

export const MAX_VIEWS = 8;
const MAX_COLS = TABLE_COLS.length;

/** Пределы своей ширины столбца. */
export const MIN_PX = 48;
export const MAX_PX = 1000;

export const defaultView = (): TableViewPrefs => ({ id: "main", name: "Все в работе", cols: DEFAULT_COLS.map((k) => ({ k })) });

const isCol = (k: unknown): k is TableCol => typeof k === "string" && (TABLE_COLS as readonly string[]).includes(k);

/** Привести виды таблицы к правильному виду. Старые настройки (hidden/shown) — в один вид. */
export function normalizeTable(raw: unknown): TablePrefs | null {
  const obj = (v: unknown): Record<string, unknown> =>
    v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const t = obj(raw);
  const views: TableViewPrefs[] = [];
  if (Array.isArray(t.views)) {
    const ids = new Set<string>();
    for (const rv of t.views.slice(0, MAX_VIEWS)) {
      const v = obj(rv);
      const id = typeof v.id === "string" && /^[a-z0-9-]{1,24}$/i.test(v.id) && !ids.has(v.id) ? v.id : `v${views.length + 1}`;
      ids.add(id);
      const name = (typeof v.name === "string" ? v.name.trim() : "").slice(0, 40) || `Вид ${views.length + 1}`;
      const seen = new Set<TableCol>();
      const cols: TableColPrefs[] = [];
      for (const rc of Array.isArray(v.cols) ? v.cols.slice(0, MAX_COLS) : []) {
        const c = obj(rc);
        if (!isCol(c.k) || seen.has(c.k)) continue;
        seen.add(c.k);
        const col: TableColPrefs = { k: c.k };
        if (c.w === "s" || c.w === "m" || c.w === "l") col.w = c.w;
        if (typeof c.px === "number" && Number.isFinite(c.px)) col.px = Math.round(Math.min(MAX_PX, Math.max(MIN_PX, c.px)));
        if (c.wrap === true) col.wrap = true;
        cols.push(col);
      }
      // Номер и статус — всегда: без них строка не заказ.
      if (!seen.has("number")) cols.unshift({ k: "number" });
      if (!seen.has("status")) cols.splice(Math.min(cols.length, 3), 0, { k: "status" });
      const view: TableViewPrefs = { id, name, cols };
      if (typeof v.sort === "string" && isCol(v.sort.replace(/^-/, ""))) view.sort = v.sort;
      if (v.dense === true) view.dense = true;
      if (v.totals === true) view.totals = true;
      if (typeof v.out === "string" && /^(any|none|[0-9a-f-]{36})$/i.test(v.out)) view.out = v.out;
      if (v.okind === "paid" || v.okind === "warranty") view.okind = v.okind;
      views.push(view);
    }
  } else if (Array.isArray(t.hidden) || Array.isArray(t.shown) || t.dense !== undefined || t.sort !== undefined) {
    // batch48: hidden — выключенные из обычных, shown — включённые из выключенных.
    const hidden = new Set(Array.isArray(t.hidden) ? t.hidden : []);
    const shown = new Set(Array.isArray(t.shown) ? t.shown : []);
    const legacy: TableCol[] = ["number", "created", "device", "serial", "status", "since", "customer", "complaint", "note", "master", "due", "total"];
    const view = defaultView();
    view.cols = legacy.filter((k) => (LEGACY_OFF.includes(k) ? shown.has(k) : !hidden.has(k) || k === "number" || k === "status")).map((k) => ({ k }));
    if (t.dense === true) view.dense = true;
    if (typeof t.sort === "string" && isCol(t.sort.replace(/^-/, ""))) view.sort = t.sort;
    views.push(view);
  }
  if (!views.length) return null;
  const active = typeof t.active === "string" && views.some((v) => v.id === t.active) ? t.active : undefined;
  return { views, ...(active ? { active } : {}) };
}

/**
 * Тип техники в виде для сравнения: «Ноутбук », «ноутбук» и «НОУТБУК» — одно.
 * Тип в базе — свободный текст, его набирают руками при приёме, и без этого
 * выключенные «ноутбуки» продолжали бы приходить «Ноутбуками».
 */
export const kindKey = (kind: string | null | undefined): string =>
  (kind ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase("ru-RU");

const panelSchema = z
  .object({
    sort: z.string().max(20).optional(),
    limit: z.number().int().min(1).max(MAX_CARDS).nullable().optional(),
    hiddenKinds: z.array(z.string().max(80)).max(200).optional(),
  })
  .strip();

export const prefsSchema = z
  .object({
    order: z.array(z.string()).max(20).optional(),
    hidden: z.array(z.string()).max(20).optional(),
    panels: z.record(z.string(), panelSchema).optional(),
    view: z.string().max(10).nullable().optional(),
    // Виды таблицы разбирает normalizeTable — здесь только предел размера.
    table: z.unknown().optional(),
    historyDock: z.string().max(10).nullable().optional(),
  })
  .strip();

const isColumn = (k: string): k is ColumnKey => (COLUMN_KEYS as readonly string[]).includes(k);
const isStage = (k: string): k is StageKey => (STAGE_KEYS as readonly string[]).includes(k);

/**
 * Привести что угодно к правильным настройкам.
 *
 * Сюда попадает и сохранённое год назад, и присланное устаревшей программой.
 * Незнакомое выбрасываем, недостающее добавляем: порядок всегда содержит все
 * колонки ровно по разу — новые встают в конец.
 */
export function normalizePrefs(raw: unknown): DashboardPrefs {
  // Разбираем по кусочку, а не одной схемой: одно кривое поле не должно
  // стирать человеку все остальные настройки.
  const obj = (v: unknown): Record<string, unknown> =>
    v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const p = obj(raw);

  const order: ColumnKey[] = [];
  for (const k of strings(p.order)) if (isColumn(k) && !order.includes(k)) order.push(k);
  for (const k of COLUMN_KEYS) if (!order.includes(k)) order.push(k);

  const hidden = [...new Set(strings(p.hidden).filter((k) => isColumn(k) || k === OVERDUE))];

  const panels: DashboardPrefs["panels"] = {};
  for (const [key, rawPanel] of Object.entries(obj(p.panels))) {
    if (!isColumn(key)) continue;
    const value = obj(rawPanel);
    const sorts: readonly string[] = isStage(key) ? STAGE_SORTS : DEBTOR_SORTS;
    const out: PanelPrefs = {};
    if (typeof value.sort === "string" && sorts.includes(value.sort) && value.sort !== sorts[0]) out.sort = value.sort;
    if (typeof value.limit === "number" && Number.isInteger(value.limit) && value.limit >= 1 && value.limit <= MAX_CARDS) {
      out.limit = value.limit;
    }
    const kinds = strings(value.hiddenKinds).slice(0, 200);
    if (isStage(key) && kinds.length) out.hiddenKinds = [...new Set(kinds.map(kindKey))].sort();
    if (Object.keys(out).length) panels[key] = out;
  }

  const out: DashboardPrefs = { order, hidden, panels };
  if (typeof p.view === "string" && (DASHBOARD_VIEWS as readonly string[]).includes(p.view)) out.view = p.view as DashboardView;
  const table = normalizeTable(p.table);
  if (table) out.table = table;
  // История ремонта в карточке заказа — прикреплена слева или справа (27.10.2026).
  if (p.historyDock === "left" || p.historyDock === "right") out.historyDock = p.historyDock;
  return out;
}

export const stageSortOf = (prefs: DashboardPrefs, key: StageKey): StageSort =>
  (prefs.panels[key]?.sort as StageSort | undefined) ?? "urgent";

export const debtorSortOf = (prefs: DashboardPrefs): DebtorSort =>
  (prefs.panels.DEBTORS?.sort as DebtorSort | undefined) ?? "sum";
