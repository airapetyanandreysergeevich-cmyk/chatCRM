import type { Prisma } from "@prisma/client";

/**
 * Приём денег за заказ — на выдаче и при погашении долга.
 *
 * Одно место на оба случая: это буквально одно и то же действие, и если
 * развести его по двум модулям, они разойдутся в мелочах — в названии статьи,
 * в выборе кассы, в том, привязан ли платёж к клиенту. Разойдутся молча, а
 * заметит это бухгалтер через квартал.
 */

export type PaidBy = "CASH" | "CARD";

/**
 * Куда положить деньги.
 *
 * Наличные идут в наличную кассу, безнал — в эквайринговую. Эквайринговой у
 * мастерской поначалу нет: при создании заводится только «Касса». Заводим её
 * сама, когда первый раз приняли картой, а не требуем сходить в настройки —
 * приёмщик в этот момент стоит с клиентом у стойки.
 */
async function registerFor(tx: Prisma.TransactionClient, tenantId: string, how: PaidBy) {
  if (how === "CASH") {
    return (
      (await tx.cashRegister.findFirst({ where: { isActive: true, kind: "CASH" }, orderBy: { name: "asc" } })) ??
      (await tx.cashRegister.findFirst({ where: { isActive: true }, orderBy: { name: "asc" } })) ??
      (await tx.cashRegister.create({ data: { tenantId, name: "Касса", kind: "CASH" } }))
    );
  }

  return (
    (await tx.cashRegister.findFirst({
      where: { isActive: true, kind: { in: ["ACQUIRING", "BANK"] } },
      orderBy: { name: "asc" },
    })) ?? (await tx.cashRegister.create({ data: { tenantId, name: "Эквайринг", kind: "ACQUIRING" } }))
  );
}

/** Статья прихода. Заводится по надобности — как и везде в кассе. */
async function paymentCategory(tx: Prisma.TransactionClient, tenantId: string) {
  const name = "Оплата заказа";
  return (
    (await tx.transactionCategory.findFirst({ where: { name, direction: "IN" } })) ??
    (await tx.transactionCategory.create({ data: { tenantId, name, direction: "IN" } }))
  );
}

/**
 * Провести оплату по заказу.
 *
 * Возвращает проведённую сумму. Ноль и отрицательное не проводим вовсе: запись
 * «принято 0 ₽» в кассе — это мусор, который потом приходится объяснять.
 */
export async function takePayment(
  tx: Prisma.TransactionClient,
  tenantId: string,
  params: {
    orderId: string;
    customerId: string | null;
    amount: number;
    how: PaidBy;
    userId: string | null;
    comment?: string;
  }
): Promise<number> {
  const amount = Math.round(params.amount * 100) / 100;
  if (amount <= 0) return 0;

  const register = await registerFor(tx, tenantId, params.how);
  const category = await paymentCategory(tx, tenantId);

  await tx.transaction.create({
    data: {
      tenantId,
      cashRegisterId: register.id,
      categoryId: category.id,
      direction: "IN",
      amount,
      orderId: params.orderId,
      customerId: params.customerId,
      userId: params.userId,
      comment: params.comment ?? null,
    },
  });

  return amount;
}
