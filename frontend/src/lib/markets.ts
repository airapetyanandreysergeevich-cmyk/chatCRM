import type { PartOffer } from "./partsApi";

/**
 * Окно площадок программы FineCRM (desktop/src/markets.js).
 *
 * Ozon, Wildberries, Авито, AliExpress, DNS сервер не спрашивает — они закрыты
 * от роботов. В программе они открываются в её окне, где ищет человек; кнопка
 * «Показать списком» присылает сюда товары с открытой страницы. Здесь они
 * хранятся до перезагрузки страницы, по площадке и запросу, и окно поиска
 * показывает их вместе с остальными магазинами.
 */

export interface MarketOffers {
  shop: string;
  query: string;
  url: string;
  offers: Array<Omit<PartOffer, "exact">>;
}

export interface MarketsBridge {
  open: (req: { shop: string; query: string; urls: Record<string, string> }) => Promise<{ ok: boolean; error?: string }>;
  onOffers: (fn: (data: MarketOffers) => void) => () => void;
}

export const marketsBridge = (): MarketsBridge | null =>
  (typeof window !== "undefined" && window.finecrmDesktop?.markets) || null;

const store = new Map<string, MarketOffers & { at: number }>();
const listeners = new Set<() => void>();
let subscribed = false;

const norm = (q: string) => q.trim().replace(/\s+/g, " ").toLowerCase();

function ensureSubscribed() {
  const b = marketsBridge();
  if (!b || subscribed) return;
  subscribed = true;
  b.onOffers((data) => {
    if (!data || typeof data.shop !== "string" || !Array.isArray(data.offers)) return;
    store.set(data.shop, { ...data, at: Date.now() });
    listeners.forEach((fn) => fn());
  });
}

/** Подписаться на приход товаров из окна площадок. Возвращает отписку. */
export function watchMarkets(fn: () => void): () => void {
  ensureSubscribed();
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Что прислало окно площадки по этому запросу. */
export function marketOffers(shop: string, query: string) {
  const e = store.get(shop);
  return e && norm(e.query) === norm(query) ? e : null;
}

/** Окно открыли заново по этой площадке — прежний список по ней больше не верен. */
export function forgetMarket(shop: string) {
  store.delete(shop);
  listeners.forEach((fn) => fn());
}

// ---- то же совпадение, что на сервере (backend/src/modules/parts/search.ts)

export function compact(s: string): string {
  return s.toUpperCase().replace(/Ё/g, "Е").replace(/[^0-9A-ZА-Я]/g, "");
}

export function matches(q: string, offer: { name: string; article?: string }): boolean {
  const hay = compact(`${offer.name} ${offer.article ?? ""}`);
  const words = q.split(/\s+/).map(compact).filter((w) => w.length >= 2);
  return words.length > 0 && words.every((w) => hay.includes(w));
}
