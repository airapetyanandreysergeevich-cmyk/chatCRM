import type { StatusGroup } from "./orders";

/**
 * Четыре стадии, из которых состоит жизнь заказа в мастерской.
 *
 * Стадия — это группа статуса, а не сам статус: названия статусов мастерская
 * правит под себя («Тестирование», «Ожидание запчасти»), а группа остаётся.
 * Поэтому и доска на главной, и цвет статуса в любом списке берутся отсюда —
 * один заказ не может быть на главной розовым, а в списке бирюзовым.
 *
 * Закрытые и отменённые заказы стадии не имеют: работа по ним кончилась,
 * на доске им места нет.
 */

export type StageKey = Extract<StatusGroup, "NEW" | "WAITING" | "IN_PROGRESS" | "DONE">;

export interface Stage {
  key: StageKey;
  label: string;
  /** Чистый цвет: заголовок панели и обводка. */
  color: string;
  /** Панель: едва заметная заливка и тонкий яркий контур. */
  panel: string;
  /** Плашка статуса: та же заливка, тот же цвет текста. */
  chip: string;
  text: string;
}

/**
 * Цвета заданы владельцем мастерской. Заливка взята почти прозрачной
 * намеренно: четыре насыщенных прямоугольника рядом друг с другом
 * невозможно читать дольше минуты, а смотреть на эту страницу приходится
 * весь день.
 */
export const STAGES: Stage[] = [
  {
    key: "NEW",
    label: "Диагностика",
    color: "#FFF993",
    panel: "border-[#FFF993]/40 bg-[#FFF993]/[0.04]",
    chip: "bg-[#FFF993]/10 text-[#FFF993]",
    text: "text-[#FFF993]",
  },
  {
    key: "WAITING",
    label: "Согласование",
    color: "#FC7E68",
    panel: "border-[#FC7E68]/40 bg-[#FC7E68]/[0.04]",
    chip: "bg-[#FC7E68]/10 text-[#FC7E68]",
    text: "text-[#FC7E68]",
  },
  {
    key: "IN_PROGRESS",
    label: "Ремонт",
    color: "#FE3E7D",
    panel: "border-[#FE3E7D]/40 bg-[#FE3E7D]/[0.045]",
    chip: "bg-[#FE3E7D]/[0.12] text-[#FE3E7D]",
    text: "text-[#FE3E7D]",
  },
  {
    key: "DONE",
    label: "Выдача",
    color: "#A5F88B",
    panel: "border-[#A5F88B]/40 bg-[#A5F88B]/[0.04]",
    chip: "bg-[#A5F88B]/10 text-[#A5F88B]",
    text: "text-[#A5F88B]",
  },
];

export const STAGE_BY_KEY: Record<StageKey, Stage> = Object.fromEntries(
  STAGES.map((s) => [s.key, s])
) as Record<StageKey, Stage>;
