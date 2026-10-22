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
/**
 * Совладельцы — своим столбцом (22.10.2026). Раньше они сидели в столбце
 * «Владелец», и всё, что отмечено владельцу (просрочка, лимит, «ремонт
 * готов»), уходило и совладельцу — в том числе по заказам владельца.
 */
export const COOWNER_ROLE = "coowner";

interface TenantNotice {
  event: NotificationEventCode;
  title: string;
  body?: string;
  /** Путь внутри приложения, например /orders/<id>. */
  url?: string;
  /** Человек, которому событие адресовано лично (назначенный мастер). */
  targetUserId?: string | null;
  /** Несколько адресатов лично — участники переписки в истории ремонта. */
  targetUserIds?: string[];
  /** Кого оповещать не надо — обычно тот, кто сам это действие и сделал. */
  exceptUserId?: string | null;
  payload?: Record<string, unknown>;
}

export async function notifyTenant(tenantId: string, notice: TenantNotice): Promise<void> {
  try {
    const targets = await withTenant(tenantId, async (tx) => {
      const why = await resolveRecipients(tx, tenantId, notice);
      const recipients = [...why.keys()];
      if (recipients.length === 0) return [];

      // Колокольчик в интерфейсе. Он работает и без Web Push, и без телефона —
      // это основной канал, push только доносит его быстрее. «Почему вам» —
      // в каждом оповещении: по нему видно, какая галочка его прислала.
      await tx.notification.createMany({
        data: recipients.map((userId) => ({
          tenantId,
          userId,
          type: notice.event,
          title: notice.title,
          body: notice.body ?? null,
          payload: { ...(notice.payload ?? {}), url: notice.url ?? null, why: why.get(userId) ?? null },
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
): Promise<Map<string, string>> {
  const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } });
  const matrix = readMatrix(tenant?.settings);
  const definition = NOTIFICATION_EVENTS.find((e) => e.code === notice.event);
  const eventTitle = definition?.title ?? notice.event;

  const configured = matrix[notice.event];
  const keys = configured ?? [...(definition?.defaultRoles ?? [])];
  // «Владелец» в умолчаниях и псевдороль owner — только сам владелец.
  const wantsOwner = keys.includes(OWNER_ROLE) || (!configured && keys.includes("Владелец"));
  const wantsCoOwner = keys.includes(COOWNER_ROLE);
  const roleKeys = keys.filter((k) => k !== OWNER_ROLE && k !== COOWNER_ROLE && k !== "Владелец");

  const or: Prisma.UserWhereInput[] = [];
  let roleIds: string[] = [];
  if (roleKeys.length) {
    // В настройках роли записаны id, в умолчаниях — названиями. Сводим к id,
    // чтобы найти роль и основной, и дополнительной у сотрудника.
    roleIds = configured
      ? roleKeys
      : (await tx.role.findMany({ where: { name: { in: roleKeys } }, select: { id: true } })).map((r) => r.id);
    if (roleIds.length) or.push({ roleId: { in: roleIds } }, { extraRoleIds: { hasSome: roleIds } });
  }
  if (wantsOwner) or.push({ isOwner: true });
  if (wantsCoOwner) or.push({ isCoOwner: true });

  const byRole = or.length
    ? await tx.user.findMany({
        where: { deletedAt: null, isActive: true, OR: or },
        select: { id: true, isOwner: true, isCoOwner: true, roleId: true, extraRoleIds: true, notifyOwnOnly: true },
      })
    : [];

  const roleRows = await tx.role.findMany({
    where: { id: { in: [...new Set(byRole.flatMap((u) => [u.roleId, ...(u.extraRoleIds ?? [])]).filter((x): x is string => !!x))] } },
    select: { id: true, name: true, permissions: true },
  });
  const roleById = new Map(roleRows.map((r) => [r.id, r]));
  const rolesOf = (u: (typeof byRole)[number]) =>
    [u.roleId, ...(u.extraRoleIds ?? [])].filter((id): id is string => !!id).map((id) => roleById.get(id)).filter((r) => !!r);

  // Личные события (назначен заказ, сообщение, ответ на согласование) — про
  // конкретный заказ. Отмеченная роль получает их, только если её люди видят
  // все заказы: иначе галочка «Мастер» у «Назначен заказ» раздавала каждому
  // мастеру чужие назначения, а открыть такой заказ он всё равно не мог.
  let allowed = byRole;
  if (definition?.hasDirectTarget && byRole.length) {
    allowed = byRole.filter(
      (u) => u.isOwner || u.isCoOwner || rolesOf(u).some((r) => r!.permissions.includes("orders.view.all"))
    );
  }

  // «Только по моим заказам» (настройка самого сотрудника): событие про
  // чужой заказ ему не уходит, даже если галочка роли стоит.
  const orderId = typeof notice.payload?.orderId === "string" ? notice.payload.orderId : null;
  if (orderId && allowed.some((u) => u.notifyOwnOnly)) {
    const order = await tx.order.findFirst({ where: { id: orderId }, select: { assignedMasterId: true } });
    allowed = allowed.filter((u) => !u.notifyOwnOnly || order?.assignedMasterId === u.id);
  }

  const out = new Map<string, string>();
  for (const u of allowed) {
    const matched = rolesOf(u).filter((r) => roleIds.includes(r!.id)).map((r) => r!.name);
    const why =
      wantsOwner && u.isOwner
        ? `в «Оповещениях» для «${eventTitle}» отмечен «Владелец»`
        : wantsCoOwner && u.isCoOwner
          ? `в «Оповещениях» для «${eventTitle}» отмечены «Совладельцы»`
          : matched.length
            ? `в «Оповещениях» для «${eventTitle}» отмечена ваша роль «${matched[0]}»`
            : `по настройке «Оповещений» для «${eventTitle}»`;
    out.set(u.id, why);
  }
  if (definition?.hasDirectTarget && notice.targetUserId) {
    out.set(notice.targetUserId, notice.event === "order.assigned" ? "вы назначены мастером этого заказа" : "вы мастер этого заказа");
  }
  if (definition?.hasDirectTarget) {
    for (const id of notice.targetUserIds ?? []) if (!out.has(id)) out.set(id, "вы мастер этого заказа или уже писали в его историю");
  }
  if (notice.exceptUserId) out.delete(notice.exceptUserId);
  return out;
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
  const { dead } = await sendPush(targets, payload);
  if (dead.length) {
    // Мёртвые подписки чистим в режиме платформы: строка найдена по своему id,
    // а держать ради уборки ещё одну транзакцию мастерской незачем.
    await withPlatform((tx) => tx.pushSubscription.deleteMany({ where: { id: { in: dead } } }));
  }
}
