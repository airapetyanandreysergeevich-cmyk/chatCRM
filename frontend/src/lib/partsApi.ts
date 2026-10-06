import { api } from "./api";

/**
 * Агент поиска запчастей (backend/src/modules/parts).
 *
 * Окно поиска спрашивает магазины по одному и параллельно: ответ каждого
 * появляется сразу, медленный сайт не держит остальные.
 */

export type PartStock = "in" | "out" | "order" | "unknown";

export interface PartShop {
  id: string;
  name: string;
  site: string;
  about: string;
  /** Только ссылка на поиск магазина — разобрать его страницу нельзя. */
  linkOnly: boolean;
  /** Запрос для «Проверить магазины». */
  probe: string;
  enabled: boolean;
}

export interface PartOffer {
  name: string;
  price: number | null;
  priceNote?: string;
  stock: PartStock;
  stockText?: string;
  url: string;
  article?: string;
  exact: boolean;
}

export interface ShopResult {
  shop: string;
  url: string;
  offers: PartOffer[];
  more: number;
  ms: number;
  error?: string;
  linkOnly?: boolean;
  cached?: boolean;
}

export const partsApi = {
  shops: () => api.get<{ personal: boolean; shops: PartShop[] }>("/parts/shops"),
  saveShops: (off: string[]) => api.put<{ off: string[] }>("/parts/shops", { off }),
  search: (shop: string, q: string, fresh = false) =>
    api.get<ShopResult>(`/parts/search?shop=${encodeURIComponent(shop)}&q=${encodeURIComponent(q)}${fresh ? "&fresh=1" : ""}`),
};

export const STOCK_LABEL: Record<PartStock, string> = {
  in: "в наличии",
  order: "ожидается",
  unknown: "наличие уточнять",
  out: "нет в наличии",
};
