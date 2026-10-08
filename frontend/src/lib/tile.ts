import { api } from "./api";

/**
 * Карточка заказа на главном экране — «Редактор панелей заказа».
 * Те же правила, что на сервере: backend/src/modules/summary/tile.ts.
 */

export const TILE_KEYS = ["number", "urgent", "color", "status", "device", "customer", "complaint", "due", "master", "total"] as const;
export type TileKey = (typeof TILE_KEYS)[number];
export type TileAlign = "left" | "center" | "right";
export type TileWidth = "full" | "half" | "auto";

export interface TileElement {
  k: TileKey;
  on: boolean;
  size: number;
  bold: boolean;
  align: TileAlign;
  lines: number;
  w: TileWidth;
}

export interface TileLayout {
  v: 1;
  pad: number;
  gap: number;
  els: TileElement[];
}

export const TILE_LABEL: Record<TileKey, string> = {
  number: "Номер заказа",
  urgent: "Срочный",
  color: "Метка клиента",
  status: "Статус",
  device: "Техника",
  customer: "Клиент",
  complaint: "Неисправность",
  due: "Срок",
  master: "Мастер",
  total: "Сумма",
};

/** У каких элементов есть смысл в «строках» — у остальных текст короткий всегда. */
export const MULTILINE: ReadonlySet<TileKey> = new Set<TileKey>(["device", "customer", "complaint", "status", "master"]);

export const WIDTH_LABEL: Record<TileWidth, string> = { full: "Вся строка", half: "Половина", auto: "По тексту" };

const el = (k: TileKey, on: boolean, size: number, bold: boolean, align: TileAlign, lines: number, w: TileWidth): TileElement => ({
  k,
  on,
  size,
  bold,
  align,
  lines,
  w,
});

export const DEFAULT_TILE: TileLayout = {
  v: 1,
  pad: 12,
  gap: 6,
  els: [
    el("number", true, 13, true, "left", 1, "auto"),
    el("urgent", true, 11, true, "left", 1, "auto"),
    el("color", false, 12, false, "left", 1, "auto"),
    el("status", false, 12, false, "left", 1, "auto"),
    el("device", true, 14, true, "left", 1, "full"),
    el("customer", false, 13, false, "left", 1, "full"),
    el("complaint", false, 12, false, "left", 2, "full"),
    el("due", true, 12, false, "left", 1, "half"),
    el("master", true, 12, false, "right", 1, "half"),
    el("total", false, 12, true, "right", 1, "half"),
  ],
};

const clamp = (v: unknown, min: number, max: number, def: number, step = 1): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v / step) * step)) : def;
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export function normalizeTile(raw: unknown): TileLayout | null {
  const p = obj(raw);
  if (!Array.isArray(p.els)) return null;
  const seen = new Set<TileKey>();
  const els: TileElement[] = [];
  for (const item of p.els) {
    const e = obj(item);
    const k = e.k as TileKey;
    if (!(TILE_KEYS as readonly string[]).includes(k) || seen.has(k)) continue;
    seen.add(k);
    const d = DEFAULT_TILE.els.find((x) => x.k === k)!;
    els.push({
      k,
      on: typeof e.on === "boolean" ? e.on : d.on,
      size: clamp(e.size, 10, 22, d.size, 0.5),
      bold: typeof e.bold === "boolean" ? e.bold : d.bold,
      align: e.align === "left" || e.align === "center" || e.align === "right" ? e.align : d.align,
      lines: clamp(e.lines, 1, 3, d.lines),
      w: e.w === "full" || e.w === "half" || e.w === "auto" ? e.w : d.w,
    });
  }
  for (const d of DEFAULT_TILE.els) if (!seen.has(d.k)) els.push({ ...d, on: false });
  return { v: 1, pad: clamp(p.pad, 4, 24, DEFAULT_TILE.pad), gap: clamp(p.gap, 0, 16, DEFAULT_TILE.gap), els };
}

/**
 * Строки карточки. «Вся строка» — своя строка; две «половины» встают рядом;
 * «по тексту» встаёт рядом с соседями. Половина без пары растягивается на
 * всю ширину — иначе «Мастер» справа оказался бы посередине карточки.
 */
export function tileRows<T extends { w: TileWidth }>(items: T[]): T[][] {
  const rows: T[][] = [];
  let cur: T[] = [];
  let halves = 0;
  const flush = () => {
    if (cur.length) rows.push(cur);
    cur = [];
    halves = 0;
  };
  for (const it of items) {
    if (it.w === "full") {
      flush();
      rows.push([it]);
    } else if (it.w === "half") {
      if (halves === 2) flush();
      cur.push(it);
      halves++;
    } else {
      cur.push(it);
    }
  }
  flush();
  return rows;
}

export const sameTile = (a: TileLayout | null, b: TileLayout | null) => JSON.stringify(a) === JSON.stringify(b);

export interface TileState {
  mine: TileLayout | null;
  workshop: TileLayout | null;
  effective: TileLayout;
  personal: boolean;
  canShare: boolean;
  money: boolean;
  contacts: boolean;
}

export const tileApi = {
  get: () => api.get<TileState>("/summary/tile"),
  save: (tile: TileLayout | null) => api.put<Omit<TileState, "personal" | "canShare" | "money" | "contacts">>("/summary/tile", { tile }),
  share: (tile: TileLayout | null) =>
    api.put<Omit<TileState, "personal" | "canShare" | "money" | "contacts">>("/summary/tile/workshop", { tile }),
};
