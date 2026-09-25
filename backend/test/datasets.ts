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

import { IncomingMessage, ServerResponse } from "node:http";
import { flagsOf, labelsText, toLabels, withFlags } from "../src/lib/dictionaries";
import { DATASETS, DATASET_KEYS, matchColumns } from "../src/modules/data/dataset";
import { buildSheets } from "../src/modules/data/export";
import { MAX_IMPORT_ROWS, phoneKey, roleKey, serviceKey, splitRoles, yesNo } from "../src/modules/data/import";
import { parseDate, parseLineItem, temporaryPassword } from "../src/modules/data/apply";
import { WIPEABLE_KEYS } from "../src/modules/data/dataset";
import { loginFor } from "../src/modules/staff/login";
import { parseRows } from "../src/modules/data/import";
import {
  contentDisposition,
  writeCsv,
  writeHtml,
  writeXlsx,
  type TableRow,
} from "../src/modules/data/tableFile";

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
  user: one({
    fullName: "Олег Иванов",
    email: "oleg@lenina",
    contactEmail: null,
    phone: "+7 900 111-22-33",
    roleId: "r1",
    extraRoleIds: ["r2"],
    isActive: false,
    workPercent: 40,
    partPercent: null,
    lastLoginAt: new Date(),
  }),
  role: {
    findMany: async () => [
      { id: "r1", name: "Мастер" },
      { id: "r2", name: "Приёмщик" },
    ],
  },
  customer: one({
    id: "c1",
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
    createdAt: new Date(),
  }),
  order: {
    ...one({
      number: "0412",
      acceptedAt: new Date(),
      status: { name: "Диагностика" },
      kind: "REPAIR",
      isUrgent: false,
      customer: { name: "Кузнецов И.", number: 412, phone: "+7 900 000-00-00" },
      device: { kind: "ноутбук", brand: "Lenovo", model: "IdeaPad 5", serial: "PF2XK9LM" },
      complaint: "не включается",
      // Новые заказы хранят перечисление списком строк, старые — чек-листом.
      // В заглушке оба вида сразу: выгрузка обязана прочитать и тот и другой.
      completeness: ["Блок питания", "Кабель"],
      appearance: [
        { key: "scratches", label: "Царапины", checked: true },
        { key: "chips", label: "Сколы", checked: false },
      ],
      // Старый заказ: признак стоит флагом, в списке его нет.
      hasOpenTraces: true,
      hasWaterDamage: false,
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
      works: [
        { name: "Замена матрицы", qty: 1, price: 3500 },
        { name: "Чистка; профилактика", qty: 2, price: 500 },
      ],
      parts: [{ name: "Матрица 15.6", qty: 1, price: 4200 }],
    }),
    // Число заказов на карточку считается одной группировкой, а не отдельным
    // счётчиком на каждого клиента: заглушка повторяет именно это.
    groupBy: async () => [{ customerId: "c1", _count: { _all: 3 } }],
  },
  stockItem: one({
    sku: "SSD-240",
    name: "SSD 240 ГБ",
    category: "Накопители",
    unit: "шт",
    minQty: 2,
    balances: [{ qty: 5, avgCost: 1200, warehouse: { name: "Основной склад" } }],
  }),
  transaction: one({
    createdAt: new Date(),
    direction: "IN",
    amount: 5500,
    comment: "Оплата при выдаче",
    cashRegister: { name: "Касса" },
    category: { name: "Оплата заказа" },
    order: { number: "0412" },
    customer: { name: "Кузнецов И." },
    user: null,
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

  // 2а. Сотрудники: без паролей, роли словами, отключённый помечен.
  const [st] = await buildSheets(fakeTx as never, ["staff"]);
  const col = (t: string) => DATASETS.staff.columns.findIndex((c) => c.title === t);
  check(st.rows[0][col("Логин")] === "oleg@lenina", "логин выгружается как есть");
  check(st.rows[0][col("Роли")] === "Мастер; Приёмщик", "роли — названиями, основная первой");
  check(st.rows[0][col("Отключён")] === "да", "отключённый сотрудник помечен «да»");
  check(st.rows[0][col("% с работ")] === 40 && st.rows[0][col("% с запчастей")] === "", "проценты — числом, пустой пуст");
  check(
    !DATASETS.staff.columns.some((c) => /парол/i.test(c.title)),
    "колонки с паролем нет ни в выгрузке, ни в загрузке"
  );
  check(!WIPEABLE_KEYS.includes("staff"), "сотрудников не стереть кнопкой «Удалить»");
  check(DATASET_KEYS[0] === "staff", "сотрудники в списке первыми — заказы ищут мастера по имени");
  check(matchColumns(["Последний вход"], DATASETS.staff).size === 0, "«Последний вход» обратно не загружается");

  check(yesNo("да") === true && yesNo("Нет") === false && yesNo("") === undefined, "да/нет/пусто");
  check(yesNo("может быть") === null, "непонятное — не «нет», а ошибка строки");
  check(splitRoles("Мастер; приёмщик, Мастер").join("|") === "Мастер|приёмщик", "роли через «;» и «,», без повторов");
  check(roleKey(" ПРИЁМЩИК ") === roleKey("приемщик"), "роль узнаётся без регистра и без «ё»");

  const l1 = loginFor("Nikita", "lenina");
  check(l1.ok && l1.login === "nikita@lenina", "у мастерской с именем «nikita» становится nikita@lenina");
  check(!loginFor("nikita@gorkogo", "lenina").ok, "чужое окончание не принимается");
  check(!loginFor("nikita", "").ok, "без имени мастерской нужен настоящий email");
  check(loginFor("Oleg@Mail.ru ", "").ok, "а настоящий email принимается");

  const pw = new Set(Array.from({ length: 200 }, () => temporaryPassword()));
  check(pw.size === 200, "временные пароли не повторяются");
  check([...pw].every((p) => p.length === 10 && /\d/.test(p) && !/[01lIoO]/.test(p)), "10 знаков, есть цифра, нет похожих букв");

  // 2б. Касса: только выгрузка, словами «Приход/Расход», суммы числом.
  const [cash] = await buildSheets(fakeTx as never, ["cash"]);
  const ccol = (t: string) => DATASETS.cash.columns.findIndex((c) => c.title === t);
  check(cash.rows[0][ccol("Движение")] === "Приход" && cash.rows[0][ccol("Сумма, ₽")] === 5500, "касса: приход и сумма числом");
  check(cash.rows[0][ccol("Заказ")] === "0412" && cash.rows[0][ccol("Кто провёл")] === "", "касса: номер заказа, пустой сотрудник — пусто");
  check(DATASETS.cash.exportOnly === true && WIPEABLE_KEYS.includes("cash"), "кассу можно выгрузить и стереть, но не загрузить");

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

  const cnt = customers.columns.findIndex((c) => c.title === "Заказов");
  check(customers.rows[0][cnt] === 3, "число заказов приходит из группировки, а не из счётчика на карточку");

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
  check(
    resurrect.preview.toRestore === 1 && resurrect.preview.toUpdate === 0 && resurrect.preview.toCreate === 0,
    "в предпросмотре это возврат карточки, а не обновление и не заведение новой"
  );

  const byPhoneDeleted = await parseRows(withDeleted, "customers", table([
    ["Номер", "Имя", "Телефон"],
    ["", "Однофамилец", "+7 900 111-22-33"],
  ]));
  check(
    byPhoneDeleted.rows[0]?.existingId === undefined,
    "по одному лишь телефону удалённый клиент не воскресает — это не повод"
  );

  // 8а. То же самое с заказами, и найдено ровно так же — на живой мастерской.
  //     Владелец выгрузил заказы, удалил их и загрузил файл обратно. Загрузка
  //     отчиталась «обновится 4», а в заказах осталось пусто: удалённые заказы
  //     она находила по номеру (иначе упёрлась бы в уникальный индекс), но
  //     оставляла удалёнными. Строка принята, и не видно её нигде.
  const deletedOrder = {
    findMany: async () => [{ id: "o1", number: "Р-2026-00001", deletedAt: new Date() }],
  };
  const withDeletedOrder = {
    customer: nothing,
    order: deletedOrder,
    stockItem: nothing,
    service: nothing,
  } as never;

  const backFromDead = await parseRows(withDeletedOrder, "orders", table([
    ["Номер", "Номер клиента", "Неисправность"],
    ["Р-2026-00001", "596", "не включается"],
  ]));
  check(backFromDead.rows[0]?.existingId === "o1", "удалённый заказ находится по номеру");
  check(backFromDead.rows[0]?.existingDeleted === true, "и помечен как подлежащий возврату — иначе загрузка отчитается и ничего не покажет");
  check(
    backFromDead.preview.toRestore === 1 && backFromDead.preview.toUpdate === 0,
    "в предпросмотре это возврат, а не обновление: «обновится 4» владелец прочитал как «заказы на месте»"
  );

  const plainUpdate = await parseRows(
    { ...(withDeletedOrder as object), order: { findMany: async () => [{ id: "o2", number: "Р-2026-00002", deletedAt: null }] } } as never,
    "orders",
    table([
      ["Номер", "Номер клиента", "Неисправность"],
      ["Р-2026-00002", "596", "не включается"],
    ])
  );
  check(
    plainUpdate.preview.toUpdate === 1 && plainUpdate.preview.toRestore === 0,
    "живой заказ по-прежнему считается обновлением"
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

  // 10. Предел строк называется интерфейсу тем же числом, каким работает
  //     загрузка. Второй экземпляр этого числа однажды разойдётся с первым, и
  //     программа будет обещать одно, а делать другое.
  const routes = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../src/modules/data/data.routes.ts", import.meta.url), "utf8")
  );
  check(
    /maxImportRows:\s*MAX_IMPORT_ROWS/.test(routes),
    "предел строк берётся из одного места, а не переписан числом"
  );
  check(MAX_IMPORT_ROWS >= 5000, `предел строк — ${MAX_IMPORT_ROWS}`);

  // 11. Шапка живой выгрузки из чужой программы. Колонка, которую мы не
  //     узнали, — это молча потерянные деньги заказа: файл загрузится, суммы
  //     будут нулевые, и заметят это через неделю.
  const чужая = matchColumns(
    ["Номер", "Клиент", "Телефон клиента", "Брэнд", "Модель", "Неисправность",
     "Работы", "Запчасти", "Скидка", "Итого", "Гарантия", "Мастер"],
    DATASETS.orders
  );
  const узнано = [...чужая.values()].map((c) => c.title);
  for (const нужна of ["Бренд", "Работы, ₽", "Запчасти, ₽", "Скидка, ₽", "Итого, ₽", "Гарантия до", "Мастер"]) {
    check(узнано.includes(нужна), `«${нужна}» узнаётся в чужой шапке`);
  }

  // 12. Съехавшая шапка. Живой случай: в выгрузке заголовки подписаны руками
  //     и с середины сдвинуты — под «Скидка» лежит фамилия мастера. Раньше эти
  //     колонки просто не узнавались, и файл грузился с нулевыми деньгами;
  //     теперь они узнаются, и надо, чтобы программа назвала причину словами,
  //     а не двести раз повторила симптом.
  const съехала = await parseRows(
    tx,
    "orders",
    table([
      ["Номер", "Номер клиента", "Неисправность", "Скидка"],
      ...Array.from({ length: 30 }, (_, i) => [`${100 + i}`, `${i + 1}`, "не включается", "МИША"]),
    ])
  );
  check(съехала.rows.length === 0, "строки с чужим значением в числовой колонке не грузятся");
  check(съехала.preview.issuesTotal === 30, `настоящее число замечаний, а не длина списка (${съехала.preview.issuesTotal})`);
  check(
    съехала.preview.hints.some((h) => h.includes("Скидка") && h.includes("сдвинуты")),
    `программа сама говорит про сдвинутые заголовки (${съехала.preview.hints[0] ?? "молчит"})`
  );

  // А пара мусорных ячеек на большой файл — это просто мусор, и пугать
  // человека рассказом про шапку из-за них не надо.
  const мусор = await parseRows(
    tx,
    "orders",
    table([
      ["Номер", "Номер клиента", "Неисправность", "Скидка"],
      ...Array.from({ length: 60 }, (_, i) => [`${200 + i}`, `${i + 1}`, "не включается", i < 2 ? "ой" : "100"]),
    ])
  );
  check(мусор.preview.hints.length === 0, "две плохие ячейки из шестидесяти — не повод обвинять шапку");

  // 13. Файл собирается до конца. Раньше проверялась только форма строки, а
  //     падало всё на записи: ячейка неожиданного типа роняет ExcelJS уже
  //     после того, как данные собраны, и человек видит «Внутреннюю ошибку»
  //     без единой подсказки, на каком разделе.
  const all = await buildSheets(fakeTx as never, DATASET_KEYS);
  const xlsx = await writeXlsx(all);
  check(xlsx.length > 0 && xlsx.subarray(0, 2).toString("latin1") === "PK", "книга Excel записывается");

  const csv = writeCsv(all[DATASET_KEYS.indexOf("customers")]);
  check(csv.subarray(0, 3).toString("hex") === "efbbbf", "csv начинается с метки порядка байтов — иначе Excel покажет кракозябры");
  check(csv.toString("utf8").split("\r\n")[0].split(";").length === DATASETS.customers.columns.length, "в шапке csv столько же колонок, сколько описано");

  const html = writeHtml(all, "проверка").toString("utf8");
  check(html.includes("Заказы") && html.includes("Услуги"), "в html попали все выбранные разделы");

  // 14. Имя файла в заголовке ответа. Русское имя, поставленное в заголовок
  //     как есть, роняло выгрузку целиком: Node не пропускает в значение
  //     заголовка ничего выше latin1. Проверяем не глазами, а тем же
  //     способом, каким это делает сам Node.
  const cd = contentDisposition("заказы-2026-09-18.xlsx", "orders-2026-09-18.xlsx");
  const res = new ServerResponse(new IncomingMessage(null as never));
  let accepted = true;
  try {
    res.setHeader("Content-Disposition", cd);
  } catch {
    accepted = false;
  }
  check(accepted, "заголовок с именем файла принимается Node, а не роняет ответ");
  check(cd.includes(`filename="orders-2026-09-18.xlsx"`), "в кавычках — латиница, её понимают все");
  check(
    cd.includes(`filename*=UTF-8''${encodeURIComponent("заказы-2026-09-18.xlsx")}`),
    "русское имя едет в filename* — именно его берёт нынешний браузер"
  );

  // 15а. Комплектность и внешнее состояние. Именно ими решается спор о
  //      забытой зарядке, и при переезде из другой программы их нельзя терять.
  const kcol = ordersSheet.columns.findIndex((c) => c.title === "Комплектность");
  const acol = ordersSheet.columns.findIndex((c) => c.title === "Внешнее состояние");
  check(ordersSheet.rows[0][kcol] === "Блок питания, Кабель", `комплектность выгружается строкой (${ordersSheet.rows[0][kcol]})`);
  check(
    ordersSheet.rows[0][acol] === "Царапины, Следы вскрытия",
    `старый чек-лист читается, неотмеченное не выгружается, флаг старого заказа попадает в список (${ordersSheet.rows[0][acol]})`
  );

  // Следы вскрытия и влаги — теперь кнопки в том же списке. Флаги заказа,
  // по которым решается гарантия, выводятся из списка, а у старых заказов
  // флаг возвращается в список — иначе квитанция потеряла бы то, чем
  // мастерская защищается от претензии.
  check(flagsOf(["Царапины", "следы вскрытия"]).hasOpenTraces, "«следы вскрытия» в списке ставят флаг, регистр не важен");
  check(!flagsOf(["Царапины"]).hasWaterDamage, "без пункта флага нет");
  check(
    withFlags(["Сколы"], { hasWaterDamage: true }).join(", ") === "Сколы, Следы влаги",
    "флаг старого заказа дописывается в список"
  );
  check(
    withFlags(["Следы влаги"], { hasWaterDamage: true }).length === 1,
    "и не задваивается, если пункт уже есть"
  );
  check(
    matchColumns(["Комплектация", "Техническое состояние"], DATASETS.orders).size === 2,
    "чужие написания обоих заголовков узнаются"
  );

  check(toLabels("Блок питания, Кабель").length === 2, "строка разбирается на пункты");
  check(toLabels("  Блок   питания ,, Кабель , ")[0] === "Блок питания", "лишние пробелы и пустые пункты убираются");
  check(toLabels("Кабель, кабель").length === 1, "повтор в другом регистре не задваивается");
  check(toLabels([{ label: "Царапины", checked: true }, { label: "Сколы", checked: false }]).join() === "Царапины", "старый чек-лист отдаёт только отмеченное");
  check(toLabels(["Блок питания", "Кабель, Сумка"]).length === 3, "список, где в одной строке два пункта, тоже разбирается");
  check(toLabels(null).length === 0 && toLabels(undefined).length === 0, "пустое остаётся пустым");
  check(toLabels("а".repeat(500))[0].length === 120, "слишком длинный пункт обрезается, а не роняет запись");
  check(toLabels(Array.from({ length: 80 }, (_, i) => "п" + i)).length === 40, "число пунктов ограничено");
  check(labelsText(["Кабель", "Сумка"]) === "Кабель, Сумка", "обратно строкой — через запятую с пробелом");

  // 15. Состав работ и запчастей. Одной суммой заказ не объяснить: «Работы,
  //     ₽ — 4500» не говорит ни клиенту, ни мастерской, что именно сделали.
  const wcol = ordersSheet.columns.findIndex((c) => c.title === "Состав работ");
  const pcol = ordersSheet.columns.findIndex((c) => c.title === "Состав запчастей");
  const wtext = String(ordersSheet.rows[0][wcol]);
  check(wcol > 0 && pcol > wcol, "состав стоит рядом со своей суммой, а не в конце таблицы");
  check(wtext.startsWith("Замена матрицы — 3500"), `работа выгружается с ценой (${wtext})`);
  check(!wtext.includes("×1"), "количество «один» не пишется — это шум в каждой строке");
  check(wtext.includes("×2"), "количество, отличное от единицы, пишется");
  check(
    !wtext.replace("Замена матрицы — 3500; ", "").includes(";"),
    "точка с запятой из названия убрана — иначе позиция разъедется надвое"
  );
  check(String(ordersSheet.rows[0][pcol]) === "Матрица 15.6 — 4200", "запчасти выгружаются тем же порядком");

  // Круговорот: то, что выгрузили, должно разбираться обратно в то же самое.
  const back = wtext.split(";").map((s) => parseLineItem(s)).filter(Boolean);
  check(back.length === 2, "обе позиции разбираются обратно");
  check(
    back[0]?.name === "Замена матрицы" && back[0]?.price === 3500 && back[0]?.qty === 1,
    "первая позиция вернулась целиком"
  );
  check(back[1]?.qty === 2 && back[1]?.price === 500, "количество и цена второй позиции вернулись");

  // Чужие написания и ловушки, на которых разбор мог бы тихо испортить данные.
  check(parseLineItem("Чистка 3-х кулеров — 800")?.name === "Чистка 3-х кулеров", "тире внутри названия не путается с ценой");
  check(parseLineItem("Чистка 3-х кулеров — 800")?.price === 800, "цена берётся за правым тире");
  check(parseLineItem("Ремонт Lenovo X1 — 1000")?.name === "Ремонт Lenovo X1", "латинская «x» в модели не съедается как количество");
  check(parseLineItem("Диагностика - 0")?.price === 0, "бесплатная работа — это тоже работа");
  check(parseLineItem("Пайка — 1 200,50")?.price === 1200.5, "цена с пробелом и запятой читается");
  check(parseLineItem("Замена кулера")?.price === 0, "позиция без цены не отбрасывается — название важнее");
  check(parseLineItem("SSD-240 — 2400")?.name === "SSD-240", "дефис внутри артикула не режет название");
  check(parseLineItem("SSD-240 — 2400")?.price === 2400, "и цена у такой позиции всё равно находится");
  check(parseLineItem(" — 3500") === null, "цена без названия — это опечатка, а не работа");
  check(parseLineItem("3500") === null, "одно только число — тоже не работа");
  check(parseLineItem("   ") === null, "пустая позиция пропускается");

  console.log(fails === 0 ? "\nвсе проверки прошли" : `\nпровалов: ${fails}`);
  process.exitCode = fails === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error("сорвалось:", err);
  process.exitCode = 1;
});
