"use strict";

/**
 * Папка заказа — сторона программы, без настоящего Electron.
 *
 *   node test/order-folders.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const of = require("../src/orderFolders");

let bad = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? "ok     " : "ПЛОХО  ") + name + (cond || extra === undefined ? "" : "  → " + JSON.stringify(extra)));
  if (!cond) bad += 1;
};

// ---- имена
ok("номер и техника", of.folderName("Р-3934", ["Ноутбук Asus X550"]) === "Р-3934_Ноутбук Asus X550");
ok("пустые части пропускаются", of.folderName("3934", ["", null, "Иванов"]) === "3934_Иванов");
ok("запрещённые символы Windows", of.folderName("3934", ['HP 15"/ab:c*?<>|x']) === "3934_HP 15 ab c x", of.folderName("3934", ['HP 15"/ab:c*?<>|x']));
ok("точки и пробелы на конце сняты", of.folderName("3934", ["Asus X550... "]) === "3934_Asus X550");
ok("«..» не уводит из папки", of.folderName("..", ["x"]) === null && of.folderName("3934", ["..", "../../etc"]) === "3934_etc");
ok("зарезервированное имя Windows", of.safePart("CON") === "_CON" && of.safePart("lpt1") === "_lpt1");
ok("без номера — нельзя", of.folderName("", ["a"]) === null && of.folderName("   ", []) === null);
const long = of.folderName("3934", ["А".repeat(200), "Б".repeat(200)]);
ok("длинное имя обрезано", long.length <= 150 && long.startsWith("3934_ААА"), long.length);
ok("перевод строки в имени — пробел", of.folderName("3934", ["Asus\nX550"]) === "3934_Asus X550");

// ---- поиск и создание
const root = fs.mkdtempSync(path.join(os.tmpdir(), "zakazy-"));
let r = of.resolveFolder(root, { number: "Р-3934", parts: ["Ноутбук Asus X550"] });
ok("папка заведена", r.ok && r.created && r.path === path.join(root, "Р-3934_Ноутбук Asus X550") && fs.statSync(r.path).isDirectory(), r);
r = of.resolveFolder(root, { number: "Р-3934", parts: ["Ноутбук Asus X550 (исправили модель)"] });
ok("сменили технику — та же папка, второй нет", r.ok && !r.created && r.path.endsWith("Р-3934_Ноутбук Asus X550") && fs.readdirSync(root).length === 1, r);
r = of.resolveFolder(root, { number: "р-3934", parts: [] });
ok("номер без учёта регистра", r.ok && !r.created && r.path.endsWith("Р-3934_Ноутбук Asus X550"));
fs.mkdirSync(path.join(root, "39345_Чужой"));
r = of.resolveFolder(root, { number: "3934", parts: ["Новый"] });
ok("«3934» не путается с «39345_…»", r.ok && r.created && r.path.endsWith("3934_Новый"), r);
fs.mkdirSync(path.join(root, "5000"));
r = of.resolveFolder(root, { number: "5000", parts: ["Телефон"] });
ok("папка с одним номером тоже находится", r.ok && !r.created && r.path === path.join(root, "5000"));
fs.writeFileSync(path.join(root, "7000_файл"), "x");
r = of.resolveFolder(root, { number: "7000", parts: ["X"] });
ok("файл с таким именем — не папка заказа", r.ok && r.created && r.path.endsWith("7000_X"));
r = of.resolveFolder(root, { number: "8000", parts: ["X"] }, { create: false });
ok("без создания — только поиск", r.ok && r.path === null && !fs.existsSync(path.join(root, "8000_X")));

// по годам
r = of.resolveFolder(root, { number: "9001", parts: ["Ноутбук"], year: 2026, byYear: true });
ok("по годам — в папке года", r.ok && r.created && r.path === path.join(root, "2026", "9001_Ноутбук"), r);
r = of.resolveFolder(root, { number: "Р-3934", parts: ["x"], year: 2026, byYear: true });
ok("включили годы позже — старая папка в корне находится", r.ok && !r.created && r.path.endsWith("Р-3934_Ноутбук Asus X550"), r);
r = of.resolveFolder(root, { number: "9002", parts: [], year: "../../etc", byYear: true });
ok("кривой год — без папки года", r.ok && r.path === path.join(root, "9002"), r);

// ошибки
r = of.resolveFolder(null, { number: "1" });
ok("папка не выбрана — просим выбрать", !r.ok && r.needRoot === true);
r = of.resolveFolder(path.join(root, "нет-такой"), { number: "1" });
ok("папки нет (диск не подключён) — понятная ошибка", !r.ok && r.missingRoot && /Диск не подключён/.test(r.error), r);
r = of.resolveFolder(path.join(root, "7000_файл"), { number: "1" });
ok("вместо папки — файл", !r.ok && /не папка/.test(r.error));
if (process.platform !== "win32" && process.getuid && process.getuid() !== 0) {
  const ro = fs.mkdtempSync(path.join(os.tmpdir(), "ro-"));
  fs.chmodSync(ro, 0o500);
  r = of.resolveFolder(ro, { number: "1", parts: [] });
  ok("нет прав — словами", !r.ok && /нет прав/.test(r.error), r);
  fs.chmodSync(ro, 0o700);
}

// ---- хранение пути
const ud = fs.mkdtempSync(path.join(os.tmpdir(), "ud-"));
ok("путь не выбран", of.readRoot(ud) === null);
of.writeRoot(ud, "D:\\Заказы");
ok("путь запомнен", of.readRoot(ud) === "D:\\Заказы");
fs.writeFileSync(path.join(ud, "order-folders.json"), "{испорчен");
ok("испорченный файл — как не выбрано", of.readRoot(ud) === null);

// ---- мостик: только главное окно
const handlers = {};
const ipcMain = { handle: (name, fn) => (handlers[name] = fn) };
const mainWc = {};
const win = { isDestroyed: () => false, webContents: mainWc };
const opened = [];
const shell = { openPath: async (p) => (opened.push(p), "") };
let pickAnswer = { canceled: false, filePaths: [root] };
const dialog = { showOpenDialog: async () => pickAnswer };
const ud2 = fs.mkdtempSync(path.join(os.tmpdir(), "ud2-"));
of.register({ ipcMain, dialog, shell, getWindow: () => win, userDataDir: ud2 });
const own = { sender: mainWc };
const alien = { sender: {} };

(async () => {
  ok("чужое окно — нельзя", (await handlers["desktop:order-folder-open"](alien, { number: "1" })).ok === false && opened.length === 0);
  ok("чужое окно не выбирает папку", (await handlers["desktop:order-folder-pick"](alien)).ok === false);
  let x = await handlers["desktop:order-folder-info"](own);
  ok("сначала папки нет", x.ok && x.root === null);
  x = await handlers["desktop:order-folder-open"](own, { number: "1" });
  ok("открыть без папки — просим выбрать", !x.ok && x.needRoot);
  pickAnswer = { canceled: true, filePaths: [] };
  x = await handlers["desktop:order-folder-pick"](own);
  ok("отменили выбор", !x.ok && x.canceled);
  pickAnswer = { canceled: false, filePaths: [root] };
  x = await handlers["desktop:order-folder-pick"](own);
  ok("выбрали папку", x.ok && x.root === root && of.readRoot(ud2) === root);
  x = await handlers["desktop:order-folder-open"](own, { number: "Р-4000", parts: ["Телефон Xiaomi"] });
  ok("открыть — создаёт и открывает", x.ok && x.created && opened.at(-1) === path.join(root, "Р-4000_Телефон Xiaomi"), x);
  x = await handlers["desktop:order-folder-ensure"](own, { number: "Р-4001", parts: ["Планшет"] });
  ok("при приёме — создаёт без окна", x.ok && x.created && opened.length === 1 && fs.existsSync(path.join(root, "Р-4001_Планшет")));
  shell.openPath = async () => "Нет программы для открытия";
  x = await handlers["desktop:order-folder-open"](own, { number: "Р-4000" });
  ok("не открылась — словами", !x.ok && /не открылась/.test(x.error));
  x = await handlers["desktop:order-folder-forget"](own);
  ok("забыть папку", x.ok && of.readRoot(ud2) === null);

  for (const d of [root, ud, ud2]) fs.rmSync(d, { recursive: true, force: true });
  console.log(bad ? `\nПровалов: ${bad}` : "\nВсё в порядке");
  process.exitCode = bad ? 1 : 0;
})();
