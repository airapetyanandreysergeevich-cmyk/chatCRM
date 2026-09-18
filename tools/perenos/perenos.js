#!/usr/bin/env node
"use strict";

/**
 * Перенос мастерской из старой программы в FineCRM.
 *
 * Утилита ничего не пишет в нашу базу. Она читает всё, что нашла в своей
 * папке, и раскладывает по трём файлам, которые понимает раздел
 * «Настройки → Базы»: клиенты, заказы, склад. Дальше данные заходят обычным
 * путём — с предпросмотром, построчными ошибками и слиянием по телефону и
 * номеру заказа.
 *
 * Так сделано намеренно. Писать напрямую в базу означало бы обойти изоляцию
 * мастерских, нумерацию заказов и журнал — то есть ровно те места, где
 * ошибка переноса заметна не сразу и стоит дороже всего.
 *
 * Источники кладутся рядом с утилитой:
 *   — файл базы старой программы (.sqlite или .db) — из него берутся клиенты,
 *     склад и заказы;
 *   — выгрузки таблицы заказов в .csv — из них берутся заказы.
 *
 * Снимков можно положить сколько угодно, в том числе за разные годы. Утилита
 * сольёт их по номеру заказа: при расхождении побеждает более свежий снимок,
 * а свежесть определяется по самой поздней дате приёма в файле. Это и есть
 * ответ на обычную ситуацию «есть архивная выгрузка и есть рабочая база».
 *
 *   node perenos.js [папка-с-источниками]
 */

const fs = require("fs");
const path = require("path");
const { readTables } = require("./sqlite.js");

// --------------------------------------------------------------- инструменты

const trim = (v) => String(v ?? "").trim();

/** В старой программе пустое поле — это дефис. Их тут тысячи. */
const clean = (v) => {
  const s = trim(v);
  return s === "-" || s === "—" ? "" : s;
};

const num = (v) => {
  const n = Number(clean(v).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
};

/** «13-03-2023 13:05» → «13.03.2023 13:05». Минуты иногда через дефис. */
function date(v) {
  const m = clean(v).match(/^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})(?:[ T]+(\d{1,2})[:.\-](\d{2}))?/);
  if (!m) return "";
  const [, d, mo, y, h, mi] = m;
  const day = `${d.padStart(2, "0")}.${mo.padStart(2, "0")}.${y}`;
  // Полночь у выданных заказов в старой базе означает «время не заполняли»,
  // а не «выдали в полночь». Писать его смысла нет.
  return h && !(h === "00" && mi === "00") ? `${day} ${h.padStart(2, "0")}:${mi}` : day;
}

/** Для сравнения снимков между собой. */
function stamp(v) {
  const m = clean(v).match(/^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})/);
  return m ? `${m[3]}${m[2].padStart(2, "0")}${m[1].padStart(2, "0")}` : "";
}

/**
 * «+7 (918) 555-00-11» и «89185550011» — один и тот же номер.
 *
 * Номер из одной повторённой цифры — это не номер, а заглушка: так в старой
 * программе записывали «клиент телефон не дал». Заводить на неё карточку
 * значит слепить в одного человека всех, кто когда-либо отказался назвать
 * номер, — и потом искать среди них настоящего.
 */
function phone(v) {
  const digits = clean(v).replace(/\D/g, "");
  if (digits.length < 10 || /^(\d)\1+$/.test(digits)) return "";
  if (digits.length === 11 && (digits[0] === "7" || digits[0] === "8")) return "+7" + digits.slice(1);
  if (digits.length === 10) return "+7" + digits;
  return "+" + digits;
}

/** «СТАЦЕНКО АРТЁМ» → «Стаценко Артём»: в старой программе всё капсом. */
const caps = (v) =>
  clean(v)
    .toLowerCase()
    .replace(/(^|[\s(«"'-])([а-яёa-z])/g, (_, a, b) => a + b.toUpperCase());

/**
 * Галочка старой программы: «0» или «1», иногда пусто.
 *
 * Отдельная функция, потому что строка «0» в JavaScript истинна, и простая
 * проверка на непустоту помечает чёрным списком всю базу — ровно это здесь
 * сперва и вышло: 715 клиентов из 729.
 */
const flag = (v) => {
  const s = clean(v).toLowerCase();
  return s !== "" && s !== "0" && s !== "false" && s !== "нет";
};

/** Тип техники пишем словом, как в карточке заказа. */
const kindOf = (v) => clean(v).toLowerCase();

/** Название позиции склада: капс выключаем, но слова не трогаем. */
const sentence = (v) => {
  const s = clean(v).replace(/\s+/g, " ").toLowerCase();
  return s ? s[0].toUpperCase() + s.slice(1) : "";
};

/** Марку и модель оставляем как есть: «ASUS» и «MAR-LX1H» — это не имена. */
const asIs = (v) => clean(v).replace(/\s+/g, " ");

// -------------------------------------------------------------------- csv

/** Своя запись csv: кавычки, удвоение кавычек, перевод строки внутри поля. */
function toCsv(rows) {
  const cell = (v) => {
    const s = String(v ?? "");
    return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  // Точка с запятой и метка порядка байтов — чтобы файл открылся в русском
  // Excel двойным щелчком, а не «мастером импорта текста».
  return "﻿" + rows.map((r) => r.map(cell).join(";")).join("\r\n") + "\r\n";
}

/**
 * Разделитель угадываем по первой строке — один на файл, а не «любой из трёх».
 *
 * Соблазн считать разделителем и запятую, и точку с запятой сразу велик и
 * ошибочен: в наших же заголовках есть «Итого, ₽» и «Скидка, %», и такой
 * разбор режет их пополам, сдвигая все колонки правее. Ошибка тихая — файл
 * читается, просто не тот.
 */
function guessDelimiter(text) {
  const line = text.split(/\r?\n/, 1)[0] ?? "";
  const count = (ch) => (line.match(new RegExp("\\" + ch, "g")) ?? []).length;
  const tabs = (line.match(/\t/g) ?? []).length;
  const semi = count(";");
  const comma = count(",");
  if (tabs > semi && tabs > comma) return "\t";
  return semi >= comma ? ";" : ",";
}

function readCsv(text, delimiter = guessDelimiter(text)) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// ------------------------------------------------------- таблица заказов

/**
 * Колонки таблицы заказов старой программы — по порядку.
 *
 * Читаем выгрузку именно по порядку, а не по заголовкам, и это не лень.
 * В присланной выгрузке шапка подписана руками и с середины съезжает: под
 * словом «Итого» лежит скидка, под «Скидка» — фамилия мастера, под «Статус» —
 * «30 дней». Excel о таком не предупреждает, и файл, загруженный по
 * заголовкам, выглядит правдоподобно и весь неверен. Порядок же у выгрузки
 * тот же, что у таблицы в базе, — его и держимся.
 */
const CATALOG = [
  "id", "Data_priema", "Data_vidachi", "Data_predoplaty", "surname", "phone", "AboutUs",
  "WhatRemont", "brand", "model", "SerialNumber", "sostoyanie", "komplektonst", "polomka",
  "kommentarij", "predvaritelnaya_stoimost", "Predoplata", "Zatrati",
  "okonchatelnaya_stoimost_remonta", "Skidka", "Status_remonta", "master", "vipolnenie_raboti",
  "Garanty", "wait_zakaz", "Adress", "Image_key", "AdressSC", "DeviceColour", "ClientId",
  "Barcode", "Deleted",
];

/** Похожа ли строка на заказ: номер числом и дата приёма на своём месте. */
const looksLikeOrder = (r) =>
  r.length >= 20 && /^\d+$/.test(trim(r[0])) && /^\d{1,2}[.\-/]\d{1,2}[.\-/]\d{4}/.test(trim(r[1]));

const STATUS = {
  "выдан": "Выдан",
  "готов": "Готов",
  "принят в работу": "В работе",
  "диагностика": "Диагностика",
  "согласовано": "В работе",
  "согласование с клиентом": "Ожидает согласования",
  "ждёт запчасть": "Ожидание запчасти",
  "ждет запчасть": "Ожидание запчасти",
  "принят по гарантии": "Новый",
};

// ------------------------------------------------------------------ сбор

function collect(dir, log) {
  const orders = new Map(); // номер → { поля, свежесть источника }
  const clients = new Map(); // id клиента → запись
  const stock = [];

  const files = fs.readdirSync(dir).filter((f) => /\.(sqlite|sqlite3|db|csv)$/i.test(f));
  if (files.length === 0) throw new Error(`в папке ${dir} нет ни .sqlite, ни .csv`);

  const sources = [];

  for (const name of files) {
    const full = path.join(dir, name);
    if (/\.csv$/i.test(name)) {
      const text = fs.readFileSync(full, "utf8").replace(/^﻿/, "");
      const rows = readCsv(text).filter(looksLikeOrder);
      if (rows.length === 0) {
        log(`  ${name}: заказов не нашёл, пропускаю`);
        continue;
      }
      const list = rows.map((r) => Object.fromEntries(CATALOG.map((c, i) => [c, trim(r[i])])));
      sources.push({ name, orders: list, clients: [], stock: [] });
      log(`  ${name}: заказов ${list.length}`);
    } else {
      const tables = readTables(full);
      const list = (tables.Catalog?.rows ?? []).map((r) =>
        Object.fromEntries(CATALOG.map((c) => [c, trim(r[c])]))
      );
      sources.push({
        name,
        orders: list,
        clients: tables.ClientsMap?.rows ?? [],
        stock: tables.Stock?.rows ?? [],
      });
      log(
        `  ${name}: заказов ${list.length}, клиентов ${tables.ClientsMap?.rows.length ?? 0}` +
          `, позиций склада ${tables.Stock?.rows.length ?? 0}`
      );
    }
  }

  // Свежесть снимка — по самой поздней дате приёма в нём. Ровно та мера, по
  // которой человек и говорит «а вот эта выгрузка новее».
  for (const s of sources) {
    s.age = s.orders.reduce((max, o) => {
      const t = stamp(o.Data_priema);
      return t > max ? t : max;
    }, "");
  }
  sources.sort((a, b) => (a.age < b.age ? -1 : 1));

  for (const s of sources) {
    for (const o of s.orders) {
      const key = trim(o.id);
      if (!key) continue;
      // Снимок свежее — он и прав: заказ за это время мог уехать из «Готов»
      // в «Выдан», обрасти комментарием и суммой.
      const before = orders.get(key);
      orders.set(key, before ? { ...before, ...pickFilled(o, before) } : o);
    }
    for (const c of s.clients) clients.set(trim(c.id), c);
    for (const item of s.stock) stock.push(item);
  }

  return { orders, clients, stock, sources };
}

/** Новое значение побеждает, но пустым старое не затирается. */
function pickFilled(fresh, old) {
  const out = {};
  for (const k of Object.keys(fresh)) out[k] = clean(fresh[k]) === "" ? old[k] : fresh[k];
  return out;
}

// --------------------------------------------------------------- выгрузка

function build(dir, log) {
  const { orders, clients, stock, sources } = collect(dir, log);

  const report = [];
  const say = (s) => {
    log(s);
    report.push(s);
  };

  say("");
  say(`Собрано: заказов ${orders.size}, клиентов ${clients.size}, позиций склада ${stock.length}`);

  // ------------------------------------------------------------- клиенты
  // Техника клиента собирается из его же заказов: отдельной таблицы техники
  // в старой программе нет, а в карточке клиента она нужна.
  const devicesOf = new Map();
  for (const o of orders.values()) {
    const id = trim(o.ClientId);
    if (!id) continue;
    const parts = [kindOf(o.WhatRemont), asIs(o.brand), asIs(o.model)].filter(Boolean).join(" ");
    if (!parts) continue;
    const serial = asIs(o.SerialNumber);
    const line = serial ? `${parts} (${serial})` : parts;
    const list = devicesOf.get(id) ?? [];
    if (!list.includes(line)) list.push(line);
    devicesOf.set(id, list);
  }

  const clientRows = [[
    "Номер", "Тип", "Имя", "Телефон", "Ещё телефон", "Email", "Адрес", "ИНН", "Источник",
    "Скидка, %", "Примечание", "Техника",
  ]];
  const phoneById = new Map();
  const nameById = new Map();
  const seenPhone = new Map();
  let badPhone = 0;
  let merged = 0;

  for (const [id, c] of clients) {
    const [first, second] = clean(c.Phone).split(/[,;/]/);
    const main = phone(first);
    const name = caps(c.FIO) || "Без имени";
    nameById.set(id, name);
    if (main) phoneById.set(id, main);
    else badPhone += 1;

    const devices = (devicesOf.get(id) ?? []).slice();

    // Один номер — одна карточка. В старой базе один и тот же человек заведён
    // по нескольку раз, и загрузчик всё равно сольёт их по телефону; лучше мы
    // сделаем это сами — с техникой из обеих карточек, — чем он молча возьмёт
    // первую и потеряет остальное.
    const twin = main ? seenPhone.get(main) : undefined;
    if (twin !== undefined) {
      merged += 1;
      const cell = clientRows[twin][11];
      const have = cell ? cell.split("; ") : [];
      for (const d of devices) if (!have.includes(d)) have.push(d);
      clientRows[twin][11] = have.slice(0, 20).join("; ");
      continue;
    }
    if (main) seenPhone.set(main, clientRows.length);

    const notes = [clean(c.Primechanie)];
    if (flag(c.Blist)) notes.push("был в чёрном списке старой программы");
    clientRows.push([
      id,
      "Физлицо",
      name,
      main,
      phone(second),
      "",
      clean(c.Adress),
      "",
      clean(c.aboutUs),
      "",
      notes.filter(Boolean).join("; "),
      // Двадцати наименований техники на карточку хватает с запасом, а
      // загрузчик всё равно больше не возьмёт.
      devices.slice(0, 20).join("; "),
    ]);
  }
  say(`Клиентов к переносу: ${clientRows.length - 1}`);
  if (badPhone) say(`   из них без годного телефона (переносятся по номеру): ${badPhone}`);
  if (merged) say(`   склеено по одинаковому телефону: ${merged}`);

  // -------------------------------------------------------------- заказы
  const orderRows = [[
    "Номер", "Принят", "Статус", "Тип обращения", "Срочный", "Клиент", "Номер клиента", "Телефон клиента",
    "Техника", "Бренд", "Модель", "Серийный номер", "Неисправность", "Примечание приёмщика",
    "Диагноз", "Мастер", "Срок готовности", "Завершён", "Выдан",
    "Работы, ₽", "Запчасти, ₽", "Скидка, ₽", "Итого, ₽", "Гарантия до",
  ]];
  const skipped = [["Номер", "Принят", "Техника", "Причина"]];
  const unknownStatus = new Map();
  const unknownClients = new Set();
  let deleted = 0;

  const sorted = [...orders.values()].sort((a, b) => (stamp(a.Data_priema) < stamp(b.Data_priema) ? -1 : 1));

  for (const o of sorted) {
    if (flag(o.Deleted)) {
      deleted += 1;
      continue;
    }

    const cid = trim(o.ClientId);
    // Заказ держится за клиента номером, а не телефоном. Раньше заказ без
    // годного телефона переносить было не на что — теперь он встаёт на
    // карточку с номером, и когда найдётся файл с этим клиентом, повторная
    // загрузка допишет ей имя и телефон, а не заведёт вторую.
    if (!cid) {
      skipped.push([
        trim(o.id),
        date(o.Data_priema),
        [kindOf(o.WhatRemont), asIs(o.brand), asIs(o.model)].filter(Boolean).join(" "),
        "в заказе не указан клиент",
      ]);
      continue;
    }
    const tel = phoneById.get(cid) ?? "";
    const known = nameById.has(cid);
    if (!known) unknownClients.add(cid);

    const raw = clean(o.Status_remonta).toLowerCase();
    const status = STATUS[raw] ?? "";
    if (raw && !status) unknownStatus.set(raw, (unknownStatus.get(raw) ?? 0) + 1);

    const total = num(o.okonchatelnaya_stoimost_remonta);
    const parts = num(o.Zatrati);
    // Затраты в старой программе — это то, что мастерская потратила на
    // запчасти. Работа отдельной строкой нигде не считалась, поэтому берём
    // остаток от итога. Отрицательной работы не бывает: если запчасти вышли
    // дороже итога, значит заказ отдали в минус, и работа тут ноль.
    const work = Math.max(0, total - parts);

    const issued = status === "Выдан" ? date(o.Data_vidachi) : "";
    const vnesh = clean(o.sostoyanie);
    const komplekt = clean(o.komplektonst);
    const colour = clean(o.DeviceColour);

    orderRows.push([
      trim(o.id),
      date(o.Data_priema),
      status,
      raw === "принят по гарантии" ? "Гарантийный возврат" : "Ремонт",
      "",
      // Имени нет — пишем номер словами, а не «Без имени»: так карточку
      // видно в списке и понятно, что с ней делать, когда найдётся база.
      nameById.get(cid) ?? `Клиент №${cid} (из старой базы)`,
      cid,
      tel,
      kindOf(o.WhatRemont),
      asIs(o.brand),
      asIs(o.model),
      asIs(o.SerialNumber),
      clean(o.polomka) || "не указана",
      [
        vnesh && `Внешний вид: ${vnesh}`,
        komplekt && `Комплектность: ${komplekt}`,
        colour && `Цвет: ${colour}`,
        clean(o.kommentarij),
      ]
        .filter(Boolean)
        .join("\n"),
      clean(o.vipolnenie_raboti),
      caps(o.master),
      "",
      "",
      issued,
      work,
      parts,
      num(o.Skidka),
      total,
      // «30 дней» считаем от выдачи: другой точки отсчёта в старой базе нет.
      clean(o.Garanty).toLowerCase().startsWith("30") && issued ? plusDays(issued, 30) : "",
    ]);
  }

  say(`Заказов к переносу: ${orderRows.length - 1}`);

  // Один телефон на сотни заказов — это не клиент, а дежурный номер, который
  // ставили, когда человек своего не назвал. Перенести мы его перенесём, но
  // сказать об этом обязаны: иначе в новой базе появится «клиент» с шестью
  // сотнями ремонтов, и поймут это не сразу.
  const perPhone = new Map();
  for (const r of orderRows.slice(1)) if (r[7]) perPhone.set(r[7], (perPhone.get(r[7]) ?? 0) + 1);
  const heavy = [...perPhone].filter(([, n]) => n > 20).sort((a, b) => b[1] - a[1]);
  if (heavy.length) {
    say("Похоже на дежурные номера, а не на клиентов — проверьте после загрузки:");
    for (const [tel, n] of heavy.slice(0, 5)) say(`   ${tel} — заказов ${n}`);
  }
  if (deleted) say(`Помечено удалёнными в старой программе, не переносим: ${deleted}`);
  if (skipped.length > 1) say(`Не переносится: ${skipped.length - 1} — см. ne-pereneseno.csv`);
  if (unknownClients.size) {
    say(`Клиентов, которых нет в присланных файлах: ${unknownClients.size}.`);
    say("   Их заказы переносятся на карточки с номером и без имени. Найдёте");
    say("   рабочую базу — положите её сюда и запустите снова: карточки допишутся.");
  }
  if (unknownStatus.size) {
    say("Статусы, которых нет в FineCRM (заказ встанет на начальный):");
    for (const [s, n] of unknownStatus) say(`   «${s}» — ${n}`);
  }

  // --------------------------------------------------------------- склад
  const stockRows = [[
    "Артикул", "Наименование", "Категория", "Единица", "Остаток",
    "Себестоимость, ₽", "Минимальный остаток", "Склад",
  ]];
  for (const s of stock) {
    const name = sentence(s.Naimenovanie);
    if (!name) continue;
    stockRows.push([
      "",
      name,
      sentence(s.Kategoriya),
      "шт",
      num(s.CountOf),
      num(s.Price),
      "",
      "Основной склад",
    ]);
  }
  say(`Позиций склада к переносу: ${stockRows.length - 1}`);

  // ------------------------------------------------------------- запись
  const out = path.join(dir, "dlya-zagruzki");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "klienty.csv"), toCsv(clientRows));
  fs.writeFileSync(path.join(out, "zakazy.csv"), toCsv(orderRows));
  fs.writeFileSync(path.join(out, "sklad.csv"), toCsv(stockRows));
  if (skipped.length > 1) fs.writeFileSync(path.join(out, "ne-pereneseno.csv"), toCsv(skipped));

  say("");
  say("Готово. Файлы в папке dlya-zagruzki:");
  say("   klienty.csv → Настройки → Базы → Клиенты и их техника");
  say("   zakazy.csv  → Настройки → Базы → Заказы");
  say("   sklad.csv   → Настройки → Базы → Склад");
  say("");
  say("Загружать в этом порядке: клиенты, потом заказы. Наоборот тоже");
  say("сработает, но тогда карточки клиентов заведутся по телефону из заказа,");
  say("без адреса и примечаний.");

  fs.writeFileSync(path.join(out, "otchet.txt"), report.join("\r\n") + "\r\n");
  return out;
}

function plusDays(ru, days) {
  const m = ru.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  if (!m) return "";
  const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]) + days);
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;
}

// ------------------------------------------------------------------ запуск

if (require.main === module) {
  const dir = path.resolve(process.argv[2] ?? __dirname);
  console.log(`Смотрю, что лежит в ${dir}`);
  try {
    build(dir, (s) => console.log(s));
  } catch (err) {
    console.error("\nНе получилось: " + err.message);
    process.exitCode = 1;
  }
}

module.exports = { build, collect, date, phone, caps, num, toCsv, readCsv, guessDelimiter, CATALOG, STATUS };
