import { Router, type Request } from "express";
import { z } from "zod";
import { withPlatform, withTenant } from "../../lib/db";
import { env, pushConfigured } from "../../lib/env";
import { ah, badRequest, notFound } from "../../lib/errors";
import { NOTIFICATION_EVENTS, isEventCode } from "../../lib/notificationEvents";
import { OWNER_ROLE } from "../../lib/notify";
import { PERMISSIONS } from "../../lib/permissions";
import { sendPush } from "../../lib/push";
import {
  authenticate,
  currentTenantId,
  requirePermission,
  requireTenant,
} from "../../middleware/auth";

/**
 * Подписки на push живут отдельным роутером: подписаться должен уметь и
 * сотрудник мастерской, и собственник платформы. Привязка берётся из вида
 * токена, а не из currentTenantId — иначе платформенный пользователь,
 * зашедший в мастерскую через «войти как», подписал бы на свой телефон
 * чужую мастерскую и получал бы её оповещения после выхода.
 */
export const pushRouter = Router();
pushRouter.use(authenticate);

pushRouter.get(
  "/key",
  ah(async (_req, res) => {
    res.json({ configured: pushConfigured, publicKey: env.vapidPublicKey || null });
  })
);

const subscriptionSchema = z.object({
  endpoint: z.string().url().max(1000),
  p256dh: z.string().min(1).max(300),
  auth: z.string().min(1).max(300),
  userAgent: z.string().max(300).optional(),
});

pushRouter.post(
  "/subscribe",
  ah(async (req, res) => {
    if (!pushConfigured) throw badRequest("Оповещения на сервере не настроены");
    const body = subscriptionSchema.parse(req.body);
    const auth = req.auth!;

    // Один и тот же браузер может переподписаться с тем же endpoint — тогда
    // просто переписываем владельца: телефон мог перейти другому сотруднику
    // или в другую мастерскую. endpoint уникален по всей базе, поэтому старую
    // строку убираем в режиме платформы: из своей мастерской чужую не видно,
    // и вставка упала бы на уникальном индексе.
    await withPlatform((tx) =>
      tx.pushSubscription.deleteMany({ where: { endpoint: body.endpoint } })
    );

    if (auth.kind === "tenant") {
      await withTenant(auth.tenantId, (tx) =>
        tx.pushSubscription.create({
          data: {
            userId: auth.userId,
            endpoint: body.endpoint,
            p256dh: body.p256dh,
            auth: body.auth,
            userAgent: body.userAgent ?? null,
          },
        })
      );
    } else {
      await withPlatform(async (tx) => {
        await tx.pushSubscription.create({
          data: {
            platformUserId: auth.platformUserId,
            endpoint: body.endpoint,
            p256dh: body.p256dh,
            auth: body.auth,
            userAgent: body.userAgent ?? null,
          },
        });
      });
    }

    res.status(201).json({ ok: true });
  })
);

pushRouter.post(
  "/unsubscribe",
  ah(async (req, res) => {
    const { endpoint } = z.object({ endpoint: z.string().max(1000) }).parse(req.body);
    const auth = req.auth!;
    // Отписка только своей подписки: одного знания endpoint мало, иначе
    // любой авторизованный мог бы молча отключить оповещения соседу.
    const owner =
      auth.kind === "tenant"
        ? { userId: auth.userId }
        : { platformUserId: auth.platformUserId };
    await withPlatform((tx) => tx.pushSubscription.deleteMany({ where: { endpoint, ...owner } }));
    res.json({ ok: true });
  })
);

/**
 * Браузер сообщает, стоит ли на этом телефоне наше андроид-приложение.
 *
 * Сам сервер узнать этого не может: сайту не положено видеть список
 * установленных программ. Отвечает только Chrome и только про наш пакет —
 * связь домена и приложения подтверждена с двух сторон.
 *
 * Значение справочное: владелец видит в списке сотрудников, кто ещё без
 * приложения, потому что мастер без него не получает оповещений о заказах.
 */
pushRouter.post(
  "/android",
  ah(async (req, res) => {
    const { installed } = z.object({ installed: z.boolean() }).parse(req.body);
    const auth = req.auth!;
    if (auth.kind !== "tenant") return res.json({ ok: true });

    await withTenant(auth.tenantId, (tx) =>
      tx.user.updateMany({
        where: { id: auth.userId },
        data: { androidAppAt: installed ? new Date() : null },
      })
    );

    res.json({ ok: true });
  })
);

/** Проверка канала: приходит ровно тому, кто нажал кнопку. */
pushRouter.post(
  "/test",
  ah(async (req, res) => {
    const auth = req.auth!;
    const where =
      auth.kind === "tenant"
        ? { userId: auth.userId }
        : { platformUserId: auth.platformUserId };

    const targets = await withPlatform((tx) =>
      tx.pushSubscription.findMany({
        where,
        select: { id: true, endpoint: true, p256dh: true, auth: true },
      })
    );
    if (targets.length === 0) throw badRequest("На этом аккаунте нет ни одного подписанного устройства");

    const result = await sendPush(targets, {
      title: "FineCRM",
      body: "Проверка связи — оповещения работают.",
      url: "/",
      tag: "test",
    });
    if (result.dead.length) {
      await withPlatform((tx) =>
        tx.pushSubscription.deleteMany({ where: { id: { in: result.dead } } })
      );
    }

    // Отдаём причины отказа, а не только счётчик: раньше отвергнутая подпись
    // считалась успешной отправкой, и кнопка бодро рапортовала об отправке,
    // пока на телефон ничего не приходило.
    res.json({
      sent: result.delivered,
      removed: result.dead.length,
      failed: result.failures.length,
      reasons: [...new Set(result.failures.map((f) => f.reason))],
    });
  })
);

// ------------------------------------------------------------ колокольчик и настройки

export const notificationsRouter = Router();
notificationsRouter.use(authenticate, requireTenant);

const tenantOf = (req: Request) => currentTenantId(req)!;
const userOf = (req: Request) => (req.auth?.kind === "tenant" ? req.auth.userId : null);

notificationsRouter.get(
  "/",
  ah(async (req, res) => {
    const userId = userOf(req);
    if (!userId) return res.json({ unread: 0, items: [] });

    const data = await withTenant(tenantOf(req), async (tx) => {
      const items = await tx.notification.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: 30,
      });
      const unread = await tx.notification.count({ where: { userId, readAt: null } });
      return { unread, items };
    });

    res.json({
      unread: data.unread,
      items: data.items.map((n) => ({
        id: n.id,
        type: n.type,
        title: n.title,
        body: n.body,
        url: (n.payload as { url?: string } | null)?.url ?? null,
        readAt: n.readAt,
        createdAt: n.createdAt,
      })),
    });
  })
);

notificationsRouter.post(
  "/read",
  ah(async (req, res) => {
    const userId = userOf(req);
    if (!userId) throw notFound("Оповещения есть только у сотрудников мастерской");
    const { ids } = z.object({ ids: z.array(z.string().uuid()).optional() }).parse(req.body ?? {});

    await withTenant(tenantOf(req), (tx) =>
      tx.notification.updateMany({
        where: { userId, readAt: null, ...(ids?.length ? { id: { in: ids } } : {}) },
        data: { readAt: new Date() },
      })
    );

    res.json({ ok: true });
  })
);

notificationsRouter.get(
  "/settings",
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  ah(async (req, res) => {
    const data = await withTenant(tenantOf(req), async (tx) => {
      const tenant = await tx.tenant.findUnique({
        where: { id: tenantOf(req) },
        select: { settings: true },
      });
      const roles = await tx.role.findMany({
        orderBy: { name: "asc" },
        select: { id: true, name: true },
      });
      return { settings: tenant?.settings, roles };
    });

    const saved = (data.settings as { notifications?: Record<string, string[]> } | null)
      ?.notifications;

    res.json({
      // Владелец — псевдороль: строкой в справочнике ролей он может и не быть,
      // а оповещения получать должен.
      roles: [{ id: OWNER_ROLE, name: "Владелец" }, ...data.roles],
      events: NOTIFICATION_EVENTS.map((e) => ({
        code: e.code,
        title: e.title,
        hint: e.hint,
        hasDirectTarget: e.hasDirectTarget,
        // Пока владелец ничего не настраивал, показываем, что работает
        // по умолчанию, — а не пустые галочки при живых оповещениях.
        roles:
          saved?.[e.code] ??
          e.defaultRoles.map((name) =>
            name === "Владелец"
              ? OWNER_ROLE
              : (data.roles.find((r) => r.name === name)?.id ?? name)
          ),
        configured: Boolean(saved?.[e.code]),
      })),
    });
  })
);

notificationsRouter.put(
  "/settings",
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  ah(async (req, res) => {
    const { matrix } = z
      .object({ matrix: z.record(z.string(), z.array(z.string().max(64)).max(50)) })
      .parse(req.body);

    const tenantId = tenantOf(req);

    await withTenant(tenantId, async (tx) => {
      const roles = await tx.role.findMany({ select: { id: true } });
      const known = new Set([OWNER_ROLE, ...roles.map((r) => r.id)]);

      // В настройки попадают только существующие роли этой мастерской:
      // иначе чужой id остался бы лежать в Json и однажды кого-то оповестил.
      const clean: Record<string, string[]> = {};
      for (const [code, ids] of Object.entries(matrix)) {
        if (!isEventCode(code)) continue;
        clean[code] = [...new Set(ids.filter((id) => known.has(id)))];
      }

      const tenant = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: { settings: true },
      });
      const settings = { ...((tenant?.settings as object) ?? {}), notifications: clean };
      await tx.tenant.update({ where: { id: tenantId }, data: { settings } });
    });

    res.json({ ok: true });
  })
);
