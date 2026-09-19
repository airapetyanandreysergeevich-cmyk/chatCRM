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
 *  — Деньги не трогаем. Кассовая операция теряет ссылку на удалённый заказ,
 *    но остаётся в кассе. Удалить её вместе с заказом значило бы молча
 *    изменить остаток кассы — сумму, которую мастерская сверяет с наличными
 *    в ящике. Данные можно стирать по просьбе владельца, деньги — нет.
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
const WIPE_ORDER: DatasetKey[] = ["orders", "customers", "stock", "services"];

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

export async function wipeDatasets(
  tx: Prisma.TransactionClient,
  keys: DatasetKey[]
): Promise<Wiped> {
  const out: Wiped = { rows: {}, files: 0 };

  for (const key of sortDatasets(keys)) {
    if (key === "orders") await wipeOrders(tx, out);
    if (key === "customers") await wipeCustomers(tx, out);
    if (key === "stock") await wipeStock(tx, out);
    if (key === "services") await wipeServices(tx, out);
  }

  return out;
}
