import type { Prisma } from "@prisma/client";
import { withPlatform, withTenant } from "./db";
import { NOTIFICATION_EVENTS, readMatrix, type NotificationEventCode } from "./notificationEvents";
import { sendPush, type PushTarget } from "./push";

/**
 * Единая точка оповещений: и в системе (колокольчик), и на телефон (Web Push).
 *
 * Правило вызова: notify* вызывается ПОСЛЕ того, как транзакция с основным
 * действием закрылась. Внутри он открывает свою транзакцию и читает данные —
 * из незакрытой чужой он их просто не увидит. Плюс отправка push — это сеть,
 * держать ради неё открытым соединение с базой незачем.
 *
 * Возвращаемое обещание можно не ждать: ошибки гасятся внутри, оповещение
 * никогда не роняет то действие, ради которого его послали.
 */

/** Псевдороль в матрице настроек: владелец мастерской строкой в Role может и не быть. */
export const OWNER_ROLE = "owner";

interface TenantNotice {
  event: NotificationEventCode;
  title: string;
  body?: string;
  /** Путь внутри приложения, например /orders/<id>. */
  url?: string;
  /** Человек, которому событие адресовано лично (назначенный мастер). */
  targetUserId?: string | null;
  /** Кого оповещать не надо — обычно тот, кто сам это действие и сделал. */
  exceptUserId?: string | null;
  payload?: Record<string, unknown>;
}

export async function notifyTenant(tenantId: string, notice: TenantNotice): Promise<void> {
  try {
    const targets = await withTenant(tenantId, async (tx) => {
      const recipients = await resolveRecipients(tx, tenantId, notice);
      if (recipients.length === 0) return [];

      // Колокольчик в интерфейсе. Он работает и без Web Push, и без телефона —
      // это основной канал, push только доносит его быстрее.
      await tx.notification.createMany({
        data: recipients.map((userId) => ({
          tenantId,
          userId,
          type: notice.event,
          title: notice.title,
          body: notice.body ?? null,
          payload: { ...(notice.payload ?? {}), url: notice.url ?? null },
        })),
      });

      const subs = await tx.pushSubscription.findMany({
        where: { userId: { in: recipients } },
        select: { id: true, endpoint: true, p256dh: true, auth: true },
      });
      return subs as PushTarget[];
    });

    await deliver(targets, {
      title: notice.title,
      body: notice.body,
      url: notice.url,
      tag: notice.event,
    });
  } catch (err) {
    console.error(`[notify] ${notice.event}:`, (err as Error).message);
  }
}

/**
 * Кому уходит событие.
 *
 * Настроенная матрица хранит id ролей, значения по умолчанию — названия:
 * id у каждой мастерской свои, а названия системных пресетов одинаковые.
 * Поэтому два разных запроса, а не один с угадыванием, что за строка пришла.
 */
async function resolveRecipients(
  tx: Prisma.TransactionClient,
  tenantId: string,
  notice: TenantNotice
): Promise<string[]> {
  const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } });
  const matrix = readMatrix(tenant?.settings);
  const definition = NOTIFICATION_EVENTS.find((e) => e.code === notice.event);

  const configured = matrix[notice.event];
  const keys = configured ?? [...(definition?.defaultRoles ?? [])];
  const wantsOwner = keys.includes(OWNER_ROLE) || (!configured && keys.includes("Владелец"));
  const roleKeys = keys.filter((k) => k !== OWNER_ROLE && k !== "Владелец");

  const or: Prisma.UserWhereInput[] = [];
  if (roleKeys.length) {
    or.push(configured ? { roleId: { in: roleKeys } } : { role: { name: { in: roleKeys } } });
  }
  if (wantsOwner) or.push({ isOwner: true });

  const byRole = or.length
    ? await tx.user.findMany({
        where: { deletedAt: null, isActive: true, OR: or },
        select: { id: true },
      })
    : [];

  const recipients = new Set(byRole.map((u) => u.id));
  if (definition?.hasDirectTarget && notice.targetUserId) recipients.add(notice.targetUserId);
  if (notice.exceptUserId) recipients.delete(notice.exceptUserId);
  return [...recipients];
}

// ------------------------------------------------------------------ платформа

export type PlatformEvent = {
  type: "APPLICATION_CREATED";
  applicationId: string;
  workshopName: string;
  ownerFullName: string;
  ownerPhone: string;
  city?: string | null;
};

/**
 * Оповещение собственнику платформы. Событие пока одно —
 * новая заявка на подключение мастерской.
 */
export async function notifyPlatform(event: PlatformEvent): Promise<void> {
  try {
    console.log(`[platform] ${event.type} ${JSON.stringify(event)}`);

    const targets = await withPlatform(async (tx) => {
      const subs = await tx.pushSubscription.findMany({
        where: { platformUserId: { not: null } },
        select: { id: true, endpoint: true, p256dh: true, auth: true },
      });
      return subs as PushTarget[];
    });

    await deliver(targets, {
      title: "Новая заявка на подключение",
      body: `${event.workshopName}${event.city ? `, ${event.city}` : ""} — ${event.ownerFullName}`,
      url: "/platform/applications",
      tag: `application-${event.applicationId}`,
    });
  } catch (err) {
    console.error("[notify] APPLICATION_CREATED:", (err as Error).message);
  }
}

// ------------------------------------------------------------------ отправка

async function deliver(
  targets: PushTarget[],
  payload: { title: string; body?: string; url?: string; tag?: string }
): Promise<void> {
  if (targets.length === 0) return;
  const dead = await sendPush(targets, payload);
  if (dead.length) {
    // Мёртвые подписки чистим в режиме платформы: строка найдена по своему id,
    // а держать ради уборки ещё одну транзакцию мастерской незачем.
    await withPlatform((tx) => tx.pushSubscription.deleteMany({ where: { id: { in: dead } } }));
  }
}
