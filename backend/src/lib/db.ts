import { Prisma, PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();

/** Делегаты Prisma для таблиц с tenantId. Совпадает со списком таблиц в prisma/rls.sql. */
const TENANT_DELEGATES = new Set([
  "branch", "role", "user", "customer", "device", "orderStatus", "order",
  "orderStatusHistory", "orderWork", "orderPart", "attachment",
  "purchaseRequest", "purchaseRequestItem",
  "warehouse", "stockItem", "stockBalance", "stockMovement",
  "cashRegister", "transactionCategory", "transaction",
  "auditLog", "notification", "pushSubscription",
]);

const WHERE_OPS = new Set([
  "findFirst", "findFirstOrThrow", "findMany", "count", "aggregate", "groupBy",
  "update", "updateMany", "delete", "deleteMany",
]);

function injectTenant(op: string, args: any, tenantId: string) {
  const a = { ...(args ?? {}) };
  if (WHERE_OPS.has(op)) a.where = { ...(a.where ?? {}), tenantId };
  else if (op === "create") a.data = { ...(a.data ?? {}), tenantId };
  else if (op === "createMany")
    a.data = Array.isArray(a.data) ? a.data.map((d: any) => ({ ...d, tenantId })) : { ...a.data, tenantId };
  else if (op === "upsert") {
    a.where = { ...(a.where ?? {}), tenantId };
    a.create = { ...(a.create ?? {}), tenantId };
  }
  return a;
}

/**
 * Клиент внутри withTenant: сам подставляет tenantId и в where, и в data.
 * Писать tenantId руками в коде не нужно — и забыть его тоже нельзя.
 */
function scopeToTenant(tx: Prisma.TransactionClient, tenantId: string): Prisma.TransactionClient {
  return new Proxy(tx, {
    get(target: any, prop: string) {
      const delegate = target[prop];
      if (typeof prop !== "string" || !TENANT_DELEGATES.has(prop) || !delegate) return delegate;
      return new Proxy(delegate, {
        get(d: any, op: string) {
          const fn = d[op];
          if (typeof fn !== "function") return fn;
          if (op === "findUnique" || op === "findUniqueOrThrow") {
            // findUnique принимает только уникальные поля, tenantId туда не подмешать.
            return () => {
              throw new Error(`${prop}.${op}: для данных мастерской используйте findFirst`);
            };
          }
          return (args?: any) => fn.call(d, injectTenant(op, args, tenantId));
        },
      });
    },
  }) as Prisma.TransactionClient;
}

/**
 * Единственный способ работать с данными мастерской.
 *
 * Два независимых рубежа изоляции:
 *   1. set_config('app.tenant_id') + политики RLS — режет PostgreSQL;
 *   2. прокси выше — подставляет tenantId в каждый запрос.
 *
 * Ограничение: во вложенных create (create: { works: { create: [...] } }) прокси до детей
 * не дотягивается. Такие вставки делайте отдельными вызовами — иначе их отклонит RLS.
 */
export function withTenant<T>(
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe("SELECT set_config('app.tenant_id', $1, true)", tenantId);
    return fn(scopeToTenant(tx, tenantId));
  });
}

/**
 * Режим платформы: снимает изоляцию по арендатору внутри одной транзакции.
 * Нужен собственнику для сводных цифр по всем мастерским — и больше нигде.
 * Использовать только в модуле platform: любой вызов отсюда читает данные всех клиентов.
 */
export function withPlatform<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe("SELECT set_config('app.platform', 'on', true)");
    return fn(tx);
  });
}
