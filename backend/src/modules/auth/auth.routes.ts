import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { prisma, withTenant } from "../../lib/db";
import { ah, unauthorized } from "../../lib/errors";
import { authenticate, currentTenantId, permissionsOf } from "../../middleware/auth";
import {
  loginPlatformUser,
  loginTenantUser,
  refreshCookieOptions,
  REFRESH_COOKIE,
  revokeRefresh,
  rotateRefresh,
} from "./auth.service";

export const authRouter = Router();

/** Подбор пароля по форме входа — самая дешёвая атака, поэтому лимит стоит до всего остального. */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Слишком много попыток входа. Попробуйте через 15 минут." },
});

const tenantLoginSchema = z.object({
  workshop: z.string().min(1, "Укажите мастерскую"),
  login: z.string().min(1, "Укажите логин"),
  password: z.string().min(1, "Укажите пароль"),
});

authRouter.post(
  "/login",
  loginLimiter,
  ah(async (req, res) => {
    const body = tenantLoginSchema.parse(req.body);
    const { accessToken, refresh, payload, tenant } = await loginTenantUser({ ...body, req });
    res.cookie(REFRESH_COOKIE, refresh, refreshCookieOptions());
    res.json({
      accessToken,
      user: { id: payload.userId, isOwner: payload.isOwner, roleCode: payload.roleCode },
      permissions: payload.permissions,
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug, status: tenant.status },
    });
  })
);

const platformLoginSchema = z.object({
  email: z.string().email("Неверный email"),
  password: z.string().min(1, "Укажите пароль"),
});

authRouter.post(
  "/platform/login",
  loginLimiter,
  ah(async (req, res) => {
    const body = platformLoginSchema.parse(req.body);
    const { accessToken, refresh, payload } = await loginPlatformUser({ ...body, req });
    res.cookie(REFRESH_COOKIE, refresh, refreshCookieOptions());
    res.json({ accessToken, platformUser: { id: payload.platformUserId, role: payload.role } });
  })
);

authRouter.post(
  "/refresh",
  ah(async (req, res) => {
    const raw = req.cookies?.[REFRESH_COOKIE];
    if (!raw) throw unauthorized("Нет сессии");
    const { accessToken, refresh } = await rotateRefresh(raw, req);
    res.cookie(REFRESH_COOKIE, refresh, refreshCookieOptions());
    res.json({ accessToken });
  })
);

authRouter.post(
  "/logout",
  ah(async (req, res) => {
    await revokeRefresh(req.cookies?.[REFRESH_COOKIE]);
    res.clearCookie(REFRESH_COOKIE, { ...refreshCookieOptions(), maxAge: undefined });
    res.json({ ok: true });
  })
);

authRouter.get(
  "/me",
  authenticate,
  ah(async (req, res) => {
    if (req.auth!.kind === "platform") {
      const auth = req.auth as Extract<typeof req.auth, { kind: "platform" }>;
      const user = await prisma.platformUser.findUnique({ where: { id: auth.platformUserId } });
      if (!user) throw unauthorized();
      const tenantId = currentTenantId(req);
      const tenant = tenantId ? await prisma.tenant.findUnique({ where: { id: tenantId } }) : null;
      return res.json({
        kind: "platform",
        platformUser: { id: user.id, email: user.email, fullName: user.fullName, role: user.role },
        impersonating: tenant ? { id: tenant.id, name: tenant.name, slug: tenant.slug } : null,
        permissions: permissionsOf(req),
      });
    }

    const auth = req.auth as Extract<typeof req.auth, { kind: "tenant" }>;
    const data = await withTenant(auth.tenantId, async (tx) => {
      const user = await tx.user.findFirst({ where: { id: auth.userId }, include: { role: true, branch: true } });
      if (!user) throw unauthorized();
      return user;
    });
    const tenant = await prisma.tenant.findUnique({ where: { id: auth.tenantId } });
    res.json({
      kind: "tenant",
      user: {
        id: data.id,
        login: data.login,
        fullName: data.fullName,
        phone: data.phone,
        isOwner: data.isOwner,
        role: data.role ? { id: data.role.id, name: data.role.name, code: data.role.code } : null,
        branch: data.branch ? { id: data.branch.id, name: data.branch.name } : null,
      },
      tenant: tenant && { id: tenant.id, name: tenant.name, slug: tenant.slug, status: tenant.status },
      permissions: permissionsOf(req),
    });
  })
);
