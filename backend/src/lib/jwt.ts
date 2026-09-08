import jwt, { type SignOptions } from "jsonwebtoken";
import { env } from "./env";

/** Токен сотрудника мастерской. tenantId внутри токена — основа изоляции. */
export interface TenantTokenPayload {
  kind: "tenant";
  userId: string;
  tenantId: string;
  roleCode: string | null;
  permissions: string[];
  isOwner: boolean;
}

/** Токен собственника или администратора платформы. */
export interface PlatformTokenPayload {
  kind: "platform";
  platformUserId: string;
  role: "OWNER" | "ADMIN";
  /** Заполнен, когда платформенный пользователь вошёл в мастерскую через «войти как». */
  impersonatingTenantId?: string;
  impersonationId?: string;
}

export type TokenPayload = TenantTokenPayload | PlatformTokenPayload;

// Типы jsonwebtoken ждут литерал вида "15m", а из переменной окружения приходит обычный string.
const accessOptions: SignOptions = { expiresIn: env.accessTokenTtl as SignOptions["expiresIn"] };

export function signAccessToken(payload: TokenPayload): string {
  return jwt.sign(payload, env.jwtAccessSecret, accessOptions);
}

export function verifyAccessToken(token: string): TokenPayload {
  return jwt.verify(token, env.jwtAccessSecret) as TokenPayload;
}
