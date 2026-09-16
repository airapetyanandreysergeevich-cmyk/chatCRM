import { Prisma } from "@prisma/client";
import { Router, type Request } from "express";
import { z } from "zod";
import { clientIp, safeDiff, writeAudit } from "../../lib/audit";
import { withTenant } from "../../lib/db";
import { ah, badRequest, notFound } from "../../lib/errors";
import { PERMISSIONS } from "../../lib/permissions";
import {
  actorUserId,
  authenticate,
  currentTenantId,
  requirePermission,
  requireTenant,
} from "../../middleware/auth";
import { enforceTenantStatus } from "../../middleware/tenantStatus";

/**
 * Прайс мастерской.
 *
 * Смысл раздела — чтобы мастер не набирал «Чистка от пыли, замена термопасты»
 * руками по двадцать раз в неделю и не выдумывал цену заново. Поэтому список
 * читают все, кто вообще работает с заказами, а правит только тот, кто
 * отвечает за деньги: прайс — это решение владельца, а не мастера.
 *
 * Удаление здесь настоящее, а не мягкое: в заказе лежит копия названия и
 * цены, и убранная из прайса услуга ничего в истории ремонтов не ломает.
 */

export const servicesRouter = Router();
servicesRouter.use(authenticate, requireTenant, enforceTenantStatus);

const tenantOf = (req: Request) => currentTenantId(req)!;

const num = (v: Prisma.Decimal | number | null | undefined): number =>
  v === null || v === undefined ? 0 : Number(v);

/** Название уникально внутри мастерской — на него завязаны подсказки. */
const isDuplicateName = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

const serviceSchema = z.object({
  name: z.string().trim().min(2, "Назовите услугу").max(160),
  price: z.coerce.number().min(0, "Цена не может быть отрицательной").max(10_000_000),
  note: z.string().trim().max(300).optional(),
  isPinned: z.coerce.boolean().optional(),
});

servicesRouter.get(
  "/",
  ah(async (req, res) => {
    const rows = await withTenant(tenantOf(req), (tx) =>
      tx.service.findMany({ orderBy: { name: "asc" } })
    );
    res.json(
      rows.map((s) => ({
        id: s.id,
        name: s.name,
        price: num(s.price),
        note: s.note,
        isPinned: s.isPinned,
      }))
    );
  })
);

servicesRouter.post(
  "/",
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  ah(async (req, res) => {
    const body = serviceSchema.parse(req.body);
    const tenantId = tenantOf(req);

    try {
      const created = await withTenant(tenantId, async (tx) => {
        const service = await tx.service.create({
          data: {
            tenantId,
            name: body.name,
            price: body.price,
            note: body.note || null,
            isPinned: body.isPinned ?? false,
          },
        });
        await writeAudit(tx, {
          tenantId,
          userId: actorUserId(req),
          entity: "Service",
          entityId: service.id,
          action: "CREATE",
          diff: safeDiff(body as Record<string, unknown>),
          ip: clientIp(req),
        });
        return service;
      });
      res.status(201).json({ id: created.id, name: created.name });
    } catch (err) {
      if (isDuplicateName(err)) throw badRequest("Такая услуга уже есть в прайсе");
      throw err;
    }
  })
);

servicesRouter.patch(
  "/:id",
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  ah(async (req, res) => {
    const body = serviceSchema.partial().parse(req.body);
    const tenantId = tenantOf(req);

    try {
      await withTenant(tenantId, async (tx) => {
        const service = await tx.service.findFirst({ where: { id: req.params.id } });
        if (!service) throw notFound("Услуга не найдена");

        await tx.service.update({
          where: { id: service.id },
          data: { ...body, ...(body.note !== undefined ? { note: body.note || null } : {}) },
        });
        await writeAudit(tx, {
          tenantId,
          userId: actorUserId(req),
          entity: "Service",
          entityId: service.id,
          action: "UPDATE",
          diff: safeDiff(body as Record<string, unknown>),
          ip: clientIp(req),
        });
      });
      res.json({ ok: true });
    } catch (err) {
      if (isDuplicateName(err)) throw badRequest("Такая услуга уже есть в прайсе");
      throw err;
    }
  })
);

servicesRouter.delete(
  "/:id",
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  ah(async (req, res) => {
    const tenantId = tenantOf(req);

    await withTenant(tenantId, async (tx) => {
      const service = await tx.service.findFirst({ where: { id: req.params.id } });
      if (!service) throw notFound("Услуга не найдена");

      await tx.service.delete({ where: { id: service.id } });
      await writeAudit(tx, {
        tenantId,
        userId: actorUserId(req),
        entity: "Service",
        entityId: service.id,
        action: "DELETE",
        diff: { name: service.name, price: num(service.price) },
        ip: clientIp(req),
      });
    });

    res.json({ ok: true });
  })
);
