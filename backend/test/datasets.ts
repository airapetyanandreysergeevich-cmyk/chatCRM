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
import { parseDate } from "../src/modules/data/apply";
import { parseRows } from "../src/modules/data/import";
import type { TableRow } from "../src/modules/data/tableFile";

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
    number: 412,
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
    customer: { name: "Кузнецов И.", number: 412, phone: "+7 900 000-00-00" },
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

  // 6. Даты. Русский порядок «день-месяц-год» и время, которое раньше терялось:
  //    заказ, принятый вечером, вставал на полночь и уезжал на день назад в
  //    любом отчёте по дням.
  const evening = parseDate("10.03.2022 18:40");
  check(evening?.getDate() === 10 && evening?.getMonth() === 2, "«10.03.2022» — десятое марта, а не третье октября");
  check(evening?.getHours() === 18 && evening?.getMinutes() === 40, "время приёма сохраняется");
  check(parseDate("10-03-2022 14:30")?.getHours() === 14, "дата через дефис тоже читается — так пишут выгрузки");
  check(parseDate("2022-03-10T14:30:00")?.getHours() === 14, "ISO-дата не сломалась");
  check(parseDate("   ") === undefined && parseDate(undefined) === undefined, "пустая дата остаётся пустой");

  // 7. Номер клиента. Он появился затем, чтобы человека можно было опознать
  //    там, где телефон не годится: при переезде из другой программы половина
  //    номеров выдумана, а один и тот же дежурный стоит у сотен карточек.
  const [customers] = await buildSheets(fakeTx as never, ["customers"]);
  check(customers.columns[0].title === "Номер", "номер клиента — первая колонка выгрузки");
  check(customers.rows[0][0] === 412, "номер попадает в выгрузку числом");

  const [ordersSheet] = await buildSheets(fakeTx as never, ["orders"]);
  const cnum = ordersSheet.columns.findIndex((c) => c.title === "Номер клиента");
  check(cnum > 0 && ordersSheet.rows[0][cnum] === 412, "в заказе есть номер его клиента");

  // Пустая база: интересно, что скажет разбор, а не с чем он сольётся.
  const nothing = { findMany: async () => [] };
  const tx = { customer: nothing, order: nothing, stockItem: nothing, service: nothing } as never;
  const table = (rows: string[][]): TableRow[] => rows.map((cells, i) => ({ n: i + 1, cells }));

  const onlyNumber = await parseRows(tx, "customers", table([
    ["Номер", "Имя", "Телефон"],
    ["412", "Кузнецов Иван", ""],
  ]));
  check(onlyNumber.rows.length === 1, "клиент с номером, но без телефона — проходит");

  const onlyPhone = await parseRows(tx, "customers", table([
    ["Номер", "Имя", "Телефон"],
    ["", "Петрова Анна", "+7 900 111-22-33"],
  ]));
  check(onlyPhone.rows.length === 1, "клиент с телефоном, но без номера — проходит");

  const neither = await parseRows(tx, "customers", table([
    ["Номер", "Имя", "Телефон"],
    ["", "Никто", ""],
  ]));
  check(
    neither.rows.length === 0 && /хотя бы одна/.test(neither.preview.issues[0]?.message ?? ""),
    "клиент без номера и без телефона отклонён с внятной причиной"
  );

  const twins = await parseRows(tx, "customers", table([
    ["Номер", "Имя", "Телефон"],
    ["412", "Кузнецов", "+7 900 111-22-33"],
    ["412", "Он же", "+7 900 444-55-66"],
  ]));
  check(twins.rows.length === 1, "две строки с одним номером — берётся первая");

  const byNumber = await parseRows(tx, "customers", table([
    ["Номер", "Имя", "Телефон"],
    ["412", "Кузнецов", "+7 900 111-22-33"],
    ["413", "Он же по телефону", "+7 900 111-22-33"],
  ]));
  check(
    byNumber.rows.length === 2,
    "разные номера с одним телефоном — это два клиента, номер главнее"
  );

  // 8. Удалённая карточка не отдаёт свой номер.
  //
  //    Живая ошибка: в мастерской пробовали завести клиента и удалили его.
  //    Номер остался занятым — уникальный индекс про удаление не знает, — а
  //    сличение смотрело только на живые карточки. Загрузка шла заводить
  //    нового клиента с тем же номером и падала на первой же строке файла.
  const deletedCard = {
    findMany: async () => [
      { id: "c1", phone: "+7 900 111-22-33", number: 1, deletedAt: new Date() },
      { id: "c2", phone: "+7 900 444-55-66", number: 2, deletedAt: null },
    ],
  };
  const withDeleted = { customer: deletedCard, order: nothing, stockItem: nothing, service: nothing } as never;

  const resurrect = await parseRows(withDeleted, "customers", table([
    ["Номер", "Имя", "Телефон"],
    ["1", "Тот же человек", "+7 900 999-88-77"],
  ]));
  check(
    resurrect.rows[0]?.existingId === "c1",
    "удалённая карточка находится по номеру, а не заводится заново"
  );
  check(resurrect.rows[0]?.existingDeleted === true, "и помечена как подлежащая возврату к жизни");
  check(resurrect.preview.toUpdate === 1 && resurrect.preview.toCreate === 0, "в предпросмотре это обновление");

  const byPhoneDeleted = await parseRows(withDeleted, "customers", table([
    ["Номер", "Имя", "Телефон"],
    ["", "Однофамилец", "+7 900 111-22-33"],
  ]));
  check(
    byPhoneDeleted.rows[0]?.existingId === undefined,
    "по одному лишь телефону удалённый клиент не воскресает — это не повод"
  );

  // 9. Заказ опознаёт клиента номером, и имени для этого не нужно.
  //
  //    Живой случай: в чужой выгрузке имена лежат в отдельной таблице, а в
  //    заказах стоит только код клиента. Требование имени заворачивало такую
  //    выгрузку целиком — при том, что клиент по номеру находится точно.
  const orderTable = (row: string[][]) =>
    table([["Номер", "Номер клиента", "Телефон клиента", "Клиент", "Неисправность"], ...row]);

  const byNumberOnly = await parseRows(tx, "orders", orderTable([["0412", "1463", "", "", "не включается"]]));
  check(byNumberOnly.rows.length === 1, "заказ с одним лишь номером клиента проходит");

  const byPhoneOnly = await parseRows(tx, "orders", orderTable([["0413", "", "+7 900 111-22-33", "", "не включается"]]));
  check(byPhoneOnly.rows.length === 1, "заказ с одним лишь телефоном тоже проходит");

  const nameless = await parseRows(tx, "orders", orderTable([["0414", "", "", "Кузнецов", "не включается"]]));
  check(
    nameless.rows.length === 0 && /хотя бы одна/.test(nameless.preview.issues[0]?.message ?? ""),
    "одного имени мало: по нему клиента не найти и не завести"
  );

  check(
    !DATASETS.orders.columns.find((c) => c.title === "Клиент")?.required,
    "имя клиента в заказе не обязательно"
  );
  check(
    DATASETS.orders.columns.find((c) => c.title === "Неисправность")?.required === true,
    "а неисправность обязательна — заказ без неё не заказ"
  );

  console.log(fails === 0 ? "\nвсе проверки прошли" : `\nпровалов: ${fails}`);
  process.exitCode = fails === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error("сорвалось:", err);
  process.exitCode = 1;
});
