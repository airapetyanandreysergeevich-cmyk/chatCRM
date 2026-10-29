import { Prisma } from "@prisma/client";
import { Router, type Request } from "express";
import { z } from "zod";
import { clientIp, safeDiff, writeAudit } from "../../lib/audit";
import { withTenant } from "../../lib/db";
import { ah, badRequest, conflict, notFound } from "../../lib/errors";
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
  /** Категория прайса; null — «Без категории». */
  categoryId: z.string().uuid().nullable().optional(),
  /** Гарантия на работу, дней (29.10.2026); null — без гарантии. */
  warrantyDays: z.coerce.number().int().min(0).max(3650).nullable().optional(),
});

// ------------------------------------------------------------ категории прайса
//
// Как на складе (Андрей, 28.10.2026): категории верхнего уровня — цветные
// карточки, внутри — подкатегории. Удаляется категория без потерь: услуги и
// подкатегории уходят в указанную или на уровень выше.

type CatRow = { id: string; parentId: string | null };

/** Категория и все её подкатегории — чтобы не перенести категорию внутрь неё самой. */
function withDescendants(id: string, all: CatRow[]): Set<string> {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of all) if (c.parentId && out.has(c.parentId) && !out.has(c.id)) (out.add(c.id), (grew = true));
  }
  return out;
}

async function assertCategory(tx: Prisma.TransactionClient, id: string | null | undefined): Promise<string | null> {
  if (!id) return null;
  const c = await tx.serviceCategory.findFirst({ where: { id }, select: { id: true } });
  if (!c) throw badRequest("Такой категории нет — обновите страницу");
  return c.id;
}

const categoryName = z.string().trim().min(1, "Назовите категорию").max(80);
const categoryColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Цвет — в виде #45C08A").nullable().optional();

servicesRouter.get(
  "/categories",
  ah(async (req, res) => {
    const out = await withTenant(tenantOf(req), async (tx) => {
      const [cats, counts, total] = await Promise.all([
        tx.serviceCategory.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
        tx.service.groupBy({ by: ["categoryId"], _count: { _all: true } }),
        tx.service.count(),
      ]);
      const n = new Map(counts.map((c) => [c.categoryId, c._count._all]));
      return {
        items: cats.map((c) => ({ id: c.id, parentId: c.parentId, name: c.name, color: c.color, sortOrder: c.sortOrder, count: n.get(c.id) ?? 0 })),
        uncategorized: n.get(null) ?? 0,
        total,
      };
    });
    res.json(out);
  })
);

servicesRouter.post(
  "/categories",
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  ah(async (req, res) => {
    const body = z.object({ name: categoryName, parentId: z.string().uuid().nullable().optional(), color: categoryColor }).parse(req.body);
    const tenantId = tenantOf(req);
    const created = await withTenant(tenantId, async (tx) => {
      const parentId = await assertCategory(tx, body.parentId);
      const same = await tx.serviceCategory.findFirst({ where: { parentId, name: { equals: body.name, mode: "insensitive" } } });
      if (same) throw conflict(`Категория «${same.name}» здесь уже есть`);
      const c = await tx.serviceCategory.create({ data: { tenantId, parentId, name: body.name, color: body.color ?? null } });
      await writeAudit(tx, { tenantId, userId: actorUserId(req), entity: "ServiceCategory", entityId: c.id, action: "CREATE", diff: { name: c.name }, ip: clientIp(req) });
      return c;
    });
    res.status(201).json({ id: created.id, name: created.name, parentId: created.parentId });
  })
);

servicesRouter.patch(
  "/categories/:id",
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  ah(async (req, res) => {
    const body = z.object({ name: categoryName.optional(), parentId: z.string().uuid().nullable().optional(), color: categoryColor }).parse(req.body);
    const tenantId = tenantOf(req);
    await withTenant(tenantId, async (tx) => {
      const cat = await tx.serviceCategory.findFirst({ where: { id: req.params.id } });
      if (!cat) throw notFound("Категория не найдена");
      let parentId = cat.parentId;
      if (body.parentId !== undefined) {
        parentId = await assertCategory(tx, body.parentId);
        const all = await tx.serviceCategory.findMany({ select: { id: true, parentId: true } });
        if (parentId && withDescendants(cat.id, all).has(parentId)) throw badRequest("Категорию нельзя перенести внутрь неё самой");
      }
      const name = body.name ?? cat.name;
      const same = await tx.serviceCategory.findFirst({ where: { id: { not: cat.id }, parentId, name: { equals: name, mode: "insensitive" } } });
      if (same) throw conflict(`Категория «${same.name}» здесь уже есть`);
      await tx.serviceCategory.update({ where: { id: cat.id }, data: { name, parentId, ...(body.color !== undefined ? { color: body.color } : {}) } });
      await writeAudit(tx, { tenantId, userId: actorUserId(req), entity: "ServiceCategory", entityId: cat.id, action: "UPDATE", diff: body as Record<string, unknown>, ip: clientIp(req) });
    });
    res.json({ ok: true });
  })
);

servicesRouter.delete(
  "/categories/:id",
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  ah(async (req, res) => {
    const { moveTo } = z.object({ moveTo: z.string().uuid().optional().or(z.literal("")) }).parse(req.query);
    const tenantId = tenantOf(req);
    const result = await withTenant(tenantId, async (tx) => {
      const cat = await tx.serviceCategory.findFirst({ where: { id: req.params.id } });
      if (!cat) throw notFound("Категория не найдена");
      const all = await tx.serviceCategory.findMany({ select: { id: true, parentId: true } });
      const target = moveTo ? await assertCategory(tx, moveTo) : cat.parentId;
      if (target && withDescendants(cat.id, all).has(target)) throw badRequest("Нельзя перенести в удаляемую категорию или её подкатегорию");
      const services = await tx.service.updateMany({ where: { categoryId: cat.id }, data: { categoryId: target } });
      const children = await tx.serviceCategory.updateMany({ where: { parentId: cat.id }, data: { parentId: target } });
      await tx.serviceCategory.delete({ where: { id: cat.id } });
      await writeAudit(tx, { tenantId, userId: actorUserId(req), entity: "ServiceCategory", entityId: cat.id, action: "DELETE", diff: { name: cat.name, services: services.count, children: children.count }, ip: clientIp(req) });
      return { services: services.count, children: children.count };
    });
    res.json({ ok: true, ...result });
  })
);

/** Действия разом над отмеченными услугами: перенести в категорию или удалить. */
servicesRouter.post(
  "/bulk",
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  ah(async (req, res) => {
    const body = z
      .discriminatedUnion("action", [
        z.object({ action: z.literal("move"), ids: z.array(z.string().uuid()).min(1).max(1000), categoryId: z.string().uuid().nullable() }),
        z.object({ action: z.literal("delete"), ids: z.array(z.string().uuid()).min(1).max(1000) }),
      ])
      .parse(req.body);
    const tenantId = tenantOf(req);
    const changed = await withTenant(tenantId, async (tx) => {
      let n: number;
      if (body.action === "move") {
        const categoryId = await assertCategory(tx, body.categoryId);
        n = (await tx.service.updateMany({ where: { id: { in: body.ids } }, data: { categoryId } })).count;
      } else {
        n = (await tx.service.deleteMany({ where: { id: { in: body.ids } } })).count;
      }
      await writeAudit(tx, {
        tenantId,
        userId: actorUserId(req),
        entity: "Service",
        entityId: tenantId,
        action: body.action === "delete" ? "DELETE" : "UPDATE",
        diff: { bulk: body.action, count: n, ...(body.action === "move" ? { categoryId: body.categoryId } : {}) },
        ip: clientIp(req),
      });
      return n;
    });
    res.json({ ok: true, changed });
  })
);

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
        categoryId: s.categoryId,
        warrantyDays: s.warrantyDays,
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
            warrantyDays: body.warrantyDays || null,
            isPinned: body.isPinned ?? false,
            categoryId: await assertCategory(tx, body.categoryId),
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

        const { categoryId, ...rest } = body;
        await tx.service.update({
          where: { id: service.id },
          data: {
            ...rest,
            ...(body.note !== undefined ? { note: body.note || null } : {}),
            ...(body.warrantyDays !== undefined ? { warrantyDays: body.warrantyDays || null } : {}),
            ...(categoryId !== undefined ? { categoryId: await assertCategory(tx, categoryId) } : {}),
          },
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
