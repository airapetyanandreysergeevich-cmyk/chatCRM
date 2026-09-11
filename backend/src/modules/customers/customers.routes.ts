import { Router, type Request } from "express";
import { z } from "zod";
import { clientIp, safeDiff, writeAudit } from "../../lib/audit";
import { withTenant } from "../../lib/db";
import { ah, notFound } from "../../lib/errors";
import { PERMISSIONS } from "../../lib/permissions";
import { actorUserId, authenticate, currentTenantId, requirePermission, requireTenant } from "../../middleware/auth";
import { enforceTenantStatus } from "../../middleware/tenantStatus";

export const customersRouter = Router();
customersRouter.use(authenticate, requireTenant, enforceTenantStatus);

const tenantOf = (req: Request) => currentTenantId(req)!;

customersRouter.get(
  "/",
  requirePermission(PERMISSIONS.CUSTOMERS_VIEW),
  ah(async (req, res) => {
    const q = z
      .object({
        search: z.string().trim().max(120).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(60),
      })
      .parse(req.query);

    const rows = await withTenant(tenantOf(req), (tx) =>
      tx.customer.findMany({
        where: {
          deletedAt: null,
          ...(q.search
            ? {
                OR: [
                  { name: { contains: q.search, mode: "insensitive" as const } },
                  { phone: { contains: q.search } },
                  { email: { contains: q.search, mode: "insensitive" as const } },
                ],
              }
            : {}),
        },
        orderBy: { createdAt: "desc" },
        take: q.limit,
        include: { _count: { select: { orders: true, devices: true } } },
      })
    );

    res.json(
      rows.map((c) => ({
        id: c.id,
        type: c.type,
        name: c.name,
        phone: c.phone,
        phone2: c.phone2,
        email: c.email,
        address: c.address,
        source: c.source,
        note: c.note,
        createdAt: c.createdAt,
        orderCount: c._count.orders,
        deviceCount: c._count.devices,
      }))
    );
  })
);

/**
 * Поиск по телефону для формы приёма: приёмщик вводит номер, и если человек
 * уже обращался, его данные подставляются, а карточка не дублируется.
 */
customersRouter.get(
  "/lookup",
  requirePermission(PERMISSIONS.CUSTOMERS_VIEW, PERMISSIONS.ORDERS_CREATE),
  ah(async (req, res) => {
    const { phone } = z.object({ phone: z.string().trim().min(4) }).parse(req.query);
    const found = await withTenant(tenantOf(req), (tx) =>
      tx.customer.findFirst({
        where: { phone: { contains: phone }, deletedAt: null },
        orderBy: { createdAt: "desc" },
      })
    );
    res.json(
      found
        ? {
            id: found.id,
            type: found.type,
            name: found.name,
            phone: found.phone,
            phone2: found.phone2,
            email: found.email,
            address: found.address,
          }
        : null
    );
  })
);

customersRouter.get(
  "/:id",
  requirePermission(PERMISSIONS.CUSTOMERS_VIEW),
  ah(async (req, res) => {
    const data = await withTenant(tenantOf(req), async (tx) => {
      const customer = await tx.customer.findFirst({
        where: { id: req.params.id, deletedAt: null },
      });
      if (!customer) throw notFound("Клиент не найден");

      const [devices, orders] = await Promise.all([
        tx.device.findMany({ where: { customerId: customer.id }, orderBy: { createdAt: "desc" } }),
        tx.order.findMany({
          where: { customerId: customer.id, deletedAt: null },
          orderBy: { acceptedAt: "desc" },
          take: 50,
          include: {
            status: { select: { name: true, group: true } },
            device: { select: { kind: true, brand: true, model: true } },
          },
        }),
      ]);

      return {
        customer,
        devices,
        orders: orders.map((o) => ({
          id: o.id,
          number: o.number,
          acceptedAt: o.acceptedAt,
          issuedAt: o.issuedAt,
          status: o.status,
          device: o.device,
          warrantyUntil: o.warrantyUntil,
        })),
      };
    });
    res.json(data);
  })
);

const customerSchema = z.object({
  type: z.enum(["INDIVIDUAL", "COMPANY"]).default("INDIVIDUAL"),
  name: z.string().trim().min(2, "Укажите имя или название"),
  phone: z.string().trim().min(6, "Укажите телефон"),
  phone2: z.string().trim().optional(),
  email: z.string().email("Похоже, это не email").optional().or(z.literal("")),
  address: z.string().trim().optional(),
  inn: z.string().trim().optional(),
  source: z.string().trim().optional(),
  note: z.string().trim().optional(),
  discountPercent: z.number().min(0).max(100).optional(),
});

/**
 * Стёртое в форме поле приходит пустой строкой. В базе это должен быть null:
 * пустая строка в телефоне ломает поиск, а в email — проверку на занятость.
 */
const OPTIONAL_TEXT = ["phone2", "email", "address", "inn", "source", "note"] as const;

function blankToNull(body: Record<string, unknown>): Record<string, null> {
  const out: Record<string, null> = {};
  for (const key of OPTIONAL_TEXT) {
    if (body[key] === "") out[key] = null;
  }
  return out;
}

customersRouter.post(
  "/",
  requirePermission(PERMISSIONS.CUSTOMERS_EDIT),
  ah(async (req, res) => {
    const body = customerSchema.parse(req.body);
    const tenantId = tenantOf(req);

    const created = await withTenant(tenantId, async (tx) => {
      const customer = await tx.customer.create({
        data: {
          tenantId,
          ...body,
          ...blankToNull(body),
          createdById: actorUserId(req),
        },
      });
      await writeAudit(tx, {
        tenantId,
        userId: actorUserId(req),
        entity: "Customer",
        entityId: customer.id,
        action: "CREATE",
        diff: safeDiff(body as Record<string, unknown>),
        ip: clientIp(req),
      });
      return customer;
    });

    res.status(201).json({ id: created.id, name: created.name });
  })
);

customersRouter.patch(
  "/:id",
  requirePermission(PERMISSIONS.CUSTOMERS_EDIT),
  ah(async (req, res) => {
    const body = customerSchema.partial().parse(req.body);
    const tenantId = tenantOf(req);

    await withTenant(tenantId, async (tx) => {
      const customer = await tx.customer.findFirst({ where: { id: req.params.id, deletedAt: null } });
      if (!customer) throw notFound("Клиент не найден");

      await tx.customer.update({
        where: { id: customer.id },
        data: { ...body, ...blankToNull(body) },
      });
      await writeAudit(tx, {
        tenantId,
        userId: actorUserId(req),
        entity: "Customer",
        entityId: customer.id,
        action: "UPDATE",
        diff: safeDiff(body as Record<string, unknown>),
        ip: clientIp(req),
      });
    });

    res.json({ ok: true });
  })
);

customersRouter.delete(
  "/:id",
  requirePermission(PERMISSIONS.CUSTOMERS_EDIT),
  ah(async (req, res) => {
    const tenantId = tenantOf(req);

    await withTenant(tenantId, async (tx) => {
      const customer = await tx.customer.findFirst({ where: { id: req.params.id, deletedAt: null } });
      if (!customer) throw notFound("Клиент не найден");

      await tx.customer.update({
        where: { id: customer.id },
        data: { deletedAt: new Date() },
      });
      await writeAudit(tx, {
        tenantId,
        userId: actorUserId(req),
        entity: "Customer",
        entityId: customer.id,
        action: "DELETE",
        diff: {},
        ip: clientIp(req),
      });
    });

    res.json({ ok: true });
  })
);
