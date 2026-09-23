"use strict";

/**
 * Ключ подключения, который владелец мастерской выдаёт сотруднику.
 *
 *   node test/staff-key.js
 *
 * Проверяем то, что ломается у живых людей: строку вставляют вместе с текстом
 * письма, копируют не целиком, а иногда вместо ключа присылают сам адрес.
 * Электрона здесь нет — разбор живёт в отдельном модуле как раз затем, чтобы
 * его можно было прогнать обычным узлом.
 */

const { parseStaffKey, addressFromKey, looksLikeKey } = require("../src/staffKey");

let bad = 0;
const ok = (name, cond) => {
  console.log((cond ? "ok     " : "ПЛОХО  ") + name);
  if (!cond) bad += 1;
};

/** Такую строку выдаёт сервер: backend/src/modules/relay/invite.ts */
const make = (data) => "FINECRM-S-" + Buffer.from(JSON.stringify(data), "utf8").toString("base64url");

const KEY = make({
  v: 1,
  a: "https://www.finecrm.ru/b/kn7tuw2m4p9xzq/",
  w: "Сервис на Ленина",
  l: "Иван, приёмщик",
});

const one = parseStaffKey(KEY);
ok("ключ разбирается", !!one);
ok("адрес мастерской на месте", one && one.address === "https://www.finecrm.ru/b/kn7tuw2m4p9xzq/");
ok("название мастерской читается по-русски", one && one.workshop === "Сервис на Ленина");
ok("видно, кому выдан ключ", one && one.label === "Иван, приёмщик");

ok(
  "ключ вынимается из письма с текстом вокруг",
  parseStaffKey(`Иван, привет!\nВот твой ключ: ${KEY}\nВставь его в программе.`)?.address === one.address
);

ok("хвостовой слэш снимается — иначе выйдет //api/health", addressFromKey(KEY) === "https://www.finecrm.ru/b/kn7tuw2m4p9xzq");

ok("вставленный адрес мастерской тоже принимается", parseStaffKey("https://www.finecrm.ru/b/kn7tuw2m4p9xzq/")?.address);
ok("адрес без хвостового слэша принимается", parseStaffKey("https://www.finecrm.ru/b/kn7tuw2m4p9xzq")?.address);

ok("адрес Основы в локальной сети ключом не считается", parseStaffKey("http://192.168.1.40:7373") === null);
ok("обычный текст ключом не считается", parseStaffKey("привет, как дела") === null);
ok("пустое поле — не ключ", parseStaffKey("   ") === null);

// Обрезанный ключ — самая частая беда: выделили мышкой не до конца.
const cut = KEY.slice(0, KEY.length - 12);
ok("обрезанный ключ отвергается, а не толкуется наугад", parseStaffKey(cut) === null);
ok("но видно, что человек пытался вставить именно ключ", looksLikeKey(cut));
ok("адрес Основы за ключ не принимают", !looksLikeKey("http://192.168.1.40:7373"));

// Чужая строка с нашей приставкой: подложить адрес, куда программа пойдёт
// сама, не должно получаться ничем, кроме настоящего http-адреса.
ok("без адреса внутри ключ недействителен", parseStaffKey(make({ v: 1, w: "Мастерская" })) === null);
ok("адрес не по http отвергается", parseStaffKey(make({ v: 1, a: "file:///C:/Windows" })) === null);

console.log(bad ? `\nПровалов: ${bad}` : "\nвсе проверки прошли");
process.exitCode = bad ? 1 : 0;
