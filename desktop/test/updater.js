"use strict";

/**
 * Проверка обновления программы — без Electron и без сети.
 *
 * Главное здесь не «скачалось ли», а порядок и согласие: ничего не качается
 * и не ставится без спроса, копия базы и остановка сервера — строго до
 * установщика, а при сбое подготовки установщик не запускается вовсе.
 *
 *   node test/updater.js
 */

const { EventEmitter } = require("events");
const { Updater, isNewer, notesText, isOffline, macFeed } = require("../src/updater");

let fails = 0;
const check = (ok, msg) => {
  console.log((ok ? "ok    " : "БЕДА  ") + msg);
  if (!ok) fails += 1;
};

/** Поддельный electron-updater и окна программы, записывающие каждый шаг. */
function setup({ version = "0.2.0", answers = [], checkError = null, downloadError = null, prepare = { ok: true } } = {}) {
  const log = [];
  const au = new EventEmitter();
  au.checkForUpdates = async () => {
    log.push("check");
    if (checkError) throw checkError;
    return { updateInfo: { version, releaseNotes: "<ul><li>Новое окно</li><li>Быстрее</li></ul>" } };
  };
  au.downloadUpdate = async () => {
    log.push("download");
    au.emit("download-progress", { percent: 50 });
    if (downloadError) throw downloadError;
  };
  au.quitAndInstall = (silent, runAfter) => log.push(`install:${silent}:${runAfter}`);
  const queue = [...answers];
  const ui = {
    ask: async (title) => (log.push(`ask:${title}`), queue.shift() ?? false),
    info: async (title) => (log.push(`info:${title}`), true),
    error: async (title, detail) => (log.push(`error:${title}:${detail}`), true),
    progress: (p) => log.push(`progress:${p}`),
    installing: (v) => log.push(`installing:${v}`),
    installFailed: () => log.push("installFailed"),
  };
  const beforeInstall = async () => (log.push("prepare"), prepare);
  const up = new Updater({ autoUpdater: au, ui, beforeInstall, currentVersion: "0.1.0" });
  return { up, au, log };
}

(async () => {
  // Версии.
  check(isNewer("0.1.1", "0.1.0") && isNewer("0.10.0", "0.9.9") && isNewer("1.0.0", "0.99.99"), "новее — по числам, а не по строке");
  check(!isNewer("0.1.0", "0.1.0") && !isNewer("0.0.9", "0.1.0"), "та же и старая версии — не обновление");

  // Текст «что нового».
  const notes = notesText({ releaseNotes: "<ul><li>Раз</li><li>Два &amp; три</li></ul>" });
  check(notes === "• Раз\n• Два & три", `«что нового» — простым текстом (${JSON.stringify(notes)})`);
  check(notesText({}) === "" && notesText(null) === "", "нет описания — пустая строка");

  // Решение за человеком.
  {
    const { au } = setup();
    check(au.autoDownload === false && au.autoInstallOnAppQuit === false, "без спроса ничего не качается и не ставится при выходе");
  }

  // Фоновая проверка, обновлений нет — молчим.
  {
    const { up, log } = setup({ version: "0.1.0" });
    const r = await up.check({ manual: false });
    check(r.result === "none" && !log.some((l) => l.startsWith("info")), "фоновая проверка без новостей не показывает окон");
  }
  // Ручная — отвечаем.
  {
    const { up, log } = setup({ version: "0.1.0" });
    await up.check({ manual: true });
    check(log.includes("info:Обновлений нет"), "ручная проверка говорит «обновлений нет»");
  }

  // Нет сети: фоновая молчит, ручная объясняет.
  {
    const err = Object.assign(new Error("getaddrinfo ENOTFOUND finecrm.ru"), { code: "ENOTFOUND" });
    check(isOffline(err), "ENOTFOUND — это нет сети");
    const bg = setup({ checkError: err });
    await bg.up.check({ manual: false });
    check(!bg.log.some((l) => l.startsWith("error")), "без сети фоновая проверка молчит");
    check(bg.up.state === "idle", "и не застревает — следующая проверка пройдёт");
    const man = setup({ checkError: err });
    await man.up.check({ manual: true });
    check(man.log.some((l) => l.includes("Нет связи")), "без сети ручная проверка объясняет по-человечески");
  }

  // Отказ: второй раз за запуск фоновая проверка не спрашивает, ручная — спрашивает.
  {
    const { up, log } = setup({ answers: [false] });
    const r = await up.check({ manual: false });
    check(r.result === "declined" && !log.includes("download"), "«Позже» — ничего не качаем");
    const again = await up.check({ manual: false });
    check(again.result === "declined-before", "отказанную версию фоном больше не предлагаем");
    await up.check({ manual: true });
    check(log.filter((l) => l.startsWith("ask:Доступна")).length === 2, "по кнопке «Проверить» спрашиваем снова");
  }

  // Полный путь: согласие → загрузка → установка сейчас.
  {
    const { up, log } = setup({ answers: [true, true] });
    const r = await up.check({ manual: false });
    check(r.result === "installing", `обновление ставится после двух согласий (${r.result})`);
    const iPrep = log.indexOf("prepare");
    const iInst = log.findIndex((l) => l.startsWith("install:"));
    check(iPrep !== -1 && iInst > iPrep, "копия и остановка сервера — строго до установщика");
    check(log.includes("install:false:true"), "установщик виден человеку и сам перезапускает программу");
    check(log.includes("progress:0.5") && log.includes("progress:-1"), "прогресс загрузки показан и потом убран");
  }

  // Загружено, но «Позже» — не ставим; ручная проверка снова предлагает установку, не качая заново.
  {
    const { up, log } = setup({ answers: [true, false, true] });
    const r = await up.check({ manual: false });
    check(r.result === "postponed" && !log.includes("prepare"), "установку можно отложить");
    const r2 = await up.check({ manual: true });
    check(r2.result === "installing" && log.filter((l) => l === "download").length === 1, "потом ставится без повторной загрузки");
  }

  // Подготовка не удалась — установщик не запускается.
  {
    const { up, log } = setup({ answers: [true, true], prepare: { ok: false, error: "Нет свежей копии" } });
    const r = await up.check({ manual: false });
    check(
      r.result === "prepare-failed" && !log.some((l) => l.startsWith("install:")),
      "без копии и остановки установщик не запускается"
    );
    // Окно «устанавливаем обновление» открывается до копии базы и убирается,
    // когда установка не состоялась: иначе оно осталось бы висеть навсегда.
    check(
      log.indexOf("installing:0.2.0") >= 0 && log.indexOf("installing:0.2.0") < log.indexOf("prepare"),
      "окно установки показано до резервной копии"
    );
    check(log.includes("installFailed"), "окно установки убрано, когда установка не состоялась");
    check(log.some((l) => l.startsWith("error:Обновление отложено") && l.includes("Нет свежей копии")), "и человек видит почему");
  }

  // Загрузка оборвалась.
  {
    const { up, log } = setup({ answers: [true], downloadError: new Error("socket hang up ECONNRESET") });
    const r = await up.check({ manual: false });
    check(r.result === "download-failed" && up.state === "idle", "оборванная загрузка не ломает следующую попытку");
    check(log.some((l) => l.startsWith("error:Обновление не загрузилось")), "и сообщает об этом");
  }

  // Mac: вместо загрузки и установки — «Скачать» (программа без подписи Apple).
  {
    const opened = [];
    const feed = macFeed({
      baseUrl: "https://www.finecrm.ru/download/desktop/",
      arch: "x64",
      fetchJson: async (u) => (opened.push(`get:${u}`), {
        version: "0.2.0",
        notes: "Программа для Mac",
        files: { arm64: "FineCRM-0.2.0-mac-arm64.dmg", x64: "FineCRM-0.2.0-mac-x64.dmg" },
      }),
    });
    const log = [];
    const ui = {
      ask: async (title, detail, buttons) => (log.push(`ask:${title}:${buttons[0]}:${detail.includes("«Программы»")}`), true),
      info: async (t) => (log.push(`info:${t}`), true),
      error: async (t) => (log.push(`error:${t}`), true),
      progress: () => log.push("progress"),
    };
    const up = new Updater({
      autoUpdater: feed,
      ui,
      currentVersion: "0.1.0",
      beforeInstall: async () => (log.push("prepare"), { ok: true }),
      openDownload: async (info) => opened.push(`open:${info.downloadUrl}`),
    });
    const r = await up.check({ manual: false });
    check(opened[0] === "get:https://www.finecrm.ru/download/desktop/mac.json", "Mac: версия — из mac.json рядом с .dmg");
    check(r.result === "opened" && opened.includes("open:https://www.finecrm.ru/download/desktop/FineCRM-0.2.0-mac-x64.dmg"), "Mac: «Скачать» открывает .dmg своего процессора");
    check(log.some((l) => l === "ask:Доступна новая версия 0.2.0:Скачать:true"), "Mac: кнопка «Скачать» и как заменить программу");
    check(!log.includes("prepare") && !log.includes("progress") && up.state === "idle", "Mac: ничего не качается и не останавливается само");
    const again = await up.check({ manual: false });
    check(again.result === "declined-before", "Mac: о той же версии второй раз не напоминаем");
    const none = await macFeed({ baseUrl: "https://x/", arch: "arm64", fetchJson: async () => null }).checkForUpdates();
    check(none === null, "Mac: нет mac.json — обновлений нет, без ошибки");
  }

  console.log(fails === 0 ? "\nвсе проверки прошли" : `\nпровалов: ${fails}`);
  process.exitCode = fails === 0 ? 0 : 1;
})();
