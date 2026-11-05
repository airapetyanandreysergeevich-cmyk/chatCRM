/**
 * Бланк «Редактора бланков» (05.11.2026): лист с элементами в миллиметрах.
 *
 * Этот файл — один и тот же в двух местах:
 *   backend/src/modules/blanks/blankModel.ts   — сервер чистит то, что сохраняют;
 *   frontend/src/lib/blankModel.ts             — редактор и печать, импорт файла.
 * Правите один — копируете во второй (проверка — backend/test/doc-layouts.ts).
 * Зависимостей нет: ни DOM, ни Node.
 *
 * Всё, что приходит снаружи (сохранение, файл от другой мастерской), проходит
 * cleanDesign: числа зажаты в пределы, лишние поля выброшены, HTML текста —
 * только разрешённые теги и стили, картинки — только data:image/… или «logo».
 */

export const BLANK_FORMAT = "finecrm-blank";
export const BLANK_VERSION = 1;

export type Target = "order" | "sale";
export type DocUse = "intake" | "act" | "extra" | "sale";
export const USES_OF: Record<Target, DocUse[]> = { order: ["intake", "act", "extra"], sale: ["sale"] };

export type FontKey = "pt-sans" | "pt-serif" | "roboto" | "pt-mono" | "arial" | "times";
export const FONTS: Array<{ key: FontKey; name: string; css: string }> = [
  { key: "pt-sans", name: "PT Sans", css: '"PT Sans", Arial, sans-serif' },
  { key: "pt-serif", name: "PT Serif", css: '"PT Serif", "Times New Roman", serif' },
  { key: "roboto", name: "Roboto", css: 'Roboto, Arial, sans-serif' },
  { key: "pt-mono", name: "PT Mono", css: '"PT Mono", "Courier New", monospace' },
  { key: "arial", name: "Arial", css: "Arial, Helvetica, sans-serif" },
  { key: "times", name: "Times New Roman", css: '"Times New Roman", Times, serif' },
];
export const fontCss = (k: string | undefined) => (FONTS.find((f) => f.key === k) ?? FONTS[0]).css;

export type Align = "left" | "center" | "right" | "justify";
export type VAlign = "top" | "middle" | "bottom";
export type LineStyle = "solid" | "dashed" | "dotted";

export interface Stroke {
  /** Толщина, мм. */
  w: number;
  color: string;
  style: LineStyle;
}

/** Рамка текста: со всех сторон, только снизу (поле «под запись»), сверху и снизу. */
export type Sides = "all" | "bottom" | "top" | "tb";

export interface TextStyle {
  font: FontKey;
  /** пт */
  size: number;
  leading: number;
  color: string;
  align: Align;
  valign: VAlign;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  upper: boolean;
  fill: string | null;
  border: (Stroke & { sides: Sides }) | null;
  /** Внутренний отступ, мм. */
  pad: number;
}

interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Закреплён: мышью не двигается. */
  locked?: boolean;
}

export interface TextEl extends Box {
  type: "text";
  /** HTML из разрешённых тегов; поле из базы — <span data-f="ключ"></span>. */
  html: string;
  st: TextStyle;
  /** Высота по тексту: длинный текст растягивает рамку и сдвигает всё, что ниже. */
  grow: boolean;
  /** Абзац, где все поля пустые, не печатается («Второй телефон: —»). */
  hideEmpty: boolean;
}

export interface LineEl extends Box {
  type: "line";
  dir: "h" | "v";
  stroke: Stroke;
  /** Линия отреза: ✂ в начале. */
  cut: boolean;
}

export interface RectEl extends Box {
  type: "rect";
  stroke: Stroke | null;
  fill: string | null;
  /** Скругление, мм. */
  radius: number;
}

export interface ImageEl extends Box {
  type: "image";
  /** data:image/…;base64 или «logo» — логотип из «Настройки → Бланки». */
  src: string;
  fit: "contain" | "cover" | "fill";
}

export type TableSource = "works" | "parts" | "lines" | "items" | "extraWorks" | "extraParts";
export type ColKey = "no" | "name" | "sku" | "qty" | "price" | "sum" | "warranty";

export interface TableCol {
  key: ColKey;
  title: string;
  /** мм */
  w: number;
  align: "left" | "center" | "right";
}

export interface TableEl extends Box {
  type: "table";
  source: TableSource;
  cols: TableCol[];
  st: {
    font: FontKey;
    size: number;
    color: string;
    /** Сетка: все линии, только между строками, без линий. */
    grid: "all" | "rows" | "none";
    headBold: boolean;
    headFill: string | null;
    /** Отступ в ячейке, мм. */
    pad: number;
  };
  /** Строка «Итого» под таблицей — сумма столбца «Сумма». */
  total: boolean;
  totalLabel: string;
  /** Пустой список — строка «Нет». */
  emptyText: string;
}

export interface CodeEl extends Box {
  type: "code";
  kind: "code128" | "qr";
  /** Что зашито: текст с полями — «{number}», ссылка на отзыв… Штрихкод — только цифры. */
  value: string;
  /** Цифры под штрихкодом. */
  caption: boolean;
}

export type BlankEl = TextEl | LineEl | RectEl | ImageEl | TableEl | CodeEl;
export type ElType = BlankEl["type"];

export interface BlankDesign {
  v: 1;
  page: { size: "A4" | "A5"; landscape: boolean; /** Поля листа, мм: граница для элементов и переноса на новый лист. */ margin: number };
  els: BlankEl[];
}

/** Файл обмена бланками между мастерскими. */
export interface BlankFile {
  format: typeof BLANK_FORMAT;
  v: number;
  name: string;
  target: Target;
  design: BlankDesign;
  exportedAt?: string;
}

// ------------------------------------------------------------ пределы

export const LIMITS = {
  els: 300,
  html: 20_000,
  image: 1_500_000, // знаков data:URL ≈ 1,1 МБ картинки
  imagesTotal: 4_000_000,
  name: 60,
  cols: 8,
  value: 500,
};

export const PAGE_MM: Record<"A4" | "A5", [number, number]> = { A4: [210, 297], A5: [148, 210] };
export const pageSize = (p: BlankDesign["page"]): [number, number] => {
  const [w, h] = PAGE_MM[p.size];
  return p.landscape ? [h, w] : [w, h];
};

export const FIELD_KEY = /^[a-zA-Z][a-zA-Z0-9]{0,39}$/;

// ------------------------------------------------------------ умолчания

export const DEFAULT_TEXT: TextStyle = {
  font: "pt-sans",
  size: 10,
  leading: 1.25,
  color: "#000000",
  align: "left",
  valign: "top",
  bold: false,
  italic: false,
  underline: false,
  upper: false,
  fill: null,
  border: null,
  pad: 0,
};

export const DEFAULT_STROKE: Stroke = { w: 0.3, color: "#000000", style: "solid" };

export const emptyDesign = (): BlankDesign => ({ v: 1, page: { size: "A4", landscape: false, margin: 10 }, els: [] });

// ------------------------------------------------------------ чистка

const num = (v: unknown, min: number, max: number, d: number) => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return d;
  return Math.round(Math.min(max, Math.max(min, n)) * 100) / 100;
};
const str = (v: unknown, max: number, d = "") => (typeof v === "string" ? v.slice(0, max) : d);
const bool = (v: unknown, d = false) => (typeof v === "boolean" ? v : d);
const oneOf = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d);
const COLOR = /^#[0-9a-fA-F]{6}$/;
const color = (v: unknown, d: string) => (typeof v === "string" && COLOR.test(v) ? v.toLowerCase() : d);
const colorOrNull = (v: unknown) => (typeof v === "string" && COLOR.test(v) ? v.toLowerCase() : null);
const FONT_KEYS = FONTS.map((f) => f.key);
const ID = /^[a-zA-Z0-9_-]{1,40}$/;

let seq = 0;
export const newId = () => "e" + Date.now().toString(36) + (seq++).toString(36) + Math.random().toString(36).slice(2, 6);

function stroke(v: unknown, d: Stroke | null): Stroke | null {
  if (!v || typeof v !== "object") return d;
  const s = v as Record<string, unknown>;
  return { w: num(s.w, 0.05, 5, 0.3), color: color(s.color, "#000000"), style: oneOf(s.style, ["solid", "dashed", "dotted"] as const, "solid") };
}

function textStyle(v: unknown): TextStyle {
  const s = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const b = s.border && typeof s.border === "object" ? (s.border as Record<string, unknown>) : null;
  return {
    font: oneOf(s.font, FONT_KEYS, DEFAULT_TEXT.font),
    size: num(s.size, 4, 72, DEFAULT_TEXT.size),
    leading: num(s.leading, 0.8, 3, DEFAULT_TEXT.leading),
    color: color(s.color, DEFAULT_TEXT.color),
    align: oneOf(s.align, ["left", "center", "right", "justify"] as const, "left"),
    valign: oneOf(s.valign, ["top", "middle", "bottom"] as const, "top"),
    bold: bool(s.bold),
    italic: bool(s.italic),
    underline: bool(s.underline),
    upper: bool(s.upper),
    fill: colorOrNull(s.fill),
    border: b ? { ...(stroke(b, DEFAULT_STROKE) as Stroke), sides: oneOf(b.sides, ["all", "bottom", "top", "tb"] as const, "all") } : null,
    pad: num(s.pad, 0, 20, 0),
  };
}

const COL_KEYS: ColKey[] = ["no", "name", "sku", "qty", "price", "sum", "warranty"];
const SOURCES: TableSource[] = ["works", "parts", "lines", "items", "extraWorks", "extraParts"];

/** Один элемент: неизвестный тип и битые поля — null (элемент выбрасывается). */
export function cleanEl(v: unknown, page: [number, number]): BlankEl | null {
  if (!v || typeof v !== "object") return null;
  const e = v as Record<string, unknown>;
  const [pw, ph] = page;
  const box: Box = {
    id: typeof e.id === "string" && ID.test(e.id) ? e.id : newId(),
    x: num(e.x, -pw, pw * 2, 10),
    y: num(e.y, -ph, ph * 2, 10),
    w: num(e.w, 0.5, pw * 2, 40),
    h: num(e.h, 0.5, ph * 4, 10),
  };
  if (e.locked === true) box.locked = true;
  switch (e.type) {
    case "text":
      return { ...box, type: "text", html: sanitizeHtml(str(e.html, LIMITS.html * 2)).slice(0, LIMITS.html), st: textStyle(e.st), grow: bool(e.grow), hideEmpty: bool(e.hideEmpty, true) };
    case "line":
      return { ...box, type: "line", dir: e.dir === "v" ? "v" : "h", stroke: stroke(e.stroke, DEFAULT_STROKE) as Stroke, cut: bool(e.cut) };
    case "rect":
      return { ...box, type: "rect", stroke: e.stroke === null ? null : stroke(e.stroke, DEFAULT_STROKE), fill: colorOrNull(e.fill), radius: num(e.radius, 0, 50, 0) };
    case "image": {
      const src = cleanImage(e.src);
      if (!src) return null;
      return { ...box, type: "image", src, fit: oneOf(e.fit, ["contain", "cover", "fill"] as const, "contain") };
    }
    case "table": {
      const st = (e.st && typeof e.st === "object" ? e.st : {}) as Record<string, unknown>;
      const cols = (Array.isArray(e.cols) ? e.cols : [])
        .slice(0, LIMITS.cols)
        .map((c) => {
          const o = (c && typeof c === "object" ? c : {}) as Record<string, unknown>;
          if (!COL_KEYS.includes(o.key as ColKey)) return null;
          return { key: o.key as ColKey, title: str(o.title, 40), w: num(o.w, 3, 400, 20), align: oneOf(o.align, ["left", "center", "right"] as const, "left") };
        })
        .filter((c): c is TableCol => !!c);
      if (!cols.length) return null;
      return {
        ...box,
        type: "table",
        source: oneOf(e.source, SOURCES, "lines"),
        cols,
        st: {
          font: oneOf(st.font, FONT_KEYS, "pt-sans"),
          size: num(st.size, 5, 24, 9.5),
          color: color(st.color, "#000000"),
          grid: oneOf(st.grid, ["all", "rows", "none"] as const, "all"),
          headBold: bool(st.headBold, true),
          headFill: colorOrNull(st.headFill),
          pad: num(st.pad, 0, 10, 1.2),
        },
        total: bool(e.total),
        totalLabel: str(e.totalLabel, 40, "Итого"),
        emptyText: str(e.emptyText, 60, "Нет"),
      };
    }
    case "code":
      return { ...box, type: "code", kind: e.kind === "qr" ? "qr" : "code128", value: str(e.value, LIMITS.value, "{number}"), caption: bool(e.caption, true) };
    default:
      return null;
  }
}

/** Бланк целиком — то, что можно сохранить и напечатать. */
export function cleanDesign(v: unknown): BlankDesign {
  const d = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const p = (d.page && typeof d.page === "object" ? d.page : {}) as Record<string, unknown>;
  const page = { size: oneOf(p.size, ["A4", "A5"] as const, "A4"), landscape: bool(p.landscape), margin: num(p.margin, 0, 40, 10) };
  const size = pageSize(page);
  const els: BlankEl[] = [];
  const ids = new Set<string>();
  let images = 0;
  for (const raw of Array.isArray(d.els) ? d.els.slice(0, LIMITS.els) : []) {
    const el = cleanEl(raw, size);
    if (!el) continue;
    if (el.type === "image" && el.src !== "logo") {
      images += el.src.length;
      if (images > LIMITS.imagesTotal) continue;
    }
    if (ids.has(el.id)) el.id = newId();
    ids.add(el.id);
    els.push(el);
  }
  return { v: 1, page, els };
}

const IMAGE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
export function cleanImage(v: unknown): string | null {
  if (v === "logo") return "logo";
  if (typeof v !== "string" || v.length > LIMITS.image) return null;
  return IMAGE.test(v) ? v : null;
}

// ------------------------------------------------------------ HTML текста

const TAGS = new Set(["div", "p", "br", "span", "b", "strong", "i", "em", "u", "s", "ul", "ol", "li"]);
const VOID = new Set(["br"]);

/** Разрешённые свойства style и проверка значения. */
const STYLE_OK: Record<string, (v: string) => string | null> = {
  "font-family": (v) => {
    const f = FONTS.find((x) => v.toLowerCase().includes(x.name.toLowerCase()));
    return f ? f.css : null;
  },
  "font-size": (v) => {
    const m = /^(\d{1,3}(?:\.\d{1,2})?)(pt|px)$/.exec(v);
    if (!m) return null;
    const pt = m[2] === "px" ? (Number(m[1]) * 72) / 96 : Number(m[1]);
    return pt >= 4 && pt <= 72 ? `${Math.round(pt * 10) / 10}pt` : null;
  },
  "font-weight": (v) => (/^(bold|bolder|normal|[1-9]00)$/.test(v) ? v : null),
  "font-style": (v) => (/^(italic|normal)$/.test(v) ? v : null),
  "text-decoration": (v) => (/^(underline|line-through|none)( (underline|line-through))?$/.test(v) ? v : null),
  "text-decoration-line": (v) => (/^(underline|line-through|none)( (underline|line-through))?$/.test(v) ? v : null),
  color: (v) => cssColor(v),
  "background-color": (v) => cssColor(v),
  "text-align": (v) => (/^(left|center|right|justify|start|end)$/.test(v) ? v : null),
  "line-height": (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0.8 && n <= 3 ? String(Math.round(n * 100) / 100) : null;
  },
  "text-transform": (v) => (/^(uppercase|none)$/.test(v) ? v : null),
};

function cssColor(v: string): string | null {
  if (/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(v)) return v.toLowerCase();
  const m = /^rgba?\((\d{1,3}),\s*(\d{1,3}),\s*(\d{1,3})(?:,\s*(0|1|0?\.\d+))?\)$/.exec(v);
  if (!m) return null;
  if (m[4] !== undefined && Number(m[4]) === 0) return "transparent";
  const hex = [m[1], m[2], m[3]].map((x) => Math.min(255, Number(x)).toString(16).padStart(2, "0")).join("");
  return `#${hex}`;
}

function cleanStyle(raw: string): string {
  const out: string[] = [];
  for (const part of raw.split(";")) {
    const i = part.indexOf(":");
    if (i < 0) continue;
    const prop = part.slice(0, i).trim().toLowerCase();
    const val = part.slice(i + 1).trim().replace(/\s*!important$/i, "").replace(/\s+/g, " ").toLowerCase();
    const check = STYLE_OK[prop];
    if (!check) continue;
    const ok = check(prop === "font-family" ? part.slice(i + 1).trim() : val);
    if (ok && ok !== "transparent") out.push(`${prop}: ${ok}`);
  }
  return out.join("; ");
}

const attr = (tag: string, name: string): string | null => {
  const re = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = re.exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : null;
};

const decodeAttr = (v: string) => v.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const escText = (s: string) => s.replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Разрешённые теги и стили, остальное — текстом или прочь. Поле из базы
 * (<span data-f="ключ">) хранится пустым: подпись в редакторе и значение при
 * печати подставляются заново. Скрипты, обработчики, ссылки, картинки внутри
 * текста — не проходят.
 */
export function sanitizeHtml(input: string): string {
  let out = "";
  const stack: string[] = [];
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|<[a-zA-Z/!?][^>]*>?/g;
  let last = 0;
  let skip = 0; // внутри <script>/<style>/поля — текст выбрасываем
  let m: RegExpExecArray | null;
  const push = (text: string) => {
    if (!skip) out += escText(text);
  };
  while ((m = re.exec(input))) {
    push(input.slice(last, m.index));
    last = re.lastIndex;
    const [, close, rawTag, rest] = m;
    if (!rawTag) continue; // комментарий или обломок тега
    const tag = rawTag.toLowerCase();
    if (tag === "script" || tag === "style" || tag === "title" || tag === "head") {
      if (close) skip = Math.max(0, skip - 1);
      else if (!/\/\s*$/.test(rest)) skip += 1;
      continue;
    }
    if (!TAGS.has(tag)) {
      // <font>, <a>, <o:p> из Word — сам тег прочь, текст остаётся
      continue;
    }
    if (close) {
      const at = Math.max(stack.lastIndexOf(tag), tag === "span" ? stack.lastIndexOf("field") : -1);
      if (at < 0) continue;
      while (stack.length > at) {
        const t = stack.pop()!;
        if (t === "field") {
          skip = Math.max(0, skip - 1);
          out += "</span>";
        } else out += `</${t}>`;
      }
      continue;
    }
    if (VOID.has(tag)) {
      if (!skip) out += "<br>";
      continue;
    }
    if (skip) continue;
    const field = tag === "span" ? attr(rest, "data-f") : null;
    if (field !== null) {
      const key = decodeAttr(field);
      if (FIELD_KEY.test(key)) {
        out += `<span data-f="${key}">`;
        stack.push("field");
        skip += 1;
        if (/\/\s*$/.test(rest)) {
          stack.pop();
          skip -= 1;
          out += "</span>";
        }
        continue;
      }
    }
    const style = attr(rest, "style");
    const css = style ? cleanStyle(decodeAttr(style)) : "";
    out += css ? `<${tag} style="${css.replace(/"/g, "&quot;")}">` : `<${tag}>`;
    stack.push(tag);
  }
  push(input.slice(last));
  while (stack.length) {
    const t = stack.pop()!;
    out += t === "field" ? "</span>" : `</${t}>`;
  }
  return out;
}

/** Ключи полей, на которые ссылается бланк: в тексте и в штрихкодах. */
export function fieldsUsed(d: BlankDesign): string[] {
  const set = new Set<string>();
  for (const e of d.els) {
    if (e.type === "text") for (const m of e.html.matchAll(/data-f="([a-zA-Z0-9]+)"/g)) set.add(m[1]);
    if (e.type === "code") for (const m of e.value.matchAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g)) set.add(m[1]);
  }
  return [...set];
}
