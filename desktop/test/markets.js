"use strict";

/**
 * Окно площадок — сторона программы, без настоящего Electron.
 *
 *   node test/markets.js
 *
 * Разбор настоящих страниц площадок проверяется отдельно (fe/e2e-markets.mjs
 * в песочнице Claude, на образцах, снятых с Wildberries, Авито, AliExpress).
 */

const m = require("../src/markets");

let bad = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? "ok     " : "ПЛОХО  ") + name + (cond || extra === undefined ? "" : "  → " + JSON.stringify(extra)));
  if (!cond) bad += 1;
};

ok("Ozon — свой сайт", m.hostOk(m.MARKETS.ozon, "https://www.ozon.ru/search/?text=x"));
ok("поддомен — свой", m.hostOk(m.MARKETS.wildberries, "https://global.wildberries.ru/x"));
ok("похожее имя — чужое", !m.hostOk(m.MARKETS.ozon, "https://ozon.ru.evil.com/x") && !m.hostOk(m.MARKETS.ozon, "https://notozon.ru/x"));
ok("только https", !m.hostOk(m.MARKETS.ozon, "http://www.ozon.ru/x") && !m.hostOk(m.MARKETS.ozon, "javascript:alert(1)"));
ok("площадка по адресу", m.marketOf("https://aliexpress.ru/item/1.html") === "aliexpress" && m.marketOf("https://example.com") === null);
ok("подпись браузера без Electron", m.chromeUserAgent("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0 Electron/33.2.0 Safari/537.36") === "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0 Safari/537.36");

const s = m.sanitizeOffers(m.MARKETS.avito, [
  { name: "  Микросхема   IT5571VG ", price: 950.4, url: "https://www.avito.ru/omsk/x_1234567" },
  { name: "Чужая ссылка", price: 1, url: "https://evil.com/x" },
  { name: "Без цены", price: -5, url: "https://www.avito.ru/a_1234567" },
  { name: "", price: 1, url: "https://www.avito.ru/b_1234567" },
  { name: 5, url: "https://www.avito.ru/c" },
  { name: "Валюта", price: null, priceNote: "€17.99", url: "https://www.avito.ru/d_1234567" },
  { name: "x".repeat(1000), price: 1e12, url: "https://www.avito.ru/e_1234567" },
  null,
]);
ok("ответ страницы чистится", s.length === 4 && s[0].name === "Микросхема IT5571VG" && s[0].price === 950 && s[0].stock === "unknown", s);
ok("наличие — только in/out", m.sanitizeOffers(m.MARKETS.ozon, [{ name: "Товар 1", price: 1, stock: "out", url: "https://www.ozon.ru/product/1" }, { name: "Товар 2", price: 1, stock: "<script>", url: "https://www.ozon.ru/product/2" }]).map((x) => x.stock).join() === "out,unknown");
ok("чужие ссылки и пустые имена отброшены", !s.some((x) => /evil|^$/.test(x.url + x.name)));
ok("отрицательная и огромная цена — без цены", s[1].price === null && s[3].price === null && s[3].name.length === 300);
ok("цена в другой валюте — подписью", s[2].priceNote === "€17.99" && s[2].price === null);
ok("не массив — пусто", m.sanitizeOffers(m.MARKETS.ozon, { a: 1 }).length === 0);
ok("не больше 80", m.sanitizeOffers(m.MARKETS.ozon, Array.from({ length: 200 }, (_, i) => ({ name: "Товар " + i, price: 1, url: "https://www.ozon.ru/product/" + i }))).length === 80);
ok("образец ссылки DNS", new RegExp(m.MARKETS.dns.product).test("/product/a1b2c3d4e5/videokarta/"));
ok("образец ссылки Авито — номер объявления", new RegExp(m.MARKETS.avito.product).test("/omsk/tovary/mikroshema_7365448552?slocation=1") && !new RegExp(m.MARKETS.avito.product).test("/omsk/tovary_dlya_kompyutera"));

// ---- мостик: только главное окно, адреса — только площадок, список уходит в главное окно
const handlers = {};
const ipcMain = { handle: (n, fn) => (handlers[n] = fn) };
const sent = [];
const mainWc = { send: (ch, data) => sent.push({ ch, data }) };
const mainWin = { isDestroyed: () => false, webContents: mainWc, isMinimized: () => false, focus: () => {}, restore: () => {} };
const loaded = [];
let pageUrl = "https://www.wildberries.ru/catalog/0/search.aspx?search=IT5571VG";
let pageResult = [{ name: "Микросхема IT5571VG-128", price: 1265, url: "https://www.wildberries.ru/catalog/1/detail.aspx" }];
class FakeWin {
  constructor() {
    this.webContents = { send: () => {}, isDestroyed: () => false };
    this.contentView = { addChildView: () => {} };
    this.toolbar = this.webContents;
  }
  loadFile() {}
  on() {}
  isDestroyed() { return false; }
  isMinimized() { return false; }
  show() {}
  focus() {}
  restore() {}
  getContentBounds() { return { width: 1200, height: 800 }; }
}
let lastWin = null;
function BrowserWindow(opts) {
  lastWin = new FakeWin(opts);
  return lastWin;
}
function WebContentsView() {
  this.setBounds = () => {};
  this.webContents = {
    getUserAgent: () => "UA Electron/33.0.0",
    setUserAgent: (ua) => (this.ua = ua),
    setWindowOpenHandler: () => {},
    on: () => {},
    loadURL: (u) => loaded.push(u),
    getURL: () => pageUrl,
    isDestroyed: () => false,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    executeJavaScript: async (code) => {
      if (!code.includes("detail\\\\.aspx") && !code.includes("detail\\.aspx") && !code.includes("_\\\\d{7,}") && !code.includes("_\\d{7,}")) throw new Error("не тот образец ссылки");
      return pageResult;
    },
  };
}
const session = { fromPartition: (p) => ({ partition: p }) };
m.register({ ipcMain, BrowserWindow, WebContentsView, session, shell: { openExternal: () => {} }, getWindow: () => mainWin });
const own = { sender: mainWc };
const alien = { sender: {} };

(async () => {
  const urls = {
    wildberries: "https://www.wildberries.ru/catalog/0/search.aspx?search=IT5571VG",
    avito: "https://www.avito.ru/rossiya?q=IT5571VG",
    ozon: "https://evil.com/?text=x",
  };
  ok("чужое окно не открывает площадки", (await handlers["desktop:markets-open"](alien, { shop: "wildberries", query: "x", urls })).ok === false && !lastWin);
  let r = await handlers["desktop:markets-open"](own, { shop: "ozon", query: "x", urls });
  ok("адрес не на площадку — отказ", r.ok === false && /не ведёт/.test(r.error), r);
  r = await handlers["desktop:markets-open"](own, { shop: "wildberries", query: "IT5571VG", urls });
  ok("открылось окно с поиском площадки", r.ok && loaded.at(-1) === urls.wildberries, { r, loaded });
  const toolbar = { sender: lastWin.webContents };
  const st = await handlers["markets:state"](toolbar);
  ok("вкладки — только проверенные площадки", st.tabs.map((t) => t.id).join() === "wildberries,avito" && st.query === "IT5571VG", st);
  ok("панель — только своему окну", (await handlers["markets:state"](own)) === null);
  await handlers["markets:tab"](toolbar, "avito");
  ok("вкладка Авито", loaded.at(-1) === urls.avito);
  r = await handlers["markets:collect"](own);
  ok("«Показать списком» — только с панели окна площадок", r.ok === false);
  pageUrl = "https://www.wildberries.ru/catalog/0/search.aspx?search=IT5571VG";
  r = await handlers["markets:collect"](toolbar);
  ok("список ушёл в окно FineCRM", r.ok && r.count === 1 && sent.at(-1).ch === "desktop:markets-offers" && sent.at(-1).data.shop === "wildberries" && sent.at(-1).data.query === "IT5571VG" && sent.at(-1).data.offers[0].price === 1265, { r, sent });
  pageUrl = "https://id.sber.ru/login";
  r = await handlers["markets:collect"](toolbar);
  ok("чужая страница (вход через Сбер ID) — просим вернуться к поиску", r.ok === false && /не страница площадки/.test(r.error), r);
  pageUrl = "https://www.avito.ru/rossiya?q=x";
  pageResult = [];
  r = await handlers["markets:collect"](toolbar);
  ok("товаров не нашлось — словами", r.ok === false && /не нашлось товаров/.test(r.error), r);

  console.log(bad ? `\nПровалов: ${bad}` : "\nВсё в порядке");
  process.exitCode = bad ? 1 : 0;
})();
