import { createHash, randomBytes } from "node:crypto";
import type { Request } from "express";
import { prisma, withPlatform, withTenant } from "../../lib/db";
import { env } from "../../lib/env";
import { forbidden, unauthorized } from "../../lib/errors";
import { signAccessToken, type PlatformTokenPayload, type TenantTokenPayload } from "../../lib/jwt";
import { hashPassword, verifyPassword } from "../../lib/password";
import { ALL_PERMISSIONS } from "../../lib/permissions";
import { clientIp } from "../../lib/audit";

const hashToken = (raw: string) => createHash("sha256").update(raw).digest("hex");

export const REFRESH_COOKIE = "rs_refresh";

/** Одинаковый ответ на «нет такого адреса» и «неверный пароль»: форма входа не должна
 *  превращаться в способ проверять, кто зарегистрирован в системе. */
const WRONG = "Неверный email или пароль";

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

/** Несуществующий адрес должен отвечать за то же время, что и существующий,
 *  иначе разницу во времени ответа можно использовать для перебора адресов. */
let decoyHash: string | null = null;
async function spendSameTime(password: string) {
  if (!decoyHash) decoyHash = await hashPassword(randomBytes(24).toString("hex"));
  await verifyPassword(password, decoyHash);
}

/**
 * Единственное место аутентификации, где снимается изоляция по мастерской:
 * пока не найден пользователь, tenantId неизвестен. Наружу отсюда уходят
 * только два идентификатора — ни почты, ни имени, ни хеша пароля.
 */
async function locateTenantUser(email: string) {
  return withPlatform((tx) =>
    tx.user.findFirst({
      where: { email, deletedAt: null, isActive: true },
      select: { id: true, tenantId: true },
    })
  );
}

function assertTenantUsable(status: string) {
  if (status === "SUSPENDED") throw forbidden("Доступ к мастерской приостановлен. Обратитесь в поддержку.");
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

export interface LoginResult {
  accessToken: string;
  refresh: string;
  kind: "platform" | "tenant";
}

/**
 * Вход один на всех. Сначала ищем среди пользователей платформы, потом среди
 * сотрудников мастерских — email уникален по всей платформе, так что пересечься они не могут.
 */
export async function login(input: { email: string; password: string; req: Request }): Promise<LoginResult> {
  const email = input.email.toLowerCase().trim();

  const platformUser = await prisma.platformUser.findUnique({ where: { email } });
  if (platformUser) {
    if (!platformUser.isActive) throw unauthorized(WRONG);
    if (!(await verifyPassword(input.password, platformUser.passwordHash))) throw unauthorized(WRONG);

    await prisma.platformUser.update({ where: { id: platformUser.id }, data: { lastLoginAt: new Date() } });
    const payload: PlatformTokenPayload = {
      kind: "platform",
      platformUserId: platformUser.id,
      role: platformUser.role,
    };
    return {
      accessToken: signAccessToken(payload),
      refresh: await issueRefresh({ platformUserId: platformUser.id, req: input.req }),
      kind: "platform",
    };
  }

  const located = await locateTenantUser(email);
  if (!located) {
    // Учётки нет — возможно, заявка ещё не одобрена. Стадию раскрываем только тому,
    // кто знает пароль от этой заявки: иначе форма выдавала бы, кто к нам обращался.
    const application = await prisma.tenantApplication.findFirst({
      where: { ownerEmail: email, status: { in: ["PENDING", "REJECTED"] } },
      orderBy: { createdAt: "desc" },
    });
    if (application && (await verifyPassword(input.password, application.passwordHash))) {
      if (application.status === "PENDING")
        throw forbidden("Заявка на подключение ещё на рассмотрении. Мы свяжемся с вами.");
      throw forbidden(
        application.rejectionReason
          ? `Заявка отклонена: ${application.rejectionReason}`
          : "Заявка отклонена."
      );
    }
    if (!application) await spendSameTime(input.password);
    throw unauthorized(WRONG);
  }

  const tenant = await prisma.tenant.findUnique({ where: { id: located.tenantId } });
  if (!tenant || tenant.deletedAt) throw unauthorized(WRONG);
  assertTenantUsable(tenant.status);

  const user = await withTenant(tenant.id, (tx) => tx.user.findFirst({ where: { id: located.id } }));
  if (!user) throw unauthorized(WRONG);
  if (!(await verifyPassword(input.password, user.passwordHash))) throw unauthorized(WRONG);

  await withTenant(tenant.id, (tx) =>
    tx.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })
  );

  const payload = await tenantPayload(tenant.id, user.id);
  return {
    accessToken: signAccessToken(payload),
    refresh: await issueRefresh({ tenantId: tenant.id, userId: user.id, req: input.req }),
    kind: "tenant",
  };
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

/** Занят ли адрес где-нибудь в системе. Вход общий, поэтому и проверка общая. */
export async function isEmailTaken(email: string, exceptUserId?: string): Promise<boolean> {
  const normalized = email.toLowerCase().trim();
  if (await prisma.platformUser.findUnique({ where: { email: normalized } })) return true;
  const existing = await withPlatform((tx) =>
    tx.user.findFirst({ where: { email: normalized, deletedAt: null }, select: { id: true } })
  );
  return !!existing && existing.id !== exceptUserId;
}
