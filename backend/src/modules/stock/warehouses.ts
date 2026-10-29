import type { Prisma } from "@prisma/client";

/**
 * Склады позиций (29.10.2026, Андрей: «у многих несколько складов»).
 * Отдельным файлом без зависимостей от окружения — им пользуется и загрузка
 * из файла, которую проверяют без базы (test/datasets.ts).
 */

const num = (v: Prisma.Decimal | number | null | undefined): number => (v === null || v === undefined ? 0 : Number(v));

/**
 * Склад по названию (29.10.2026): «Склад» в карточке позиции — как место
 * хранения, текстом с подсказками. Такой есть (без учёта регистра) — он,
 * нет — заводим. Пусто — null: основной склад.
 */
export async function warehouseByName(tx: Prisma.TransactionClient, tenantId: string, raw: string | null | undefined) {
  const name = (raw ?? "").trim().replace(/\s+/g, " ").slice(0, 80);
  if (!name) return null;
  const found = await tx.warehouse.findFirst({ where: { name: { equals: name, mode: "insensitive" } } });
  if (found) return found;
  // Складов ещё нет — первый названный становится основным, а не вторым рядом с пустым «Основным».
  const any = await tx.warehouse.count();
  return tx.warehouse.create({ data: { tenantId, name, isDefault: any === 0 } });
}

/** Склад позиции: её собственный, а не задан — основной. */
export async function homeWarehouse(tx: Prisma.TransactionClient, tenantId: string, warehouseId: string | null | undefined) {
  if (warehouseId) {
    const w = await tx.warehouse.findFirst({ where: { id: warehouseId } });
    if (w) return w;
  }
  return (
    (await tx.warehouse.findFirst({ orderBy: [{ isDefault: "desc" }, { name: "asc" }] })) ??
    (await tx.warehouse.create({ data: { tenantId, name: "Основной склад", isDefault: true } }))
  );
}

/**
 * Позицию перенесли на другой склад — её остаток едет с ней: остатки на
 * прежних складах сливаются в один на новом (средняя себестоимость — по
 * количеству). Движения в журнале остаются, где были.
 */
export async function rehomeBalances(tx: Prisma.TransactionClient, tenantId: string, stockItemId: string, toWarehouseId: string) {
  const all = await tx.stockBalance.findMany({ where: { stockItemId } });
  const others = all.filter((b) => b.warehouseId !== toWarehouseId);
  if (!others.length) return;
  const target = all.find((b) => b.warehouseId === toWarehouseId);
  const qty = all.reduce((n, b) => n + num(b.qty), 0);
  const value = all.reduce((n, b) => n + num(b.qty) * num(b.avgCost), 0);
  const avgCost = qty > 0 ? value / qty : num(target?.avgCost ?? others[0].avgCost);
  await tx.stockBalance.deleteMany({ where: { id: { in: others.map((b) => b.id) } } });
  if (target) await tx.stockBalance.update({ where: { id: target.id }, data: { qty, avgCost } });
  else await tx.stockBalance.create({ data: { tenantId, warehouseId: toWarehouseId, stockItemId, qty, avgCost } });
}

