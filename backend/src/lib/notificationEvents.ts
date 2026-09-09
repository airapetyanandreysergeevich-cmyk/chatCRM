/**
 * Справочник событий, о которых система умеет оповещать.
 *
 * Владелец мастерской настраивает матрицу «событие × роль» — она лежит
 * в Tenant.settings.notifications и выглядит как { "order.completed": [roleId, …] }.
 * Пока владелец ничего не менял, работают defaultRoles: система полезна
 * из коробки, а не после часа настройки.
 */

export const NOTIFICATION_EVENTS = [
  {
    code: "order.assigned",
    title: "Назначен заказ",
    hint: "Уходит назначенному мастеру. Отметьте роли, которые должны знать об этом дополнительно.",
    /** Кроме ролей из матрицы, событие всегда уходит конкретному человеку. */
    hasDirectTarget: true,
    defaultRoles: [] as string[],
  },
  {
    code: "order.completed",
    title: "Ремонт готов",
    hint: "Мастер закрыл работу — пора звонить клиенту.",
    hasDirectTarget: false,
    defaultRoles: ["Приёмщик", "Управляющий"],
  },
  {
    code: "order.overdue",
    title: "Просрочен срок готовности",
    hint: "Проверяется раз в час. По каждому заказу оповещение приходит один раз.",
    hasDirectTarget: false,
    defaultRoles: ["Управляющий", "Владелец"],
  },
  {
    code: "order.limit_exceeded",
    title: "Превышен согласованный лимит",
    hint: "Сумма работ и запчастей вышла за сумму, которую согласовал клиент.",
    hasDirectTarget: false,
    defaultRoles: ["Приёмщик", "Управляющий", "Владелец"],
  },
  {
    code: "purchase.requested",
    title: "Заявка на закупку",
    hint: "Заработает вместе с модулем закупок.",
    hasDirectTarget: false,
    defaultRoles: ["Управляющий", "Владелец"],
  },
] as const;

export type NotificationEventCode = (typeof NOTIFICATION_EVENTS)[number]["code"];

export const EVENT_CODES: string[] = NOTIFICATION_EVENTS.map((e) => e.code);

export const isEventCode = (v: string): v is NotificationEventCode => EVENT_CODES.includes(v);

/** Матрица целиком: код события → список id ролей. */
export type NotificationMatrix = Record<string, string[]>;

/**
 * Из настроек арендатора достаём матрицу, отбрасывая мусор: настройки — это Json,
 * туда за годы может попасть что угодно, а падать на оповещении нельзя.
 */
export function readMatrix(settings: unknown): NotificationMatrix {
  const raw = (settings as { notifications?: unknown } | null)?.notifications;
  if (!raw || typeof raw !== "object") return {};
  const out: NotificationMatrix = {};
  for (const [code, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isEventCode(code) || !Array.isArray(value)) continue;
    out[code] = value.filter((v): v is string => typeof v === "string");
  }
  return out;
}
