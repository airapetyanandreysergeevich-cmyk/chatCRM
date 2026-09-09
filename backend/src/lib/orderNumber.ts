import type { Prisma } from "@prisma/client";

/**
 * Номер заказа выдаётся счётчиком самой мастерской, а не сквозным по платформе:
 * у каждой своя нумерация с первого номера, как в бумажном журнале.
 *
 * Счётчик двигается одним `UPDATE ... RETURNING`, поэтому два одновременных
 * приёма не получат один номер даже если приёмщики нажали «сохранить» разом.
 */
export async function nextOrderNumber(
  tx: Prisma.TransactionClient,
  tenantId: string
): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ orderNumberNext: number; orderNumberPrefix: string }>>`
    UPDATE "Tenant"
       SET "orderNumberNext" = "orderNumberNext" + 1
     WHERE id = ${tenantId}
    RETURNING "orderNumberNext", "orderNumberPrefix"
  `;
  if (!rows.length) throw new Error("Мастерская не найдена");

  const issued = Number(rows[0].orderNumberNext) - 1;
  const year = new Date().getFullYear();
  return `${rows[0].orderNumberPrefix}-${year}-${String(issued).padStart(5, "0")}`;
}
