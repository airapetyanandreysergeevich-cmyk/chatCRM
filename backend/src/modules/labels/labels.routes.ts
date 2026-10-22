import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { clientIp, writeAudit } from "../../lib/audit";
import { withTenant } from "../../lib/db";
import { ah, badRequest, conflict, forbidden, notFound } from "../../lib/errors";
import { notifyTenant } from "../../lib/notify";
import { PERMISSIONS } from "../../lib/permissions";
import { actorUserId, authenticate, currentTenantId, isOwnerLike, permissionsOf, requireTenant } from "../../middleware/auth";
import { enforceTenantStatus } from "../../middleware/tenantStatus";

/**
 * Индивидуальные оповещения — свои ярлыки заказов мастерской (Андрей,
 * 22.10.2026): «Требуется звонок клиенту» синим кружком с телефоном рядом со
 * статусом. Значок — ключ из коллекции интерфейса (frontend/src/lib/labelIcons),
 * цвет — свой.
 *
 * Заводит и правит ярлыки владелец или совладелец. Ставят и снимают их все,
 * кто работает с заказом: правит его, меняет статус или чинит. Каждое
 * «поставил / снял» — строкой в истории ремонта (OrderEvent).
 */
export const labelsRouter = Router();
labelsRouter.use(authenticate, requireTenant, enforceTenantStatus);

const tenantOf = (req: Request) => currentTenantId(req)!;
const has = (req: Request, code: string) => permissionsOf(req).includes(code);

const MAX_LABELS = 40;

function requireOwner(req: Request, _res: Response, next: NextFunction) {
  if (isOwnerLike(req) || req.auth?.kind === "platform") return next();
  next(forbidden("Ярлыки заводит владелец мастерской"));
}

const labelSchema = z.object({
  name: z.string().trim().min(1, "Назовите ярлык").max(60, "Слишком длинное название — до 60 знаков"),
  icon: z.string().regex(/^[a-z0-9-]{1,24}$/, "Выберите значок"),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Выберите цвет"),
  quickFilter: z.boolean().default(false),
  notify: z.boolean().default(false),
});

/** Ярлыки мастерской и сколько заказов в работе с каждым. */
labelsRouter.get(
  "/",
  ah(async (req, res) => {
    const rows = await withTenant(tenantOf(req), async (tx) => {
      const labels = await tx.orderLabel.findMany({ orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
      const counts = await tx.orderLabelMark.groupBy({
        by: ["labelId"],
        where: { order: { deletedAt: null, issuedAt: null } },
        _count: { _all: true },
      });
      const n = new Map(counts.map((c) => [c.labelId, c._count._all]));
      return labels.map((l) => ({ id: l.id, name: l.name, icon: l.icon, color: l.color, quickFilter: l.quickFilter, notify: l.notify, orders: n.get(l.id) ?? 0 }));
    });
    res.json({ items: rows, canManage: isOwnerLike(req) || req.auth?.kind === "platform" });
  })
);

labelsRouter.post(
  "/",
  requireOwner,
  ah(async (req, res) => {
    const body = labelSchema.parse(req.body);
    const tenantId = tenantOf(req);
    const created = await withTenant(tenantId, async (tx) => {
      const count = await tx.orderLabel.count();
      if (count >= MAX_LABELS) throw badRequest(`Ярлыков не больше ${MAX_LABELS}`);
      if (await tx.orderLabel.findFirst({ where: { name: { equals: body.name, mode: "insensitive" } } })) {
        throw conflict(`Ярлык «${body.name}» уже есть`);
      }
      const last = await tx.orderLabel.aggregate({ _max: { sortOrder: true } });
      const label = await tx.orderLabel.create({ data: { ...body, tenantId, sortOrder: (last._max.sortOrder ?? 0) + 1 } });
      await writeAudit(tx, { tenantId, userId: actorUserId(req), entity: "OrderLabel", entityId: label.id, action: "CREATE", diff: { name: body.name }, ip: clientIp(req) });
      return label;
    });
    res.status(201).json(created);
  })
);

/** Порядок ярлыков: весь список id сверху вниз. */
labelsRouter.put(
  "/order",
  requireOwner,
  ah(async (req, res) => {
    const { ids } = z.object({ ids: z.array(z.string().uuid()).max(MAX_LABELS) }).parse(req.body);
    await withTenant(tenantOf(req), async (tx) => {
      for (const [i, id] of ids.entries()) await tx.orderLabel.updateMany({ where: { id }, data: { sortOrder: i + 1 } });
    });
    res.json({ ok: true });
  })
);

labelsRouter.patch(
  "/:id",
  requireOwner,
  ah(async (req, res) => {
    const body = labelSchema.partial().parse(req.body);
    const tenantId = tenantOf(req);
    const updated = await withTenant(tenantId, async (tx) => {
      const label = await tx.orderLabel.findFirst({ where: { id: req.params.id } });
      if (!label) throw notFound("Ярлык не найден");
      if (body.name && body.name.toLowerCase() !== label.name.toLowerCase()) {
        if (await tx.orderLabel.findFirst({ where: { name: { equals: body.name, mode: "insensitive" }, id: { not: label.id } } })) {
          throw conflict(`Ярлык «${body.name}» уже есть`);
        }
      }
      return tx.orderLabel.update({ where: { id: label.id }, data: body });
    });
    res.json(updated);
  })
);

/** Удалить ярлык — снимается со всех заказов; строки в истории ремонта остаются. */
labelsRouter.delete(
  "/:id",
  requireOwner,
  ah(async (req, res) => {
    const tenantId = tenantOf(req);
    const removed = await withTenant(tenantId, async (tx) => {
      const label = await tx.orderLabel.findFirst({ where: { id: req.params.id } });
      if (!label) throw notFound("Ярлык не найден");
      const marks = await tx.orderLabelMark.count({ where: { labelId: label.id } });
      await tx.orderLabel.delete({ where: { id: label.id } });
      await writeAudit(tx, { tenantId, userId: actorUserId(req), entity: "OrderLabel", entityId: label.id, action: "DELETE", diff: { name: label.name, marks }, ip: clientIp(req) });
      return { marks };
    });
    res.json({ ok: true, ...removed });
  })
);

// ------------------------------------------------------------ на заказе

/**
 * Поставить или снять ярлык на заказе.
 *
 * Кто может: тот, кто правит заказы, меняет статусы или назначает мастеров, —
 * и мастер на своём заказе. Мастер с «только своими» чужого заказа не видит,
 * значит и ярлык на него не поставит.
 */
export const orderLabelsRouter = Router({ mergeParams: true });
orderLabelsRouter.use(authenticate, requireTenant, enforceTenantStatus);

orderLabelsRouter.post(
  "/",
  ah(async (req, res) => {
    const { labelId, on } = z.object({ labelId: z.string().uuid(), on: z.boolean() }).parse(req.body);
    const tenantId = tenantOf(req);
    const me = actorUserId(req);
    const result = await withTenant(tenantId, async (tx) => {
      const order = await tx.order.findFirst({
        where: { id: (req.params as { id: string }).id, deletedAt: null },
        select: { id: true, number: true, assignedMasterId: true },
      });
      if (!order) throw notFound("Заказ не найден");
      const own = !!me && order.assignedMasterId === me;
      const seesAll = has(req, PERMISSIONS.ORDERS_VIEW_ALL);
      if (!seesAll && !own) throw notFound("Заказ не найден");
      const may =
        has(req, PERMISSIONS.ORDERS_EDIT) ||
        has(req, PERMISSIONS.ORDERS_STATUS) ||
        has(req, PERMISSIONS.ORDERS_ASSIGN) ||
        (own && has(req, PERMISSIONS.ORDERS_STATUS_OWN));
      if (!may) throw forbidden("Ставить ярлыки может тот, кто работает с заказом");

      const label = await tx.orderLabel.findFirst({ where: { id: labelId } });
      if (!label) throw notFound("Ярлык не найден — возможно, его удалили");
      const mark = await tx.orderLabelMark.findFirst({ where: { orderId: order.id, labelId } });
      if (on === !!mark) return { changed: false, order, label };
      if (on) await tx.orderLabelMark.create({ data: { tenantId, orderId: order.id, labelId, setById: me } });
      else await tx.orderLabelMark.delete({ where: { id: mark!.id } });
      await tx.orderEvent.create({
        data: {
          tenantId,
          orderId: order.id,
          userId: me,
          kind: on ? "LABEL_SET" : "LABEL_UNSET",
          // Название и вид — на момент события: ярлык потом могут
          // переименовать или удалить, а история должна читаться как была.
          data: { labelId, name: label.name, icon: label.icon, color: label.color },
        },
      });
      return { changed: true, order, label };
    });

    if (result.changed && on && result.label.notify) {
      void notifyTenant(tenantId, {
        event: "order.label",
        title: `${result.label.name} — заказ ${result.order.number}`,
        url: `/orders/${result.order.id}`,
        targetUserId: result.order.assignedMasterId,
        exceptUserId: me,
        payload: { orderId: result.order.id, labelId },
      });
    }
    res.json({ ok: true, changed: result.changed });
  })
);
