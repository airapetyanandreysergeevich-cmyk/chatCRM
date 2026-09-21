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
  /** Светящаяся полоса по верхней грани колонки на главной. */
  glow: string;
  /** Точка у названия колонки — тот же свет, только маленький. */
  dot: string;
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
 * Колонки на главной — одного цвета. Раньше каждая была залита своим цветом
 * и обведена им же, и четыре разные заливки рядом читались как четыре разные
 * программы. Цвет стадии теперь собран в тонкую светящуюся полосу по верхней
 * грани и в точку у названия: колонку по-прежнему узнаёшь с другого конца
 * мастерской, но смотреть на доску весь день не утомительно.
 *
 * Свечение задано тенью с цветом из той же переменной: так оно следует за
 * палитрой мастерской и перекрашивается вместе с ней.
 */
export const STAGES: Stage[] = [
  {
    key: "NEW",
    label: "Диагностика",
    glow: "bg-stage-new/[0.85] shadow-[0_0_14px_1px_rgb(var(--stage-new)/0.5)]",
    dot: "bg-stage-new shadow-[0_0_8px_1px_rgb(var(--stage-new)/0.75)]",
    chip: "bg-stage-new/10 text-stage-new",
    pill: "border-stage-new/50 bg-stage-new/[0.14] text-stage-new",
    text: "text-stage-new",
  },
  {
    key: "WAITING",
    label: "Согласование",
    glow: "bg-stage-waiting/[0.85] shadow-[0_0_14px_1px_rgb(var(--stage-waiting)/0.5)]",
    dot: "bg-stage-waiting shadow-[0_0_8px_1px_rgb(var(--stage-waiting)/0.75)]",
    chip: "bg-stage-waiting/10 text-stage-waiting",
    pill: "border-stage-waiting/50 bg-stage-waiting/[0.14] text-stage-waiting",
    text: "text-stage-waiting",
  },
  {
    key: "IN_PROGRESS",
    label: "Ремонт",
    glow: "bg-stage-progress/[0.85] shadow-[0_0_14px_1px_rgb(var(--stage-progress)/0.5)]",
    dot: "bg-stage-progress shadow-[0_0_8px_1px_rgb(var(--stage-progress)/0.75)]",
    chip: "bg-stage-progress/[0.12] text-stage-progress",
    pill: "border-stage-progress/50 bg-stage-progress/[0.14] text-stage-progress",
    text: "text-stage-progress",
  },
  {
    key: "DONE",
    label: "Выдача",
    glow: "bg-stage-done/[0.85] shadow-[0_0_14px_1px_rgb(var(--stage-done)/0.5)]",
    dot: "bg-stage-done shadow-[0_0_8px_1px_rgb(var(--stage-done)/0.75)]",
    chip: "bg-stage-done/10 text-stage-done",
    pill: "border-stage-done/50 bg-stage-done/[0.14] text-stage-done",
    text: "text-stage-done",
  },
];
