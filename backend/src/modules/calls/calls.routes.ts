import { Router, type Request } from "express";
import { z } from "zod";
import { clientIp, writeAudit } from "../../lib/audit";
import { withTenant } from "../../lib/db";
import { ah, badRequest, forbidden, notFound } from "../../lib/errors";
import { PERMISSIONS } from "../../lib/permissions";
import { actorUserId, authenticate, currentTenantId, permissionsOf, requireTenant } from "../../middleware/auth";
import { enforceTenantStatus } from "../../middleware/tenantStatus";
import { assertOrderAccess, seesCustomerContacts } from "../orders/orders.service";
import { CALLS_KIND, KEEP_DAYS, callSelect, callView, loadCallSettings } from "./calls";

/**
 * Звонки клиентов для сотрудников: настройки («Настройки → Интеграции →
 * Звонки клиентов»), список звонков заказа и клиента, перенос в другой заказ.
 */
export const callsRouter = Router();
callsRouter.use(authenticate, requireTenant, enforceTenantStatus);

const tenantOf = (req: Request) => currentTenantId(req)!;
const has = (req: Request, code: string) => permissionsOf(req).includes(code);
const viewOpts = (req: Request) => ({ contacts: seesCustomerContacts(req), listen: has(req, PERMISSIONS.CALLS_LISTEN) });

callsRouter.get(
  "/settings",
  ah(async (req, res) => {
    if (!has(req, PERMISSIONS.SETTINGS_MANAGE)) throw forbidden("Звонки настраивает администратор мастерской");
    const out = await withTenant(tenantOf(req), async (tx) => {
      const s = await loadCallSettings(tx);
      const since = new Date(Date.now() - 30 * 86_400_000);
      const [total, withAudio, lastAt] = await Promise.all([
        tx.callRecord.count({ where: { startedAt: { gte: since } } }),
        tx.callRecord.count({ where: { startedAt: { gte: since }, attachmentId: { not: null } } }),
        tx.callRecord.findFirst({ orderBy: { startedAt: "desc" }, select: { startedAt: true } }),
      ]);
      return { settings: s, month: { total, withAudio }, lastAt: lastAt?.startedAt ?? null };
    });
    res.json(out);
  })
);

callsRouter.put(
  "/settings",
  ah(async (req, res) => {
    if (!has(req, PERMISSIONS.SETTINGS_MANAGE)) throw forbidden("Звонки настраивает администратор мастерской");
    const body = z
      .object({
        enabled: z.boolean(),
        audio: z.boolean(),
        missed: z.boolean(),
        keepDays: z.number().int().refine((v) => (KEEP_DAYS as readonly number[]).includes(v), "Срок — 90 дней, год или всегда"),
      })
      .parse(req.body);
    const tenantId = tenantOf(req);
    const saved = await withTenant(tenantId, async (tx) => {
      const config = { audio: body.audio, missed: body.missed, keepDays: body.keepDays };
      const row = await tx.integration.upsert({
        where: { tenantId_kind: { tenantId, kind: CALLS_KIND } },
        create: { tenantId, kind: CALLS_KIND, enabled: body.enabled, config },
        update: { enabled: body.enabled, config },
      });
      await writeAudit(tx, {
        tenantId,
        userId: actorUserId(req),
        entity: "Integration",
        entityId: row.id,
        action: "UPDATE",
        diff: { kind: CALLS_KIND, ...body },
        ip: clientIp(req),
      });
      return loadCallSettings(tx);
    });
    res.json({ settings: saved });
  })
);

/** Звонки заказа (?orderId=) или клиента (?customerId=), новые сверху. */
callsRouter.get(
  "/",
  ah(async (req, res) => {
    const q = z.object({ orderId: z.string().uuid().optional(), customerId: z.string().uuid().optional() }).parse(req.query);
    if (!q.orderId && !q.customerId) throw badRequest("Укажите заказ или клиента");
    const rows = await withTenant(tenantOf(req), async (tx) => {
      if (q.orderId) {
        const order = await tx.order.findFirst({ where: { id: q.orderId, deletedAt: null }, select: { id: true, assignedMasterId: true } });
        if (!order) throw notFound("Заказ не найден");
        assertOrderAccess(req, order);
        return tx.callRecord.findMany({ where: { orderId: order.id }, orderBy: { startedAt: "desc" }, take: 200, select: callSelect });
      }
      if (!has(req, PERMISSIONS.CUSTOMERS_VIEW)) throw forbidden("Нет доступа к клиентам");
      return tx.callRecord.findMany({ where: { customerId: q.customerId }, orderBy: { startedAt: "desc" }, take: 200, select: callSelect });
    });
    const opts = viewOpts(req);
    res.json({ items: await Promise.all(rows.map((c) => callView(c, opts))), canListen: opts.listen });
  })
);

/**
 * Перенести звонок в другой заказ того же клиента или оставить только у
 * клиента (orderId: null). Автоматически перенесённый звонок больше не трогаем.
 */
callsRouter.patch(
  "/:id",
  ah(async (req, res) => {
    if (!has(req, PERMISSIONS.ORDERS_EDIT)) throw forbidden("Переносить звонки может тот, кто правит заказы");
    const body = z.object({ orderId: z.string().uuid().nullable() }).parse(req.body);
    const tenantId = tenantOf(req);
    const row = await withTenant(tenantId, async (tx) => {
      const call = await tx.callRecord.findFirst({ where: { id: req.params.id }, select: { id: true, customerId: true, orderId: true } });
      if (!call) throw notFound("Звонок не найден");
      if (body.orderId) {
        const order = await tx.order.findFirst({ where: { id: body.orderId, deletedAt: null }, select: { id: true, customerId: true, number: true } });
        if (!order) throw notFound("Заказ не найден");
        if (call.customerId && order.customerId !== call.customerId) throw badRequest("Звонок можно перенести только в заказ этого же клиента");
      }
      const updated = await tx.callRecord.update({
        where: { id: call.id },
        data: { orderId: body.orderId, movedById: actorUserId(req) },
        select: callSelect,
      });
      await writeAudit(tx, {
        tenantId,
        userId: actorUserId(req),
        entity: "CallRecord",
        entityId: call.id,
        action: "UPDATE",
        diff: { orderId: { from: call.orderId, to: body.orderId } },
        ip: clientIp(req),
      });
      return updated;
    });
    res.json(await callView(row, viewOpts(req)));
  })
);

/** Заказы клиента звонка — куда его можно перенести. */
callsRouter.get(
  "/:id/targets",
  ah(async (req, res) => {
    const rows = await withTenant(tenantOf(req), async (tx) => {
      const call = await tx.callRecord.findFirst({ where: { id: req.params.id }, select: { customerId: true } });
      if (!call) throw notFound("Звонок не найден");
      if (!call.customerId) return [];
      return tx.order.findMany({
        where: { customerId: call.customerId, deletedAt: null },
        orderBy: { acceptedAt: "desc" },
        take: 30,
        select: { id: true, number: true, acceptedAt: true, issuedAt: true, device: { select: { kind: true, brand: true, model: true } } },
      });
    });
    res.json({ items: rows });
  })
);
