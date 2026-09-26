import { STAGES } from "./stages";
import { OVERDUE_KEY, type ColumnKey, type DashboardPrefs, type PanelPrefs } from "./workshop";

/**
 * Панели главного экрана: названия и то, какие из них человек видит.
 *
 * Одно место и для главной, и для раздела «Интерфейс» — иначе панель
 * называлась бы на доске «Выдача», а в настройках «Готово к выдаче».
 */

export function panelLabel(key: string): string {
  if (key === "DEBTORS") return "Должники";
  if (key === OVERDUE_KEY) return "Полоса «Просрочка задолженности»";
  return STAGES.find((s) => s.key === key)?.label ?? key;
}

/** Колонки, которые человеку положено видеть, в его порядке — включённые и нет. */
export function columnsFor(prefs: DashboardPrefs, money: boolean): ColumnKey[] {
  // «Должники» — про деньги клиентов: у кого нет к ним доступа, у того нет
  // и панели, даже в настройках. Сервер её такому и не пришлёт.
  return prefs.order.filter((k) => k !== "DEBTORS" || money);
}

export const isShown = (prefs: DashboardPrefs, key: string) => !prefs.hidden.includes(key);

/** Заменить настройки одной панели. Пустые — убираем совсем. */
export function withPanel(prefs: DashboardPrefs, key: ColumnKey, panel: PanelPrefs): DashboardPrefs {
  const clean: PanelPrefs = {};
  if (panel.sort) clean.sort = panel.sort;
  if (typeof panel.limit === "number") clean.limit = panel.limit;
  if (panel.hiddenKinds?.length) clean.hiddenKinds = panel.hiddenKinds;
  const panels = { ...prefs.panels };
  if (Object.keys(clean).length) panels[key] = clean;
  else delete panels[key];
  return { ...prefs, panels };
}

/** Тип техники в виде для сравнения — так же, как на сервере (summary/prefs.ts). */
export const kindKey = (kind: string | null | undefined): string =>
  (kind ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase("ru-RU");
