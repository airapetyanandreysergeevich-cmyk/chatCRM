import type { Prisma } from "@prisma/client";
import type { DatasetKey } from "./dataset";

/**
 * Стирание раздела базы мастерской насовсем.
 *
 * Отдельным файлом и с тем же правилом, что у удаления мастерской целиком:
 * порядок здесь не стиль, а условие работы. Каскадов в схеме нет намеренно —
 * с ними одна ошибка в коде тихо уносит заказы за собой, — поэтому детей
 * удаляем раньше родителей, и каждый шаг выписан руками.
 *
 * Что именно происходит с чужими ссылками, решено здесь раз и навсегда:
 *
 *  — Деньги вместе с заказами не трогаем. Кассовая операция теряет ссылку на
 *    удалённый заказ, но остаётся в кассе. Удалить её заодно с заказом
 *    значило бы молча изменить остаток кассы — сумму, которую мастерская
 *    сверяет с наличными в ящике. Стереть деньги можно только отдельным
 *    разделом «Касса», выбрав его явно (и, по желанию, только некоторые
 *    кассы) — тогда это решение владельца, а не побочный эффект.
 *
 *  — Заявки на закупку и движения склада тоже остаются, теряя привязку к
 *    заказу. Это их собственная история, а не история заказа.
 *
 *  — Позиции заказов и закупок, ссылавшиеся на удалённую номенклатуру,
 *    сохраняются: название и цена записаны в самой позиции, и заказ от
 *    стирания склада не должен подешеветь.
 *
 *  — Счётчики номеров не сбрасываются. После стирания заказов мастерская
 *    почти всегда загружает базу заново — из файла, где номера свои. Начни
 *    счётчик с единицы, первый же принятый вручную заказ столкнулся бы с
 *    номером загруженного, и выглядело бы это как поломка приёма.
 */

export interface Wiped {
  /** Сколько строк ушло, по таблицам. Идёт в журнал и человеку на экран. */
  rows: Record<string, number>;
  /** Сколько фотографий удалено из хранилища. */
  files: number;
}

const add = (into: Wiped, table: string, count: number) => {
  if (count > 0) into.rows[table] = (into.rows[table] ?? 0) + count;
};

/**
 * Порядок разделов: заказы раньше клиентов.
 *
 * Заказ ссылается на клиента обязательным полем, и стереть карточку, пока
 * жив хоть один её заказ, база не даст. Когда выбрано и то и другое,
 * очерёдность решаем здесь, а не оставляем на порядок галочек на экране.
 */
const WIPE_ORDER: DatasetKey[] = ["cash", "orders", "customers", "stock", "services"];

export const sortDatasets = (keys: DatasetKey[]): DatasetKey[] =>
  WIPE_ORDER.filter((k) => keys.includes(k));

/**
 * Можно ли стереть выбранное.
 *
 * Отказ должен прийти раньше первой удалённой строки: стирание идёт одной
 * транзакцией, но человеку нужно не «откатилось», а «вот что сделать».
 */
export async function wipeBlocker(
  tx: Prisma.TransactionClient,
  keys: DatasetKey[]
): Promise<string | null> {
  if (keys.includes("customers") && !keys.includes("orders")) {
    const orders = await tx.order.count();
    if (orders > 0) {
      return (
        `Сначала сотрите заказы: их ${orders}, и каждый ссылается на карточку клиента. ` +
        "Отметьте «Заказы» вместе с «Клиентами» или сотрите их отдельно раньше."
      );
    }
  }
  return null;
}

/**
 * Ключи фотографий заказов — чтобы убрать их из хранилища до транзакции.
 *
 * Само удаление файлов живёт в маршруте, а не здесь: хранилище это сеть, а
 * сеть тянет за собой настройки окружения, и файл с правилами стирания
 * перестал бы проверяться без поднятой базы. Здесь — только чтение ключей.
 */
export async function wipeFiles(tx: Prisma.TransactionClient): Promise<string[]> {
  const rows = await tx.attachment.findMany({ select: { objectKey: true } });
  return rows.map((r) => r.objectKey);
}

async function wipeOrders(tx: Prisma.TransactionClient, out: Wiped): Promise<void> {
  add(out, "attachment", (await tx.attachment.deleteMany({})).count);

  // Чужие ссылки на заказ обнуляем, сами записи не трогаем.
  await tx.transaction.updateMany({ where: { orderId: { not: null } }, data: { orderId: null } });
  await tx.purchaseRequest.updateMany({ where: { orderId: { not: null } }, data: { orderId: null } });
  await tx.stockMovement.updateMany({ where: { orderId: { not: null } }, data: { orderId: null } });

  add(out, "orderMessage", (await tx.orderMessage.deleteMany({})).count);
  add(out, "orderPart", (await tx.orderPart.deleteMany({})).count);
  add(out, "orderWork", (await tx.orderWork.deleteMany({})).count);
  add(out, "orderStatusHistory", (await tx.orderStatusHistory.deleteMany({})).count);
  add(out, "order", (await tx.order.deleteMany({})).count);
}

async function wipeCustomers(tx: Prisma.TransactionClient, out: Wiped): Promise<void> {
  await tx.transaction.updateMany({ where: { customerId: { not: null } }, data: { customerId: null } });

  // Техника живёт только при карточке: у неё нет владельца, кроме клиента.
  add(out, "device", (await tx.device.deleteMany({})).count);
  add(out, "customer", (await tx.customer.deleteMany({})).count);
}

async function wipeStock(tx: Prisma.TransactionClient, out: Wiped): Promise<void> {
  // Позиции заказов и закупок остаются: название и цена записаны в них
  // самих, и заказ от стирания склада не должен подешеветь.
  await tx.orderPart.updateMany({ where: { stockItemId: { not: null } }, data: { stockItemId: null } });
  await tx.purchaseRequestItem.updateMany({
    where: { stockItemId: { not: null } },
    data: { stockItemId: null },
  });

  add(out, "stockMovement", (await tx.stockMovement.deleteMany({})).count);
  add(out, "stockBalance", (await tx.stockBalance.deleteMany({})).count);
  add(out, "stockItem", (await tx.stockItem.deleteMany({})).count);
  // Склады не трогаем: это настройка мастерской, а не её номенклатура.
}

async function wipeServices(tx: Prisma.TransactionClient, out: Wiped): Promise<void> {
  // Прайс ни с чем не связан: работа в заказе хранит своё название и цену.
  add(out, "service", (await tx.service.deleteMany({})).count);
}

/**
 * Касса: только движения денег. Сами кассы и статьи — это настройки
 * мастерской, как склады при стирании склада, и остаются на месте.
 */
async function wipeCash(tx: Prisma.TransactionClient, out: Wiped, registers?: string[]): Promise<void> {
  add(
    out,
    "transaction",
    (await tx.transaction.deleteMany({ where: registers?.length ? { cashRegisterId: { in: registers } } : {} })).count
  );
}

export interface CashImpact {
  /** Сколько движений денег уйдёт. */
  transactions: number;
  /** Сколько выданных заказов станут долгами (или долг у них вырастет). */
  orders: number;
  /** На сколько вырастут долги в сумме. */
  sum: number;
}

/**
 * Что станет с долгами, если стереть движения выбранных касс.
 *
 * Долг — это итог заказа минус платежи по нему. Платежи уйдут, заказы
 * останутся — и выданный оплаченный заказ станет долгом. Считаем заранее,
 * чтобы окно стирания сказало это числом, а не человек узнал из сводки.
 */
export async function cashWipeImpact(
  tx: Prisma.TransactionClient,
  tenantId: string,
  registers?: string[]
): Promise<CashImpact> {
  const all = !registers?.length;
  const picked = registers?.length ? registers : [""];
  const [row] = await tx.$queryRaw<Array<{ transactions: bigint; orders: bigint; sum: string | null }>>`
    WITH t AS (
      SELECT "orderId", "cashRegisterId",
             CASE WHEN direction = 'IN' THEN amount ELSE -amount END AS signed
        FROM "Transaction"
       WHERE "tenantId" = ${tenantId} AND "deletedAt" IS NULL
    ),
    paid AS (
      SELECT "orderId",
             SUM(signed) AS paid,
             SUM(CASE WHEN ${all} OR "cashRegisterId" = ANY(${picked}::text[]) THEN signed ELSE 0 END) AS removed
        FROM t WHERE "orderId" IS NOT NULL GROUP BY "orderId"
    ),
    hit AS (
      SELECT GREATEST(o.total - (p.paid - p.removed), 0) - GREATEST(o.total - p.paid, 0) AS grow
        FROM "Order" o JOIN paid p ON p."orderId" = o.id
       WHERE o."tenantId" = ${tenantId} AND o."deletedAt" IS NULL AND o."issuedAt" IS NOT NULL
    )
    SELECT (SELECT COUNT(*) FROM t WHERE ${all} OR "cashRegisterId" = ANY(${picked}::text[])) AS transactions,
           (SELECT COUNT(*) FROM hit WHERE grow > 0.004) AS orders,
           (SELECT COALESCE(SUM(grow), 0) FROM hit WHERE grow > 0.004)::text AS sum
  `;
  return {
    transactions: Number(row?.transactions ?? 0),
    orders: Number(row?.orders ?? 0),
    sum: Math.round(Number(row?.sum ?? 0)),
  };
}

export async function wipeDatasets(
  tx: Prisma.TransactionClient,
  keys: DatasetKey[],
  opts: { registers?: string[] } = {}
): Promise<Wiped> {
  const out: Wiped = { rows: {}, files: 0 };

  for (const key of sortDatasets(keys)) {
    if (key === "cash") await wipeCash(tx, out, opts.registers);
    if (key === "orders") await wipeOrders(tx, out);
    if (key === "customers") await wipeCustomers(tx, out);
    if (key === "stock") await wipeStock(tx, out);
    if (key === "services") await wipeServices(tx, out);
  }

  return out;
}
