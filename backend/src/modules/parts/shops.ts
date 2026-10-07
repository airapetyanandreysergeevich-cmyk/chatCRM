import { attrOf, parseHtml, query, queryAll, textOf, type HNode } from "./html";

/**
 * Магазины запчастей и их «читалки».
 *
 * Каждая читалка знает адрес поиска своего магазина и где на его странице
 * лежат название, цена и наличие. Страницы магазинов меняются — тогда
 * читалка перестаёт находить товары, и в окне поиска у магазина пишется
 * «не ответил» или «ничего». Правка — обычно пара селекторов здесь, проверка —
 * backend/test/parts.ts на сохранённых образцах страниц.
 *
 * Список составлен Андреем 06.10.2026, адреса и разметка проверены в тот же
 * день настоящим браузером.
 */

export type Stock = "in" | "out" | "order" | "unknown";

export interface PartOffer {
  name: string;
  /** Цена в рублях. null — магазин цену не показал. */
  price: number | null;
  /** Вторая цена словами: «опт 1 150 ₽», «по карте 590 ₽». */
  priceNote?: string;
  stock: Stock;
  /** Как написал магазин: «в 3 магазинах», «ожидается 20.10». */
  stockText?: string;
  url: string;
  article?: string;
}

export interface Shop {
  id: string;
  name: string;
  /** Адрес для человека: «moba.ru». */
  site: string;
  /** Что там обычно ищут — подсказка в настройках. */
  about: string;
  /** Страница поиска магазина с запросом — её же открывает «Открыть на сайте». */
  searchUrl: (q: string) => string;
  /**
   * Магазин не разбираем, только даём ссылку на его поиск: страница
   * рисуется скриптами и закрыта от запросов не из браузера.
   */
  linkOnly?: boolean;
  /** Запрос, на который у магазина точно есть товары, — для «Проверить магазины». */
  probe: string;
  /** Что скачивает сервер, если это не страница для человека (таблица — её выгрузка CSV). */
  fetchUrl?: (q: string) => string;
  /** Куда магазин может перенаправить скачивание (выгрузка таблиц Google — на googleusercontent.com). */
  redirectHosts?: string[];
  /** Откуда брать значок: адрес картинки; false — буква вместо значка. По умолчанию — значок сайта. */
  logo?: string | false;
  /** Достать товары из ответа. Второй запрос (если нужен) делает сама читалка через fetchText. */
  read?: (html: string, ctx: ReadContext) => Promise<PartOffer[]> | PartOffer[];
}

export interface ReadContext {
  q: string;
  /** Скачать ещё одну страницу того же магазина (с теми же ограничениями). */
  fetchText: (url: string, init?: { method?: string; body?: string; contentType?: string }) => Promise<string>;
}

const enc = encodeURIComponent;

/** «1 280.00 руб.», «3 990 р.», «650 ₽», «1&nbsp;370» → число. */
export function parsePrice(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = /(\d[\d\s\u00a0\u202f]*)(?:[.,](\d{1,2}))?/.exec(text);
  if (!m) return null;
  const whole = Number(m[1].replace(/[\s\u00a0\u202f]/g, ""));
  if (!Number.isFinite(whole) || whole <= 0) return null;
  return whole + (m[2] ? Number(m[2].padEnd(2, "0")) / 100 : 0);
}

export const rub = (n: number) => `${Math.round(n).toLocaleString("ru-RU").replace(/[\u00a0\u202f]/g, " ")} ₽`;

function abs(href: string, base: string): string {
  try {
    return new URL(href, base).href;
  } catch {
    return base;
  }
}

/** Общий разбор «карточка → поля» для магазинов с обычной разметкой. */
function cards(
  html: string,
  base: string,
  card: string,
  pick: (c: HNode) => Omit<PartOffer, "url"> & { href: string }
): PartOffer[] {
  const root = parseHtml(html);
  const out: PartOffer[] = [];
  for (const c of queryAll(root, card)) {
    const x = pick(c);
    const { href, ...rest } = x;
    if (!rest.name) continue;
    out.push({ ...rest, url: abs(href, base) });
  }
  return out;
}

const stockFromButton = (t: string): Stock =>
  /нет в наличии|нет на складе/i.test(t) ? "out" : /в корзину|купить/i.test(t) ? "in" : "unknown";

export const SHOPS: Shop[] = [
  {
    id: "nbzip",
    name: "NBzip",
    site: "nbzip.ru",
    about: "Комплектующие для ноутбуков, мультиконтроллеры",
    searchUrl: (q) => `https://www.nbzip.ru/magazin/search/result.html?setsearchdata=1&category_id=0&search=${enc(q)}`,
    probe: "IT5571",
    read: (html) =>
      cards(html, "https://www.nbzip.ru/", "div.product", (c) => {
        const a = query(c, ".product_title a, .name a");
        const opt = parsePrice(textOf(query(c, ".grpup_2 span")));
        return {
          name: textOf(a),
          href: attrOf(a, "href"),
          price: parsePrice(textOf(query(c, ".grpup_1 span")) || textOf(query(c, ".jshop_price span"))),
          priceNote: opt ? `опт ${rub(opt)}` : undefined,
          stock: query(c, ".button_buy") ? "in" : "unknown",
        };
      }),
  },
  {
    id: "recomb",
    name: "ReComB",
    site: "recomb-omsk.ru",
    about: "Микросхемы, транзисторы, разъёмы",
    searchUrl: (q) => `https://recomb-omsk.ru/index.php?ukey=search&searchstring=${enc(q)}`,
    probe: "RT8223",
    read: async (html, ctx) => {
      const items = cards(html, "https://recomb-omsk.ru/", "form.product_brief_block", (c) => {
        const a = query(c, ".prdbrief_name a");
        return {
          name: textOf(a),
          href: attrOf(a, "href"),
          price: parsePrice(textOf(query(c, ".totalPrice"))) ?? parsePrice(attrOf(query(c, "input.product_price"), "value")),
          stock: "unknown",
        };
      });
      // Наличие и «в пути» магазин отдаёт только подсказкам поиска — отдельным запросом.
      let hint: { in_stock?: { name: string; title: string }[]; transit?: { name: string; title: string; date: string }[] } = {};
      try {
        hint = JSON.parse(
          await ctx.fetchText("https://recomb-omsk.ru/products_search.php", {
            method: "POST",
            body: `exec=product_search&query=${enc(ctx.q)}`,
            contentType: "application/x-www-form-urlencoded; charset=UTF-8",
          })
        );
      } catch {
        // Подсказки не ответили — покажем найденное без наличия.
      }
      const key = (s: string) => s.trim().toUpperCase();
      const inStock = new Set((hint.in_stock ?? []).map((x) => key(x.name)));
      const transit = new Map((hint.transit ?? []).map((x) => [key(x.name), x.date] as const));
      for (const it of items) {
        if (inStock.has(key(it.name))) it.stock = "in";
        else if (transit.has(key(it.name))) {
          it.stock = "order";
          it.stockText = `ожидается ${transit.get(key(it.name))}`;
        }
      }
      // Чего ещё нет на витрине, но едет, — тоже полезно мастеру.
      const shown = new Set(items.map((x) => key(x.name)));
      for (const t of hint.transit ?? []) {
        if (shown.has(key(t.name))) continue;
        items.push({
          name: t.title || t.name,
          price: null,
          stock: "order",
          stockText: `ожидается ${t.date}`,
          url: `https://recomb-omsk.ru/index.php?ukey=search&searchstring=${enc(ctx.q)}`,
        });
      }
      return items;
    },
  },
  {
    id: "aitech",
    name: "Aitech",
    site: "aitech1.ru",
    about: "Микросхемы, разъёмы, запчасти для ноутбуков",
    searchUrl: (q) => `https://aitech1.ru/catalog/?q=${enc(q)}`,
    probe: "IT5571",
    read: (html) =>
      cards(html, "https://aitech1.ru/", ".cat_list_item", (c) => {
        const a = query(c, "a[href]");
        const price = parsePrice(textOf(query(c, ".price1 .price")));
        const opt = parsePrice(textOf(query(c, ".price2 .price")));
        const article = textOf(query(c, ".info")).replace(/^Артикул\s*/i, "");
        return {
          name: textOf(query(c, ".name")),
          href: attrOf(a, "href"),
          article: article || undefined,
          price,
          priceNote: opt ? `опт ${rub(opt)}` : undefined,
          // Наличие — только надпись «Доступно N» над карточкой. Цену магазин
          // показывает и у того, чего нет: на странице товара вместо «В
          // корзину» у такого — «Сообщить о поступлении». Без цены — тоже нет.
          ...aitechStock(textOf(query(c, ".available_quantity__catalog")), price),
        };
      }),
  },
  {
    id: "extraparts",
    name: "ExtraParts",
    site: "extraparts.ru",
    about: "Матрицы, клавиатуры, аккумуляторы, блоки питания",
    searchUrl: (q) => `https://extraparts.ru/search/?q=${enc(q)}`,
    probe: "A31N1319",
    read: (html) =>
      cards(html, "https://extraparts.ru/", "li.catalog__item", (c) => {
        const st = textOf(query(c, ".search__item-stock"));
        const n = /в\s+(\d+)\s+магазин/i.exec(st);
        return {
          name: textOf(query(c, ".catalog__item-name")),
          href: attrOf(query(c, "a.catalog__item-link, a[href]"), "href"),
          price: parsePrice(textOf(query(c, ".catalog__item-price"))),
          stock: /нет в наличии/i.test(st) ? "out" : n || /в наличии/i.test(st) ? "in" : "unknown",
          stockText: n ? `в ${n[1]} ${Number(n[1]) === 1 ? "магазине" : "магазинах"}` : undefined,
        };
      }),
  },
  {
    id: "3delectronics",
    name: "3Delectronics",
    site: "3delectronics.ru",
    about: "Запчасти для ноутбуков и планшетов",
    searchUrl: (q) => `https://3delectronics.ru/search/?search=${enc(q)}`,
    probe: "NT156WHM",
    read: (html) =>
      cards(html, "https://3delectronics.ru/", "#products .thumbnail", (c) => {
        const a = query(c, ".product_name a");
        return {
          name: textOf(a),
          href: attrOf(a, "href"),
          price: parsePrice(textOf(query(c, ".list-price"))),
          stock: stockFromButton(textOf(query(c, ".btn-cart, .price-active, .price-noactive"))),
        };
      }),
  },
  {
    id: "asusparts",
    name: "AsusParts",
    site: "asusparts.ru",
    about: "Оригинальные запчасти Asus",
    searchUrl: (q) => `https://asusparts.ru/search/?search=${enc(q)}`,
    probe: "X550",
    read: (html) =>
      cards(html, "https://asusparts.ru/", ".product-grid .list-right", (c) => {
        const a = query(c, ".name a");
        return {
          name: textOf(a),
          href: attrOf(a, "href"),
          price: parsePrice(textOf(query(c, ".price"))),
          stock: stockFromButton(textOf(query(c, ".cart"))),
        };
      }),
  },
  {
    id: "boottec",
    name: "БУТТЭК",
    site: "boottec.ru",
    about: "Микросхемы и запчасти, новые и снятые",
    searchUrl: (q) => `https://www.boottec.ru/catalog/?q=${enc(q)}`,
    probe: "IT5571",
    read: (html) =>
      cards(html, "https://www.boottec.ru/", ".product-item", (c) => {
        const a = query(c, ".product-item-title a");
        return {
          name: textOf(a),
          href: attrOf(a, "href"),
          price: parsePrice(textOf(query(c, ".product-item-price-current"))),
          stock: stockFromButton(textOf(query(c, ".product-item-button-container"))),
        };
      }),
  },
  {
    id: "acodis",
    name: "Acodis",
    site: "acodis.ru",
    about: "Матрицы, платы, комплектующие для ноутбуков и телефонов",
    searchUrl: (q) => `https://acodis.ru/search/?search=${enc(q)}`,
    probe: "NT156WHM-N10",
    read: (html) =>
      cards(html, "https://acodis.ru/", ".product-thumb", (c) => {
        const a = query(c, "h4 a, .caption a");
        const meta = attrOf(query(c, "meta[itemprop=price]"), "content");
        const avail = textOf(query(c, ".attr_i_4")).replace(/^Наличие:\s*/i, "");
        const article = textOf(query(c, ".attr_i_3")).replace(/^Артикул:\s*/i, "");
        return {
          name: textOf(a),
          href: attrOf(a, "href"),
          article: article || undefined,
          price: parsePrice(meta) ?? parsePrice(textOf(query(c, ".price"))),
          stock: /нет/i.test(avail) ? "out" : /в наличии|есть/i.test(avail) ? "in" : "unknown",
          stockText: avail && !/^(в наличии|есть)$/i.test(avail) ? avail.toLowerCase() : undefined,
        };
      }),
  },
  {
    id: "moba",
    name: "Moba",
    site: "moba.ru",
    about: "Запчасти для телефонов и планшетов, микросхемы",
    searchUrl: (q) => `https://moba.ru/catalog/?q=${enc(q)}`,
    probe: "IT5571",
    read: (html) => {
      // Карточки рисует скрипт страницы, но данные лежат в ней же одним JSON.
      const json = extractJsonAfter(html, "payload: {\"products\":");
      if (!json) return [];
      const data = JSON.parse(json) as {
        products?: {
          name: string;
          link?: string;
          article?: string;
          price?: number;
          discountPrice?: number | null;
          meta?: { available?: boolean; willArrive?: string };
        }[];
      };
      return (data.products ?? []).map((p) => ({
        name: p.name,
        url: abs(p.link ?? "/", "https://moba.ru/"),
        article: p.article,
        price: typeof p.price === "number" && p.price > 0 ? p.price : null,
        priceNote: p.discountPrice ? `по карте ${rub(p.discountPrice)}` : undefined,
        stock: p.meta?.available ? "in" : p.meta?.willArrive ? "order" : "out",
        stockText: !p.meta?.available && p.meta?.willArrive ? p.meta.willArrive.toLowerCase() : undefined,
      }));
    },
  },
  // Маркетплейсы: только ссылкой. Их страницы рисуются скриптами и закрыты защитой
  // от роботов; обходить её мы не станем — открываем их поиск в браузере.
  {
    id: "ozon",
    name: "Ozon",
    site: "ozon.ru",
    about: "Маркетплейс. Только ссылка на поиск",
    searchUrl: (q) => `https://www.ozon.ru/search/?text=${enc(q)}`,
    linkOnly: true,
    probe: "",
  },
  {
    id: "wildberries",
    name: "Wildberries",
    site: "wildberries.ru",
    about: "Маркетплейс. Только ссылка на поиск",
    searchUrl: (q) => `https://www.wildberries.ru/catalog/0/search.aspx?search=${enc(q)}`,
    linkOnly: true,
    probe: "",
  },
  {
    id: "avito",
    name: "Авито",
    site: "avito.ru",
    about: "Объявления по всей России, в том числе б/у и снятое. Только ссылка на поиск",
    searchUrl: (q) => `https://www.avito.ru/rossiya?q=${enc(q)}`,
    linkOnly: true,
    probe: "",
  },
  {
    id: "aliexpress",
    name: "AliExpress",
    site: "aliexpress.com",
    about: "Заказ из Китая, дольше, но дешевле. Только ссылка на поиск",
    searchUrl: (q) => `https://www.aliexpress.com/wholesale?SearchText=${enc(q)}`,
    linkOnly: true,
    probe: "",
  },
  {
    // Поставщик Андрея: прайс — Google-таблица, заказ — сообщением в Telegram.
    id: "vshop",
    name: "Vshop",
    site: "@Vshop931",
    about: "Процессоры для ноутбуков, прайс в Google-таблице. Заказ — сообщением @Vshop931 в Telegram",
    searchUrl: () => VSHOP_SHEET,
    fetchUrl: () => `${VSHOP_SHEET_BASE}/export?format=csv&gid=0`,
    redirectHosts: ["googleusercontent.com"],
    logo: false,
    probe: "i7",
    read: (csv) =>
      readSheet(csv).map((r) => ({
        name: r.model,
        price: parsePrice(r.price),
        stock: r.stock,
        stockText: [r.newOld && `New/old ${r.newOld}`, r.gen, r.socket].filter(Boolean).join(" · ") || undefined,
        url: "https://t.me/Vshop931",
      })),
  },
  {
    id: "dns",
    name: "DNS",
    site: "dns-shop.ru",
    about: "Сетевой магазин электроники. Только ссылка на поиск",
    searchUrl: (q) => `https://www.dns-shop.ru/search/?q=${enc(q)}`,
    linkOnly: true,
    probe: "",
  },
];

/**
 * JSON-объект, который начинается в тексте сразу после метки (метка включает
 * открывающую «{»). Считаем скобки, не путаясь в скобках внутри строк.
 */
export function extractJsonAfter(text: string, marker: string): string | null {
  const k = text.indexOf(marker);
  if (k < 0) return null;
  const start = text.indexOf("{", k);
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export const shopById = (id: string) => SHOPS.find((s) => s.id === id);

// ------------------------------------------------------------ Google-таблица Vshop

const VSHOP_SHEET_BASE = "https://docs.google.com/spreadsheets/d/1T1O__26xh7jo-DqgBTF7BsnxMIAh8oIziUskkQ3e76c";
const VSHOP_SHEET = `${VSHOP_SHEET_BASE}/edit?gid=0#gid=0`;

/** CSV по правилам таблиц: запятые, кавычки, "" внутри кавычек, переводы строк внутри ячейки. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += c;
      continue;
    }
    if (c === '"') q = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export interface SheetRow {
  model: string;
  price: string;
  newOld: string;
  gen: string;
  socket: string;
  stock: Stock;
}

/**
 * Прайс Vshop: несколько таблиц рядом (Intel слева, AMD справа), у каждой шапка
 * «Модель, Магазин, New/old, Поколение, Сокет». Строки без цены — заголовки
 * разделов («8 поколение», «Zen 3»), их пропускаем. New/old — сколько есть новых
 * и б/у («0/1»); все нули — нет в наличии.
 */
export function readSheet(csv: string): SheetRow[] {
  const rows = parseCsv(csv);
  const head = rows.findIndex((r) => r.some((c) => c.trim().toLowerCase() === "модель"));
  if (head < 0) return [];
  const starts = rows[head].map((c, i) => (c.trim().toLowerCase() === "модель" ? i : -1)).filter((i) => i >= 0);
  const out: SheetRow[] = [];
  for (const r of rows.slice(head + 1)) {
    for (const c of starts) {
      const model = (r[c] ?? "").replace(/\s+/g, " ").trim();
      const price = (r[c + 1] ?? "").trim();
      if (!model || !price || !/\d/.test(price)) continue;
      const newOld = (r[c + 2] ?? "").trim();
      const nums = newOld.match(/\d+/g)?.map(Number) ?? [];
      out.push({
        model,
        price,
        newOld,
        gen: (r[c + 3] ?? "").trim(),
        socket: (r[c + 4] ?? "").trim(),
        stock: !nums.length ? "unknown" : nums.some((n) => n > 0) ? "in" : "out",
      });
    }
  }
  return out;
}

/** Aitech: «Доступно 5» — в наличии, нет надписи — нет в наличии. */
function aitechStock(available: string, price: number | null): { stock: Stock; stockText?: string } {
  const n = available.match(/(\d+)/);
  if (n && Number(n[1]) > 0) return { stock: "in", stockText: `${n[1]} шт.` };
  return { stock: "out", stockText: price ? undefined : "цены нет" };
}
