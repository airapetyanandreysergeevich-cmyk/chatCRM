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
  /** Панель: едва заметная заливка и тонкий яркий контур. */
  panel: string;
  /** Плашка статуса: та же заливка, тот же цвет текста. */
  chip: string;
  /** Выбранный фильтр в списке заказов. */
  pill: string;
  text: string;
}

/**
 * Сами цвета здесь не хранятся: они живут в CSS-переменных --stage-*, которые
 * выставляет lib/theme.ts по настройкам мастерской. Здесь только классы —
 * иначе цвет пришлось бы держать в двух местах, и они разошлись бы в первый
 * же день.
 *
 * Заливка взята почти прозрачной намеренно: четыре насыщенных прямоугольника
 * рядом друг с другом невозможно читать дольше минуты, а смотреть на эту
 * страницу приходится весь день.
 */
export const STAGES: Stage[] = [
  {
    key: "NEW",
    label: "Диагностика",
    panel: "border-stage-new/40 bg-stage-new/[0.04]",
    chip: "bg-stage-new/10 text-stage-new",
    pill: "border-stage-new/50 bg-stage-new/[0.14] text-stage-new",
    text: "text-stage-new",
  },
  {
    key: "WAITING",
    label: "Согласование",
    panel: "border-stage-waiting/40 bg-stage-waiting/[0.04]",
    chip: "bg-stage-waiting/10 text-stage-waiting",
    pill: "border-stage-waiting/50 bg-stage-waiting/[0.14] text-stage-waiting",
    text: "text-stage-waiting",
  },
  {
    key: "IN_PROGRESS",
    label: "Ремонт",
    panel: "border-stage-progress/40 bg-stage-progress/[0.045]",
    chip: "bg-stage-progress/[0.12] text-stage-progress",
    pill: "border-stage-progress/50 bg-stage-progress/[0.14] text-stage-progress",
    text: "text-stage-progress",
  },
  {
    key: "DONE",
    label: "Выдача",
    panel: "border-stage-done/40 bg-stage-done/[0.04]",
    chip: "bg-stage-done/10 text-stage-done",
    pill: "border-stage-done/50 bg-stage-done/[0.14] text-stage-done",
    text: "text-stage-done",
  },
];
