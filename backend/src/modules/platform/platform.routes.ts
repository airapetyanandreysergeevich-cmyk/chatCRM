import type { Prisma } from "@prisma/client";
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { clientIp } from "../../lib/audit";
import { prisma, withPlatform } from "../../lib/db";
import { ah, badRequest, conflict, forbidden, notFound } from "../../lib/errors";
import { signAccessToken, type PlatformTokenPayload } from "../../lib/jwt";
import { hashPassword } from "../../lib/password";
import { uniqueSlug } from "../../lib/slug";
import { authenticate } from "../../middleware/auth";
import { isEmailTaken } from "../auth/auth.service";
import { createTenant } from "../../services/tenant";

export const platformRouter = Router();

function platformAuth(req: Request): PlatformTokenPayload {
  if (req.auth?.kind !== "platform") throw forbidden("Раздел доступен только платформе");
  return req.auth;
}

function requirePlatform(req: Request, _res: Response, next: NextFunction) {
  try {
    platformAuth(req);
    next();
  } catch (err) {
    next(err);
  }
}

/** Администратор платформы не может заводить других администраторов и менять тарифы. */
function requireOwner(req: Request, _res: Response, next: NextFunction) {
  try {
    if (platformAuth(req).role !== "OWNER") throw forbidden("Действие доступно только собственнику");
    next();
  } catch (err) {
    next(err);
  }
}

async function logPlatform(
  req: Request,
  action: string,
  tenantId: string | null,
  meta?: Record<string, unknown>
) {
  await prisma.platformAuditLog.create({
    data: {
      platformUserId: req.auth?.kind === "platform" ? req.auth.platformUserId : null,
      tenantId,
      action,
      meta: meta as Prisma.InputJsonValue | undefined,
      ip: clientIp(req),
    },
  });
}

platformRouter.use(authenticate, requirePlatform);

// ---------- мастерские ----------

platformRouter.get(
  "/tenants",
  ah(async (_req, res) => {
    const tenants = await prisma.tenant.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: "desc" },
    });
    // Счётчики читаются в режиме платформы — единственное место, где это оправдано.
    const stats = await withPlatform(async (tx) => {
      const users = await tx.user.groupBy({ by: ["tenantId"], _count: { _all: true }, where: { deletedAt: null } });
      const orders = await tx.order.groupBy({ by: ["tenantId"], _count: { _all: true }, where: { deletedAt: null } });
      return { users, orders };
    });
    const userBy = new Map(stats.users.map((s) => [s.tenantId, s._count._all]));
    const orderBy = new Map(stats.orders.map((s) => [s.tenantId, s._count._all]));

    res.json(
      tenants.map((t) => ({
        id: t.id,
        name: t.name,
        slug: t.slug,
        status: t.status,
        plan: t.plan,
        maxUsers: t.maxUsers,
        timezone: t.timezone,
        contactName: t.contactName,
        contactPhone: t.contactPhone,
        contactEmail: t.contactEmail,
        createdAt: t.createdAt,
        userCount: userBy.get(t.id) ?? 0,
        orderCount: orderBy.get(t.id) ?? 0,
      }))
    );
  })
);

const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, "Минимум 3 символа")
  .max(30, "Максимум 30 символов")
  .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, "Только латиница, цифры и дефис");

const createTenantSchema = z.object({
  name: z.string().trim().min(2, "Укажите название мастерской"),
  slug: slugSchema,
  // Владелец входит по этому адресу — он же его рабочая учётная запись.
  ownerEmail: z.string().trim().toLowerCase().email("Похоже, это не email"),
  ownerPassword: z.string().min(8, "Пароль от 8 символов"),
  ownerFullName: z.string().trim().min(2, "Укажите имя владельца"),
  timezone: z.string().optional(),
  contactPhone: z.string().trim().optional(),
});

platformRouter.post(
  "/tenants",
  ah(async (req, res) => {
    const body = createTenantSchema.parse(req.body);
    const existing = await prisma.tenant.findUnique({ where: { slug: body.slug } });
    if (existing) throw conflict("Мастерская с таким кодом уже есть");
    if (await isEmailTaken(body.ownerEmail)) throw conflict("Этот email уже используется");

    const tenant = await createTenant({
      name: body.name,
      slug: body.slug,
      ownerEmail: body.ownerEmail,
      ownerPassword: body.ownerPassword,
      ownerFullName: body.ownerFullName,
      timezone: body.timezone,
    });

    if (body.contactPhone) {
      await prisma.tenant.update({
        where: { id: tenant.id },
        data: { contactPhone: body.contactPhone, contactName: body.ownerFullName, contactEmail: body.ownerEmail },
      });
    }

    await logPlatform(req, "TENANT_CREATE", tenant.id, { name: tenant.name, slug: tenant.slug });
    res.status(201).json({ id: tenant.id, name: tenant.name, slug: tenant.slug });
  })
);

platformRouter.get(
  "/tenants/:id",
  ah(async (req, res) => {
    const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id } });
    if (!tenant || tenant.deletedAt) throw notFound("Мастерская не найдена");
    const impersonations = await prisma.impersonation.findMany({
      where: { tenantId: tenant.id },
      orderBy: { startedAt: "desc" },
      take: 20,
      include: { platformUser: { select: { fullName: true, email: true } } },
    });
    res.json({ tenant, impersonations });
  })
);

const updateTenantSchema = z.object({
  name: z.string().trim().min(2).optional(),
  status: z.enum(["ACTIVE", "READONLY", "SUSPENDED"]).optional(),
  maxUsers: z.number().int().min(1).max(500).optional(),
  timezone: z.string().optional(),
  contactName: z.string().trim().optional(),
  contactPhone: z.string().trim().optional(),
  contactEmail: z.string().email().optional().or(z.literal("")),
  plan: z.string().optional(),
});

platformRouter.patch(
  "/tenants/:id",
  ah(async (req, res) => {
    const auth = platformAuth(req);
    const body = updateTenantSchema.parse(req.body);
    if (body.plan !== undefined && auth.role !== "OWNER") throw forbidden("Тариф меняет только собственник");

    const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id } });
    if (!tenant || tenant.deletedAt) throw notFound("Мастерская не найдена");

    const updated = await prisma.tenant.update({
      where: { id: tenant.id },
      data: { ...body, contactEmail: body.contactEmail === "" ? null : body.contactEmail },
    });
    await logPlatform(req, "TENANT_UPDATE", tenant.id, body);
    res.json(updated);
  })
);

// ---------- вход в мастерскую под ролью владельца ----------

platformRouter.post(
  "/tenants/:id/impersonate",
  ah(async (req, res) => {
    const auth = platformAuth(req);
    const reason = z.object({ reason: z.string().trim().min(5, "Опишите причину входа") }).parse(req.body).reason;

    const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id } });
    if (!tenant || tenant.deletedAt) throw notFound("Мастерская не найдена");

    const impersonation = await prisma.impersonation.create({
      data: { platformUserId: auth.platformUserId, tenantId: tenant.id, reason, ip: clientIp(req) },
    });
    await logPlatform(req, "IMPERSONATE_START", tenant.id, { reason });

    // Отдельный токен: сессия в мастерской ограничена сроком жизни access-токена,
    // продлить её можно только новым явным входом.
    const payload: PlatformTokenPayload = {
      kind: "platform",
      platformUserId: auth.platformUserId,
      role: auth.role,
      impersonatingTenantId: tenant.id,
      impersonationId: impersonation.id,
    };
    res.json({
      accessToken: signAccessToken(payload),
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
    });
  })
);

platformRouter.post(
  "/impersonate/stop",
  ah(async (req, res) => {
    const auth = platformAuth(req);
    if (!auth.impersonationId) throw badRequest("Сейчас нет активного входа в мастерскую");
    await prisma.impersonation.updateMany({
      where: { id: auth.impersonationId, endedAt: null },
      data: { endedAt: new Date() },
    });
    await logPlatform(req, "IMPERSONATE_STOP", auth.impersonatingTenantId ?? null);
    const payload: PlatformTokenPayload = {
      kind: "platform",
      platformUserId: auth.platformUserId,
      role: auth.role,
    };
    res.json({ accessToken: signAccessToken(payload) });
  })
);

// ---------- администраторы платформы ----------

platformRouter.get(
  "/admins",
  requireOwner,
  ah(async (_req, res) => {
    const admins = await prisma.platformUser.findMany({
      orderBy: { createdAt: "asc" },
      select: { id: true, email: true, fullName: true, role: true, isActive: true, lastLoginAt: true },
    });
    res.json(admins);
  })
);

const createAdminSchema = z.object({
  email: z.string().email("Неверный email"),
  fullName: z.string().trim().min(2, "Укажите имя"),
  password: z.string().min(10, "Пароль от 10 символов"),
});

platformRouter.post(
  "/admins",
  requireOwner,
  ah(async (req, res) => {
    const body = createAdminSchema.parse(req.body);
    const email = body.email.toLowerCase().trim();
    if (await isEmailTaken(email)) throw conflict("Этот email уже используется");

    const admin = await prisma.platformUser.create({
      data: { email, fullName: body.fullName, passwordHash: await hashPassword(body.password), role: "ADMIN" },
      select: { id: true, email: true, fullName: true, role: true },
    });
    await logPlatform(req, "ADMIN_CREATE", null, { email });
    res.status(201).json(admin);
  })
);

platformRouter.patch(
  "/admins/:id",
  requireOwner,
  ah(async (req, res) => {
    const auth = platformAuth(req);
    if (req.params.id === auth.platformUserId) throw badRequest("Нельзя менять собственную учётную запись отсюда");
    const body = z.object({ isActive: z.boolean().optional(), fullName: z.string().trim().min(2).optional() }).parse(req.body);

    const target = await prisma.platformUser.findUnique({ where: { id: req.params.id } });
    if (!target) throw notFound("Учётная запись не найдена");
    if (target.role === "OWNER") throw forbidden("Учётную запись собственника менять нельзя");

    const updated = await prisma.platformUser.update({
      where: { id: target.id },
      data: body,
      select: { id: true, email: true, fullName: true, role: true, isActive: true },
    });
    if (body.isActive === false) {
      await prisma.session.updateMany({ where: { platformUserId: target.id, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    await logPlatform(req, "ADMIN_UPDATE", null, body);
    res.json(updated);
  })
);

platformRouter.get(
  "/audit",
  ah(async (req, res) => {
    const take = Math.min(Number(req.query.limit ?? 100), 500);
    const logs = await prisma.platformAuditLog.findMany({
      orderBy: { createdAt: "desc" },
      take,
      include: { platformUser: { select: { fullName: true, email: true } } },
    });
    res.json(logs);
  })
);

// ---------- заявки на подключение ----------

/** Счётчики для панели: по ним рисуется значок «есть новые заявки». */
platformRouter.get(
  "/summary",
  ah(async (_req, res) => {
    const [pendingApplications, tenants] = await Promise.all([
      prisma.tenantApplication.count({ where: { status: "PENDING" } }),
      prisma.tenant.count({ where: { deletedAt: null } }),
    ]);
    res.json({ pendingApplications, tenants });
  })
);

platformRouter.get(
  "/applications",
  ah(async (req, res) => {
    const status = z
      .enum(["PENDING", "APPROVED", "REJECTED", "ALL"])
      .catch("PENDING")
      .parse(req.query.status);

    const rows = await prisma.tenantApplication.findMany({
      where: status === "ALL" ? {} : { status },
      orderBy: { createdAt: "desc" },
      take: 200,
      include: {
        reviewedBy: { select: { fullName: true, email: true } },
        tenant: { select: { id: true, name: true, slug: true } },
      },
    });

    // Хеш пароля наружу не отдаём даже собственнику платформы.
    res.json(
      rows.map(({ passwordHash: _hash, ...row }) => row)
    );
  })
);

platformRouter.post(
  "/applications/:id/approve",
  ah(async (req, res) => {
    const auth = platformAuth(req);
    const body = z
      .object({ slug: slugSchema.optional(), timezone: z.string().optional() })
      .parse(req.body ?? {});

    const application = await prisma.tenantApplication.findUnique({ where: { id: req.params.id } });
    if (!application) throw notFound("Заявка не найдена");
    if (application.status !== "PENDING") throw badRequest("Заявка уже рассмотрена");
    if (await isEmailTaken(application.ownerEmail))
      throw conflict("Этот email уже занят другой учётной записью");

    const taken = async (candidate: string) => !!(await prisma.tenant.findUnique({ where: { slug: candidate } }));
    if (body.slug && (await taken(body.slug))) throw conflict("Мастерская с таким кодом уже есть");
    const slug = body.slug ?? (await uniqueSlug(application.workshopName, taken));

    // Пароль заявитель задал сам при регистрации — в открытом виде его у нас нет,
    // поэтому переносим готовый хеш: человек войдёт тем же паролем, что придумал.
    const tenant = await createTenant({
      name: application.workshopName,
      slug,
      ownerEmail: application.ownerEmail,
      ownerFullName: application.ownerFullName,
      ownerPhone: application.ownerPhone,
      ownerPasswordHash: application.passwordHash,
      timezone: body.timezone,
    });

    await prisma.tenant.update({
      where: { id: tenant.id },
      data: {
        contactName: application.ownerFullName,
        contactPhone: application.ownerPhone,
        contactEmail: application.ownerEmail,
      },
    });

    await prisma.tenantApplication.update({
      where: { id: application.id },
      data: {
        status: "APPROVED",
        reviewedById: auth.platformUserId,
        reviewedAt: new Date(),
        tenantId: tenant.id,
      },
    });

    await logPlatform(req, "APPLICATION_APPROVE", tenant.id, { applicationId: application.id, slug });
    res.json({ tenantId: tenant.id, slug, name: tenant.name });
  })
);

platformRouter.post(
  "/applications/:id/reject",
  ah(async (req, res) => {
    const auth = platformAuth(req);
    const { reason } = z
      .object({ reason: z.string().trim().min(5, "Опишите причину — её увидит заявитель") })
      .parse(req.body);

    const application = await prisma.tenantApplication.findUnique({ where: { id: req.params.id } });
    if (!application) throw notFound("Заявка не найдена");
    if (application.status !== "PENDING") throw badRequest("Заявка уже рассмотрена");

    await prisma.tenantApplication.update({
      where: { id: application.id },
      data: {
        status: "REJECTED",
        rejectionReason: reason,
        reviewedById: auth.platformUserId,
        reviewedAt: new Date(),
      },
    });

    await logPlatform(req, "APPLICATION_REJECT", null, { applicationId: application.id, reason });
    res.json({ ok: true });
  })
);
