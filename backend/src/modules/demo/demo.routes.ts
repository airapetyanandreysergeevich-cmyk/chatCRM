import { Router, type NextFunction, type Request, type Response } from "express";
import { clientIp, writeAudit } from "../../lib/audit";
import { prisma, withTenant } from "../../lib/db";
import { ah, conflict, forbidden, notFound } from "../../lib/errors";
import { removeFile } from "../../lib/storage";
import { actorUserId, authenticate, currentTenantId, requireTenant } from "../../middleware/auth";
import { enforceTenantStatus } from "../../middleware/tenantStatus";
import { revokeAllForUser } from "../auth/auth.service";
import { localLoginDomain } from "../relay/remoteAccess";
import { demoOf, isEmptyBase, removeDemo, seedDemo } from "./demo";

/**
 * Тестовые данные: посмотреть, завести, убрать. Только владельцу.
 *
 * Завести — одним движением на пустую базу; убрать — одним движением всё
 * заведённое. Право «Настройки мастерской» сюда не годится: уборка стирает
 * заказы и кассу, пусть и тестовые, а такое у нас делает только владелец.
 */
export const demoRouter = Router();
demoRouter.use(authenticate, requireTenant, enforceTenantStatus);

const tenantOf = (req: Request) => currentTenantId(req)!;

function requireOwner(req: Request, _res: Response, next: NextFunction) {
  if (req.auth?.kind === "tenant" && req.auth.isOwner) return next();
  next(forbidden("Тестовыми данными распоряжается владелец мастерской"));
}
demoRouter.use(requireOwner);

demoRouter.get(
  "/",
  ah(async (req, res) => {
    const tenantId = tenantOf(req);
    const out = await withTenant(tenantId, async (tx) => {
      const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } });
      const demo = demoOf(tenant?.settings);
      if (!demo) return { active: false as const, canSeed: await isEmptyBase(tx) };
      const [orders, customers] = await Promise.all([
        tx.order.count({ where: { id: { in: demo.orders } } }),
        tx.customer.count({ where: { id: { in: demo.customers } } }),
      ]);
      return {
        active: true as const,
        createdAt: demo.createdAt,
        password: demo.password,
        logins: demo.logins,
        orders,
        customers,
      };
    });
    res.set("Cache-Control", "no-store");
    res.json(out);
  })
);

demoRouter.post(
  "/",
  ah(async (req, res) => {
    const tenantId = tenantOf(req);
    const ownerId = actorUserId(req);
    if (!ownerId) throw forbidden("Нужна учётка владельца");
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { slug: true, maxUsers: true, settings: true } });
    if (!tenant) throw notFound("Мастерская не найдена");
    if (demoOf(tenant.settings)) throw conflict("Тестовые данные уже в базе");
    const loginDomain = await localLoginDomain();

    const state = await withTenant(
      tenantId,
      async (tx) => {
        if (!(await isEmptyBase(tx))) {
          throw conflict("В базе уже есть заказы, клиенты или склад — тестовые данные заводятся только в пустую");
        }
        const s = await seedDemo(tx, tenantId, { ownerId, loginDomain, slug: tenant.slug, maxUsers: tenant.maxUsers });
        await writeAudit(tx, {
          tenantId,
          userId: ownerId,
          entity: "Demo",
          entityId: tenantId,
          action: "CREATE",
          diff: { orders: s.orders.length, customers: s.customers.length, staff: s.users.length },
          ip: clientIp(req),
        });
        return s;
      },
      { timeout: 2 * 60_000, maxWait: 30_000 }
    );
    res.status(201).json({ orders: state.orders.length, customers: state.customers.length, logins: state.logins });
  })
);

demoRouter.delete(
  "/",
  ah(async (req, res) => {
    const tenantId = tenantOf(req);
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } });
    const demo = demoOf(tenant?.settings);
    if (!demo) throw notFound("Тестовых данных в базе нет");

    const removed = await withTenant(
      tenantId,
      async (tx) => {
        const out = await removeDemo(tx, tenantId, demo);
        await writeAudit(tx, {
          tenantId,
          userId: actorUserId(req),
          entity: "Demo",
          entityId: tenantId,
          action: "DELETE",
          diff: { orders: out.orders, customers: out.customers, stock: out.stock, services: out.services, staff: out.users },
          ip: clientIp(req),
        });
        return out;
      },
      { timeout: 2 * 60_000, maxWait: 30_000 }
    );

    for (const id of removed.revoke) await revokeAllForUser(id);
    for (const key of removed.files) await removeFile(key).catch(() => {});

    const { revoke: _r, files, ...shown } = removed;
    res.json({ ...shown, files: files.length });
  })
);
