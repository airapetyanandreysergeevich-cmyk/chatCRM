/**
 * Как выглядит карточка заказа на главном экране — «Редактор панелей заказа».
 *
 * Карточка — это список элементов сверху вниз: номер, техника, срок… У
 * каждого — показывать ли, размер шрифта, жирный, выравнивание, сколько строк
 * и ширина: вся строка, половина (две половины встают рядом) или «по тексту»
 * (встаёт рядом с соседом, как «срочный» после номера). Плюс поля карточки и
 * расстояние между строками.
 *
 * Своя раскладка у каждого сотрудника (`User.cardLayout`); владелец может
 * «Сделать так у всех» — раскладка мастерской (`Tenant.settings.cardLayout`)
 * становится общей, а личные сбрасываются. Нет ни своей, ни общей — стандартная,
 * та же, что была до редактора.
 *
 * Тот же список и те же правила — во frontend/src/lib/tile.ts.
 */

export const TILE_KEYS = [
  "number",
  "urgent",
  "color",
  "status",
  "device",
  "customer",
  "complaint",
  "due",
  "master",
  "total",
] as const;
export type TileKey = (typeof TILE_KEYS)[number];

export type TileAlign = "left" | "center" | "right";
export type TileWidth = "full" | "half" | "auto";

export interface TileElement {
  k: TileKey;
  on: boolean;
  /** Размер шрифта, px: 10–22, шаг 0,5. */
  size: number;
  bold: boolean;
  align: TileAlign;
  /** Сколько строк текста, дальше — многоточие. */
  lines: number;
  w: TileWidth;
}

export interface TileLayout {
  v: 1;
  /** Поля карточки, px. */
  pad: number;
  /** Между строками, px. */
  gap: number;
  els: TileElement[];
}

const el = (k: TileKey, on: boolean, size: number, bold: boolean, align: TileAlign, lines: number, w: TileWidth): TileElement => ({
  k,
  on,
  size,
  bold,
  align,
  lines,
  w,
});

/** Стандартная карточка — как до редактора: номер и «срочный», техника, срок и мастер. */
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

const clamp = (v: unknown, min: number, max: number, def: number, step = 1): number => {
  const n = Number(v);
  if (typeof v !== "number" || !Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.round(n / step) * step));
};
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * Привести что угодно к правильной раскладке. Кривое поле не портит
 * остальные; незнакомые элементы выбрасываем, недостающие (появятся в новых
 * версиях) встают в конец выключенными — карточка у человека не меняется сама.
 * Не раскладка вовсе — null.
 */
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

/** Что рисовать: своя → мастерской → стандартная. */
export const effectiveTile = (mine: unknown, workshop: unknown): TileLayout =>
  normalizeTile(mine) ?? normalizeTile(workshop) ?? DEFAULT_TILE;
