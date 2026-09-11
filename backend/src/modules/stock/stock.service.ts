import type { Prisma } from "@prisma/client";
import { badRequest, notFound } from "../../lib/errors";

/** Prisma отдаёт Decimal объектом — наружу и в расчёты берём число. */
export const num = (v: Prisma.Decimal | number | null | undefined): number =>
  v === null || v === undefined ? 0 : Number(v);

/**
 * tenantId в data пишем явно, хотя прокси из lib/db его тоже подставит.
 * Прокси работает в рантайме, а типы Prisma требуют поле на этапе сборки —
 * без него не компилируется. Дублирование безвредно: значения одинаковые.
 */

/**
 * Склад по умолчанию. Мастерская почти всегда одна и складов не заводит,
 * поэтому первый приход создаёт «Основной склад» сам — заставлять человека
 * сначала завести склад, чтобы оприходовать одну планку памяти, незачем.
 */
export async function defaultWarehouse(
  tx: Prisma.TransactionClient,
  tenantId: string,
  wanted?: string | null
) {
  if (wanted) {
    const w = await tx.warehouse.findFirst({ where: { id: wanted } });
    if (!w) throw notFound("Склад не найден");
    return w;
  }
  return (
    (await tx.warehouse.findFirst({ orderBy: [{ isDefault: "desc" }, { name: "asc" }] })) ??
    (await tx.warehouse.create({ data: { tenantId, name: "Основной склад", isDefault: true } }))
  );
}

/**
 * Одно движение = одна запись в журнале + пересчёт остатка.
 *
 * Себестоимость ведём средней взвешенной: при приходе новая средняя
 * считается по деньгам, а не по последней цене. Для мастерской, где одна
 * и та же планка памяти покупается то за 1200, то за 1800, это
 * единственный способ получить осмысленную цифру склада в деньгах.
 */
export async function applyMovement(
  tx: Prisma.TransactionClient,
  params: {
    tenantId: string;
    warehouseId: string;
    stockItemId: string;
    type: "IN" | "OUT" | "WRITE_OFF" | "RETURN" | "INVENTORY";
    qty: number;
    price?: number | null;
    orderId?: string | null;
    purchaseRequestId?: string | null;
    userId: string | null;
    comment?: string | null;
  }
) {
  const balance =
    (await tx.stockBalance.findFirst({
      where: { warehouseId: params.warehouseId, stockItemId: params.stockItemId },
    })) ??
    (await tx.stockBalance.create({
      data: {
        tenantId: params.tenantId,
        warehouseId: params.warehouseId,
        stockItemId: params.stockItemId,
        qty: 0,
        avgCost: 0,
      },
    }));

  const have = num(balance.qty);
  const avg = num(balance.avgCost);

  let nextQty = have;
  let nextAvg = avg;
  let movementQty = params.qty;

  if (params.type === "IN" || params.type === "RETURN") {
    nextQty = have + params.qty;
    if (params.price !== undefined && params.price !== null && nextQty > 0) {
      nextAvg = (have * avg + params.qty * params.price) / nextQty;
    }
  } else if (params.type === "INVENTORY") {
    // Инвентаризация задаёт остаток, а не изменяет его: в журнал пишем
    // разницу, чтобы было видно, на сколько разошлось с учётом.
    nextQty = params.qty;
    movementQty = params.qty - have;
  } else {
    if (params.qty > have) {
      throw badRequest(
        `На складе только ${have}, списать ${params.qty} нельзя. Сначала оприходуйте недостающее или проведите инвентаризацию.`
      );
    }
    nextQty = have - params.qty;
  }

  await tx.stockBalance.update({
    where: { id: balance.id },
    data: { qty: nextQty, avgCost: nextAvg },
  });

  return tx.stockMovement.create({
    data: {
      tenantId: params.tenantId,
      warehouseId: params.warehouseId,
      stockItemId: params.stockItemId,
      type: params.type,
      qty: movementQty,
      price: params.price ?? null,
      orderId: params.orderId ?? null,
      purchaseRequestId: params.purchaseRequestId ?? null,
      userId: params.userId,
      comment: params.comment ?? null,
    },
  });
}

