import type { Prisma } from "@prisma/client";
import type { Request } from "express";

export type AuditAction = "CREATE" | "UPDATE" | "DELETE" | "STATUS" | "LOGIN" | "PASSWORD";

/**
 * Запись в аудит-лог мастерской. Вызывается внутри той же транзакции, что и само изменение:
 * если изменение откатится, запись в логе не останется.
 */
export async function writeAudit(
  tx: Prisma.TransactionClient,
  params: {
    tenantId: string;
    userId?: string | null;
    entity: string;
    entityId: string;
    action: AuditAction;
    diff?: Record<string, unknown>;
    ip?: string | null;
  }
) {
  await tx.auditLog.create({
    data: {
      tenantId: params.tenantId,
      userId: params.userId ?? null,
      entity: params.entity,
      entityId: params.entityId,
      action: params.action,
      diff: params.diff as Prisma.InputJsonValue | undefined,
      ip: params.ip ?? null,
    },
  });
}

export const clientIp = (req: Request): string | null =>
  (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ?? req.socket.remoteAddress ?? null;

/** Убирает из объекта поля, которые нельзя писать в лог. */
export function safeDiff<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const hidden = new Set(["password", "passwordHash", "devicePasscode", "refreshHash", "totpSecret"]);
  return Object.fromEntries(Object.entries(obj).filter(([k]) => !hidden.has(k)));
}
