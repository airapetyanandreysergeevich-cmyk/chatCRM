/**
 * Перенос из старой программы: чтение SQLite и раскладка по нашим таблицам.
 *
 *   npx tsx test/migrate.ts
 *
 * Гоняется на `tools/perenos/proba.sqlite` — маленькой базе, собранной из
 * настоящих граблей (съехавшие поля, «0» в галочке, телефон-заглушка,
 * двойник по телефону, дефис вместо пустого, комментарий в страницах
 * переполнения). Настоящие базы мастерских в репозиторий не кладём: там
 * живые люди с телефонами.
 */
import fs from "node:fs";
import path from "node:path";
import { detectSource } from "../src/modules/migrate/sources";
import { caps, cleanComment, latin, phones, warrantyDays } from "../src/modules/migrate/sources/catalog";
import { BadFile, readTables } from "../src/modules/migrate/sqlite";

let fails = 0;
const check = (ok: boolean, msg: string, extra?: unknown) => {
  console.log((ok ? "ok    " : "БЕДА  ") + msg + (ok || extra === undefined ? "" : `  → ${JSON.stringify(extra)}`));
  if (!ok) fails += 1;
};

// ---- помощники
check(phones("89005481830;89115326624").join(" ") === "+79005481830 +79115326624", "два телефона через «;»");
check(phones("8921050877289211230321").length === 2, "два телефона слитно — разрезаны", phones("8921050877289211230321"));
check(phones("00000000000").length === 0, "заглушка из нулей — не телефон");
check(phones("+7 (918) 555-00-11")[0] === "+79185550011", "телефон в скобках и с дефисами");
check(caps("ДЬЯКОНОВА НАДЕЖДА") === "Дьяконова Надежда", "имя из капса");
check(warrantyDays("30 дней") === 30 && warrantyDays("3 месяца") === 90 && warrantyDays("Без гарантии") === 0, "гарантия в днях и месяцах");
check(warrantyDays("1 год") === 365 && warrantyDays("") === 0, "гарантия в годах, пусто — ноль");
check(latin("Павел") === "pavel" && latin("Карлоссс") === "karlosss", "логин из имени латиницей");

let c = cleanComment("________\nПароль: \n23348\n‾‾‾‾‾‾‾‾\nзамена шлейфа");
check(c.passcode === "23348" && c.text === "замена шлейфа", "пароль из рамки — в своё поле, из текста убран", c);
c = cleanComment("Пароль:\n115577\nобещает забрать");
check(c.passcode === "115577" && c.text === "обещает забрать", "пароль без рамки", c);
c = cleanComment("Пароль:\n-\nтекст");
check(c.passcode === "" && c.text === "текст", "«-» вместо пароля — пароля нет", c);
c = cleanComment("мост\r\n+=====+\r\n20-02-2018 23:07\r\n Установлена галочка\r\n______\r\n");
check(c.text === "мост", "журнал галочек старой программы выброшен", c);

// ---- чтение файла
let bad = "";
try {
  readTables(Buffer.from("это не база"));
} catch (err) {
  bad = err instanceof BadFile ? err.message : "не та ошибка";
}
check(/не файл базы/.test(bad), "не SQLite — понятная ошибка", bad);

const file = path.join(__dirname, "..", "..", "tools", "perenos", "proba.sqlite");
const buf = fs.readFileSync(file);
let broken = "";
try {
  readTables(buf.subarray(0, buf.length - 4096));
} catch (err) {
  broken = err instanceof BadFile ? err.message : String(err);
}
check(/обрывается|нет страницы/.test(broken), "обрезанный файл — понятная ошибка, а не падение", broken);

const tables = readTables(buf);
const source = detectSource(tables);
check(source?.id === "catalog-clientsmap", "программа узнана по таблицам");
check(detectSource({}) === null, "пустой набор таблиц — не узнан");

const conv = source!.convert(tables);
const rows = (t: typeof conv.orders) => {
  const head = t[0].cells.map(String);
  return t.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r.cells[i]])));
};
const orders = rows(conv.orders);
const customers = rows(conv.customers);

check(customers.length === 3, "клиенты: двойник по телефону склеен", customers.length);
check(orders.length === 6, "удалённый заказ не переносится", orders.map((o) => o["Номер"]));
const o100 = orders.find((o) => o["Номер"] === "100")!;
check(
  o100["Итого, ₽"] === 3000 && o100["Запчасти, ₽"] === 1200 && o100["Скидка, ₽"] === 100 && o100["Работы, ₽"] === 1900,
  "деньги: итог со скидкой, работа = итог + скидка − запчасти",
  o100
);
check(o100["Гарантия до"] === "11.04.2022", "гарантия 30 дней от выдачи", o100["Гарантия до"]);
check(o100["Комплектность"] === "Аппарат", "комплектность — своим полем", o100["Комплектность"]);
check(String(o100["Диагноз"]).length <= 4000, "длинный комментарий из страниц переполнения прочитан и ограничен");
check(conv.staff.length === 1 && conv.staff[0].name === "Миша", "мастер — один человек, по имени", conv.staff);
check(conv.lastNumber === 106, "последний номер заказа найден", conv.lastNumber);
check(conv.colors.size === 1, "чёрный список — красная метка");
const paid = conv.payments.filter((p) => p.number === "100").reduce((n, p) => n + p.amount, 0);
check(paid === 3000, "выданный заказ оплачен целиком", paid);
check(conv.notes.some((n) => /неведомый статус/.test(n)), "незнакомый статус назван в замечаниях", conv.notes);

console.log(fails ? `\nНЕ ПРОШЛО: ${fails}` : "\nвсе проверки прошли");
process.exit(fails ? 1 : 0);
