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
}

/**
 * Главная таблицей (Андрей, 21.10.2026: «как в HelloClient»): строка на
 * заказ, столбцы на выбор. Храним, как и всё здесь, выключенное — новый
 * столбец сам встанет на место. Кроме тех, что по умолчанию выключены:
 * они перечислены в TABLE_OFF и включаются явно, списком shown.
 */
export const DASHBOARD_VIEWS = ["board", "table"] as const;
export type DashboardView = (typeof DASHBOARD_VIEWS)[number];

export const TABLE_COLS = ["number", "created", "device", "status", "customer", "complaint", "master", "due", "total", "serial", "note", "since"] as const;
export type TableCol = (typeof TABLE_COLS)[number];
/** Выключены, пока их не включат: серийник, примечание приёмщика, «в статусе». */
export const TABLE_OFF: readonly TableCol[] = ["serial", "note", "since"];
export const TABLE_SORTS = ["created", "-created", "number", "-number", "due", "-due", "total", "-total", "since", "-since"] as const;

export interface TablePrefs {
  /** Выключенные столбцы из обычных. */
  hidden?: TableCol[];
  /** Включённые из тех, что по умолчанию выключены. */
  shown?: TableCol[];
  dense?: boolean;
  sort?: (typeof TABLE_SORTS)[number];
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
    table: z
      .object({
        hidden: z.array(z.string().max(20)).max(30).optional(),
        shown: z.array(z.string().max(20)).max(30).optional(),
        dense: z.boolean().optional(),
        sort: z.string().max(12).optional(),
      })
      .strip()
      .optional(),
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
  const t = obj(p.table);
  const cols = (v: unknown, keep: (c: TableCol) => boolean) =>
    [...new Set(strings(v))].filter((c): c is TableCol => (TABLE_COLS as readonly string[]).includes(c) && keep(c as TableCol));
  const table: TablePrefs = {};
  // Номер и статус не выключаются: без них строка — не заказ.
  const tHidden = cols(t.hidden, (c) => !TABLE_OFF.includes(c) && c !== "number" && c !== "status");
  const tShown = cols(t.shown, (c) => TABLE_OFF.includes(c));
  if (tHidden.length) table.hidden = tHidden;
  if (tShown.length) table.shown = tShown;
  if (t.dense === true) table.dense = true;
  if (typeof t.sort === "string" && (TABLE_SORTS as readonly string[]).includes(t.sort) && t.sort !== "-created") {
    table.sort = t.sort as TablePrefs["sort"];
  }
  if (Object.keys(table).length) out.table = table;
  return out;
}

export const stageSortOf = (prefs: DashboardPrefs, key: StageKey): StageSort =>
  (prefs.panels[key]?.sort as StageSort | undefined) ?? "urgent";

export const debtorSortOf = (prefs: DashboardPrefs): DebtorSort =>
  (prefs.panels.DEBTORS?.sort as DebtorSort | undefined) ?? "sum";
