import { attrOf, parseHtml, queryAll } from "./html";
import { shopById, type Shop } from "./shops";

/**
 * Значки магазинов для окна поиска и настроек.
 *
 * Берём значок самого сайта (favicon): своих картинок в программе держать не
 * нужно, и у нового магазина значок появится сам. Браузер сотрудника на чужие
 * сайты не ходит — значок отдаёт наш сервер, один раз скачав и запомнив на
 * сутки. Не скачался — окно рисует первую букву названия.
 */

export interface Logo {
  type: string;
  body: Buffer;
}

const MAX_BYTES = 300 * 1024;
const OK_TTL = 24 * 60 * 60 * 1000;
const FAIL_TTL = 60 * 60 * 1000;
const TIMEOUT_MS = 8000;

export type BinFetcher = (url: string) => Promise<{ url: string; type: string; body: Buffer } | null>;

const fetchBin: BinFetcher = async (url) => {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
        Accept: "image/avif,image/webp,image/png,image/svg+xml,image/*,text/html;q=0.8,*/*;q=0.5",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    if (Number(res.headers.get("content-length") ?? 0) > MAX_BYTES * 4) return null;
    const body = Buffer.from(await res.arrayBuffer());
    return { url: res.url, type: (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase(), body };
  } catch {
    return null;
  }
};

/** Похоже ли на картинку: по типу или по первым байтам (ICO, PNG, GIF, JPEG). SVG не берём — в нём бывают скрипты. */
export function imageType(type: string, body: Buffer): string | null {
  if (!body.length || body.length > MAX_BYTES) return null;
  const b = body;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return "image/x-icon";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP") return "image/webp";
  // Тип в заголовке не в счёт: решают байты (сайт может отдать страницу ошибки как image/png).
  void type;
  return null;
}

function homeOf(shop: Shop): string | null {
  try {
    const u = new URL(shop.searchUrl("x"));
    return `${u.protocol}//${u.host}/`;
  } catch {
    return null;
  }
}

/** Найти и скачать значок магазина. */
export async function fetchLogo(shop: Shop, get: BinFetcher = fetchBin): Promise<Logo | null> {
  if (shop.logo === false) return null;
  const tryUrl = async (u: string) => {
    const r = await get(u);
    if (!r) return null;
    const type = imageType(r.type, r.body);
    return type ? { type, body: r.body } : null;
  };
  if (typeof shop.logo === "string") return tryUrl(shop.logo);
  const home = homeOf(shop);
  if (!home) return null;
  // Значок, объявленный страницей, обычно лучше старого favicon.ico.
  const page = await get(home);
  if (page && /html/.test(page.type) && page.body.length < 3 * 1024 * 1024) {
    const root = parseHtml(page.body.toString("utf8"));
    const links = queryAll(root, "link[rel]")
      .filter((l) => /(^|\s)(icon|apple-touch-icon)(\s|$)/i.test(attrOf(l, "rel")))
      .map((l) => ({ href: attrOf(l, "href"), sizes: attrOf(l, "sizes"), rel: attrOf(l, "rel").toLowerCase() }))
      .filter((l) => l.href && !/\.svg(\?|$)/i.test(l.href) && !l.href.startsWith("data:"));
    // Предпочитаем 32–64 px: крупный apple-touch-icon тяжёлый, 16 px — мыльный.
    const score = (l: { sizes: string; rel: string }) => {
      const n = Number(/(\d+)x/.exec(l.sizes)?.[1] ?? 0);
      return n >= 32 && n <= 96 ? 0 : l.rel.includes("apple") ? 2 : 1;
    };
    links.sort((a, b) => score(a) - score(b));
    for (const l of links.slice(0, 3)) {
      let abs: string;
      try {
        abs = new URL(l.href, page.url || home).href;
      } catch {
        continue;
      }
      if (!/^https?:/.test(abs)) continue;
      const got = await tryUrl(abs);
      if (got) return got;
    }
  }
  return tryUrl(home + "favicon.ico");
}

const cache = new Map<string, { at: number; logo: Logo | null }>();
const pending = new Map<string, Promise<Logo | null>>();

export function clearLogoCache() {
  cache.clear();
}

export async function logoFor(shopId: string, get?: BinFetcher): Promise<Logo | null> {
  const shop = shopById(shopId);
  if (!shop) return null;
  const hit = cache.get(shopId);
  if (hit && Date.now() - hit.at < (hit.logo ? OK_TTL : FAIL_TTL)) return hit.logo;
  // Десять строк окна просят один и тот же значок разом — скачиваем один раз.
  let p = pending.get(shopId);
  if (!p) {
    p = fetchLogo(shop, get)
      .catch(() => null)
      .then((logo) => {
        cache.set(shopId, { at: Date.now(), logo });
        pending.delete(shopId);
        return logo;
      });
    pending.set(shopId, p);
  }
  return p;
}
