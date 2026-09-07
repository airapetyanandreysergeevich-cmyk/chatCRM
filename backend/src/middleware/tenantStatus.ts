import type { NextFunction, Request, Response } from "express";
import { prisma } from "../lib/db";
import { forbidden } from "../lib/errors";
import { currentTenantId } from "./auth";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Неоплаченная подписка переводит мастерскую в режим «только чтение».
 * Данные остаются на месте и видны владельцу — блокируются только изменения.
 */
export async function enforceTenantStatus(req: Request, res: Response, next: NextFunction) {
  const tenantId = currentTenantId(req);
  if (!tenantId) return next();
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { status: true, deletedAt: true },
    });
    if (!tenant || tenant.deletedAt) return next(forbidden("Мастерская недоступна"));
    if (tenant.status === "SUSPENDED") return next(forbidden("Доступ к мастерской приостановлен"));
    if (tenant.status === "READONLY" && !READ_METHODS.has(req.method)) {
      return next(forbidden("Подписка не оплачена: изменения временно недоступны"));
    }
    next();
  } catch (err) {
    next(err);
  }
}
