/**
 * Проверка таблиц выгрузки и загрузки.
 *
 * Стережём две вещи, которые ломаются молча и обнаруживаются у клиента.
 *
 * Первая: строка выгрузки должна быть ровно такой длины, как описание
 * колонок. Описание и сборка строки лежат в разных файлах, добавить колонку в
 * одном и забыть в другом — дело одной минуты, а в выгруженном файле после
 * этого всё съезжает на ячейку вправо, начиная с середины. Excel об этом не
 * скажет: он покажет телефон в колонке «Email» и будет по-своему прав.
 *
 * Вторая: заголовки из чужих выгрузок должны узнаваться. Ради этого у колонок
 * есть синонимы, и проверяем мы именно их — «Цена» вместо «Цена, ₽» приедет из
 * любой чужой программы.
 *
 *   npx tsx test/datasets.ts
 */

import { DATASETS, DATASET_KEYS, matchColumns } from "../src/modules/data/dataset";
import { buildSheets } from "../src/modules/data/export";
import { phoneKey, serviceKey } from "../src/modules/data/import";

let fails = 0;
const check = (ok: boolean, msg: string) => {
  console.log((ok ? "ok    " : "БЕДА  ") + msg);
  if (!ok) fails += 1;
};

/**
 * Заглушка вместо базы: каждая таблица отдаёт одну выдуманную запись.
 *
 * Нам не нужны настоящие данные — нужна форма строки. Поля берём с запасом:
 * лишнее сборке не мешает, а недостающее она превратит в undefined, и длина
 * строки от этого не изменится — что и проверяем.
 */
const one = <T>(v: T) => ({ findMany: async () => [v] });

const fakeTx = {
  customer: one({
    type: "INDIVIDUAL",
    name: "Кузнецов И.",
    phone: "+7 900 000-00-00",
    phone2: null,
    email: null,
    address: null,
    inn: null,
    source: null,
    discountPercent: 0,
    note: null,
    devices: [{ kind: "ноутбук", brand: "Lenovo", model: "IdeaPad 5", serial: "PF2XK9LM" }],
    _count: { orders: 3 },
    createdAt: new Date(),
  }),
  order: one({
    number: "0412",
    acceptedAt: new Date(),
    status: { name: "Диагностика" },
    kind: "REPAIR",
    isUrgent: false,
    customer: { name: "Кузнецов И.", phone: "+7 900 000-00-00" },
    device: { kind: "ноутбук", brand: "Lenovo", model: "IdeaPad 5", serial: "PF2XK9LM" },
    complaint: "не включается",
    receptionNote: null,
    diagnosis: null,
    assignedMaster: { fullName: "Сергей Панов" },
    dueAt: null,
    completedAt: null,
    issuedAt: null,
    totalWork: 0,
    totalParts: 0,
    discount: 0,
    total: 0,
    warrantyUntil: null,
  }),
  stockItem: one({
    sku: "SSD-240",
    name: "SSD 240 ГБ",
    category: "Накопители",
    unit: "шт",
    minQty: 2,
    balances: [{ qty: 5, avgCost: 1200, warehouse: { name: "Основной склад" } }],
  }),
  service: one({
    name: "Замена экрана",
    price: 1500,
    note: null,
    isPinned: true,
  }),
};

async function main(): Promise<void> {
  // 1. Длина строки выгрузки совпадает с описанием колонок — по каждой таблице.
  for (const key of DATASET_KEYS) {
    const def = DATASETS[key];
    if (def.exportOnly === undefined || def.exportOnly === false) {
      // выгружаются все, оговорка нужна только для загрузки
    }
    const [sheet] = await buildSheets(fakeTx as never, [key]);
    check(!!sheet, `«${def.title}»: выгрузка собирается`);
    if (!sheet) continue;

    check(
      sheet.columns.length === def.columns.length,
      `«${def.title}»: шапка из ${sheet.columns.length} колонок, описано ${def.columns.length}`
    );
    for (const row of sheet.rows) {
      check(
        row.length === def.columns.length,
        `«${def.title}»: в строке ${row.length} ячеек при ${def.columns.length} колонках`
      );
    }
  }

  // 2. Услуги — новая таблица, поэтому отдельно и придирчиво.
  const services = DATASETS.services;
  check(services.matchBy === "Название", "услуги сливаются по названию");
  const [svc] = await buildSheets(fakeTx as never, ["services"]);
  check(svc.rows[0][0] === "Замена экрана", "название услуги попадает в первую колонку");
  check(svc.rows[0][1] === 1500, "цена выгружается числом, а не строкой");
  check(svc.rows[0][3] === "да", "закреплённая услуга помечена словом, понятным в Excel");

  // 3. Чужие заголовки узнаются. Регистр, лишние пробелы и «ё» значения не имеют.
  const found = matchColumns(["  УСЛУГА ", "Стоимость", "Что входит"], services);
  const titles = [...found.values()].map((c) => c.title).join(", ");
  check(found.size === 3, `три чужих заголовка узнаны (${titles})`);
  check(
    [...found.values()].some((c) => c.title === "Цена, ₽"),
    "«Стоимость» узнана как «Цена, ₽»"
  );

  // 4. Вычисляемые колонки из файла не берутся: «Заказов» и «Заведён» в базу
  //    не пишутся, и молча принимать их — значит обещать несбыточное.
  const readOnly = matchColumns(["Заказов", "Заведён"], DATASETS.customers);
  check(readOnly.size === 0, "вычисляемые колонки при загрузке пропускаются");

  // 5. Ключи сличения.
  check(serviceKey("  Замена   ЭКРАНА ") === serviceKey("замена экрана"), "услуга узнаётся при другом написании");
  check(serviceKey("Замена экрана") !== serviceKey("Замена стекла"), "разные услуги не схлопываются");
  check(phoneKey("+7 (921) 555-00-11") === phoneKey("89215550011"), "телефон узнаётся в любом написании");

  console.log(fails === 0 ? "\nвсе проверки прошли" : `\nпровалов: ${fails}`);
  process.exitCode = fails === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error("сорвалось:", err);
  process.exitCode = 1;
});
