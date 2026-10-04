import type { LabelData } from "../components/Label";
import type { LabelField, LabelSettings } from "./labels";

/**
 * Свой макет наклейки: какие элементы где стоят.
 *
 * Координаты — миллиметры внутри содержимого наклейки: без «Повернуть» это
 * сама этикетка, с ним — она же, повёрнутая (ширина и высота меняются
 * местами). Размер шрифта — в пунктах, как в любом редакторе текста.
 *
 * Макет не рисуется с нуля: «Свой макет» начинается с автоматической
 * раскладки (autoLayout), переведённой в элементы, — человек двигает то, что
 * уже видел на бумаге. Сервер хранит то же самое (backend printing/labels.ts).
 */

export const PT = 25.4 / 72; // мм в пункте

export const EL_KINDS = [
  "logo",
  "workshop",
  "number",
  "counter",
  "item",
  "client",
  "phone",
  "device",
  "serial",
  "complaint",
  "date",
  "due",
  "code",
] as const;
export type ElKind = (typeof EL_KINDS)[number];

export interface LayoutEl {
  kind: ElKind;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Пункты. */
  size?: number;
  bold?: boolean;
  align?: "left" | "center" | "right";
  lines?: number;
  upper?: boolean;
}

export interface LabelLayout {
  /** Размер содержимого, под который нарисован макет, мм. */
  w: number;
  h: number;
  elements: LayoutEl[];
}

export const EL_NAME: Record<ElKind, string> = {
  logo: "Логотип",
  workshop: "Название мастерской",
  number: "Номер заказа",
  counter: "«1/3»",
  item: "Вещь из комплекта",
  client: "Клиент",
  phone: "Телефон",
  device: "Техника",
  serial: "Серийный номер",
  complaint: "Неисправность",
  date: "Дата приёма",
  due: "Срок",
  code: "Штрихкод",
};

/** Какой галочкой «Что напечатать» включается элемент. Штрихкод есть всегда. */
export const FIELD_OF: Record<ElKind, LabelField | null> = {
  logo: "logo",
  workshop: "workshop",
  number: "number",
  counter: "item",
  item: "item",
  client: "client",
  phone: "phone",
  device: "device",
  serial: "serial",
  complaint: "complaint",
  date: "date",
  due: "due",
  code: null,
};

export const isText = (k: ElKind) => k !== "logo" && k !== "code";
export const elOn = (s: Pick<LabelSettings, "fields">, k: ElKind) => {
  const f = FIELD_OF[k];
  return f === null || s.fields[f];
};

/** Размер содержимого: с поворотом ширина и высота меняются местами. */
export const contentSize = (s: Pick<LabelSettings, "width" | "height" | "rotate">) =>
  s.rotate ? { iw: s.height, ih: s.width } : { iw: s.width, ih: s.height };

/** Что написано в текстовом элементе. null — сейчас нечего (у техники нет «1/3», серийного нет). */
export function elText(kind: ElKind, d: LabelData): string | null {
  switch (kind) {
    case "workshop":
      return d.workshop || null;
    case "number":
      return d.number;
    case "counter":
      return d.item && d.item.total > 1 ? `${d.item.index}/${d.item.total}` : null;
    case "item":
      return d.item?.accessory ? d.item.title : null;
    case "client":
      return d.client || null;
    case "phone":
      return d.phone ? `…${d.phone}` : null;
    case "device":
      return d.device || null;
    case "serial":
      return d.serial ? `S/N ${d.serial}` : null;
    case "complaint":
      return d.complaint || null;
    case "date":
      return d.date ? `Принят ${d.date}` : null;
    case "due":
      return d.due ? `Срок ${d.due}` : null;
    default:
      return null;
  }
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const r1 = (v: number) => Math.round(v * 10) / 10;
const LH = 1.18;

/**
 * Автоматическая раскладка элементами — те же размеры, что рисует
 * автоматическая наклейка (components/Label.tsx), только каждая строка —
 * отдельный элемент, который можно двигать.
 */
export function autoLayout(s: LabelSettings, numberLen = 12): LabelLayout {
  const { iw, ih } = contentSize(s);
  const f = s.fields;
  const pad = clamp(Math.min(s.width, s.height) * 0.045, 1.2, 2.4);
  const cw = iw - pad * 2;
  const ch = ih - pad * 2;
  const qr = s.code === "qr";
  const qrSide = Math.min(ch, cw * 0.45);
  const textX = qr ? pad + qrSide + pad : pad;
  const textW = qr ? cw - qrSide - pad : cw;
  const base = clamp(Math.min(ch * 0.08, cw * 0.06, (qr ? textW : cw) / 11), 1.9, 3.6);
  const small = base * 0.82;
  const counterSize = base * 1.35;
  const counterW = f.item ? counterSize * 2.6 + base : 0;
  const big = Math.max(1.9, Math.min(base * 1.75, (textW - counterW) / (Math.max(6, numberLen) * 0.62)));
  const gap = base * 0.12;
  const els: LayoutEl[] = [];
  const text = (kind: ElKind, x: number, y: number, w: number, sizeMm: number, extra: Partial<LayoutEl> = {}) => {
    const lines = extra.lines ?? 1;
    const el: LayoutEl = { kind, x: r1(x), y: r1(y), w: r1(w), h: r1(sizeMm * LH * lines + 0.2), size: r1(sizeMm / PT), align: "left", lines, ...extra };
    els.push(el);
    return el.h;
  };

  let y = pad;
  if (qr) els.push({ kind: "code", x: r1(pad), y: r1(pad), w: r1(qrSide), h: r1(qrSide) });

  // шапка: логотип и название
  if (f.logo || f.workshop) {
    const logoH = clamp(small * 1.5, 2.6, ch * 0.2);
    const logoW = f.workshop ? Math.min(textW * 0.45, logoH * 2.6) : Math.min(textW, logoH * 4);
    let rowH = 0;
    if (f.logo) {
      els.push({ kind: "logo", x: r1(textX), y: r1(y), w: r1(logoW), h: r1(logoH), align: "left" });
      rowH = logoH;
    }
    if (f.workshop) {
      const x = f.logo ? textX + logoW + base * 0.6 : textX;
      const h = small * LH;
      text("workshop", x, f.logo ? y + (logoH - h) / 2 : y, textX + textW - x, small, { bold: true, upper: true });
      rowH = Math.max(rowH, h);
    }
    y += rowH + gap;
  }
  // номер и «1/3» — по нижнему краю строки, как в автоматической наклейке
  if (f.number || f.item) {
    const nh = big * LH + 0.2;
    const chh = counterSize * LH + 0.2;
    const rowH = Math.max(f.number ? nh : 0, f.item ? chh : 0);
    if (f.number) text("number", textX, y + rowH - nh, textW - counterW, big, { bold: true });
    if (f.item) text("counter", textX + textW - counterW, y + rowH - chh, counterW, counterSize, { bold: true, align: "right" });
    y += rowH + gap;
  }
  if (!qr) {
    const h = clamp(ch * 0.27, 5, 14);
    els.push({ kind: "code", x: r1(pad), y: r1(y), w: r1(cw), h: r1(h) });
    y += h + gap;
  }
  if (f.item) y += text("item", textX, y, textW, base * 1.15, { bold: true }) + gap;
  if (f.client || f.phone) {
    const both = f.client && f.phone;
    const split = both ? textW * 0.64 : textW;
    let h = 0;
    if (f.client) h = text("client", textX, y, split, base, { bold: true });
    if (f.phone) h = text("phone", textX + (both ? split : 0), y, both ? textW - split : textW, base, { bold: true, align: both ? "right" : "left" });
    y += h + gap;
  }
  if (f.device) y += text("device", textX, y, textW, base) + gap;
  if (f.serial) y += text("serial", textX, y, textW, small) + gap;
  if (f.complaint) y += text("complaint", textX, y, textW, small, { lines: 2 }) + gap;
  if (f.date || f.due) {
    const both = f.date && f.due;
    if (f.date) text("date", textX, y, both ? textW / 2 : textW, small, { bold: true });
    if (f.due) text("due", textX + (both ? textW / 2 : 0), y, both ? textW / 2 : textW, small, { bold: true, align: both ? "right" : "left" });
  }
  return { w: iw, h: ih, elements: els };
}

/** Сменили размер этикетки — макет растягивается следом; шрифт — по меньшему из растяжений. */
export function scaleLayout(l: LabelLayout, iw: number, ih: number): LabelLayout {
  if (Math.abs(l.w - iw) < 0.01 && Math.abs(l.h - ih) < 0.01) return l;
  const kx = iw / l.w, ky = ih / l.h, k = Math.min(kx, ky);
  return {
    w: iw,
    h: ih,
    elements: l.elements.map((e) => ({
      ...e,
      x: r1(e.x * kx),
      y: r1(e.y * ky),
      w: r1(Math.max(0.5, e.w * kx)),
      h: r1(Math.max(0.5, e.h * ky)),
      ...(e.size ? { size: r1(clamp(e.size * k, 3, 72)) } : {}),
    })),
  };
}

const overlaps = (a: LayoutEl, b: LayoutEl) =>
  a.x < b.x + b.w - 0.05 && b.x < a.x + a.w - 0.05 && a.y < b.y + b.h - 0.05 && b.y < a.y + a.h - 0.05;

/** Пары элементов, которые заметно налезают друг на друга (больше полумиллиметра в обе стороны). */
export function overlapping(l: LabelLayout, s: Pick<LabelSettings, "fields">): Array<[ElKind, ElKind]> {
  const shown = l.elements.filter((e) => elOn(s, e.kind));
  const out: Array<[ElKind, ElKind]> = [];
  for (let i = 0; i < shown.length; i++)
    for (let j = i + 1; j < shown.length; j++) {
      const a = shown[i], b = shown[j];
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ox > 0.5 && oy > 0.5) out.push([a.kind, b.kind]);
    }
  return out;
}

/** Свободное место для нового элемента: сначала там, где его поставила бы автоматика, потом ниже/выше, потом где угодно. */
function placeFree(e: LayoutEl, taken: LayoutEl[], iw: number, ih: number): LayoutEl {
  const free = (c: LayoutEl) => !taken.some((t) => overlaps(c, t));
  if (free(e)) return e;
  const xs = [e.x, ...Array.from({ length: Math.max(0, Math.floor((iw - e.w) / 0.5)) + 1 }, (_, i) => i * 0.5)];
  for (const x of xs)
    for (let y = 0; y + e.h <= ih + 0.01; y += 0.5) {
      const c = { ...e, x: r1(x), y: r1(y) };
      if (free(c)) return c;
    }
  return e; // места нет — встанет поверх, человек подвинет
}

/**
 * Макет, в котором есть всё включённое: включили галочку, а элемента в
 * макете ещё не было — он встаёт туда, где его поставила бы автоматическая
 * раскладка, а если там уже что-то стоит — на ближайшее свободное место.
 * Выключенные элементы остаются в макете (включат снова — вернутся на своё
 * место), но не рисуются.
 */
export function ensureElements(l: LabelLayout, s: LabelSettings): LabelLayout {
  const have = new Set(l.elements.map((e) => e.kind));
  const missing = EL_KINDS.filter((k) => elOn(s, k) && !have.has(k));
  if (!missing.length) return l;
  const auto = autoLayout(s);
  const taken = l.elements.filter((e) => elOn(s, e.kind));
  const add: LayoutEl[] = [];
  for (const e of auto.elements.filter((x) => missing.includes(x.kind))) {
    const placed = placeFree(e, [...taken, ...add], l.w, l.h);
    add.push(placed);
  }
  return { ...l, elements: [...l.elements, ...add] };
}

/** Макет для печати по настройке: свой (подогнанный под размер) или null — автоматическая. */
export function activeLayout(s: LabelSettings): LabelLayout | null {
  if (s.mode !== "custom" || !s.layout) return null;
  const { iw, ih } = contentSize(s);
  return ensureElements(scaleLayout(s.layout, iw, ih), s);
}
