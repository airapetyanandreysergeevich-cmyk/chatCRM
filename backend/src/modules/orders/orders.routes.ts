import type { Prisma } from "@prisma/client";
import { Router, type Request } from "express";
import multer from "multer";
import { z } from "zod";
import { clientIp, safeDiff, writeAudit } from "../../lib/audit";
import { withTenant } from "../../lib/db";
import {
  APPEARANCE_ITEMS,
  COMPLETENESS_ITEMS,
  normalizeChecklist,
} from "../../lib/dictionaries";
import { env } from "../../lib/env";
import { ah, badRequest, conflict, forbidden, notFound } from "../../lib/errors";
import { notifyTenant } from "../../lib/notify";
import { nextOrderNumber } from "../../lib/orderNumber";
import { PERMISSIONS } from "../../lib/permissions";
import { isAllowedUpload, putOrderFile, removeFile, signedUrl } from "../../lib/storage";
import {
  actorUserId,
  authenticate,
  currentTenantId,
  permissionsOf,
  requirePermission,
  requireTenant,
} from "../../middleware/auth";
import { enforceTenantStatus } from "../../middleware/tenantStatus";
import {
  assertOrderAccess,
  limitExceeded,
  orderInclude,
  previousRepairSummary,
  projectOrder,
  recalcTotals,
  seesAllOrders,
  seesCustomerContacts,
  seesMoney,
} from "./orders.service";

export const ordersRouter = Router();
ordersRouter.use(authenticate, requireTenant, enforceTenantStatus);

const tenantOf = (req: Request) => currentTenantId(req)!;
const has = (req: Request, code: string) => permissionsOf(req).includes(code);

/**
 * Оповещение о превышении согласованной суммы.
 * Отдельной функцией, потому что зовётся из двух мест — работы и запчасти
 * правят по очереди, а лимит один на заказ.
 */
function notifyLimit(
  tenantId: string,
  orderId: string,
  over: { number: string; total: number; limit: number } | null,
  actorId: string | null
): void {
  if (!over) return;
  const money = (v: number) => `${v.toLocaleString("ru-RU")} ₽`;
  void notifyTenant(tenantId, {
    event: "order.limit_exceeded",
    title: `Заказ ${over.number}: вышли за согласованную сумму`,
    body: `Насчитано ${money(over.total)} при согласованных ${money(over.limit)}. Нужно согласовать с клиентом.`,
    url: `/orders/${orderId}`,
    exceptUserId: actorId,
    payload: { orderId },
  });
}

/** Фото приходят с телефона мастера, поэтому держим их в памяти и сразу кладём в хранилище. */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.maxFileSizeMb * 1024 * 1024, files: 10 },
});

// ---------------------------------------------------------------- список

/**
 * Поиск по заказу.
 *
 * Ищем не только по номеру и технике, но и по всему, что люди пишут о
 * заказе словами: жалоба клиента, примечание приёмщика, диагноз, комментарии
 * мастера, рекомендация и подписи к смене статуса. Приёмщик помнит ремонт не
 * по номеру, а по фразе «та самая мамка с залитием» — и должен его найти.
 *
 * Контакты клиента подмешиваем только тому, кому они вообще положены:
 * иначе по ним можно перебором вытащить телефон, не имея права его видеть.
 */
function searchWhere(search: string, withContacts: boolean): Prisma.OrderWhereInput[] {
  const like = { contains: search, mode: "insensitive" as const };
  return [
    { number: like },
    { complaint: like },
    { receptionNote: like },
    { diagnosis: like },
    { masterComment: like },
    { internalComment: like },
    { recommendation: like },
    { appearanceNote: like },
    { storageLocation: like },
    { statusHistory: { some: { comment: like } } },
    { device: { is: { serial: like } } },
    { device: { is: { model: like } } },
    { device: { is: { brand: like } } },
    ...(withContacts
      ? [
          { customer: { is: { name: like } } },
          { customer: { is: { phone: { contains: search } } } },
        ]
      : []),
  ];
}

ordersRouter.get(
  "/",
  requirePermission(
    PERMISSIONS.ORDERS_VIEW_ALL,
    PERMISSIONS.ORDERS_VIEW_ASSIGNED,
    PERMISSIONS.ORDERS_VIEW_DELIVERY
  ),
  ah(async (req, res) => {
    const q = z
      .object({
        search: z.string().trim().max(120).optional(),
        statusId: z.string().uuid().optional(),
        group: z.enum(["NEW", "IN_PROGRESS", "WAITING", "DONE", "CLOSED", "CANCELLED"]).optional(),
        mine: z.enum(["1", "0"]).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(60),
      })
      .parse(req.query);

    const me = req.auth?.kind === "tenant" ? req.auth.userId : null;
    // Мастер видит только назначенное ему — фильтр стоит в запросе, а не в интерфейсе.
    const onlyMine = !seesAllOrders(req) || q.mine === "1";

    const rows = await withTenant(tenantOf(req), (tx) =>
      tx.order.findMany({
        where: {
          deletedAt: null,
          ...(onlyMine && me ? { assignedMasterId: me } : {}),
          ...(q.statusId ? { statusId: q.statusId } : {}),
          ...(q.group ? { status: { group: q.group } } : {}),
          ...(q.search ? { OR: searchWhere(q.search, seesCustomerContacts(req)) } : {}),
        },
        orderBy: [{ isUrgent: "desc" }, { acceptedAt: "desc" }],
        take: q.limit,
        include: orderInclude,
      })
    );

    const contacts = seesCustomerContacts(req);
    const money = seesMoney(req);
    res.json(rows.map((o) => projectOrder(o, { contacts, money })));
  })
);

// ---------------------------------------------------------------- приём техники

const acceptSchema = z.object({
  customer: z.object({
    id: z.string().uuid().optional(),
    name: z.string().trim().min(2, "Укажите имя клиента"),
    phone: z.string().trim().min(6, "Укажите телефон"),
    phone2: z.string().trim().optional(),
    email: z.string().email("Похоже, это не email").optional().or(z.literal("")),
    address: z.string().trim().optional(),
    type: z.enum(["INDIVIDUAL", "COMPANY"]).default("INDIVIDUAL"),
    source: z.string().trim().max(80).optional(),
  }),
  device: z.object({
    kind: z.string().trim().min(2, "Укажите тип техники"),
    brand: z.string().trim().optional(),
    model: z.string().trim().optional(),
    serial: z.string().trim().optional(),
  }),
  kind: z.enum(["REPAIR", "DIAGNOSTICS", "WARRANTY", "REPEAT"]).default("REPAIR"),
  parentOrderId: z.string().uuid().optional(),
  isUrgent: z.boolean().default(false),

  complaint: z.string().trim().min(3, "Опишите неисправность словами клиента"),
  receptionNote: z.string().trim().optional(),
  devicePasscode: z.string().trim().optional(),
  completeness: z.array(z.string()).default([]),
  appearance: z.array(z.string()).default([]),
  appearanceNote: z.string().trim().optional(),
  hasOpenTraces: z.boolean().default(false),
  hasWaterDamage: z.boolean().default(false),
  storageLocation: z.string().trim().optional(),

  dueAt: z.string().datetime().optional().or(z.literal("")),
  estimatedCost: z.number().min(0).optional(),
  approvedLimit: z.number().min(0).optional(),
  prepayment: z.number().min(0).default(0),
  assignedMasterId: z.string().uuid().optional(),
});

ordersRouter.post(
  "/",
  requirePermission(PERMISSIONS.ORDERS_CREATE),
  ah(async (req, res) => {
    const body = acceptSchema.parse(req.body);
    const tenantId = tenantOf(req);
    const userId = actorUserId(req);
    if (!userId) throw forbidden("Принимать технику может только сотрудник мастерской");

    const created = await withTenant(tenantId, async (tx) => {
      const branch = await tx.branch.findFirst({ where: { isDefault: true } });
      if (!branch) throw badRequest("В мастерской не настроен филиал");

      const status = await tx.orderStatus.findFirst({ where: { isInitial: true } });
      if (!status) throw badRequest("В мастерской не настроены статусы заказов");

      // Клиента ищем по телефону: один и тот же человек не должен плодиться
      // в базе после каждого визита.
      let customer =
        (body.customer.id
          ? await tx.customer.findFirst({ where: { id: body.customer.id, deletedAt: null } })
          : null) ?? (await tx.customer.findFirst({ where: { phone: body.customer.phone, deletedAt: null } }));

      if (!customer) {
        customer = await tx.customer.create({
          data: {
            tenantId,
            type: body.customer.type,
            name: body.customer.name,
            phone: body.customer.phone,
            phone2: body.customer.phone2 || null,
            email: body.customer.email || null,
            address: body.customer.address || null,
            source: body.customer.source || null,
            createdById: userId,
          },
        });
      }

      // Отдельными вызовами, без вложенных create: прокси в withTenant
      // до дочерних записей не дотягивается, и RLS их отклонит.
      const device = await tx.device.create({
        data: {
          tenantId,
          customerId: customer.id,
          kind: body.device.kind,
          brand: body.device.brand || null,
          model: body.device.model || null,
          serial: body.device.serial || null,
        },
      });

      if (body.parentOrderId) {
        const parent = await tx.order.findFirst({ where: { id: body.parentOrderId, deletedAt: null } });
        if (!parent) throw badRequest("Прошлый заказ не найден");
      }

      const number = await nextOrderNumber(tx, tenantId);

      const order = await tx.order.create({
        data: {
          tenantId,
          branchId: branch.id,
          number,
          kind: body.kind,
          isUrgent: body.isUrgent,
          customerId: customer.id,
          deviceId: device.id,
          statusId: status.id,
          acceptedById: userId,
          dueAt: body.dueAt ? new Date(body.dueAt) : null,
          complaint: body.complaint,
          receptionNote: body.receptionNote || null,
          devicePasscode: body.devicePasscode || null,
          completeness: normalizeChecklist(body.completeness, COMPLETENESS_ITEMS),
          appearance: normalizeChecklist(body.appearance, APPEARANCE_ITEMS),
          appearanceNote: body.appearanceNote || null,
          hasOpenTraces: body.hasOpenTraces,
          hasWaterDamage: body.hasWaterDamage,
          storageLocation: body.storageLocation || null,
          estimatedCost: body.estimatedCost ?? null,
          approvedLimit: body.approvedLimit ?? null,
          prepayment: body.prepayment,
          assignedMasterId: body.assignedMasterId ?? null,
          parentOrderId: body.parentOrderId ?? null,
        },
      });

      await tx.orderStatusHistory.create({
        data: { tenantId, orderId: order.id, toStatusId: status.id, userId, comment: "Принято в работу" },
      });
      await writeAudit(tx, {
        tenantId,
        userId,
        entity: "Order",
        entityId: order.id,
        action: "CREATE",
        diff: safeDiff({ number, kind: body.kind, device: body.device }),
        ip: clientIp(req),
      });

      return order;
    });

    // После транзакции: оповещение читает уже записанное и ходит в сеть,
    // держать ради него открытым соединение с базой незачем.
    if (created.assignedMasterId) {
      void notifyTenant(tenantId, {
        event: "order.assigned",
        title: `Новый заказ ${created.number}`,
        body: [body.device.kind, body.device.brand, body.device.model].filter(Boolean).join(" "),
        url: `/orders/${created.id}`,
        targetUserId: created.assignedMasterId,
        exceptUserId: userId,
        payload: { orderId: created.id },
      });
    }

    res.status(201).json({ id: created.id, number: created.number });
  })
);

// ---------------------------------------------------------------- карточка

ordersRouter.get(
  "/:id",
  requirePermission(
    PERMISSIONS.ORDERS_VIEW_ALL,
    PERMISSIONS.ORDERS_VIEW_ASSIGNED,
    PERMISSIONS.ORDERS_VIEW_DELIVERY
  ),
  ah(async (req, res) => {
    const tenantId = tenantOf(req);
    const data = await withTenant(tenantId, async (tx) => {
      const order = await tx.order.findFirst({
        where: { id: req.params.id, deletedAt: null },
        include: orderInclude,
      });
      if (!order) throw notFound("Заказ не найден");
      assertOrderAccess(req, order);

      // Гарантийный возврат без карточки прошлого ремонта бесполезен:
      // мастеру нужно знать, что делали в прошлый раз.
      const previousRepair = order.parentOrderId
        ? await previousRepairSummary(tx, order.parentOrderId)
        : null;

      return projectOrder(order, {
        contacts: seesCustomerContacts(req),
        money: seesMoney(req),
        previousRepair,
      });
    });
    res.json(data);
  })
);

// ---------------------------------------------------------------- правка приёмки

const patchSchema = acceptSchema
  .pick({
    isUrgent: true,
    complaint: true,
    receptionNote: true,
    devicePasscode: true,
    appearanceNote: true,
    storageLocation: true,
    hasOpenTraces: true,
    hasWaterDamage: true,
  })
  .partial()
  .extend({
    dueAt: z.string().datetime().nullable().optional(),
    estimatedCost: z.number().min(0).nullable().optional(),
    approvedLimit: z.number().min(0).nullable().optional(),
    assignedMasterId: z.string().uuid().nullable().optional(),
    completeness: z.array(z.string()).optional(),
    appearance: z.array(z.string()).optional(),
  });

ordersRouter.patch(
  "/:id",
  requirePermission(PERMISSIONS.ORDERS_EDIT),
  ah(async (req, res) => {
    const body = patchSchema.parse(req.body);
    const tenantId = tenantOf(req);

    const assigned = await withTenant(tenantId, async (tx) => {
      const order = await tx.order.findFirst({ where: { id: req.params.id, deletedAt: null } });
      if (!order) throw notFound("Заказ не найден");

      await tx.order.update({
        where: { id: order.id },
        data: {
          ...body,
          dueAt: body.dueAt === undefined ? undefined : body.dueAt ? new Date(body.dueAt) : null,
          completeness: body.completeness
            ? normalizeChecklist(body.completeness, COMPLETENESS_ITEMS)
            : undefined,
          appearance: body.appearance ? normalizeChecklist(body.appearance, APPEARANCE_ITEMS) : undefined,
        },
      });
      await writeAudit(tx, {
        tenantId,
        userId: actorUserId(req),
        entity: "Order",
        entityId: order.id,
        action: "UPDATE",
        diff: safeDiff(body as Record<string, unknown>),
        ip: clientIp(req),
      });

      // Оповещаем только когда мастера действительно сменили: сохранение
      // карточки без изменений не должно дёргать человека второй раз.
      const changed =
        body.assignedMasterId !== undefined && body.assignedMasterId !== order.assignedMasterId;
      return changed && body.assignedMasterId
        ? { masterId: body.assignedMasterId, number: order.number }
        : null;
    });

    if (assigned) {
      void notifyTenant(tenantId, {
        event: "order.assigned",
        title: `Вам назначен заказ ${assigned.number}`,
        url: `/orders/${req.params.id}`,
        targetUserId: assigned.masterId,
        exceptUserId: actorUserId(req),
        payload: { orderId: req.params.id },
      });
    }

    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------- статус

ordersRouter.post(
  "/:id/status",
  ah(async (req, res) => {
    const { statusId, comment } = z
      .object({ statusId: z.string().uuid(), comment: z.string().trim().max(500).optional() })
      .parse(req.body);
    const tenantId = tenantOf(req);
    const me = req.auth?.kind === "tenant" ? req.auth.userId : null;

    await withTenant(tenantId, async (tx) => {
      const order = await tx.order.findFirst({ where: { id: req.params.id, deletedAt: null } });
      if (!order) throw notFound("Заказ не найден");

      const canAny = has(req, PERMISSIONS.ORDERS_STATUS);
      const canOwn = has(req, PERMISSIONS.ORDERS_STATUS_OWN) && me && order.assignedMasterId === me;
      if (!canAny && !canOwn) throw forbidden("Менять статус этого заказа нельзя");

      const status = await tx.orderStatus.findFirst({ where: { id: statusId } });
      if (!status) throw badRequest("Статус не найден");
      if (status.id === order.statusId) return;

      await tx.order.update({
        where: { id: order.id },
        data: {
          statusId: status.id,
          completedAt: status.group === "DONE" ? new Date() : order.completedAt,
        },
      });
      await tx.orderStatusHistory.create({
        data: {
          tenantId,
          orderId: order.id,
          fromStatusId: order.statusId,
          toStatusId: status.id,
          userId: me,
          comment: comment || null,
        },
      });
      await writeAudit(tx, {
        tenantId,
        userId: me,
        entity: "Order",
        entityId: order.id,
        action: "STATUS",
        diff: { to: status.name },
        ip: clientIp(req),
      });
    });

    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------- работы и запчасти мастера

/** Мастер правит только свой заказ; управляющий и приёмщик — любой. */
async function loadEditableOrder(req: Request, tx: Parameters<typeof recalcTotals>[0]) {
  const order = await tx.order.findFirst({ where: { id: req.params.id, deletedAt: null } });
  if (!order) throw notFound("Заказ не найден");
  const me = req.auth?.kind === "tenant" ? req.auth.userId : null;
  const own = me && order.assignedMasterId === me;
  if (!has(req, PERMISSIONS.ORDERS_EDIT) && !own) throw forbidden("Этот заказ вам не назначен");
  return order;
}

const worksSchema = z.object({
  works: z
    .array(
      z.object({
        name: z.string().trim().min(2, "Назовите работу"),
        qty: z.number().min(0.001).default(1),
        price: z.number().min(0),
      })
    )
    .max(100),
});

ordersRouter.put(
  "/:id/works",
  ah(async (req, res) => {
    const { works } = worksSchema.parse(req.body);
    const tenantId = tenantOf(req);
    const me = req.auth?.kind === "tenant" ? req.auth.userId : null;

    const over = await withTenant(tenantId, async (tx) => {
      const order = await loadEditableOrder(req, tx);
      await tx.orderWork.deleteMany({ where: { orderId: order.id } });
      for (const w of works) {
        await tx.orderWork.create({
          data: { tenantId, orderId: order.id, name: w.name, qty: w.qty, price: w.price, masterId: me },
        });
      }
      await recalcTotals(tx, order.id);
      await writeAudit(tx, {
        tenantId,
        userId: me,
        entity: "Order",
        entityId: order.id,
        action: "UPDATE",
        diff: { works: works.length },
        ip: clientIp(req),
      });
      return limitExceeded(tx, order.id);
    });

    notifyLimit(tenantId, req.params.id, over, actorUserId(req));
    res.json({ ok: true });
  })
);

const partsSchema = z.object({
  parts: z
    .array(
      z.object({
        name: z.string().trim().min(2, "Назовите запчасть"),
        qty: z.number().min(0.001).default(1),
        price: z.number().min(0),
        source: z.enum(["STOCK", "PURCHASED", "CUSTOMER"]).default("STOCK"),
      })
    )
    .max(100),
});

ordersRouter.put(
  "/:id/parts",
  ah(async (req, res) => {
    const { parts } = partsSchema.parse(req.body);
    const tenantId = tenantOf(req);

    const over = await withTenant(tenantId, async (tx) => {
      const order = await loadEditableOrder(req, tx);
      await tx.orderPart.deleteMany({ where: { orderId: order.id } });
      for (const p of parts) {
        await tx.orderPart.create({
          data: { tenantId, orderId: order.id, name: p.name, qty: p.qty, price: p.price, source: p.source },
        });
      }
      await recalcTotals(tx, order.id);
      await writeAudit(tx, {
        tenantId,
        userId: actorUserId(req),
        entity: "Order",
        entityId: order.id,
        action: "UPDATE",
        diff: { parts: parts.length },
        ip: clientIp(req),
      });
      return limitExceeded(tx, order.id);
    });

    notifyLimit(tenantId, req.params.id, over, actorUserId(req));
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------- завершение ремонта

const completeSchema = z.object({
  diagnosis: z.string().trim().min(3, "Опишите, что оказалось не так"),
  masterComment: z.string().trim().optional(),
  internalComment: z.string().trim().optional(),
  recommendation: z.string().trim().optional(),
  warrantyDays: z.number().int().min(0).max(3650).optional(),
});

ordersRouter.post(
  "/:id/complete",
  ah(async (req, res) => {
    const body = completeSchema.parse(req.body);
    const tenantId = tenantOf(req);
    const me = req.auth?.kind === "tenant" ? req.auth.userId : null;

    const completed = await withTenant(tenantId, async (tx) => {
      const order = await loadEditableOrder(req, tx);
      const done = await tx.orderStatus.findFirst({ where: { group: "DONE" }, orderBy: { sortOrder: "asc" } });

      const warrantyUntil =
        body.warrantyDays && body.warrantyDays > 0
          ? new Date(Date.now() + body.warrantyDays * 24 * 60 * 60 * 1000)
          : null;

      await tx.order.update({
        where: { id: order.id },
        data: {
          diagnosis: body.diagnosis,
          masterComment: body.masterComment || null,
          internalComment: body.internalComment || null,
          recommendation: body.recommendation || null,
          warrantyDays: body.warrantyDays ?? null,
          warrantyUntil,
          completedAt: new Date(),
          ...(done ? { statusId: done.id } : {}),
        },
      });

      if (done && done.id !== order.statusId) {
        await tx.orderStatusHistory.create({
          data: {
            tenantId,
            orderId: order.id,
            fromStatusId: order.statusId,
            toStatusId: done.id,
            userId: me,
            comment: "Ремонт завершён",
          },
        });
      }
      await writeAudit(tx, {
        tenantId,
        userId: me,
        entity: "Order",
        entityId: order.id,
        action: "STATUS",
        diff: { completed: true },
        ip: clientIp(req),
      });

      const device = await tx.device.findFirst({
        where: { id: order.deviceId ?? "" },
        select: { kind: true, brand: true, model: true },
      });
      return {
        number: order.number,
        device: [device?.kind, device?.brand, device?.model].filter(Boolean).join(" "),
      };
    });

    void notifyTenant(tenantId, {
      event: "order.completed",
      title: `Ремонт готов — ${completed.number}`,
      body: completed.device ? `${completed.device}. Можно звонить клиенту.` : "Можно звонить клиенту.",
      url: `/orders/${req.params.id}`,
      exceptUserId: me,
      payload: { orderId: req.params.id },
    });

    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------- выдача

ordersRouter.post(
  "/:id/issue",
  requirePermission(PERMISSIONS.ORDERS_ISSUE),
  ah(async (req, res) => {
    const { discount, reason } = z
      .object({
        discount: z.number().min(0).default(0),
        reason: z.string().trim().min(3).max(300).optional(),
      })
      .parse(req.body ?? {});
    const tenantId = tenantOf(req);

    await withTenant(tenantId, async (tx) => {
      const order = await tx.order.findFirst({ where: { id: req.params.id, deletedAt: null } });
      if (!order) throw notFound("Заказ не найден");
      if (order.issuedAt) throw conflict("Заказ уже выдан");
      // Технику можно отдать и без ремонта — клиент отказался, не подтвердилась
      // неисправность. Но это осознанное решение, поэтому нужна причина: иначе
      // заказ закрывается «в ноль» и никто потом не поймёт, что произошло.
      if (!order.completedAt && !reason) {
        throw conflict("Ремонт ещё не завершён — укажите причину выдачи без ремонта");
      }

      const closed = await tx.orderStatus.findFirst({
        where: { group: "CLOSED" },
        orderBy: { sortOrder: "asc" },
      });

      await tx.order.update({ where: { id: order.id }, data: { discount } });
      await recalcTotals(tx, order.id);
      await tx.order.update({
        where: { id: order.id },
        data: {
          issuedAt: new Date(),
          issuedById: actorUserId(req),
          ...(closed ? { statusId: closed.id } : {}),
        },
      });
      if (closed && closed.id !== order.statusId) {
        await tx.orderStatusHistory.create({
          data: {
            tenantId,
            orderId: order.id,
            fromStatusId: order.statusId,
            toStatusId: closed.id,
            userId: actorUserId(req),
            comment: reason ? `Выдано без ремонта: ${reason}` : "Выдано клиенту",
          },
        });
      }
      await writeAudit(tx, {
        tenantId,
        userId: actorUserId(req),
        entity: "Order",
        entityId: order.id,
        action: "STATUS",
        diff: { issued: true, discount, ...(reason ? { withoutRepair: reason } : {}) },
        ip: clientIp(req),
      });
    });

    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------- фотографии

ordersRouter.post(
  "/:id/attachments",
  upload.array("files", 10),
  ah(async (req, res) => {
    const kind = z
      .enum(["INTAKE", "COMPLETION", "DOCUMENT", "OTHER"])
      .catch("OTHER")
      .parse(req.body?.kind);
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (!files.length) throw badRequest("Файлы не приложены");

    const tenantId = tenantOf(req);

    for (const f of files) {
      if (!isAllowedUpload(f.mimetype)) {
        throw badRequest(`Такой файл загрузить нельзя: ${f.originalname}`);
      }
    }

    // Права проверяем в короткой транзакции, а сами файлы льём уже снаружи:
    // десяток фотографий по мобильному интернету — это секунды, и держать
    // всё это время открытую транзакцию к базе незачем.
    const orderId = await withTenant(tenantId, async (tx) => (await loadEditableOrder(req, tx)).id);

    const uploaded: Array<{ key: string; file: Express.Multer.File }> = [];
    for (const f of files) {
      uploaded.push({
        key: await putOrderFile({ tenantId, orderId, buffer: f.buffer, mimeType: f.mimetype }),
        file: f,
      });
    }

    const saved = await withTenant(tenantId, async (tx) => {
      const out = [];
      for (const { key, file } of uploaded) {
        const row = await tx.attachment.create({
          data: {
            tenantId,
            orderId,
            kind,
            objectKey: key,
            fileName: file.originalname.slice(0, 200),
            mimeType: file.mimetype,
            sizeBytes: file.size,
            uploadedById: actorUserId(req),
          },
        });
        out.push({ id: row.id, fileName: row.fileName, kind: row.kind });
      }
      return out;
    });

    res.status(201).json(saved);
  })
);

ordersRouter.get(
  "/:id/attachments/:attachmentId/url",
  ah(async (req, res) => {
    const tenantId = tenantOf(req);
    const key = await withTenant(tenantId, async (tx) => {
      const order = await tx.order.findFirst({ where: { id: req.params.id, deletedAt: null } });
      if (!order) throw notFound("Заказ не найден");
      assertOrderAccess(req, order);

      const attachment = await tx.attachment.findFirst({
        where: { id: req.params.attachmentId, orderId: order.id },
      });
      if (!attachment) throw notFound("Файл не найден");
      return attachment.objectKey;
    });

    res.json({ url: await signedUrl(key) });
  })
);

ordersRouter.delete(
  "/:id/attachments/:attachmentId",
  ah(async (req, res) => {
    const tenantId = tenantOf(req);
    const key = await withTenant(tenantId, async (tx) => {
      const order = await loadEditableOrder(req, tx);
      const attachment = await tx.attachment.findFirst({
        where: { id: req.params.attachmentId, orderId: order.id },
      });
      if (!attachment) throw notFound("Файл не найден");
      await tx.attachment.delete({ where: { id: attachment.id } });
      return attachment.objectKey;
    });
    await removeFile(key);
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------- история

ordersRouter.get(
  "/:id/history",
  ah(async (req, res) => {
    const tenantId = tenantOf(req);
    const rows = await withTenant(tenantId, async (tx) => {
      const order = await tx.order.findFirst({ where: { id: req.params.id, deletedAt: null } });
      if (!order) throw notFound("Заказ не найден");
      assertOrderAccess(req, order);
      return tx.orderStatusHistory.findMany({
        where: { orderId: order.id },
        orderBy: { createdAt: "asc" },
        include: {
          fromStatus: { select: { name: true } },
          toStatus: { select: { name: true } },
          user: { select: { fullName: true } },
        },
      });
    });
    res.json(rows);
  })
);
