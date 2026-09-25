/**
 * Проверка стирания разделов базы.
 *
 * Это самая опасная кнопка в программе, и проверять здесь надо не то, что
 * она работает, а то, чего она НЕ делает.
 *
 * Первое: деньги. Кассовая операция, привязанная к стираемому заказу, теряет
 * ссылку, но остаётся в кассе. Удали её вместе с заказом — и остаток кассы,
 * который мастерская сверяет с наличными в ящике, молча изменится. Узнают об
 * этом в конце смены, когда сходиться уже нечему.
 *
 * Второе: порядок. Каскадов в схеме нет намеренно, и родитель, удалённый
 * раньше детей, не «почти получится», а остановит стирание на полпути —
 * в состоянии, из которого нет пути ни назад, ни вперёд.
 *
 *   npx tsx test/wipe.ts
 */

import { sortDatasets, wipeBlocker, wipeDatasets } from "../src/modules/data/wipe";

let fails = 0;
const check = (ok: boolean, msg: string) => {
  console.log((ok ? "ok    " : "БЕДА  ") + msg);
  if (!ok) fails += 1;
};

/**
 * Заглушка вместо базы: записывает, что и в каком порядке у неё просили.
 * Настоящие строки не нужны — нужен след.
 */
function recorder(counts: Record<string, number> = {}) {
  const log: string[] = [];
  const tx = new Proxy(
    {},
    {
      get: (_t, table: string) => ({
        deleteMany: async () => {
          log.push(`${table}.delete`);
          return { count: counts[table] ?? 0 };
        },
        updateMany: async () => {
          log.push(`${table}.update`);
          return { count: 0 };
        },
        count: async () => counts[table] ?? 0,
        findMany: async () => [],
      }),
    }
  );
  return { tx: tx as never, log };
}

const before = (log: string[], a: string, b: string) => {
  const i = log.indexOf(a);
  const j = log.indexOf(b);
  return i !== -1 && j !== -1 && i < j;
};

async function main(): Promise<void> {
  // 1. Порядок разделов: заказы раньше клиентов, как бы ни стояли галочки.
  check(sortDatasets(["customers", "orders"]).join() === "orders,customers", "заказы стираются раньше клиентов");
  check(sortDatasets(["services", "stock"]).join() === "stock,services", "порядок не зависит от порядка галочек");
  check(sortDatasets(["orders"]).join() === "orders", "один раздел остаётся один");

  // 2. Отказ раньше первой удалённой строки.
  const withOrders = recorder({ order: 4039 });
  const blocked = await wipeBlocker(withOrders.tx, ["customers"]);
  check(!!blocked && blocked.includes("4039"), `клиентов без заказов стереть нельзя, и в отказе — число (${blocked})`);
  check(
    (await wipeBlocker(withOrders.tx, ["orders", "customers"])) === null,
    "вместе с заказами — можно"
  );
  const empty = recorder({ order: 0 });
  check((await wipeBlocker(empty.tx, ["customers"])) === null, "когда заказов нет, клиенты стираются сами по себе");

  // 3. Деньги не удаляются никогда.
  const money = recorder({ order: 10, transaction: 99 });
  await wipeDatasets(money.tx, ["orders", "customers"]);
  check(!money.log.includes("transaction.delete"), "кассовые операции не удаляются вместе с заказами");
  check(money.log.includes("transaction.update"), "но теряют ссылку на стёртый заказ");
  check(!money.log.includes("cashRegister.delete"), "кассы не трогаем вовсе");

  // 3а. Касса — только когда её выбрали явно, и только движения.
  const cash = recorder({ transaction: 99 });
  const cashOut = await wipeDatasets(cash.tx, ["cash"]);
  check(cash.log.join() === "transaction.delete", `касса стирает только движения (${cash.log.join(", ")})`);
  check(cashOut.rows.transaction === 99, "число стёртых движений возвращается");
  check(sortDatasets(["orders", "cash"]).join() === "cash,orders", "касса стирается раньше заказов");

  // 4. Дети раньше родителей.
  const orders = recorder();
  await wipeDatasets(orders.tx, ["orders"]);
  for (const child of ["attachment", "orderPart", "orderWork", "orderStatusHistory"]) {
    check(before(orders.log, `${child}.delete`, "order.delete"), `${child} удаляется раньше заказа`);
  }

  const both = recorder();
  await wipeDatasets(both.tx, ["customers", "orders"]);
  check(before(both.log, "order.delete", "customer.delete"), "заказ удаляется раньше клиента");
  check(before(both.log, "device.delete", "customer.delete"), "техника удаляется раньше карточки");

  const stock = recorder();
  await wipeDatasets(stock.tx, ["stock"]);
  check(before(stock.log, "stockMovement.delete", "stockItem.delete"), "движения раньше позиции");
  check(before(stock.log, "stockBalance.delete", "stockItem.delete"), "остатки раньше позиции");
  check(!stock.log.includes("warehouse.delete"), "склады остаются: это настройка, а не номенклатура");
  check(
    !stock.log.includes("orderPart.delete") && stock.log.includes("orderPart.update"),
    "позиции заказов не удаляются вместе со складом — заказ не должен подешеветь"
  );

  // 5. Стирание прайса ничего за собой не тянет.
  const services = recorder({ service: 312 });
  await wipeDatasets(services.tx, ["services"]);
  check(services.log.join() === "service.delete", `прайс стирается один (${services.log.join(", ")})`);

  // 6. Счёт стёртого возвращается человеку и попадает в журнал.
  const counted = recorder({ order: 4039, orderWork: 800, service: 0 });
  const result = await wipeDatasets(counted.tx, ["orders"]);
  check(result.rows.order === 4039, "число стёртых заказов возвращается");
  check(result.rows.orderWork === 800, "и число стёртых работ тоже");
  check(!("service" in result.rows), "пустые таблицы в отчёт не попадают — это шум");

  console.log(fails === 0 ? "\nвсе проверки прошли" : `\nпровалов: ${fails}`);
  process.exitCode = fails === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error("сорвалось:", err);
  process.exitCode = 1;
});
