import { SHOPS, shopById, type PartOffer, type Shop } from "./shops";

/**
 * Поиск запчасти в одном магазине.
 *
 * Окно поиска спрашивает магазины по одному и параллельно — ответы
 * появляются по мере прихода, и медленный сайт не держит остальные.
 *
 * Сервер ходит в магазин только по нажатию «Найти» и запоминает ответ на час:
 * нагрузка на магазин та же, что от мастера, открывшего сайт сам.
 */

export interface Offer extends PartOffer {
  /** Название совпадает с запросом. Остальное магазин предложил «похожим». */
  exact: boolean;
}

export interface ShopResult {
  shop: string;
  /** Страница поиска магазина — «Открыть на сайте». */
  url: string;
  offers: Offer[];
  /** Сколько похожих (не совпавших) отброшено сверх лимита. */
  more: number;
  ms: number;
  error?: string;
  linkOnly?: boolean;
  cached?: boolean;
}

export const TIMEOUT_MS = 10_000;
const MAX_BYTES = 4 * 1024 * 1024;
const TTL_MS = 60 * 60 * 1000;
const CACHE_MAX = 500;
const LIMIT_EXACT = 25;
const LIMIT_OTHER = 10;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.6",
};

/** Буквы и цифры заглавными, без пробелов и чёрточек: «IT5571VG-128 CXO» → «IT5571VG128CXO». */
export function compact(s: string): string {
  return s
    .toUpperCase()
    .replace(/Ё/g, "Е")
    .replace(/[^0-9A-ZА-Я]/g, "");
}

/**
 * Совпадает ли товар с запросом: каждое слово запроса есть в названии или
 * артикуле. «it5571vg» находит «IT5571VG-128 CXO», «NT156WHM-N10» не находит
 * «NT156WHM-N42» и материнскую плату, где чип упомянут только в описании.
 */
export function matches(q: string, offer: Pick<PartOffer, "name" | "article">): boolean {
  const hay = compact(`${offer.name} ${offer.article ?? ""}`);
  const words = q
    .split(/\s+/)
    .map(compact)
    .filter((w) => w.length >= 2);
  if (!words.length) return false;
  return words.every((w) => hay.includes(w));
}

const STOCK_ORDER = { in: 0, order: 1, unknown: 2, out: 3 } as const;

export function rank(q: string, offers: PartOffer[]): { offers: Offer[]; more: number } {
  const seen = new Set<string>();
  const marked: Offer[] = [];
  for (const o of offers) {
    // Один и тот же товар магазин иногда выводит дважды (витрина + «популярное»).
    const k = `${o.url}|${o.name}|${o.price}`;
    if (seen.has(k)) continue;
    seen.add(k);
    marked.push({ ...o, exact: matches(q, o) });
  }
  const order = (a: Offer, b: Offer) =>
    STOCK_ORDER[a.stock] - STOCK_ORDER[b.stock] || (a.price ?? Infinity) - (b.price ?? Infinity);
  const exact = marked.filter((o) => o.exact).sort(order).slice(0, LIMIT_EXACT);
  const other = marked.filter((o) => !o.exact);
  return { offers: [...exact, ...other.slice(0, LIMIT_OTHER)], more: Math.max(0, other.length - LIMIT_OTHER) };
}

// ------------------------------------------------------------ сеть

export class ShopError extends Error {}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function decode(buf: ArrayBuffer, contentType: string | null): string {
  let cs = /charset=["']?([\w-]+)/i.exec(contentType ?? "")?.[1];
  const tryDecode = (label: string) => {
    try {
      return new TextDecoder(label).decode(buf);
    } catch {
      return null;
    }
  };
  let text = tryDecode(cs ?? "utf-8") ?? tryDecode("utf-8")!;
  if (!cs) {
    const meta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(text.slice(0, 4096))?.[1];
    if (meta && !/utf-?8/i.test(meta)) {
      cs = meta;
      text = tryDecode(meta) ?? text;
    }
  }
  return text;
}

export type Fetcher = (url: string, init?: { method?: string; body?: string; contentType?: string }) => Promise<string>;

/** Скачать страницу магазина: таймаут, потолок размера, только свой домен. */
export function makeFetcher(shop: Shop): Fetcher {
  const own = hostOf((shop.fetchUrl ?? shop.searchUrl)("x"));
  const okAfterRedirect = (h: string) => h === own || (shop.redirectHosts ?? []).some((x) => h === x || h.endsWith("." + x));
  return async (url, init) => {
    if (hostOf(url) !== own) throw new ShopError("чужой адрес");
    let res: Response;
    try {
      res = await fetch(url, {
        method: init?.method ?? "GET",
        body: init?.body,
        headers: { ...HEADERS, ...(init?.contentType ? { "Content-Type": init.contentType, "X-Requested-With": "XMLHttpRequest" } : {}) },
        redirect: "follow",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      const name = (e as Error)?.name;
      if (name === "TimeoutError" || name === "AbortError") throw new ShopError(`не ответил за ${TIMEOUT_MS / 1000} с`);
      throw new ShopError("сайт недоступен");
    }
    if (!okAfterRedirect(hostOf(res.url))) throw new ShopError("перенаправил на другой сайт");
    if (res.status === 403 || res.status === 429 || res.status === 503)
      throw new ShopError("не пустил запрос — защита от роботов");
    if (!res.ok) throw new ShopError(`ответил ошибкой ${res.status}`);
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > MAX_BYTES) throw new ShopError("слишком большая страница");
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) throw new ShopError("слишком большая страница");
    return decode(buf, res.headers.get("content-type"));
  };
}

// ------------------------------------------------------------ кэш

const cache = new Map<string, { at: number; result: ShopResult }>();

export function clearCache() {
  cache.clear();
}

/** Поиск в одном магазине. fetcher подменяется в тестах. */
export async function searchShop(shopId: string, rawQ: string, opts: { fetcher?: Fetcher; fresh?: boolean } = {}): Promise<ShopResult> {
  const shop = shopById(shopId);
  if (!shop) throw new ShopError("нет такого магазина");
  const q = rawQ.trim().replace(/\s+/g, " ");
  const url = shop.searchUrl(q);
  if (shop.linkOnly || !shop.read) return { shop: shop.id, url, offers: [], more: 0, ms: 0, linkOnly: true };

  const key = `${shop.id}|${compact(q)}|${q.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && !opts.fresh && Date.now() - hit.at < TTL_MS) return { ...hit.result, cached: true };

  const t0 = Date.now();
  const fetcher = opts.fetcher ?? makeFetcher(shop);
  try {
    const html = await fetcher((shop.fetchUrl ?? shop.searchUrl)(q));
    const raw = await shop.read(html, { q, fetchText: fetcher });
    const { offers, more } = rank(q, raw);
    const result: ShopResult = { shop: shop.id, url, offers, more, ms: Date.now() - t0 };
    cache.set(key, { at: Date.now(), result });
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
    return result;
  } catch (e) {
    // Ошибки не запоминаем: магазин мог просто моргнуть.
    const msg = e instanceof ShopError ? e.message : "страница изменилась — читалку нужно поправить";
    return { shop: shop.id, url, offers: [], more: 0, ms: Date.now() - t0, error: msg };
  }
}

export const SHOP_IDS = SHOPS.map((s) => s.id);
