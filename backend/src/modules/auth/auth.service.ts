import { createHash, randomBytes } from "node:crypto";
import type { Request } from "express";
import { prisma, withTenant } from "../../lib/db";
import { env } from "../../lib/env";
import { forbidden, unauthorized } from "../../lib/errors";
import { signAccessToken, type PlatformTokenPayload, type TenantTokenPayload } from "../../lib/jwt";
import { verifyPassword } from "../../lib/password";
import { ALL_PERMISSIONS } from "../../lib/permissions";
import { clientIp } from "../../lib/audit";

const hashToken = (raw: string) => createHash("sha256").update(raw).digest("hex");

export const REFRESH_COOKIE = "rs_refresh";

export function refreshCookieOptions() {
  return {
    httpOnly: true,
    secure: env.nodeEnv === "production",
    sameSite: "lax" as const,
    path: "/api/auth",
    maxAge: env.refreshTokenTtlDays * 24 * 60 * 60 * 1000,
  };
}

/** Создаёт refresh-сессию и возвращает сырой токен — в базе лежит только его хеш. */
async function issueRefresh(params: {
  tenantId?: string | null;
  userId?: string | null;
  platformUserId?: string | null;
  req: Request;
}) {
  const raw = randomBytes(48).toString("base64url");
  const expiresAt = new Date(Date.now() + env.refreshTokenTtlDays * 24 * 60 * 60 * 1000);
  await prisma.session.create({
    data: {
      tenantId: params.tenantId ?? null,
      userId: params.userId ?? null,
      platformUserId: params.platformUserId ?? null,
      refreshHash: hashToken(raw),
      expiresAt,
      ip: clientIp(params.req),
      userAgent: params.req.headers["user-agent"]?.slice(0, 300) ?? null,
    },
  });
  return raw;
}

async function tenantPayload(tenantId: string, userId: string): Promise<TenantTokenPayload> {
  return withTenant<TenantTokenPayload>(tenantId, async (tx) => {
    const user = await tx.user.findFirst({ where: { id: userId }, include: { role: true } });
    if (!user || !user.isActive || user.deletedAt) throw unauthorized("Учётная запись отключена");
    return {
      kind: "tenant",
      userId: user.id,
      tenantId,
      roleCode: user.role?.code ?? null,
      permissions: user.isOwner ? [...ALL_PERMISSIONS] : (user.role?.permissions ?? []),
      isOwner: user.isOwner,
    };
  });
}

function assertTenantUsable(status: string) {
  if (status === "SUSPENDED") throw forbidden("Доступ к мастерской приостановлен. Обратитесь в поддержку.");
}

export async function loginTenantUser(input: {
  workshop: string;
  login: string;
  password: string;
  req: Request;
}) {
  const tenant = await prisma.tenant.findUnique({ where: { slug: input.workshop.toLowerCase().trim() } });
  // Одинаковая ошибка для «нет мастерской», «нет логина» и «неверный пароль»:
  // иначе форма входа превращается в способ проверять, кто зарегистрирован.
  if (!tenant || tenant.deletedAt) throw unauthorized("Неверная мастерская, логин или пароль");
  assertTenantUsable(tenant.status);

  const user = await withTenant(tenant.id, (tx) =>
    tx.user.findFirst({ where: { login: input.login.trim() }, include: { role: true } })
  );
  if (!user || !user.isActive || user.deletedAt) throw unauthorized("Неверная мастерская, логин или пароль");
  if (!(await verifyPassword(input.password, user.passwordHash)))
    throw unauthorized("Неверная мастерская, логин или пароль");

  await withTenant(tenant.id, (tx) =>
    tx.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })
  );

  const payload = await tenantPayload(tenant.id, user.id);
  const refresh = await issueRefresh({ tenantId: tenant.id, userId: user.id, req: input.req });
  return { accessToken: signAccessToken(payload), refresh, payload, tenant };
}

export async function loginPlatformUser(input: { email: string; password: string; req: Request }) {
  const user = await prisma.platformUser.findUnique({ where: { email: input.email.toLowerCase().trim() } });
  if (!user || !user.isActive) throw unauthorized("Неверный email или пароль");
  if (!(await verifyPassword(input.password, user.passwordHash))) throw unauthorized("Неверный email или пароль");

  await prisma.platformUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  const payload: PlatformTokenPayload = { kind: "platform", platformUserId: user.id, role: user.role };
  const refresh = await issueRefresh({ platformUserId: user.id, req: input.req });
  return { accessToken: signAccessToken(payload), refresh, payload };
}

/**
 * Ротация: старая сессия гасится, выдаётся новая.
 * Если предъявлен уже погашенный токен — считаем, что его украли, и гасим все сессии владельца.
 */
export async function rotateRefresh(raw: string, req: Request) {
  const session = await prisma.session.findUnique({ where: { refreshHash: hashToken(raw) } });
  if (!session) throw unauthorized("Сессия недействительна");

  if (session.revokedAt) {
    await prisma.session.updateMany({
      where: session.userId ? { userId: session.userId } : { platformUserId: session.platformUserId },
      data: { revokedAt: new Date() },
    });
    throw unauthorized("Сессия отозвана, войдите заново");
  }
  if (session.expiresAt < new Date()) throw unauthorized("Сессия истекла, войдите заново");

  await prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });

  if (session.userId && session.tenantId) {
    const tenant = await prisma.tenant.findUnique({ where: { id: session.tenantId } });
    if (!tenant || tenant.deletedAt) throw unauthorized("Мастерская недоступна");
    assertTenantUsable(tenant.status);
    const payload = await tenantPayload(session.tenantId, session.userId);
    const refresh = await issueRefresh({ tenantId: session.tenantId, userId: session.userId, req });
    return { accessToken: signAccessToken(payload), refresh };
  }

  if (session.platformUserId) {
    const user = await prisma.platformUser.findUnique({ where: { id: session.platformUserId } });
    if (!user || !user.isActive) throw unauthorized("Учётная запись отключена");
    const payload: PlatformTokenPayload = { kind: "platform", platformUserId: user.id, role: user.role };
    const refresh = await issueRefresh({ platformUserId: user.id, req });
    return { accessToken: signAccessToken(payload), refresh };
  }

  throw unauthorized("Сессия недействительна");
}

export async function revokeRefresh(raw: string | undefined) {
  if (!raw) return;
  await prisma.session.updateMany({
    where: { refreshHash: hashToken(raw), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** Гасит все сессии сотрудника — при увольнении, смене пароля или отключении учётки. */
export async function revokeAllForUser(userId: string) {
  await prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
}
