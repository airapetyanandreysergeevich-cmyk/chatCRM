/**
 * Агент поиска запчастей: разборщик HTML, читалки магазинов, совпадение,
 * порядок, кэш и ошибки сети.
 *
 *   npx tsx test/parts.ts
 *
 * Читалки проверяются на образцах страниц из test/fixtures/parts — это
 * куски настоящих страниц поиска магазинов (06.10.2026), без картинок и
 * лишнего. Поменял магазин вёрстку — снимите новый образец и поправьте
 * селекторы в src/modules/parts/shops.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { decodeEntities, parseHtml, query, queryAll, textOf } from "../src/modules/parts/html";
import { clearCache, compact, matches, rank, searchShop, ShopError, type Fetcher } from "../src/modules/parts/search";
import { extractJsonAfter, parseCsv, parsePrice, readSheet, SHOPS, shopById } from "../src/modules/parts/shops";
import { clearLogoCache, fetchLogo, imageType, logoFor } from "../src/modules/parts/logo";

let fails = 0;
const check = (ok: boolean, msg: string, extra?: unknown) => {
  console.log((ok ? "ok    " : "БЕДА  ") + msg + (ok || extra === undefined ? "" : `  → ${JSON.stringify(extra)}`));
  if (!ok) fails += 1;
};
const fx = (name: string) => fs.readFileSync(path.join(__dirname, "fixtures", "parts", name), "utf8");

async function main() {
  // ---------------------------------------------------------------- html
  const root = parseHtml(
    `<div class="a b" id=x><p>раз<p>два</p><ul><li>1<li>2</ul><br/><img src=1><span title='x > y'>т&amp;т&nbsp;&#8381;</span></div></b><script>var s="<div class=a>";</script>`
  );
  check(queryAll(root, "div.a").length === 1, "скрипт не порождает тегов");
  check(queryAll(root, "p").length === 2, "незакрытый <p> закрыт следующим");
  check(queryAll(root, "ul > li").length === 2, "незакрытые <li> — соседи");
  check(textOf(query(root, "span")) === "т&т ₽", "сущности раскодированы", textOf(query(root, "span")));
  check(query(root, "span")?.attrs.title === "x > y", "«>» в кавычках атрибута не ломает тег");
  check(query(root, "#x") !== null && query(root, "div#x.b") !== null, "id и классы вместе");
  check(query(root, "[title*=y]") !== null && query(root, "img[src=1]") !== null, "селекторы атрибутов");
  check(queryAll(root, "li, span").length === 3, "несколько селекторов через запятую");
  check(decodeEntities("&#x41;&#66;&unknown;") === "AB&unknown;", "числовые сущности, неизвестные — как есть");

  // ---------------------------------------------------------------- цены и совпадение
  check(parsePrice("1280.00 руб.") === 1280, "цена с копейками");
  check(parsePrice(" 3 990 р. ") === 3990, "цена с пробелом");
  check(parsePrice("1\u00a0370 ₽") === 1370, "цена с неразрывным пробелом");
  check(parsePrice("цены нет") === null && parsePrice("0") === null, "пустая и нулевая цена — нет цены");
  check(compact("IT5571VG-128 CXO") === "IT5571VG128CXO", "сжатие названия");
  check(matches("it5571vg", { name: "Мультиконтроллер IT5571VG CXO Bulk" }), "запрос без хвоста находит полное имя");
  check(matches("IT5571VG-128", { name: "IT5571VG 128 CXO" }), "дефис в запросе и пробел в имени");
  check(!matches("NT156WHM-N10", { name: "Матрица NT156WHM-N42" }), "соседняя модель — не совпадение");
  check(matches("клавиатура asus x550", { name: "Клавиатура для ноутбука Asus X550C" }), "несколько слов — все есть");
  check(matches("52700", { name: "Мультиконтроллер", article: "52700" }), "по артикулу");
  check(!matches("a", { name: "abc" }), "односимвольный запрос ничего не совпадает");
  const r = rank("it5571", [
    { name: "IT5571 нет", price: 100, stock: "out", url: "u1" },
    { name: "IT5571 дорогой", price: 900, stock: "in", url: "u2" },
    { name: "IT5571 дешёвый", price: 500, stock: "in", url: "u3" },
    { name: "IT5571 дешёвый", price: 500, stock: "in", url: "u3" },
    { name: "Плата с чипом", price: 50, stock: "in", url: "u4" },
    { name: "IT5571 едет", price: null, stock: "order", url: "u5" },
  ]);
  check(
    r.offers.map((o) => o.url).join(",") === "u3,u2,u5,u1,u4",
    "порядок: в наличии дешевле, едет, нет; похожие в конце; повтор убран",
    r.offers.map((o) => o.url)
  );
  check(r.offers.find((o) => o.url === "u4")?.exact === false, "похожее помечено");

  // ---------------------------------------------------------------- читалки
  const read = async (id: string, file: string, q: string, extra?: Fetcher) => {
    const shop = shopById(id)!;
    const fetchText: Fetcher = extra ?? (async () => "{}");
    return shop.read!(fx(file), { q, fetchText });
  };

  const nb = await read("nbzip", "nbzip.html", "it5571vg");
  check(nb.length === 1 && nb[0].name.startsWith("IT5571VG-128 CXO"), "NBzip: товар", nb);
  check(nb[0]?.price === 1280 && nb[0]?.priceNote === "опт 1 150 ₽", "NBzip: розница и опт", nb[0]);
  check(nb[0]?.url === "https://www.nbzip.ru/magazin/multikontrollery/it5571vg-128-cxo.html", "NBzip: полная ссылка", nb[0]?.url);
  check(nb[0]?.stock === "in", "NBzip: «Купить» — в наличии");

  const suggest = fx("recomb-suggest.json");
  let suggestBody = "";
  const rc = await read("recomb", "recomb.html", "RT8223", async (_u, init) => {
    suggestBody = init?.body ?? "";
    return JSON.stringify({ in_stock_cnt: "1", in_stock: [{ name: "RT8223B", title: "RT8223B" }], ...JSON.parse(suggest) });
  });
  check(suggestBody === "exec=product_search&query=RT8223", "ReComB: подсказки спрошены POST-ом", suggestBody);
  check(rc.length === 3, "ReComB: две позиции витрины и одна в пути", rc.map((x) => x.name));
  check(rc[0]?.price === 85 && rc[1]?.price === 1086, "ReComB: цены", rc.map((x) => x.price));
  check(rc[0]?.stock === "in" && rc[0]?.url === "https://recomb-omsk.ru/index.php?productID=10579", "ReComB: наличие из подсказок и ссылка", rc[0]);
  check(rc[2]?.stock === "order" && rc[2]?.stockText === "ожидается 20.10.2026" && rc[2]?.price === null, "ReComB: «в пути» без цены", rc[2]);
  const rcBroken = await read("recomb", "recomb.html", "RT8223", async () => "<html>не json");
  check(rcBroken.length === 2 && rcBroken[0].stock === "unknown", "ReComB: подсказки сломались — витрина всё равно показана");

  const ai = await read("aitech", "aitech.html", "it5571vg");
  check(ai.length === 3, "Aitech: три карточки", ai.length);
  check(ai[0]?.stock === "in" && ai[0]?.stockText === "5 шт." && ai[0]?.price === 480, "Aitech: «Доступно 5» — в наличии, 5 шт.", ai[0]);
  check(ai[1]?.price === 680 && ai[1]?.priceNote === "опт 600 ₽" && ai[1]?.article === "52700", "Aitech: розница, опт, артикул", ai[1]);
  check(ai[1]?.stock === "out" && !ai[1]?.stockText, "Aitech: цена есть, а «Доступно» нет — нет в наличии", ai[1]);
  check(ai[2]?.price === null && ai[2]?.stock === "out", "Aitech: без цены — нет в продаже", ai[2]);

  const ex = await read("extraparts", "extraparts.html", "NT156WHM-N10");
  check(ex[0]?.name === 'Матрица 15.6" NT156WHM-N10 Boe Hydis' && ex[0]?.price === 8400 && ex[0]?.stock === "out", "ExtraParts: нет в наличии", ex[0]);
  check(ex[1]?.stock === "in" && ex[1]?.stockText === "в 3 магазинах" && ex[1]?.price === 4790, "ExtraParts: в наличии в магазинах", ex[1]);
  check(ex[0]?.url === "https://extraparts.ru/catalog/nt156whm-n10/", "ExtraParts: ссылка", ex[0]?.url);

  const td = await read("3delectronics", "3delectronics.html", "NT156WHM-N45");
  check(td.length === 2 && td[0].name === "Матрица NT156WHM-N45" && td[0].price === 3700 && td[0].stock === "in", "3Delectronics: товар", td[0]);

  const ap = await read("asusparts", "asusparts.html", "x550");
  check(ap[0]?.stock === "out" && ap[0]?.price === 950 && ap[1]?.stock === "in" && ap[1]?.price === 2200, "AsusParts: наличие и цены", ap);

  const bt = await read("boottec", "boottec.html", "it5571vg");
  check(bt[0]?.name === "IT5571VG-128 CXO новый" && bt[0]?.price === 650 && bt[0]?.stock === "in", "БУТТЭК: новый в наличии", bt[0]);
  check(bt[1]?.price === 1370 && bt[1]?.stock === "out", "БУТТЭК: снятый — нет", bt[1]);
  check(bt[0]?.url === "https://www.boottec.ru/catalog/ite/it5571vg_128_cxo_novyy/", "БУТТЭК: ссылка", bt[0]?.url);

  const ac = await read("acodis", "acodis.html", "NT156WHM-N10");
  check(ac[0]?.price === 1980 && ac[0]?.stock === "unknown" && ac[0]?.stockText === "уточняйте" && ac[0]?.article === "00000007174", "Acodis: «уточняйте»", ac[0]);
  check(ac[1]?.stock === "in", "Acodis: в наличии", ac[1]);
  const acRanked = rank("IT5571VG", ac);
  check(acRanked.offers.every((o) => !o.exact), "Acodis: плата с чипом в описании — не совпадение");

  const mb = await read("moba", "moba.html", "it5571vg");
  check(mb.length === 2 && mb[0].name === "Микросхема IT5571VG-128 CXO", "Moba: товары из JSON страницы", mb.map((x) => x.name));
  check(mb[0]?.price === 700 && mb[0]?.priceNote === "по карте 590 ₽" && mb[0]?.stock === "in", "Moba: цена, цена по карте, наличие", mb[0]);
  check(mb[1]?.stock === "order" && mb[1]?.stockText === "ожидается 14.10", "Moba: «ожидается»", mb[1]);
  check(mb[0]?.url === "https://moba.ru/catalog/mikroskhemy-kontrollery-usiliteli-i-t-p/mikroskhema-it5571vg-128-cxo/", "Moba: ссылка", mb[0]?.url);
  check(extractJsonAfter('x payload: {"a":"} {","b":{"c":1}} rest', 'payload: {"a"') === '{"a":"} {","b":{"c":1}}', "JSON со скобками в строке");
  check((await read("moba", "nbzip.html", "x")).length === 0, "Moba: страница без данных — пусто, не падение");

  // Vshop: Google-таблица, две таблицы рядом, заголовки разделов без цены.
  check(JSON.stringify(parseCsv('a,"b,c","d ""e""",\r\n"x\ny",2')) === JSON.stringify([["a", "b,c", 'd "e"', ""], ["x\ny", "2"]]), "CSV: кавычки, запятая и перевод строки в ячейке");
  const vs = readSheet(fx("vshop.csv"));
  check(vs.length === 13, "Vshop: товары обеих таблиц, без заголовков разделов", vs.map((x) => x.model));
  check(!vs.some((x) => /поколение|^Zen/.test(x.model)), "Vshop: «8 поколение», «Zen 3» — не товары");
  const v10750 = vs.find((x) => x.model === "SRH8Q i7-10750H");
  check(v10750?.stock === "out" && v10750.price === "17000" && v10750.socket === "BGA1440", "Vshop: 0 — нет в наличии", v10750);
  check(vs.find((x) => x.model.startsWith("Q0GF"))?.stock === "in", "Vshop: «0/1» — есть б/у");
  check(vs.some((x) => x.model === 'Ryzen 7 5800H 100-000000295, "tray"'), "Vshop: ячейка в кавычках, двойные пробелы схлопнуты", vs.filter((x) => /5800H/.test(x.model)));
  const vsOffers = await read("vshop", "vshop.csv", "i5-8250U");
  const v8250 = vsOffers.find((x) => x.name === "SR3LA i5-8250U");
  check(v8250?.price === 7000 && v8250.stock === "in" && v8250.stockText === "New/old 27 · Kaby Lake-R · BGA1356" && v8250.url === "https://t.me/Vshop931", "Vshop: цена, наличие, ссылка на Telegram", v8250);
  check(vsOffers.find((x) => x.name.startsWith("Ryzen 5 3500H"))?.price === 7500, "Vshop: цена с пробелом");
  check(readSheet("нет,шапки\r\n1,2").length === 0, "Vshop: таблица без шапки «Модель» — пусто");
  const vshop = shopById("vshop")!;
  check(vshop.searchUrl("x").startsWith("https://docs.google.com/spreadsheets/d/") && vshop.fetchUrl!("x").endsWith("/export?format=csv&gid=0"), "Vshop: человеку — таблица, серверу — выгрузка CSV");
  let fetched = "";
  const vr = await searchShop("vshop", "i7-10750H", { fetcher: async (u) => { fetched = u; return fx("vshop.csv"); } });
  check(fetched === vshop.fetchUrl!("") && vr.url === vshop.searchUrl("") && vr.offers[0]?.name === "SRH8Q i7-10750H" && vr.offers[0].exact, "Vshop: сервер качает CSV, чип ведёт на таблицу", { fetched, vr });

  // Значки магазинов
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const ico = Buffer.from([0, 0, 1, 0, 1, 0, 16, 16]);
  check(imageType("", png) === "image/png" && imageType("text/html", ico) === "image/x-icon", "значок узнаётся по байтам");
  check(imageType("image/png", Buffer.from("<html>404</html>")) === null, "страница ошибки под видом картинки — не значок");
  check(imageType("image/svg+xml", Buffer.from("<svg><script>")) === null, "SVG не берём");
  check(imageType("", Buffer.alloc(400 * 1024, 0x89)) === null, "слишком большой — не берём");
  const asked: string[] = [];
  const web = (map: Record<string, { type: string; body: Buffer }>) => async (u: string) => {
    asked.push(u);
    const r = map[u];
    return r ? { url: u, ...r } : null;
  };
  const l1 = await fetchLogo(shopById("boottec")!, web({
    "https://www.boottec.ru/": { type: "text/html", body: Buffer.from('<head><link rel="apple-touch-icon" href="/a180.png" sizes="180x180"><link rel="icon" href="/i.svg" type="image/svg+xml"><link rel="shortcut icon" href="/fav32.png" sizes="32x32"></head>') },
    "https://www.boottec.ru/fav32.png": { type: "image/png", body: png },
  }));
  check(l1?.type === "image/png" && asked.includes("https://www.boottec.ru/fav32.png") && !asked.some((u) => u.endsWith(".svg")), "значок из <link rel=icon>, 32 px раньше 180, SVG пропущен", asked);
  asked.length = 0;
  const l2 = await fetchLogo(shopById("moba")!, web({ "https://moba.ru/favicon.ico": { type: "image/vnd.microsoft.icon", body: ico } }));
  check(l2?.type === "image/x-icon" && asked.at(-1) === "https://moba.ru/favicon.ico", "без <link> — /favicon.ico", asked);
  check((await fetchLogo(shopById("vshop")!, web({}))) === null, "Vshop — буква вместо значка");
  clearLogoCache();
  let n = 0;
  const slow = async (u: string) => { n++; await new Promise((r) => setTimeout(r, 30)); return u.endsWith("favicon.ico") ? { url: u, type: "image/x-icon", body: ico } : null; };
  const [a, b] = await Promise.all([logoFor("aitech", slow), logoFor("aitech", slow)]);
  await logoFor("aitech", slow);
  check(!!a && a === b && n === 2, "значок качается один раз и запоминается", n);
  check((await logoFor("evil", slow)) === null, "чужой код — без значка");

  // Чужая страница в любой читалке — пусто, а не падение.
  for (const s of SHOPS) {
    if (!s.read) continue;
    let ok = true;
    try {
      const got = await s.read("<html><body><p>Ничего не найдено</p></body></html>", { q: "x", fetchText: async () => "{}" });
      ok = Array.isArray(got) && got.length === 0;
    } catch {
      ok = false;
    }
    check(ok, `${s.name}: пустая страница — пустой ответ`);
  }
  check(SHOPS.filter((s) => s.id !== "vshop").every((s) => s.searchUrl("a b&c").includes("a%20b%26c")), "запрос в адресе закодирован у всех (кроме таблицы Vshop — она одна на всё)");
  check(new Set(SHOPS.map((s) => s.id)).size === SHOPS.length, "у магазинов разные коды");

  // ---------------------------------------------------------------- searchShop: кэш и ошибки
  clearCache();
  let calls = 0;
  const f: Fetcher = async () => {
    calls++;
    return fx("boottec.html");
  };
  const a1 = await searchShop("boottec", "IT5571VG", { fetcher: f });
  const a2 = await searchShop("boottec", "it5571vg ", { fetcher: f });
  check(a1.offers.length === 2 && a1.offers[0].exact && !a1.error, "поиск в магазине", a1);
  check(calls === 1 && a2.cached === true, "повтор того же запроса — из памяти", { calls, cached: a2.cached });
  await searchShop("boottec", "IT5571VG", { fetcher: f, fresh: true });
  check(calls === 2, "«обновить» идёт в магазин заново");
  const e1 = await searchShop("aitech", "x", { fetcher: async () => { throw new ShopError("не ответил за 10 с"); } });
  check(e1.error === "не ответил за 10 с" && e1.offers.length === 0, "таймаут — понятная ошибка", e1);
  let after = 0;
  await searchShop("aitech", "x", { fetcher: async () => { after++; return "<p>"; } });
  check(after === 1, "ошибка не запоминается — следующий раз снова спрашиваем");
  const e2 = await searchShop("moba", "zz", { fetcher: async () => fx("moba.html").replace('"products":[{', '"products":[{{') });
  check(!!e2.error && /читалку/.test(e2.error), "испорченная страница — «читалку нужно поправить»", e2);
  const dns = await searchShop("dns", "IT5571", { fetcher: async () => { throw new Error("не должен ходить"); } });
  check(dns.linkOnly === true && dns.url === "https://www.dns-shop.ru/search/?q=IT5571", "DNS — только ссылка, в сеть не ходим", dns);
  for (const [id, url] of [
    ["ozon", "https://www.ozon.ru/search/?text=IT5571%20VG"],
    ["wildberries", "https://www.wildberries.ru/catalog/0/search.aspx?search=IT5571%20VG"],
    ["avito", "https://www.avito.ru/rossiya?q=IT5571%20VG"],
    ["aliexpress", "https://www.aliexpress.com/wholesale?SearchText=IT5571%20VG"],
  ]) {
    const m = await searchShop(id, "IT5571 VG", { fetcher: async () => { throw new Error("не должен ходить"); } });
    check(m.linkOnly === true && m.url === url && !m.error, `${id}: только ссылка на поиск`, m);
  }

  console.log(fails ? `\nПровалов: ${fails}` : "\nВсё в порядке");
  process.exit(fails ? 1 : 0);
}

main();
