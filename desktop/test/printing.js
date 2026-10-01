"use strict";

/**
 * Печать через CRM — сторона программы, без настоящего Electron.
 *
 *   node test/printing.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const printing = require("../src/printing");

let bad = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? "ok     " : "ПЛОХО  ") + name + (cond || extra === undefined ? "" : "  → " + JSON.stringify(extra)));
  if (!cond) bad += 1;
};

const ID = "0b8c6a2e-5f1d-4c7a-9e3b-2a1f0c9d8e7f";
const page = "http://127.0.0.1:4102/orders";
const allowed = (u, p = page) => printing.allowedPrintUrl(u, p);

ok("бланк заказа в режиме станции", allowed(`http://127.0.0.1:4102/orders/${ID}/print?doc=intake&station=1`));
ok("тестовая страница", allowed(`http://127.0.0.1:4102/print-test?station=1&printer=HP`));
ok("через узел связи /b/<код>/", allowed(`https://www.finecrm.ru/b/kod1abcdefghij/orders/${ID}/print?doc=act&station=1`, "https://www.finecrm.ru/b/kod1abcdefghij/"));
ok("чужой адрес — нельзя", !allowed(`https://evil.example/orders/${ID}/print?station=1`));
ok("другая страница CRM — нельзя", !allowed(`http://127.0.0.1:4102/settings?station=1`));
ok("без режима станции — нельзя", !allowed(`http://127.0.0.1:4102/orders/${ID}/print?doc=intake`));
ok("кривой адрес — нельзя", !allowed("не адрес"));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "print-"));
const first = printing.deviceId(dir);
ok("номер станции заводится", typeof first === "string" && first.length >= 8);
ok("и помнится между запусками", printing.deviceId(dir) === first);

ok("принтер пропал — понятная причина", /не нашла этот принтер/.test(printing.failureText("Invalid deviceName provided")));
ok("прочее — с кодом причины", /не принял задание \(failed\)/.test(printing.failureText("failed")));

// --- сам обработчик печати с поддельными окном и ipc
const handlers = {};
const ipcMain = { handle: (name, fn) => (handlers[name] = fn) };
const printed = [];
class FakeWindow {
  constructor(opts) {
    this.opts = opts;
    this.destroyed = false;
    this.webContents = new EventEmitter();
    this.webContents.print = (o, cb) => {
      printed.push(o);
      setTimeout(() => cb(o.deviceName !== "Сломанный", o.deviceName === "Сломанный" ? "failed" : ""), 5);
    };
    FakeWindow.last = this;
  }
  async loadURL(url) {
    this.url = url;
    // Бланк дорисовался — страница меняет заголовок (OrderPrint.tsx).
    setTimeout(() => this.webContents.emit("page-title-updated", {}, FakeWindow.title), 5);
  }
  isDestroyed() {
    return this.destroyed;
  }
  destroy() {
    this.destroyed = true;
  }
}
FakeWindow.title = printing.READY;
const mainContents = {
  session: { name: "main" },
  getPrintersAsync: async () => [
    { name: "HP LaserJet", displayName: "HP LaserJet (Приёмка)", isDefault: true },
    { name: "Сломанный", displayName: "", isDefault: false },
  ],
};
const mainWin = { webContents: mainContents, isDestroyed: () => false };
printing.register({ ipcMain, BrowserWindow: FakeWindow, getWindow: () => mainWin, userDataDir: dir });

const fromMain = { sender: mainContents, senderFrame: { url: page } };
const fromOther = { sender: {}, senderFrame: { url: page } };
const url = `http://127.0.0.1:4102/orders/${ID}/print?doc=intake&station=1`;

(async () => {
  const info = await handlers["desktop:print-info"](fromMain);
  ok("сведения о станции — номер и имя компьютера", info.ok && info.deviceId === first && info.name === os.hostname(), info);
  ok("чужому окну сведения не отдаются", (await handlers["desktop:print-info"](fromOther)).ok === false);

  const list = await handlers["desktop:printers"](fromMain);
  ok("список принтеров Windows", list.ok && list.printers.length === 2 && list.printers[1].displayName === "Сломанный", list);

  let r = await handlers["desktop:print"](fromMain, { url, printer: "HP LaserJet", copies: 2 });
  ok("напечатано", r.ok === true, r);
  const opts = printed.at(-1);
  ok("молча, на нужный принтер, две копии, A4", opts.silent && opts.deviceName === "HP LaserJet" && opts.copies === 2 && opts.pageSize === "A4", opts);
  ok("невидимое окно в той же сессии и закрыто после печати", FakeWindow.last.opts.show === false && FakeWindow.last.opts.webPreferences.session === mainContents.session && FakeWindow.last.destroyed);

  r = await handlers["desktop:print"](fromMain, { url, printer: "HP LaserJet", copies: 9 });
  ok("копий не больше двух", printed.at(-1).copies === 2);

  r = await handlers["desktop:print"](fromMain, { url, printer: "Нет такого" });
  ok("неизвестный принтер — отказ до печати", !r.ok && /не видит принтер «Нет такого»/.test(r.error), r);

  r = await handlers["desktop:print"](fromMain, { url, printer: "Сломанный" });
  ok("принтер не принял — причина", !r.ok && /не принял задание/.test(r.error), r);

  r = await handlers["desktop:print"](fromMain, { url: "https://evil.example/x?station=1", printer: "HP LaserJet" });
  ok("чужой адрес не печатается", !r.ok && /нельзя/.test(r.error), r);

  r = await handlers["desktop:print"](fromOther, { url, printer: "HP LaserJet" });
  ok("из чужого окна — отказ", !r.ok, r);

  FakeWindow.title = printing.FAILED + "Заказ не найден";
  r = await handlers["desktop:print"](fromMain, { url, printer: "HP LaserJet" });
  ok("бланк не открылся — причина со страницы", !r.ok && r.error === "Заказ не найден" && FakeWindow.last.destroyed, r);

  console.log(bad ? `\nпровалов: ${bad}` : "\nвсе проверки прошли");
  process.exitCode = bad ? 1 : 0;
})();
