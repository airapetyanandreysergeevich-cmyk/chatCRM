"use strict";

/**
 * Проверка утилиты переноса.
 *
 * Данные здесь выдуманные, но все грабли настоящие — каждая взята из живой
 * базы, на которой утилита писалась:
 *
 *  — шапка csv-выгрузки подписана руками и с середины съезжает, поэтому
 *    читать её нельзя вовсе;
 *  — «0» в колонке-галочке (строка, а не число) при простой проверке на
 *    непустоту помечает чёрным списком всю базу;
 *  — телефон «00000000000» означает «не дал номер», а не клиента;
 *  — один и тот же человек заведён дважды с одним номером;
 *  — пустое поле записано дефисом;
 *  — длинный комментарий не помещается в страницу sqlite и уезжает в
 *    страницы переполнения.
 *
 *   node test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const { date, phone, caps, toCsv, readCsv, CATALOG, build } = require("./perenos.js");
const { readTables } = require("./sqlite.js");

let fails = 0;
const check = (ok, msg) => {
  console.log((ok ? "ok    " : "БЕДА  ") + msg);
  if (!ok) fails += 1;
};

// ------------------------------------------------------------ мелочи

check(date("13-03-2023 13:05") === "13.03.2023 13:05", "дата и время читаются");
check(date("10-03-2022 00:00") === "10.03.2022", "полночь — это «время не заполняли», её не пишем");
check(date("-") === "" && date("") === "", "дефис вместо даты остаётся пустотой");

check(phone("89185550011") === "+79185550011", "восьмёрка становится семёркой");
check(phone("+7 (918) 555-00-11") === "+79185550011", "скобки и дефисы не мешают");
check(phone("00000000000") === "", "номер из нулей — не номер");
check(phone("11111111111") === "", "номер из единиц — тоже не номер");
check(phone("555") === "", "короткий номер отбрасывается");

check(caps("СТАЦЕНКО АРТЁМ ПАВЛОВИЧ") === "Стаценко Артём Павлович", "капс превращается в имя");
check(caps("-") === "", "дефис вместо имени — пусто");

const back = readCsv(toCsv([["а", 'с "кавычкой"'], ["б", "две\nстроки"]]).replace(/^﻿/, ""));
check(back[0][1] === 'с "кавычкой"' && back[1][1] === "две\nстроки", "кавычки и перенос строки переживают запись и чтение");

// ------------------------------------------- база-образец и выгрузка

/**
 * Рядом лежит proba.sqlite — маленькая база, собранная из тех же граблей.
 * Она в репозитории нарочно: собирать её на месте значило бы требовать
 * установленный sqlite3 и на машине разработчика, и в проверке перед
 * сборкой, а без неё проверять читалку было бы нечем, кроме неё самой.
 * Как она сделана — в README.
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perenos-"));
fs.copyFileSync(path.join(__dirname, "proba.sqlite"), path.join(dir, "baza.sqlite"));

const tables = readTables(path.join(dir, "baza.sqlite"));
check(tables.Catalog.rows.length === 7, "читалка sqlite видит все заказы");
check(tables.ClientsMap.rows.length === 4, "клиенты прочитаны");
check(tables.ClientsMap.rows[0].id === 1, "INTEGER PRIMARY KEY берётся из номера строки");
check(
  tables.Catalog.rows[0].kommentarij.length > 5000 &&
    tables.Catalog.rows[0].kommentarij.endsWith("комментарий. "),
  "длинный комментарий читается целиком, а не до конца страницы"
);

// Та же выгрузка в csv — со съехавшей шапкой, как в жизни. Строки берём из
// самой базы: так проверка не разойдётся с образцом при правке.
const lying = ["Номер", "Принят", "Выдан", "", "Клиент", "Телефон клиента", "", "Техника",
  "Бренд", "Модель", "Серийный номер", "", "", "Неисправность", "Примечание приёмщика",
  "", "", "Запчасти", "", "Итого", "", "Скидка", " ", "Статус", "Мастер", "", "Гарантия до"];
fs.writeFileSync(
  path.join(dir, "Catalog_old.csv"),
  toCsv([lying, ...tables.Catalog.rows.map((o) => CATALOG.map((c) => o[c]))])
);

const out = build(dir, () => {});
const read = (f) => readCsv(fs.readFileSync(path.join(out, f), "utf8").replace(/^﻿/, ""));

const kl = read("klienty.csv");
const za = read("zakazy.csv");

/**
 * Колонку ищем по названию, а не по номеру.
 *
 * Номера здесь уже менялись — когда у клиента появился номер, вся проверка
 * поехала вслед за ним. Проверка, которая ломается от добавления колонки,
 * рано или поздно будет «поправлена» подгонкой чисел, а не разбором.
 */
const col = (rows, title) => {
  const i = rows[0].indexOf(title);
  if (i < 0) throw new Error(`в файле нет колонки «${title}»`);
  return (row) => row[i];
};

const klNumber = col(kl, "Номер");
const klName = col(kl, "Имя");
const klPhone = col(kl, "Телефон");
const klPhone2 = col(kl, "Ещё телефон");
const klNote = col(kl, "Примечание");
const klTech = col(kl, "Техника");
const byName = (name) => kl.slice(1).find((r) => klName(r) === name);

check(kl[0].includes("Имя") && kl[0].includes("Телефон"), "шапка клиентов — наша");
check(kl.length - 1 === 3, `перенесено 3 клиента из 4 (вышло ${kl.length - 1})`);
check(!!byName("Иванов Иван"), "клиент с нормальным телефоном перенесён");
check(!byName("Иванов И."), "двойник по телефону склеен с первым");

const bezNomera = byName("Без Номера");
check(!!bezNomera, "клиент с телефоном-заглушкой всё равно перенесён — по номеру");
check(klPhone(bezNomera) === "", "но телефон-заглушка в базу не едет");
check(klNumber(bezNomera) === "3", "номер у него свой, из старой базы");

const ivan = byName("Иванов Иван");
check(klNumber(ivan) === "1", "номер клиента взят из старой базы");
check(klNote(ivan) === "", "чёрного списка нет там, где в базе «0»");
const anna = byName("Петрова Анна");
check(klNote(anna).includes("чёрном списке"), "чёрный список есть там, где «1»");
check(klPhone2(anna) === "+79185550033", "второй телефон через запятую попадает в «Ещё телефон»");
check(klTech(ivan).includes("ноутбук ASUS X550 (SN1)"), "техника собрана из заказов клиента");

const zaNumber = col(za, "Номер");
const zaStatus = col(za, "Статус");
const zaClient = col(za, "Клиент");
const zaClientNo = col(za, "Номер клиента");
const zaWork = col(za, "Работы, ₽");
const zaParts = col(za, "Запчасти, ₽");
const zaTotal = col(za, "Итого, ₽");
const zaWarranty = col(za, "Гарантия до");
const zaNote = col(za, "Примечание приёмщика");
const zaMaster = col(za, "Мастер");
const order = (n) => za.slice(1).find((r) => zaNumber(r) === n);

check(za[0].includes("Итого, ₽") && za[0].includes("Номер клиента"), "шапка заказов — наша");
const o100 = order("100");
check(!!o100, "заказ перенесён");
check(zaStatus(o100) === "Выдан", "статус переведён на наш");
check(zaWork(o100) === "1800" && zaParts(o100) === "1200" && zaTotal(o100) === "3000", "работы = итог − запчасти");
check(zaWarranty(o100) === "11.04.2022", "гарантия 30 дней считается от выдачи");
check(zaNote(o100).includes("Внешний вид: Царапины") && zaNote(o100).includes("Комплектность"), "приёмка собрана в примечание");
check(zaMaster(o100) === "Миша", "мастер перестал кричать капсом");
check(!order("105"), "удалённый в старой программе не переносится");
check(zaStatus(order("106")) === "", "неведомый статус оставлен пустым, а не выдуман");

const o102 = order("102");
check(!!o102 && zaClientNo(o102) === "3", "заказ клиента без телефона перенесён — держится за номер");

const o104 = order("104");
check(!!o104, "заказ пропавшего клиента тоже перенесён");
check(zaClientNo(o104) === "9", "у него остался номер из старой базы");
check(zaClient(o104).includes("№9"), "а имя честно говорит, что клиент неизвестен");
check(za.slice(1).some((r) => zaNumber(r) === "103"), "заказ двойника перенесён на склеенную карточку");

fs.rmSync(dir, { recursive: true, force: true });

console.log(fails === 0 ? "\nвсе проверки прошли" : `\nпровалов: ${fails}`);
process.exitCode = fails === 0 ? 0 : 1;
