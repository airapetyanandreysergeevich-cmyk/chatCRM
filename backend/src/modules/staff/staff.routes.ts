import { Router, type Request } from "express";
import { z } from "zod";
import { clientIp, safeDiff, writeAudit } from "../../lib/audit";
import { prisma, withTenant } from "../../lib/db";
import { ah, badRequest, conflict, forbidden, notFound } from "../../lib/errors";
import { hashPassword } from "../../lib/password";
import { ALL_PERMISSIONS, PERMISSION_GROUPS, PERMISSIONS } from "../../lib/permissions";
import { actorUserId, authenticate, currentTenantId, permissionsOf, requirePermission, requireTenant } from "../../middleware/auth";
import { enforceTenantStatus } from "../../middleware/tenantStatus";
import { isEmailTaken, revokeAllForUser } from "../auth/auth.service";

export const staffRouter = Router();
staffRouter.use(authenticate, requireTenant, enforceTenantStatus);

const tenantOf = (req: Request) => currentTenantId(req)!;

/** Нельзя выдать право, которого нет у тебя самого — иначе управляющий выпишет себе всё через новую роль. */
function assertCanGrant(req: Request, requested: string[]) {
  const mine = new Set(permissionsOf(req));
  const excess = requested.filter((p) => !mine.has(p));
  if (excess.length) throw forbidden(`Нельзя выдать права, которых нет у вас: ${excess.join(", ")}`);
  const unknown = requested.filter((p) => !(ALL_PERMISSIONS as string[]).includes(p));
  if (unknown.length) throw badRequest(`Неизвестные права: ${unknown.join(", ")}`);
}

// ---------- справочник прав ----------

staffRouter.get("/permissions", (_req, res) => res.json(PERMISSION_GROUPS));

// ---------- сотрудники ----------

staffRouter.get(
  "/staff",
  requirePermission(PERMISSIONS.STAFF_MANAGE),
  ah(async (req, res) => {
    const users = await withTenant(tenantOf(req), (tx) =>
      tx.user.findMany({
        where: { deletedAt: null },
        orderBy: [{ isOwner: "desc" }, { fullName: "asc" }],
        include: { role: { select: { id: true, name: true, code: true } } },
      })
    );
    res.json(
      users.map((u) => ({
        id: u.id,
        fullName: u.fullName,
        phone: u.phone,
        email: u.email,
        isOwner: u.isOwner,
        isActive: u.isActive,
        lastLoginAt: u.lastLoginAt,
        role: u.role,
        workPercent: u.workPercent,
        partPercent: u.partPercent,
      }))
    );
  })
);

/** Короткий список для назначения мастера на заказ — без зарплат и контактов. */
staffRouter.get(
  "/staff/masters",
  requirePermission(PERMISSIONS.ORDERS_CREATE, PERMISSIONS.ORDERS_EDIT, PERMISSIONS.STAFF_MANAGE),
  ah(async (req, res) => {
    const users = await withTenant(tenantOf(req), (tx) =>
      tx.user.findMany({
        where: { deletedAt: null, isActive: true, role: { code: "MASTER" } },
        orderBy: { fullName: "asc" },
        select: { id: true, fullName: true },
      })
    );
    res.json(users);
  })
);

const createStaffSchema = z.object({
  // Вход в систему по email, поэтому он обязателен и уникален по всей платформе.
  // Нет почты — подойдёт адрес вида master1@<код мастерской>.local.
  email: z.string().trim().toLowerCase().email("Похоже, это не email"),
  password: z.string().min(8, "Пароль от 8 символов"),
  fullName: z.string().trim().min(2, "Укажите имя"),
  phone: z.string().trim().optional(),
  roleId: z.string().uuid("Выберите роль"),
  workPercent: z.number().min(0).max(100).optional(),
  partPercent: z.number().min(0).max(100).optional(),
});

staffRouter.post(
  "/staff",
  requirePermission(PERMISSIONS.STAFF_MANAGE),
  ah(async (req, res) => {
    const body = createStaffSchema.parse(req.body);
    const tenantId = tenantOf(req);

    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw notFound("Мастерская не найдена");

    // Проверка общая по всей платформе: вход единый, и один адрес не может вести в две учётки.
    if (await isEmailTaken(body.email)) throw conflict("Этот email уже используется");

    const created = await withTenant(tenantId, async (tx) => {
      const count = await tx.user.count({ where: { deletedAt: null } });
      if (count >= tenant.maxUsers)
        throw conflict(`Тариф позволяет не больше ${tenant.maxUsers} сотрудников. Обратитесь к нам, чтобы расширить.`);

      const role = await tx.role.findFirst({ where: { id: body.roleId } });
      if (!role) throw badRequest("Роль не найдена");
      assertCanGrant(req, role.permissions);

      const user = await tx.user.create({
        data: {
          tenantId,
          email: body.email,
          passwordHash: await hashPassword(body.password),
          fullName: body.fullName,
          phone: body.phone || null,
          roleId: role.id,
          workPercent: body.workPercent ?? null,
          partPercent: body.partPercent ?? null,
        },
      });
      await writeAudit(tx, {
        tenantId,
        userId: actorUserId(req),
        entity: "User",
        entityId: user.id,
        action: "CREATE",
        diff: safeDiff({ ...body, roleName: role.name }),
        ip: clientIp(req),
      });
      return user;
    });

    res.status(201).json({ id: created.id, email: created.email, fullName: created.fullName });
  })
);

const updateStaffSchema = z.object({
  fullName: z.string().trim().min(2).optional(),
  phone: z.string().trim().optional(),
  email: z.string().trim().toLowerCase().email("Похоже, это не email").optional(),
  roleId: z.string().uuid().optional(),
  isActive: z.boolean().optional(),
  workPercent: z.number().min(0).max(100).nullable().optional(),
  partPercent: z.number().min(0).max(100).nullable().optional(),
});

staffRouter.patch(
  "/staff/:id",
  requirePermission(PERMISSIONS.STAFF_MANAGE),
  ah(async (req, res) => {
    const body = updateStaffSchema.parse(req.body);
    const tenantId = tenantOf(req);

    if (body.email && (await isEmailTaken(body.email, req.params.id)))
      throw conflict("Этот email уже используется");

    const updated = await withTenant(tenantId, async (tx) => {
      const user = await tx.user.findFirst({ where: { id: req.params.id, deletedAt: null } });
      if (!user) throw notFound("Сотрудник не найден");
      if (user.isOwner && body.isActive === false) throw forbidden("Владельца отключить нельзя");

      if (body.roleId) {
        const role = await tx.role.findFirst({ where: { id: body.roleId } });
        if (!role) throw badRequest("Роль не найдена");
        assertCanGrant(req, role.permissions);
      }

      const next = await tx.user.update({ where: { id: user.id }, data: body });
      await writeAudit(tx, {
        tenantId,
        userId: actorUserId(req),
        entity: "User",
        entityId: user.id,
        action: "UPDATE",
        diff: safeDiff(body),
        ip: clientIp(req),
      });
      return next;
    });

    if (body.isActive === false) await revokeAllForUser(updated.id);
    res.json({ id: updated.id, fullName: updated.fullName, isActive: updated.isActive });
  })
);

staffRouter.post(
  "/staff/:id/password",
  requirePermission(PERMISSIONS.STAFF_MANAGE),
  ah(async (req, res) => {
    const { password } = z.object({ password: z.string().min(8, "Пароль от 8 символов") }).parse(req.body);
    const tenantId = tenantOf(req);

    await withTenant(tenantId, async (tx) => {
      const user = await tx.user.findFirst({ where: { id: req.params.id, deletedAt: null } });
      if (!user) throw notFound("Сотрудник не найден");
      await tx.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(password) } });
      await writeAudit(tx, {
        tenantId,
        userId: actorUserId(req),
        entity: "User",
        entityId: user.id,
        action: "PASSWORD",
        ip: clientIp(req),
      });
    });

    // Смена пароля выбрасывает сотрудника со всех устройств — это и есть смысл смены.
    await revokeAllForUser(req.params.id);
    res.json({ ok: true });
  })
);

staffRouter.delete(
  "/staff/:id",
  requirePermission(PERMISSIONS.STAFF_MANAGE),
  ah(async (req, res) => {
    const tenantId = tenantOf(req);
    await withTenant(tenantId, async (tx) => {
      const user = await tx.user.findFirst({ where: { id: req.params.id, deletedAt: null } });
      if (!user) throw notFound("Сотрудник не найден");
      if (user.isOwner) throw forbidden("Владельца удалить нельзя");
      // Мягкое удаление: заказы и записи в логе продолжают ссылаться на сотрудника.
      await tx.user.update({ where: { id: user.id }, data: { deletedAt: new Date(), isActive: false } });
      await writeAudit(tx, {
        tenantId,
        userId: actorUserId(req),
        entity: "User",
        entityId: user.id,
        action: "DELETE",
        ip: clientIp(req),
      });
    });
    await revokeAllForUser(req.params.id);
    res.json({ ok: true });
  })
);

// ---------- роли ----------

staffRouter.get(
  "/roles",
  requirePermission(PERMISSIONS.STAFF_MANAGE, PERMISSIONS.ROLES_MANAGE),
  ah(async (req, res) => {
    const roles = await withTenant(tenantOf(req), (tx) =>
      tx.role.findMany({ orderBy: [{ isSystem: "desc" }, { name: "asc" }] })
    );
    res.json(roles);
  })
);

const roleSchema = z.object({
  name: z.string().trim().min(2, "Название роли от 2 символов"),
  permissions: z.array(z.string()).default([]),
});

staffRouter.post(
  "/roles",
  requirePermission(PERMISSIONS.ROLES_MANAGE),
  ah(async (req, res) => {
    const body = roleSchema.parse(req.body);
    assertCanGrant(req, body.permissions);

    const tenantId = tenantOf(req);
    const role = await withTenant(tenantId, async (tx) => {
      if (await tx.role.findFirst({ where: { name: body.name } })) throw conflict("Роль с таким названием уже есть");
      const created = await tx.role.create({
        data: { tenantId, name: body.name, permissions: body.permissions, isSystem: false },
      });
      await writeAudit(tx, {
        tenantId,
        userId: actorUserId(req),
        entity: "Role",
        entityId: created.id,
        action: "CREATE",
        diff: body,
        ip: clientIp(req),
      });
      return created;
    });
    res.status(201).json(role);
  })
);

staffRouter.patch(
  "/roles/:id",
  requirePermission(PERMISSIONS.ROLES_MANAGE),
  ah(async (req, res) => {
    const body = roleSchema.partial().parse(req.body);
    if (body.permissions) assertCanGrant(req, body.permissions);

    const tenantId = tenantOf(req);
    const role = await withTenant(tenantId, async (tx) => {
      const existing = await tx.role.findFirst({ where: { id: req.params.id } });
      if (!existing) throw notFound("Роль не найдена");
      const updated = await tx.role.update({ where: { id: existing.id }, data: body });
      await writeAudit(tx, {
        tenantId,
        userId: actorUserId(req),
        entity: "Role",
        entityId: existing.id,
        action: "UPDATE",
        diff: body,
        ip: clientIp(req),
      });
      return updated;
    });
    res.json(role);
  })
);

staffRouter.delete(
  "/roles/:id",
  requirePermission(PERMISSIONS.ROLES_MANAGE),
  ah(async (req, res) => {
    const tenantId = tenantOf(req);
    await withTenant(tenantId, async (tx) => {
      const role = await tx.role.findFirst({ where: { id: req.params.id } });
      if (!role) throw notFound("Роль не найдена");
      if (role.isSystem) throw forbidden("Системную роль удалить нельзя — можно склонировать и править копию");
      const inUse = await tx.user.count({ where: { roleId: role.id, deletedAt: null } });
      if (inUse) throw conflict(`Роль назначена ${inUse} сотрудникам — сначала переведите их на другую`);
      await tx.role.delete({ where: { id: role.id } });
      await writeAudit(tx, {
        tenantId,
        userId: actorUserId(req),
        entity: "Role",
        entityId: role.id,
        action: "DELETE",
        ip: clientIp(req),
      });
    });
    res.json({ ok: true });
  })
);

// ---------- прозрачность для владельца ----------

staffRouter.get(
  "/settings/impersonations",
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  ah(async (req, res) => {
    // История входов платформы в эту мастерскую. Владелец должен её видеть.
    const rows = await prisma.impersonation.findMany({
      where: { tenantId: tenantOf(req) },
      orderBy: { startedAt: "desc" },
      take: 100,
      include: { platformUser: { select: { fullName: true, email: true } } },
    });
    res.json(rows);
  })
);
