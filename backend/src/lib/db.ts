import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();

/** Модели, у которых есть tenantId и на которых включён RLS. */
export const TENANT_MODELS = new Set([
  "Branch", "Role", "User", "Customer", "Device", "OrderStatus", "Order",
  "OrderStatusHistory", "OrderWork", "OrderPart", "Attachment",
  "PurchaseRequest", "PurchaseRequestItem",
  "Warehouse", "StockItem", "StockBalance", "StockMovement",
  "CashRegister", "TransactionCategory", "Transaction",
  "AuditLog", "Notification", "PushSubscription",
]);

/**
 * Первый рубеж: транзакция с установленным app.tenant_id.
 * Политики RLS в PostgreSQL отсекут чужие строки, даже если в коде забыли фильтр.
 * Все запросы к данным мастерской идут только через эту обёртку.
 */
export function withTenant<T>(
  tenantId: string,
  fn: (tx: Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">) => Promise<T>
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SELECT set_config('app.tenant_id', $1, true)", tenantId);
    return fn(tx);
  });
}

/**
 * Второй рубеж: расширение клиента, которое само подставляет tenantId в where и data.
 * Два независимых слоя: забыли фильтр в коде — срежет база; ошиблись в политике — срежет здесь.
 */
export function tenantClient(tenantId: string) {
  return prisma.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!model || !TENANT_MODELS.has(model)) return query(args);
          const a = args as Record<string, any>;

          switch (operation) {
            case "findUnique":
            case "findUniqueOrThrow":
              // findUnique не принимает неуникальные фильтры, поэтому подмешать tenantId нельзя.
              // В коде работы с данными мастерской используем findFirst.
              throw new Error(
                `${model}.${operation}: для данных мастерской используйте findFirst — ` +
                  `иначе tenantId не подставится`
              );
            case "findFirst":
            case "findFirstOrThrow":
            case "findMany":
            case "count":
            case "aggregate":
            case "groupBy":
            case "updateMany":
            case "deleteMany":
              a.where = { ...(a.where ?? {}), tenantId };
              break;
            case "update":
            case "delete":
              a.where = { ...(a.where ?? {}), tenantId };
              break;
            case "create":
              a.data = { ...(a.data ?? {}), tenantId };
              break;
            case "createMany":
              a.data = Array.isArray(a.data)
                ? a.data.map((d: any) => ({ ...d, tenantId }))
                : { ...a.data, tenantId };
              break;
            case "upsert":
              a.where = { ...(a.where ?? {}), tenantId };
              a.create = { ...(a.create ?? {}), tenantId };
              break;
          }
          return query(a);
        },
      },
    },
  });
}
