"use strict";

const path = require("path");

/**
 * Окно площадок: Ozon, Wildberries, Авито, AliExpress, DNS внутри программы.
 *
 * Эти площадки закрыты от роботов, поэтому сервер их не спрашивает. Здесь —
 * обычное окно браузера, в котором ищет человек: открыл поиск по запросу из
 * FineCRM, полистал, при желании вошёл в свой аккаунт (вход помнит само окно,
 * как браузер; пароль программа не видит). Кнопка «Показать списком» берёт
 * товары с той страницы, которую человек сейчас видит, и отдаёт их в окно
 * поиска запчастей FineCRM — с ценой и кнопкой «В заказ».
 *
 * Ничего не делается за спиной: страница грузится только по действию
 * человека, капчу, если покажут, решает он сам.
 *
 * Адреса поиска приходят из окна FineCRM (их знает сервер, backend/…/shops.ts),
 * здесь только проверяется, что адрес ведёт на сайт этой площадки.
 */

const TOOLBAR_H = 52;
const PARTITION = "persist:finecrm-markets";

/** Площадки: какие сайты свои и как выглядит ссылка на товар. */
const MARKETS = {
  ozon: { name: "Ozon", hosts: ["ozon.ru"], product: "/product/" },
  wildberries: { name: "Wildberries", hosts: ["wildberries.ru", "wb.ru"], product: "/catalog/\\d+/detail\\.aspx" },
  avito: { name: "Авито", hosts: ["avito.ru"], product: "_\\d{7,}(?:[?#]|$)" },
  aliexpress: { name: "AliExpress", hosts: ["aliexpress.com", "aliexpress.ru"], product: "/item/\\d+\\.html" },
  dns: { name: "DNS", hosts: ["dns-shop.ru"], product: "/product/[0-9a-f]{6,}/" },
};

function hostOk(market, url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase();
    return market.hosts.some((x) => h === x || h.endsWith("." + x));
  } catch {
    return false;
  }
}

/** Какая площадка у этого адреса. */
function marketOf(url) {
  return Object.keys(MARKETS).find((id) => hostOk(MARKETS[id], url)) || null;
}

/**
 * Достать товары со страницы — выполняется В СТРАНИЦЕ площадки.
 *
 * Не завязано на вёрстку: ищем ссылки на товары (у каждой площадки свой вид
 * адреса товара), от каждой поднимаемся к ближайшему блоку, где есть цена в
 * рублях и нет других товаров, — это карточка. Название — текст ссылки или
 * подпись картинки, цена — первая цена в карточке (у площадок первой стоит
 * цена со скидкой).
 */
function extractOffers(productPattern) {
  const re = new RegExp(productPattern);
  // «1 265 ₽», «1 234,56 ₽» (AliExpress пишет копейки) — копейки отбрасываем.
  // Разряды — строго по три цифры: «4.8 1 265 ₽» (оценка рядом с ценой) не превращается в 81 265.
  const PRICE = /(\d{1,3}(?:[\s\u00a0\u2009\u202f]\d{3})+|\d+)(?:[.,]\d{1,2})?\s*(?:₽|руб)/;
  const MONEY = /[₽$€¥]|руб/;
  const clean = (s) => String(s || "").replace(/[\s\u00a0\u2009\u202f]+/g, " ").trim();
  const text = (el) => clean(el.innerText || el.textContent);
  const keyOf = (href) => {
    try {
      const u = new URL(href, location.href);
      return u.origin + u.pathname;
    } catch {
      return null;
    }
  };
  const isProduct = (a) => re.test(a.getAttribute("href") || "");
  const groups = new Map();
  for (const a of Array.from(document.querySelectorAll("a[href]"))) {
    if (!isProduct(a)) continue;
    const key = keyOf(a.getAttribute("href"));
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }
  const out = [];
  for (const [key, anchors] of groups) {
    // Карточка — самый большой блок вокруг ссылки, где нет других товаров.
    let card = anchors[0];
    for (let i = 0, el = card.parentElement; i < 9 && el && el !== document.body; i++, el = el.parentElement) {
      const keys = new Set(Array.from(el.querySelectorAll("a[href]")).filter(isProduct).map((x) => keyOf(x.getAttribute("href"))));
      if (keys.size > 1) break;
      card = el;
    }
    // Название: самое длинное из текста ссылок, подписей ссылок и картинок, заголовков
    // карточки. Ярлыки («aliexpress», «Хит») короче настоящего имени и проигрывают.
    const candidates = [];
    for (const a of anchors) candidates.push(a.getAttribute("aria-label"), a.getAttribute("title"));
    for (const a of anchors) if (!MONEY.test(text(a))) candidates.push(text(a));
    for (const im of Array.from(card.querySelectorAll("img[alt]"))) candidates.push(im.getAttribute("alt"));
    for (const h of Array.from(card.querySelectorAll("h1, h2, h3, h4, [itemprop=name]"))) candidates.push(text(h));
    const name = candidates
      .map(clean)
      .filter((t) => t.length >= 6 && !MONEY.test(t))
      .sort((x, y) => y.length - x.length)[0];
    if (!name) continue;
    // Цена — первая в рублях: у площадок первой стоит цена со скидкой. В другой валюте — без цены.
    const t = text(card);
    const m = PRICE.exec(t);
    const price = m ? Number(m[1].replace(/\D/g, "")) : null;
    const foreign = m ? null : /[$€¥]\s?\d{1,3}(?:[,\s]\d{3})*(?:[.,]\d{1,2})?|\d{1,3}(?:[,\s]\d{3})*(?:[.,]\d{1,2})?\s?[$€¥]/.exec(t);
    // Площадки показывают в выдаче то, что можно купить; «нет в наличии» пишут словами.
    const gone = /нет в наличии|закончил|распродан|снят с продажи|out of stock|sold out/i.test(t);
    out.push({ name: name.slice(0, 300), price: price && price > 0 ? price : null, priceNote: foreign ? clean(foreign[0]) : undefined, stock: gone ? "out" : "in", url: key });
    if (out.length >= 80) break;
  }
  return out;
}

/** Ответу страницы не доверяем: только строки и числа разумной длины, ссылки — на эту площадку. */
function sanitizeOffers(market, raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const x of raw.slice(0, 80)) {
    if (!x || typeof x.name !== "string" || typeof x.url !== "string") continue;
    if (!hostOk(market, x.url)) continue;
    const name = x.name.replace(/\s+/g, " ").trim().slice(0, 300);
    if (!name) continue;
    const price = typeof x.price === "number" && Number.isFinite(x.price) && x.price > 0 && x.price < 1e8 ? Math.round(x.price) : null;
    const priceNote = price === null && typeof x.priceNote === "string" && x.priceNote.length <= 30 ? x.priceNote : undefined;
    const stock = x.stock === "in" || x.stock === "out" ? x.stock : "unknown";
    out.push({ name, price, ...(priceNote ? { priceNote } : {}), url: x.url.slice(0, 1000), stock });
  }
  return out;
}

/** Обычный Chrome: без «Electron/…» в подписи некоторые сайты отдают упрощённую страницу. */
function chromeUserAgent(ua) {
  return String(ua || "").replace(/\s?(Electron|FineCRM|finecrm-desktop)\/[\d.]+/gi, "");
}

function register({ ipcMain, BrowserWindow, WebContentsView, session, shell, getWindow }) {
  let win = null;
  let view = null;
  let state = { shop: null, query: "", urls: {} };

  const fromMain = (e) => {
    const w = getWindow();
    return !!w && !w.isDestroyed() && e.sender === w.webContents;
  };
  const fromToolbar = (e) => !!win && !win.isDestroyed() && e.sender === win.webContents;

  const toolbarState = () => ({
    shop: state.shop,
    query: state.query,
    tabs: Object.keys(state.urls).map((id) => ({ id, name: MARKETS[id].name })),
    url: view && !view.webContents.isDestroyed() ? view.webContents.getURL() : "",
    canBack: !!view && view.webContents.navigationHistory.canGoBack(),
    canForward: !!view && view.webContents.navigationHistory.canGoForward(),
  });
  const pushState = () => {
    if (win && !win.isDestroyed()) win.webContents.send("markets:state", toolbarState());
  };

  function layout() {
    if (!win || !view) return;
    const b = win.getContentBounds();
    view.setBounds({ x: 0, y: TOOLBAR_H, width: b.width, height: Math.max(0, b.height - TOOLBAR_H) });
  }

  function ensureWindow() {
    if (win && !win.isDestroyed()) return;
    win = new BrowserWindow({
      width: 1200,
      height: 860,
      minWidth: 640,
      minHeight: 480,
      title: "Площадки — FineCRM",
      backgroundColor: "#0F1117",
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, "markets-preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.loadFile(path.join(__dirname, "markets.html"));

    const ses = session.fromPartition(PARTITION);
    view = new WebContentsView({
      webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    view.webContents.setUserAgent(chromeUserAgent(view.webContents.getUserAgent()));
    win.contentView.addChildView(view);
    layout();
    win.on("resize", layout);
    win.on("closed", () => {
      win = null;
      view = null;
    });

    const wc = view.webContents;
    // Ссылки «в новой вкладке»: своё — в этом же окне, чужое — в обычный браузер.
    wc.setWindowOpenHandler(({ url }) => {
      if (marketOf(url)) wc.loadURL(url);
      else if (/^https?:/.test(url)) shell.openExternal(url);
      return { action: "deny" };
    });
    for (const ev of ["did-navigate", "did-navigate-in-page", "did-finish-load", "page-title-updated"]) wc.on(ev, pushState);
    wc.on("did-fail-load", (_e, code, desc, url, isMain) => {
      if (isMain && code !== -3 && win && !win.isDestroyed()) win.webContents.send("markets:notice", { tone: "error", text: `Страница не открылась: ${desc}` });
    });
  }

  function show(shop) {
    const url = state.urls[shop];
    if (!url) return;
    state.shop = shop;
    ensureWindow();
    view.webContents.loadURL(url);
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    pushState();
  }

  // Окно FineCRM: «открой Ozon с поиском IT5571VG» (и адреса остальных площадок — для вкладок).
  ipcMain.handle("desktop:markets-open", (e, req) => {
    if (!fromMain(e)) return { ok: false };
    const urls = {};
    for (const [id, url] of Object.entries((req && req.urls) || {})) {
      if (MARKETS[id] && typeof url === "string" && hostOk(MARKETS[id], url)) urls[id] = url;
    }
    const shop = req && req.shop;
    if (!urls[shop]) return { ok: false, error: "Этот адрес не ведёт на сайт площадки" };
    state = { shop, query: String((req && req.query) || "").slice(0, 80), urls };
    show(shop);
    return { ok: true };
  });

  // Панель окна площадок.
  ipcMain.handle("markets:state", (e) => (fromToolbar(e) ? toolbarState() : null));
  ipcMain.handle("markets:tab", (e, shop) => {
    if (fromToolbar(e) && state.urls[shop]) show(shop);
  });
  ipcMain.handle("markets:nav", (e, what) => {
    if (!fromToolbar(e) || !view) return;
    const h = view.webContents.navigationHistory;
    if (what === "back" && h.canGoBack()) h.goBack();
    else if (what === "forward" && h.canGoForward()) h.goForward();
    else if (what === "reload") view.webContents.reload();
    else if (what === "search" && state.urls[state.shop]) view.webContents.loadURL(state.urls[state.shop]);
  });
  ipcMain.handle("markets:collect", async (e) => {
    if (!fromToolbar(e) || !view) return { ok: false };
    const url = view.webContents.getURL();
    const shop = marketOf(url);
    if (!shop) return { ok: false, error: "Это не страница площадки — вернитесь к поиску" };
    let raw;
    try {
      raw = await view.webContents.executeJavaScript(`(${extractOffers.toString()})(${JSON.stringify(MARKETS[shop].product)})`, true);
    } catch {
      return { ok: false, error: "Не получилось прочитать страницу — дождитесь, пока она загрузится" };
    }
    const offers = sanitizeOffers(MARKETS[shop], raw);
    if (!offers.length) return { ok: false, error: "На этой странице не нашлось товаров с ценой. Откройте список результатов поиска" };
    const main = getWindow();
    if (main && !main.isDestroyed()) {
      main.webContents.send("desktop:markets-offers", { shop, query: state.query, url, offers });
      if (main.isMinimized()) main.restore();
      main.focus();
    }
    return { ok: true, count: offers.length };
  });
}

module.exports = { register, MARKETS, hostOk, marketOf, extractOffers, sanitizeOffers, chromeUserAgent, TOOLBAR_H };
