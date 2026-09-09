import { withPlatform } from "../lib/db";
import { notifyTenant } from "../lib/notify";

/**
 * Просроченные заказы.
 *
 * Раз в час проходим по всем мастерским и ищем заказы, у которых прошёл срок
 * готовности, а ремонт не завершён. Оповещение по каждому заказу уходит один
 * раз: признак того, что уже оповещали, — запись в колокольчике, отдельного
 * поля в заказе ради этого заводить не стоит.
 *
 * Запрос идёт в режиме платформы, потому что это фоновая задача — она не
 * принадлежит ни одной мастерской. Дальше каждая мастерская обрабатывается
 * своим notifyTenant, то есть настройки оповещений у всех свои.
 */
export async function checkOverdueOrders(): Promise<void> {
  try {
    const overdue = await withPlatform(async (tx) => {
      const orders = await tx.order.findMany({
        where: {
          deletedAt: null,
          completedAt: null,
          issuedAt: null,
          dueAt: { lt: new Date() },
          status: { group: { notIn: ["CLOSED", "CANCELLED"] } },
        },
        select: { id: true, tenantId: true, number: true, dueAt: true },
        take: 500,
      });
      if (orders.length === 0) return [];

      // Json-фильтр Prisma умеет сравнивать значение по пути, но не «одно из
      // списка», поэтому уже оповещённые отбираем по типу и отсеиваем в коде.
      // Полугодовой горизонт: заказ, просроченный дольше, — это не оповещение,
      // а разговор с управляющим.
      const since = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
      const notified = await tx.notification.findMany({
        where: { type: "order.overdue", createdAt: { gte: since } },
        select: { payload: true },
        take: 5000,
      });
      const already = new Set(
        notified.map((n) => (n.payload as { orderId?: string } | null)?.orderId).filter(Boolean)
      );

      return orders.filter((o) => !already.has(o.id));
    });

    for (const order of overdue) {
      await notifyTenant(order.tenantId, {
        event: "order.overdue",
        title: `Просрочен заказ ${order.number}`,
        body: order.dueAt
          ? `Срок готовности был ${order.dueAt.toLocaleDateString("ru-RU")}.`
          : undefined,
        url: `/orders/${order.id}`,
        payload: { orderId: order.id },
      });
    }

    if (overdue.length) console.log(`[overdue] оповещений: ${overdue.length}`);
  } catch (err) {
    console.error("[overdue]:", (err as Error).message);
  }
}

/** Раз в час, первый проход — через минуту после старта, чтобы не мешать запуску. */
export function startOverdueWatch(): void {
  setTimeout(() => void checkOverdueOrders(), 60_000).unref();
  setInterval(() => void checkOverdueOrders(), 60 * 60 * 1000).unref();
}
