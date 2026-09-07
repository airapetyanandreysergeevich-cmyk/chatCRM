import type { NextFunction, Request, Response } from "express";
import { verifyAccessToken, type TokenPayload } from "../lib/jwt";
import { ALL_PERMISSIONS } from "../lib/permissions";

declare global {
  namespace Express {
    interface Request {
      auth?: TokenPayload;
    }
  }
}

export function authenticate(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Не авторизован" });
  }
  try {
    req.auth = verifyAccessToken(header.slice(7));
    next();
  } catch {
    res.status(401).json({ error: "Токен недействителен" });
  }
}

/** tenantId только из токена — никогда из тела запроса, заголовка или параметра URL. */
export function currentTenantId(req: Request): string | null {
  if (!req.auth) return null;
  if (req.auth.kind === "tenant") return req.auth.tenantId;
  return req.auth.impersonatingTenantId ?? null;
}

export function permissionsOf(req: Request): string[] {
  if (!req.auth) return [];
  if (req.auth.kind === "platform") return [...ALL_PERMISSIONS];
  return req.auth.isOwner ? [...ALL_PERMISSIONS] : req.auth.permissions;
}

export function requirePermission(...codes: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const granted = permissionsOf(req);
    if (codes.some((c) => granted.includes(c))) return next();
    res.status(403).json({ error: "Недостаточно прав" });
  };
}

export function requireTenant(req: Request, res: Response, next: NextFunction) {
  if (!currentTenantId(req)) return res.status(403).json({ error: "Нет привязки к мастерской" });
  next();
}
