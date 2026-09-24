import type { Prisma } from "@prisma/client";
import { Router, type Request } from "express";
import { z, ZodError } from "zod";
import { clientIp, safeDiff, writeAudit } from "../../lib/audit";
import { prisma, withTenant } from "../../lib/db";
import { ah, badRequest, conflict, forbidden, notFound } from "../../lib/errors";
import { pageFields, paged, skipTake } from "../../lib/paging";
import { hashPassword } from "../../lib/password";
import { ALL_PERMISSIONS, PERMISSION_GROUPS, PERMISSIONS } from "../../lib/permissions";
import { actorUserId, authenticate, currentTenantId, permissionsOf, requirePermission, requireTenant } from "../../middleware/auth";
import { enforceTenantStatus } from "../../middleware/tenantStatus";
import { isEmailTaken, revokeAllForUser } from "../auth/auth.service";
import { listMasters } from "./masters";
import { localProblem } from "../../lib/login";
import { localLoginDomain } from "../relay/remoteAccess";

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

/**
 * Роли сотрудника из запроса: новый бланк шлёт список roleIds, старый — одну
 * roleId. Первая в списке — основная (по ней, например, подписан сотрудник в
 * старых отчётах), остальные — дополнительные. Права складываются.
 */
const roleIdsField = z.array(z.string().uuid()).min(1, "Выберите хотя бы одну роль").max(10);

function requestedRoles(body: { roleId?: string; roleIds?: string[] }): string[] | undefined {
  const list = body.roleIds ?? (body.roleId ? [body.roleId] : undefined);
  return list && [...new Set(list)];
}

/** Проверить роли и разложить на основную и дополнительные. */
async function resolveRoles(req: Request, tx: Prisma.TransactionClient, ids: string[]) {
  const roles = await tx.role.findMany({ where: { id: { in: ids } } });
  if (roles.length !== ids.length) throw badRequest("Роль не найдена");
  assertCanGrant(req, [...new Set(roles.flatMap((r) => r.permissions))]);
  const byId = new Map(roles.map((r) => [r.id, r]));
  const ordered = ids.map((id) => byId.get(id)!);
  return {
    roleId: ordered[0].id,
    extraRoleIds: ordered.slice(1).map((r) => r.id),
    names: ordered.map((r) => r.name),
  };
}

// ---------- справочник прав ----------

staffRouter.get("/permissions", (_req, res) => res.json(PERMISSION_GROUPS));

// ---------- сотрудники ----------

staffRouter.get(
  "/staff",
  requirePermission(PERMISSIONS.STAFF_MANAGE),
  ah(async (req, res) => {
    const q = z.object(pageFields).parse(req.query);
    const where = { deletedAt: null };

    const [users, total, roles] = await withTenant(tenantOf(req), (tx) =>
      Promise.all([
        tx.user.findMany({
          where,
          orderBy: [{ isOwner: "desc" }, { fullName: "asc" }],
          ...skipTake(q),
        }),
        tx.user.count({ where }),
        tx.role.findMany({ select: { id: true, name: true, code: true } }),
      ])
    );
    const roleById = new Map(roles.map((r) => [r.id, r]));
    const rolesOf = (u: { roleId: string | null; extraRoleIds: string[] }) =>
      [u.roleId, ...u.extraRoleIds].flatMap((id) => (id && roleById.has(id) ? [roleById.get(id)!] : []));
    res.json(
      paged(
        users.map((u) => ({
          id: u.id,
          fullName: u.fullName,
          phone: u.phone,
          email: u.email,
          contactEmail: u.contactEmail,
          isOwner: u.isOwner,
          isActive: u.isActive,
          lastLoginAt: u.lastLoginAt,
          // Владельцу важно видеть, у кого нет приложения: без него мастер
          // не получает оповещений о назначенных заказах.
          androidAppAt: u.androidAppAt,
          role: rolesOf(u)[0] ?? null,
          roles: rolesOf(u),
          workPercent: u.workPercent,
          partPercent: u.partPercent,
        })),
        total,
        q
      )
    );
  })
);

/** Короткий список для назначения мастера на заказ — без зарплат и контактов. */
staffRouter.get(
  "/staff/masters",
  requirePermission(PERMISSIONS.ORDERS_CREATE, PERMISSIONS.ORDERS_EDIT, PERMISSIONS.STAFF_MANAGE),
  ah(async (req, res) => {
    res.json(await withTenant(tenantOf(req), (tx) => listMasters(tx)));
  })
);

/**
 * Логин сотрудника.
 *
 * У мастерской с именем (lenina) логины одного вида — nikita@lenina, и
 * владелец вводит только часть до @: окончание дописывается здесь. Чужое
 * окончание не принимаем — такой логин не заработал бы на общем сайте, и
 * узнали бы об этом не здесь, а у стойки в понедельник утром.
 * У мастерской без имени логин — почта, как раньше.
 */
async function resolveLogin(raw: string): Promise<string> {
  const login = raw.trim().toLowerCase();
  const fail = (message: string): never => {
    throw new ZodError([{ code: "custom", path: ["email"], message }]);
  };
  const domain = await localLoginDomain();
  if (domain) {
    const local = login.includes("@") ? login.slice(0, login.lastIndexOf("@")) : login;
    const tail = login.includes("@") ? login.slice(login.lastIndexOf("@") + 1) : domain;
    if (tail !== domain) fail(`Логин в этой мастерской оканчивается на @${domain}`);
    const bad = localProblem(local);
    if (bad) fail(bad);
    return `${local}@${domain}`;
  }
  // Без имени логин — только настоящая почта. Логин вида nikita@lenina здесь
  // не годится: в облаке такой вход ушёл бы искать мастерскую lenina.
  if (!z.string().email().safeParse(login).success) fail("Похоже, это не email");
  return login;
}

const contactEmailField = z.string().trim().toLowerCase().email("Похоже, это не email").optional().or(z.literal(""));

const createStaffSchema = z.object({
  // Вход общий по всей платформе, поэтому логин обязателен и уникален везде.
  // У мастерской с именем — nikita@lenina (см. resolveLogin), без имени — почта.
  email: z.string().trim().toLowerCase().min(1, "Укажите логин"),
  contactEmail: contactEmailField,
  password: z.string().min(8, "Пароль от 8 символов"),
  fullName: z.string().trim().min(2, "Укажите имя"),
  phone: z.string().trim().optional(),
  roleId: z.string().uuid("Выберите роль").optional(),
  roleIds: roleIdsField.optional(),
  workPercent: z.number().min(0).max(100).optional(),
  partPercent: z.number().min(0).max(100).optional(),
});

staffRouter.post(
  "/staff",
  requirePermission(PERMISSIONS.STAFF_MANAGE),
  ah(async (req, res) => {
    const parsed = createStaffSchema.parse(req.body);
    const body = { ...parsed, email: await resolveLogin(parsed.email) };
    const tenantId = tenantOf(req);

    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw notFound("Мастерская не найдена");

    // Проверка общая по всей платформе: вход единый, и один адрес не может вести в две учётки.
    if (await isEmailTaken(body.email)) throw conflict("Этот логин уже занят");

    const created = await withTenant(tenantId, async (tx) => {
      const count = await tx.user.count({ where: { deletedAt: null } });
      if (count >= tenant.maxUsers)
        throw conflict(`Тариф позволяет не больше ${tenant.maxUsers} сотрудников. Обратитесь к нам, чтобы расширить.`);

      const ids = requestedRoles(body);
      if (!ids?.length) throw badRequest("Выберите роль");
      const roles = await resolveRoles(req, tx, ids);

      const user = await tx.user.create({
        data: {
          tenantId,
          email: body.email,
          contactEmail: body.contactEmail || null,
          passwordHash: await hashPassword(body.password),
          fullName: body.fullName,
          phone: body.phone || null,
          roleId: roles.roleId,
          extraRoleIds: roles.extraRoleIds,
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
        diff: safeDiff({ ...body, roleNames: roles.names }),
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
  email: z.string().trim().toLowerCase().min(1, "Укажите логин").optional(),
  contactEmail: contactEmailField,
  roleId: z.string().uuid().optional(),
  roleIds: roleIdsField.optional(),
  isActive: z.boolean().optional(),
  workPercent: z.number().min(0).max(100).nullable().optional(),
  partPercent: z.number().min(0).max(100).nullable().optional(),
});

staffRouter.patch(
  "/staff/:id",
  requirePermission(PERMISSIONS.STAFF_MANAGE),
  ah(async (req, res) => {
    const parsed = updateStaffSchema.parse(req.body);
    const body = { ...parsed, ...(parsed.email ? { email: await resolveLogin(parsed.email) } : {}) };
    const tenantId = tenantOf(req);

    if (body.email && (await isEmailTaken(body.email, req.params.id)))
      throw conflict("Этот логин уже занят");

    const updated = await withTenant(tenantId, async (tx) => {
      const user = await tx.user.findFirst({ where: { id: req.params.id, deletedAt: null } });
      if (!user) throw notFound("Сотрудник не найден");
      if (user.isOwner && body.isActive === false) throw forbidden("Владельца отключить нельзя");

      const { roleId: _one, roleIds: _many, ...fields } = body;
      const ids = requestedRoles(body);
      const roles = ids ? await resolveRoles(req, tx, ids) : null;

      const next = await tx.user.update({
        where: { id: user.id },
        data: {
          ...fields,
          ...(fields.phone !== undefined ? { phone: fields.phone || null } : {}),
          ...(fields.contactEmail !== undefined ? { contactEmail: fields.contactEmail || null } : {}),
          ...(roles ? { roleId: roles.roleId, extraRoleIds: roles.extraRoleIds } : {}),
        },
      });
      await writeAudit(tx, {
        tenantId,
        userId: actorUserId(req),
        entity: "User",
        entityId: user.id,
        action: "UPDATE",
        diff: safeDiff({ ...fields, ...(roles ? { roleNames: roles.names } : {}) }),
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
      const inUse = await tx.user.count({
        where: { deletedAt: null, OR: [{ roleId: role.id }, { extraRoleIds: { has: role.id } }] },
      });
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
