import type { Prisma } from "@prisma/client";

/**
 * Деньги заказа: как из работ и запчастей получается сумма к оплате.
 *
 * Отдельным файлом, и не ради порядка. Этот расчёт нужен и карточке заказа, и
 * складу, и загрузке данных из файла, а тянуть ради двух формул весь
 * orders.service — значит тянуть за ним права, хранилище и переменные
 * окружения. Здесь нет ничего, кроме арифметики и типов Prisma: расчёт можно
 * прогнать в тесте, не поднимая ни базы, ни приложения.
 */

/**
 * Скидка клиента считается только от стоимости работ.
 *
 * Запчасть мастерская покупает за живые деньги, и процент с неё — это процент
 * из своего кармана. Скидывать можно только то, что заработано руками, поэтому
 * запчасти в расчёт не входят вовсе.
 */
export function discountOnWork(
  totalWork: number,
  percent: Prisma.Decimal | number | null | undefined
): number {
  const p = Number(percent ?? 0);
  if (!p) return 0;
  // Округляем до копеек здесь, а не при выводе: иначе в квитанции и в кассе
  // окажутся суммы, различающиеся на копейку, и сойтись они уже не смогут.
  return Math.round(totalWork * p) / 100;
}

/** Пересчёт сумм после любой правки работ или запчастей — источник истины один. */
export async function recalcTotals(tx: Prisma.TransactionClient, orderId: string): Promise<void> {
  const order = await tx.order.findFirst({
    where: { id: orderId },
    include: { works: true, parts: true },
  });
  if (!order) return;

  const sum = (rows: Array<{ qty: Prisma.Decimal; price: Prisma.Decimal }>) =>
    rows.reduce((acc, r) => acc + Number(r.qty) * Number(r.price), 0);

  const totalWork = sum(order.works);
  const totalParts = sum(order.parts);
  const workDiscount = discountOnWork(totalWork, order.workDiscountPercent);
  const discount = Number(order.discount);

  await tx.order.update({
    where: { id: orderId },
    data: {
      totalWork,
      totalParts,
      total: Math.max(0, totalWork - workDiscount + totalParts - discount),
    },
  });
}
