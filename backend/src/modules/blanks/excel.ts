import ExcelJS from "exceljs";
import { knownOf, listsOf, marksOf, MARK_RE, norm, ROW_NO, suggest, type ListDef, type Target } from "./marks";

/**
 * Свои бланки из Excel (03.11.2026): разбор шаблона, заполнение и лист для
 * печати в браузере.
 *
 *   шаблон .xlsx с {метками}
 *        ↓ fill(): метки → данные заказа; строка с {работа…} — по строке на работу
 *   заполненная книга ──→ .xlsx (скачать, поправить в Excel)
 *        └──────────────→ toHtml(): таблица с ширинами, высотами, объединениями,
 *                          шрифтами, рамками, заливкой и картинками — печать из браузера
 */

// ------------------------------------------------------------------ разбор

export interface Scan {
  known: string[];
  unknown: Array<{ mark: string; suggest: string | null }>;
  lists: string[];
  sheets: number;
}

type Cell = ExcelJS.Cell;

/** Текст ячейки, в которой могут быть метки: строка или «богатый» текст. */
function cellText(c: Cell): string | null {
  const v = c.value as unknown;
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && Array.isArray((v as { richText?: unknown }).richText)) {
    return ((v as { richText: Array<{ text: string }> }).richText).map((r) => r.text).join("");
  }
  return null;
}

export async function loadBook(buf: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
  } catch {
    throw new Error("Файл не читается как книга Excel (.xlsx). Сохраните его в Excel как «Книга Excel (*.xlsx)»");
  }
  if (!wb.worksheets.length) throw new Error("В книге нет листов");
  return wb;
}

export async function scan(buf: Buffer, target: Target): Promise<Scan> {
  const wb = await loadBook(buf);
  const k = knownOf(target);
  const known = new Set<string>();
  const unknown = new Map<string, string | null>();
  const lists = new Set<string>();
  for (const ws of visibleSheets(wb)) {
    ws.eachRow({ includeEmpty: false }, (row) =>
      row.eachCell({ includeEmpty: false }, (c) => {
        const t = cellText(c);
        if (!t) return;
        for (const m of t.matchAll(MARK_RE)) {
          const key = norm(m[1]);
          if (key === ROW_NO) known.add(ROW_NO);
          else if (k.scalar.has(key)) known.add(k.scalar.get(key)!.key);
          else if (k.list.has(key)) {
            known.add(k.list.get(key)!.field.key);
            lists.add(k.list.get(key)!.list.title);
          } else unknown.set(m[1].trim(), suggest(m[1], target));
        }
      })
    );
  }
  return {
    known: [...known],
    unknown: [...unknown.entries()].map(([mark, s]) => ({ mark, suggest: s })),
    lists: [...lists],
    sheets: visibleSheets(wb).length,
  };
}

/** Видимые листы. Лист «Метки» — памятка из нашего образца, его не печатаем. */
const visibleSheets = (wb: ExcelJS.Workbook) =>
  wb.worksheets.filter((ws) => ws.state !== "hidden" && ws.state !== "veryHidden" && norm(ws.name) !== "метки");

// ------------------------------------------------------------------ заполнение

export interface FillData {
  /** Метка (как в каталоге) → текст. Деньги — числом. */
  values: Record<string, string | number>;
  /** Ключ списка («работа») → строки: метка поля → значение. */
  lists: Record<string, Array<Record<string, string | number>>>;
  /** Метки-деньги: ячейка из одной такой метки станет числом с форматом. */
  money: Set<string>;
}

export const MONEY_FMT = '#,##0 "₽";-#,##0 "₽"';
const MONEY_FMT_KOP = '#,##0.00 "₽";-#,##0.00 "₽"';

export const rubText = (n: number) =>
  `${(Math.round(n * 100) / 100).toLocaleString("ru-RU", { minimumFractionDigits: Number.isInteger(Math.round(n * 100) / 100) ? 0 : 2, maximumFractionDigits: 2 }).replace(/[  ]/g, " ")} ₽`;

/** Заменить метки в ячейке. Ячейка — одна метка-деньги → число с форматом. */
function fillCell(c: Cell, lookup: (key: string) => string | number | undefined, money: Set<string>) {
  const v = c.value as unknown;
  const replaceIn = (s: string) =>
    s.replace(MARK_RE, (all, raw: string) => {
      const x = lookup(norm(raw));
      if (x === undefined) return all;
      return typeof x === "number" ? rubText(x) : x;
    });
  if (typeof v === "string") {
    const only = /^\s*\{([^{}\n]{1,40})\}\s*$/.exec(v);
    if (only && money.has(norm(only[1]))) {
      const x = lookup(norm(only[1]));
      if (typeof x === "number") {
        c.value = x;
        if (!c.numFmt || c.numFmt === "General") c.numFmt = Number.isInteger(x) ? MONEY_FMT : MONEY_FMT_KOP;
        return;
      }
    }
    if (MARK_RE.test(v)) {
      MARK_RE.lastIndex = 0;
      c.value = replaceIn(v);
    }
    MARK_RE.lastIndex = 0;
    return;
  }
  if (v && typeof v === "object" && Array.isArray((v as { richText?: unknown }).richText)) {
    const rt = (v as { richText: Array<{ text: string; font?: unknown }> }).richText.map((r) => ({ ...r, text: replaceIn(r.text) }));
    c.value = { richText: rt } as ExcelJS.CellRichTextValue;
  }
}

interface Merge {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

function parseRange(r: string): Merge | null {
  const m = /^\$?([A-Z]+)\$?(\d+):\$?([A-Z]+)\$?(\d+)$/i.exec(r.trim());
  if (!m) return null;
  const col = (s: string) => s.toUpperCase().split("").reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
  return { top: Number(m[2]), left: col(m[1]), bottom: Number(m[4]), right: col(m[3]) };
}

function mergesOf(ws: ExcelJS.Worksheet): Merge[] {
  const raw = ((ws as unknown as { model: { merges?: string[] } }).model.merges ?? []) as string[];
  return raw.map(parseRange).filter((m): m is Merge => !!m);
}

/** Какой список у строки: по первой метке списка в ней. */
function listOfRow(row: ExcelJS.Row, lists: ListDef[]): ListDef | null {
  const fields = new Map<string, ListDef>();
  for (const l of lists) for (const f of l.fields) fields.set(norm(f.key), l);
  let found: ListDef | null = null;
  row.eachCell({ includeEmpty: false }, (c) => {
    if (found) return;
    const t = cellText(c);
    if (!t) return;
    for (const m of t.matchAll(MARK_RE)) {
      const l = fields.get(norm(m[1]));
      if (l) {
        found = l;
        return;
      }
    }
  });
  return found;
}

export async function fill(buf: Buffer, target: Target, data: FillData): Promise<ExcelJS.Workbook> {
  const wb = await loadBook(buf);
  const lists = listsOf(target);
  const scalars = new Map(Object.entries(data.values).map(([k, v]) => [norm(k), v]));
  for (const ws of visibleSheets(wb)) {
    // Строки-списки — снизу вверх: вставка строк не сдвигает ещё не обработанные выше.
    const listRows: Array<{ r: number; list: ListDef }> = [];
    ws.eachRow({ includeEmpty: false }, (row, r) => {
      const l = listOfRow(row, lists);
      if (l) listRows.push({ r, list: l });
    });
    for (const { r, list } of listRows.sort((a, b) => b.r - a.r)) {
      const items = data.lists[list.key] ?? [];
      const n = Math.max(1, items.length);
      if (n > 1) insertCopies(ws, r, n - 1);
      for (let i = 0; i < n; i++) {
        const item = items[i];
        const values = new Map<string, string | number>(item ? Object.entries(item).map(([k, v]) => [norm(k), v]) : []);
        if (item) values.set(ROW_NO, String(i + 1));
        const row = ws.getRow(r + i);
        row.eachCell({ includeEmpty: false }, (c) =>
          // Пустой список — строка остаётся, метки списка стираются.
          fillCell(c, (k) => values.get(k) ?? (item ? scalars.get(k) : lists.some((l) => l.fields.some((f) => norm(f.key) === k)) || k === ROW_NO ? "" : scalars.get(k)), data.money)
        );
      }
    }
    ws.eachRow({ includeEmpty: false }, (row) => row.eachCell({ includeEmpty: false }, (c) => fillCell(c, (k) => scalars.get(k), data.money)));
  }
  // Формулы (СУММ по таблице работ) Excel пересчитает при открытии.
  (wb as unknown as { calcProperties: { fullCalcOnLoad?: boolean } }).calcProperties = { fullCalcOnLoad: true };
  return wb;
}

/**
 * Вставить count копий строки r под ней — с оформлением, высотой и
 * объединёнными ячейками. Объединения ниже сдвигаем сами: exceljs при
 * вставке строк их не двигает.
 */
function insertCopies(ws: ExcelJS.Worksheet, r: number, count: number) {
  const merges = mergesOf(ws);
  for (const m of merges) {
    try {
      ws.unMergeCells(m.top, m.left, m.bottom, m.right);
    } catch {
      /* уже разъединено */
    }
  }
  const height = ws.getRow(r).height;
  ws.duplicateRow(r, count, true);
  for (let i = 1; i <= count; i++) if (height) ws.getRow(r + i).height = height;
  const again = (m: Merge) => {
    try {
      ws.mergeCells(m.top, m.left, m.bottom, m.right);
    } catch {
      /* пересеклось — оставляем без объединения */
    }
  };
  for (const m of merges) {
    if (m.top === r && m.bottom === r) {
      for (let i = 0; i <= count; i++) again({ ...m, top: r + i, bottom: r + i });
    } else if (m.top > r) again({ ...m, top: m.top + count, bottom: m.bottom + count });
    else if (m.bottom >= r) again({ ...m, bottom: m.bottom + count });
    else again(m);
  }
  // Область печати (и сквозные строки) — растягивается вместе со списком,
  // иначе подписи и дата под таблицей обрезались (найдено 04.11.2026).
  const ps = ws.pageSetup as { printArea?: string; printTitlesRow?: string };
  if (ps.printArea) ps.printArea = shiftRows(ps.printArea, r, count);
  if (ps.printTitlesRow) ps.printTitlesRow = shiftRows(ps.printTitlesRow, r, count);
  // Картинки ниже строки — тоже вниз.
  for (const img of ws.getImages()) {
    const a = img.range as unknown as { tl: { nativeRow: number }; br?: { nativeRow: number } };
    try {
      if (a.tl.nativeRow >= r) {
        a.tl.nativeRow += count;
        if (a.br) a.br.nativeRow += count;
      }
    } catch {
      /* картинка без привязки к ячейкам */
    }
  }
}

/**
 * Диапазоны вида «A1:G30», «$A$1:$G$30», «1:3», несколько через запятую или
 * «&&»: после вставки count строк под строкой r всё, что ниже r, едет вниз,
 * а диапазон, захватывающий строку r, — растягивается.
 */
export function shiftRows(ranges: string, r: number, count: number): string {
  return ranges
    .split(/(,|&&)/)
    .map((part) => {
      if (part === "," || part === "&&") return part;
      const refs = part.split(":");
      const rows = refs.map((ref) => Number(/\$?(\d+)$/.exec(ref.trim())?.[1] ?? NaN));
      return refs
        .map((ref, i) => {
          const row = rows[i];
          if (!Number.isFinite(row)) return ref;
          const isBottom = i === refs.length - 1 && refs.length > 1;
          const moves = row > r || (isBottom && row >= r && (rows[0] ?? row) <= r);
          return moves ? ref.replace(/(\$?)(\d+)$/, (_, d) => `${d}${row + count}`) : ref;
        })
        .join(":");
    })
    .join("");
}

export async function toBuffer(wb: ExcelJS.Workbook): Promise<Buffer> {
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ------------------------------------------------------------------ лист для печати

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot", "'": "#39" }[c]};`);

const argb = (c?: { argb?: string; theme?: number } | null, fallback = "") => {
  const a = c?.argb;
  if (a && /^[0-9a-f]{8}$/i.test(a)) return "#" + a.slice(2);
  if (a && /^[0-9a-f]{6}$/i.test(a)) return "#" + a;
  return fallback;
};

const BORDER: Record<string, string> = {
  thin: "1px solid",
  hair: "1px dotted",
  dotted: "1px dotted",
  dashed: "1px dashed",
  dashDot: "1px dashed",
  dashDotDot: "1px dashed",
  medium: "2px solid",
  mediumDashed: "2px dashed",
  mediumDashDot: "2px dashed",
  mediumDashDotDot: "2px dashed",
  slantDashDot: "2px dashed",
  thick: "3px solid",
  double: "3px double",
};

/** Число по формату ячейки — главное: знаки после запятой, разряды, «₽» или «р.» в кавычках. */
export function formatNumber(v: number, fmt?: string): string {
  if (!fmt || fmt === "General") return String(Math.round(v * 1e6) / 1e6).replace(".", ",");
  const part = fmt.split(";")[v < 0 && fmt.includes(";") ? 1 : 0] ?? fmt;
  if (/%/.test(part)) {
    const d = (/0\.(0+)/.exec(part)?.[1].length ?? 0);
    return (Math.abs(v) * 100).toFixed(d).replace(".", ",") + "%";
  }
  const decimals = /0\.(0+)/.exec(part)?.[1].length ?? 0;
  const group = /#,##|0,0/.test(part);
  let s = Math.abs(v).toFixed(decimals);
  if (group) {
    const [i, f] = s.split(".");
    s = i.replace(/\B(?=(\d{3})+(?!\d))/g, " ") + (f ? "," + f : "");
  } else s = s.replace(".", ",");
  // Текст до первого и после последнего знака числа: «"₽"», «р.», пробелы, подчёркивания-отступы.
  const first = part.search(/[0#?]/);
  const last = Math.max(part.lastIndexOf("0"), part.lastIndexOf("#"), part.lastIndexOf("?"));
  const clean = (x: string) =>
    x
      .replace(/\[[^\]]*\]/g, "")
      .replace(/"([^"]*)"/g, "$1")
      .replace(/\\(.)/g, "$1")
      .replace(/_./g, " ")
      .replace(/\*./g, "")
      .replace(/^-/, "");
  const before = first > 0 ? clean(part.slice(0, first)) : "";
  const after = last >= 0 ? clean(part.slice(last + 1)) : "";
  const neg = v < 0 && (!fmt.includes(";") || /-/.test(part.slice(0, Math.max(0, first)))) ? "-" : "";
  return `${neg}${before}${s}${after}`.trimEnd();
}

function displayOf(c: Cell): string {
  const v = c.value as unknown;
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return formatNumber(v, c.numFmt);
  if (typeof v === "boolean") return v ? "ИСТИНА" : "ЛОЖЬ";
  if (v instanceof Date) return new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC" }).format(v);
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    const o = v as { richText?: Array<{ text: string }>; result?: unknown; text?: string; error?: string };
    if (Array.isArray(o.richText)) return o.richText.map((r) => r.text).join("");
    if ("result" in o) {
      const r = o.result;
      if (typeof r === "number") return formatNumber(r, c.numFmt);
      if (r instanceof Date) return new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC" }).format(r);
      return r === undefined || r === null ? "" : String(r);
    }
    if (typeof o.text === "string") return o.text;
    if (o.error) return o.error;
  }
  return String(v);
}

function richHtml(c: Cell): string | null {
  const v = c.value as { richText?: Array<{ text: string; font?: Partial<ExcelJS.Font> }> } | null;
  if (!v || typeof v !== "object" || !Array.isArray(v.richText)) return null;
  return v.richText
    .map((r) => {
      const st = fontCss(r.font);
      return st ? `<span style="${st}">${esc(r.text)}</span>` : esc(r.text);
    })
    .join("");
}

function fontCss(f?: Partial<ExcelJS.Font> | null): string {
  if (!f) return "";
  const out: string[] = [];
  if (f.name) out.push(`font-family:'${String(f.name).replace(/'/g, "")}',Calibri,Arial,sans-serif`);
  if (f.size) out.push(`font-size:${f.size}pt`);
  if (f.bold) out.push("font-weight:700");
  if (f.italic) out.push("font-style:italic");
  const deco = [f.underline ? "underline" : "", f.strike ? "line-through" : ""].filter(Boolean).join(" ");
  if (deco) out.push(`text-decoration:${deco}`);
  const col = argb(f.color as { argb?: string });
  if (col) out.push(`color:${col}`);
  return out.join(";");
}

/** Ширина столбца Excel (знаков) → пиксели при 96 dpi, как считает сам Excel для Calibri 11. */
const colPx = (w?: number) => Math.round(((w ?? 8.43) * 7 + 5) * 100) / 100;
/** Высота строки (пункты) → пиксели. */
const rowPx = (h?: number) => Math.round(((h ?? 15) * 96) / 72 * 100) / 100;

export interface SheetHtml {
  name: string;
  html: string;
  width: number;
  height: number;
  landscape: boolean;
}

export function toHtml(wb: ExcelJS.Workbook): SheetHtml[] {
  const out: SheetHtml[] = [];
  for (const ws of visibleSheets(wb)) {
    const area = parseRange(String((ws.pageSetup as { printArea?: string } | undefined)?.printArea ?? "").split(",")[0] ?? "");
    let maxRow = 0;
    let maxCol = 0;
    ws.eachRow({ includeEmpty: false }, (row, r) =>
      row.eachCell({ includeEmpty: false }, (c, col) => {
        if (displayOf(c) || c.border || c.fill) {
          maxRow = Math.max(maxRow, r);
          maxCol = Math.max(maxCol, col);
        }
      })
    );
    const images = ws.getImages();
    for (const img of images) {
      const br = (img.range as unknown as { br?: { nativeRow: number; nativeCol: number } }).br;
      if (br) {
        maxRow = Math.max(maxRow, br.nativeRow + 1);
        maxCol = Math.max(maxCol, br.nativeCol + 1);
      }
    }
    const merges = mergesOf(ws);
    for (const m of merges) {
      maxRow = Math.max(maxRow, m.bottom);
      maxCol = Math.max(maxCol, m.right);
    }
    const top = area?.top ?? 1;
    const left = area?.left ?? 1;
    const bottom = area?.bottom ?? maxRow;
    const right = area?.right ?? maxCol;
    if (bottom < top || right < left) continue;

    const defW = (ws.properties as { defaultColWidth?: number }).defaultColWidth;
    const defH = (ws.properties as { defaultRowHeight?: number }).defaultRowHeight ?? 15;
    const cols: number[] = [];
    for (let c = left; c <= right; c++) {
      const col = ws.getColumn(c);
      cols.push(col.hidden ? 0 : colPx(col.width ?? defW));
    }
    const rows: number[] = [];
    for (let r = top; r <= bottom; r++) {
      const row = ws.getRow(r);
      rows.push(row.hidden ? 0 : rowPx(row.height ?? defH));
    }
    const covered = new Set<string>();
    const spanAt = new Map<string, { rs: number; cs: number }>();
    for (const m of merges) {
      if (m.bottom < top || m.top > bottom || m.right < left || m.left > right) continue;
      spanAt.set(`${m.top}:${m.left}`, { rs: m.bottom - m.top + 1, cs: m.right - m.left + 1 });
      for (let r = m.top; r <= m.bottom; r++) for (let c = m.left; c <= m.right; c++) if (r !== m.top || c !== m.left) covered.add(`${r}:${c}`);
    }

    const width = cols.reduce((a, b) => a + b, 0);
    const height = rows.reduce((a, b) => a + b, 0);
    let html = `<table class="xl" style="width:${width}px"><colgroup>${cols.map((w) => `<col style="width:${w}px">`).join("")}</colgroup>`;
    for (let r = top; r <= bottom; r++) {
      const h = rows[r - top];
      if (!h) continue;
      html += `<tr style="height:${h}px">`;
      for (let c = left; c <= right; c++) {
        if (covered.has(`${r}:${c}`)) continue;
        if (!cols[c - left]) continue;
        const cell = ws.getCell(r, c);
        const span = spanAt.get(`${r}:${c}`);
        const st: string[] = [];
        const font = fontCss(cell.font);
        if (font) st.push(font);
        const al = cell.alignment ?? {};
        const isNum = typeof cell.value === "number" || (cell.value && typeof cell.value === "object" && typeof (cell.value as { result?: unknown }).result === "number");
        const hz = al.horizontal ?? (isNum ? "right" : undefined);
        if (hz && (hz as string) !== "general") st.push(`text-align:${hz === "centerContinuous" || hz === "distributed" ? "center" : hz === "fill" || hz === "justify" ? "justify" : hz}`);
        st.push(`vertical-align:${al.vertical === "top" ? "top" : al.vertical === "middle" ? "middle" : "bottom"}`);
        // Как в Excel: длинный текст без переноса заходит на соседние пустые ячейки.
        st.push(al.wrapText ? "white-space:pre-wrap;overflow:hidden" : "white-space:pre;overflow:visible");
        if (al.indent) st.push(`padding-left:${al.indent * 9 + 2}px`);
        const b = cell.border ?? {};
        for (const side of ["top", "right", "bottom", "left"] as const) {
          const s = (b as Record<string, { style?: string; color?: { argb?: string } } | undefined>)[side];
          if (s?.style && BORDER[s.style]) st.push(`border-${side}:${BORDER[s.style]} ${argb(s.color, "#000")}`);
        }
        const fill = cell.fill as { type?: string; pattern?: string; fgColor?: { argb?: string } } | undefined;
        if (fill?.type === "pattern" && fill.pattern === "solid") {
          const bg = argb(fill.fgColor);
          if (bg) st.push(`background:${bg}`);
        }
        const content = richHtml(cell) ?? esc(displayOf(cell));
        html += `<td${span ? `${span.rs > 1 ? ` rowspan="${span.rs}"` : ""}${span.cs > 1 ? ` colspan="${span.cs}"` : ""}` : ""} style="${st.join(";")}">${content}</td>`;
      }
      html += "</tr>";
    }
    html += "</table>";

    // Картинки (логотип, печать, подпись) — поверх таблицы, на своих местах.
    const xOf = (col: number, off = 0) => {
      let x = 0;
      for (let c = left; c < left + Math.floor(col) && c <= right; c++) x += cols[c - left] ?? 0;
      return x + (cols[Math.floor(col)] ?? 0) * (col % 1) + off;
    };
    const yOf = (row: number) => {
      let y = 0;
      for (let r = top; r < top + Math.floor(row) && r <= bottom; r++) y += rows[r - top] ?? 0;
      return y + (rows[Math.floor(row)] ?? 0) * (row % 1);
    };
    let pics = "";
    for (const img of images) {
      try {
        const media = wb.getImage(Number(img.imageId)) as { buffer?: Buffer; base64?: string; extension?: string };
        const b64 = media.base64 ?? (media.buffer ? Buffer.from(media.buffer).toString("base64") : "");
        if (!b64) continue;
        const ext = (media.extension ?? "png").toLowerCase().replace("jpg", "jpeg");
        if (!/^(png|jpeg|gif|bmp|webp)$/.test(ext)) continue;
        const rg = img.range as unknown as {
          tl: { col: number; row: number };
          br?: { col: number; row: number };
          ext?: { width: number; height: number };
        };
        const x = xOf(rg.tl.col - (left - 1));
        const y = yOf(rg.tl.row - (top - 1));
        const w = rg.br ? xOf(rg.br.col - (left - 1)) - x : (rg.ext?.width ?? 100);
        const h = rg.br ? yOf(rg.br.row - (top - 1)) - y : (rg.ext?.height ?? 50);
        if (w <= 0 || h <= 0) continue;
        pics += `<img src="data:image/${ext};base64,${b64}" alt="" style="position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px">`;
      } catch {
        /* картинку не прочитали — лист печатается без неё */
      }
    }
    out.push({
      name: ws.name,
      html: `<div class="xl-sheet" style="position:relative;width:${width}px">${html}${pics}</div>`,
      width,
      height,
      landscape: (ws.pageSetup as { orientation?: string } | undefined)?.orientation === "landscape",
    });
  }
  return out;
}

// ------------------------------------------------------------------ пример

/** Образец для мастерской: аккуратный бланк со всеми метками и памяткой на втором листе. */
export async function example(target: Target): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "FineCRM";
  const ws = wb.addWorksheet(target === "sale" ? "Товарный чек" : "Бланк");
  ws.columns = [{ width: 5 }, { width: 40 }, { width: 10 }, { width: 14 }, { width: 14 }];
  ws.pageSetup = { paperSize: 9, orientation: "portrait", margins: { left: 0.5, right: 0.5, top: 0.6, bottom: 0.6, header: 0.3, footer: 0.3 } };
  const thin = { style: "thin" as const, color: { argb: "FF000000" } };
  const box = { top: thin, left: thin, bottom: thin, right: thin };
  const put = (addr: string, v: string, f: Partial<ExcelJS.Font> = {}, a: Partial<ExcelJS.Alignment> = {}) => {
    const c = ws.getCell(addr);
    c.value = v;
    c.font = { name: "Calibri", size: 11, ...f };
    c.alignment = { vertical: "middle", ...a };
    return c;
  };
  ws.mergeCells("A1:E1");
  put("A1", "{мастерская}", { size: 14, bold: true });
  ws.mergeCells("A2:E2");
  put("A2", "{реквизиты}", { size: 9, color: { argb: "FF555555" } }, { wrapText: true });
  ws.getRow(2).height = 30;
  ws.mergeCells("A4:E4");
  put("A4", target === "sale" ? "Товарный чек № {номер} от {дата}" : "Договор-квитанция № {номер} от {дата приёма}", { size: 13, bold: true }, { horizontal: "center" });

  let r = 6;
  const pairs =
    target === "sale"
      ? [
          ["Покупатель", "{клиент}, {телефон}"],
          ["Продавец", "{продавец}"],
        ]
      : [
          ["Клиент", "{клиент}, {телефон}"],
          ["Техника", "{устройство}, s/n {серийный}"],
          ["Неисправность", "{неисправность}"],
          ["Мастер", "{мастер}"],
        ];
  for (const [k, v] of pairs) {
    put(`A${r}`, k, { bold: true });
    ws.mergeCells(`A${r}:B${r}`);
    ws.mergeCells(`C${r}:E${r}`);
    put(`C${r}`, v);
    r++;
  }
  r++;
  const head = ["№", "Наименование", "Кол-во", "Цена", "Сумма"];
  head.forEach((h, i) => {
    const c = ws.getCell(r, i + 1);
    c.value = h;
    c.font = { bold: true };
    c.border = box;
    c.alignment = { horizontal: "center", vertical: "middle" };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEDEFF3" } };
  });
  r++;
  const line = target === "sale" ? ["{№}", "{товар}", "{товар кол-во}", "{товар цена}", "{товар сумма}"] : ["{№}", "{строка}", "{строка кол-во}", "{строка цена}", "{строка сумма}"];
  line.forEach((v, i) => {
    const c = ws.getCell(r, i + 1);
    c.value = v;
    c.border = box;
    c.alignment = { horizontal: i === 1 ? "left" : i === 0 || i === 2 ? "center" : "right", vertical: "middle", wrapText: i === 1 };
  });
  r++;
  ws.mergeCells(`A${r}:D${r}`);
  put(`A${r}`, "Итого:", { bold: true }, { horizontal: "right" });
  put(`E${r}`, "{итого}", { bold: true }, { horizontal: "right" });
  r++;
  ws.mergeCells(`A${r}:E${r}`);
  put(`A${r}`, "Сумма прописью: {итого прописью}. Оплата: {оплата}.", { italic: true });
  r += 2;
  ws.mergeCells(`A${r}:E${r}`);
  put(`A${r}`, "Гарантия {гарантия} дней — до {гарантия до}.", {}, { wrapText: true });
  r += 3;
  put(`B${r}`, "Подпись клиента ____________");
  put(`D${r}`, target === "sale" ? "Продавец ____________" : "Мастерская ____________");

  // Памятка — на втором листе: все метки с пояснениями.
  const help = wb.addWorksheet("Метки");
  help.columns = [{ width: 26 }, { width: 60 }];
  help.addRow(["Метка", "Что подставится"]).font = { bold: true };
  for (const m of marksOf(target)) help.addRow([`{${m.key}}`, m.hint]);
  help.addRow([]);
  for (const l of listsOf(target)) {
    help.addRow([`Список: ${l.title}`, "строка с этими метками повторится для каждого элемента"]).font = { bold: true };
    for (const f of l.fields) help.addRow([`{${f.key}}`, f.hint]);
  }
  help.addRow([`{${ROW_NO}}`, "номер строки в списке"]);
  help.addRow([]);
  help.addRow(["Лист «Метки» FineCRM не печатает. Остальные видимые листы печатаются каждый на своей странице."]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
