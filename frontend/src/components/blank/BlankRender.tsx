import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import qrcode from "qrcode-generator";
import "@fontsource/pt-sans/cyrillic-400.css";
import "@fontsource/pt-sans/cyrillic-700.css";
import "@fontsource/pt-sans/cyrillic-400-italic.css";
import "@fontsource/pt-sans/cyrillic-700-italic.css";
import "@fontsource/pt-sans/latin-400.css";
import "@fontsource/pt-sans/latin-700.css";
import "@fontsource/pt-sans/latin-400-italic.css";
import "@fontsource/pt-sans/latin-700-italic.css";
import "@fontsource/pt-serif/cyrillic-400.css";
import "@fontsource/pt-serif/cyrillic-700.css";
import "@fontsource/pt-serif/cyrillic-400-italic.css";
import "@fontsource/pt-serif/cyrillic-700-italic.css";
import "@fontsource/pt-serif/latin-400.css";
import "@fontsource/pt-serif/latin-700.css";
import "@fontsource/pt-serif/latin-400-italic.css";
import "@fontsource/pt-serif/latin-700-italic.css";
import "@fontsource/roboto/cyrillic-400.css";
import "@fontsource/roboto/cyrillic-700.css";
import "@fontsource/roboto/cyrillic-400-italic.css";
import "@fontsource/roboto/cyrillic-700-italic.css";
import "@fontsource/roboto/latin-400.css";
import "@fontsource/roboto/latin-700.css";
import "@fontsource/roboto/latin-400-italic.css";
import "@fontsource/roboto/latin-700-italic.css";
import "@fontsource/pt-mono/cyrillic-400.css";
import "@fontsource/pt-mono/latin-400.css";
import { code128Bars } from "../../lib/labels";
import { fieldLabel, type BlankData, type Row } from "../../lib/blankData";
import {
  fontCss,
  FONTS,
  pageSize,
  type BlankDesign,
  type BlankEl,
  type CodeEl,
  type ImageEl,
  type LineEl,
  type RectEl,
  type Stroke,
  type TableEl,
  type Target,
  type TextEl,
} from "../../lib/blankModel";

/**
 * Лист бланка «Редактора бланков» (05.11.2026).
 *
 *   ElView      — один элемент на своём месте (редактор и печать)
 *   BlankPages  — бланк целиком с данными: растущие элементы (таблица, текст
 *                 «по тексту») сдвигают всё, что ниже; не влезло — новый лист,
 *                 у таблицы шапка повторяется.
 *
 * Шрифты — свои (PT Sans, PT Serif, Roboto, PT Mono): бланк печатается
 * одинаково с любого компьютера и телефона. Arial и Times — системные.
 */

export const PX_PER_MM = 96 / 25.4;
const pxToMm = (px: number) => px / PX_PER_MM;

if ((qrcode as unknown as { stringToBytesFuncs?: Record<string, unknown> }).stringToBytesFuncs?.["UTF-8"]) {
  (qrcode as unknown as { stringToBytes: unknown }).stringToBytes = (qrcode as unknown as { stringToBytesFuncs: Record<string, unknown> }).stringToBytesFuncs["UTF-8"];
}

export const BLANK_CSS = `
.bf-sheet { color: #000; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.bf-sheet * { box-sizing: border-box; }
.bf-text p, .bf-text div { margin: 0; }
.bf-text ul, .bf-text ol { margin: 0; padding-left: 1.4em; }
.bf-text ul { list-style: disc; }
.bf-text ol { list-style: decimal; }
.bf-chip { display: inline; background: rgba(42,127,208,.14); color: #1f5f9e; border-radius: 2px; padding: 0 .15em; box-shadow: inset 0 0 0 1px rgba(42,127,208,.35); white-space: nowrap; }
.bf-table { border-collapse: collapse; table-layout: fixed; }
.bf-table td, .bf-table th { overflow-wrap: anywhere; vertical-align: top; font-weight: inherit; }
`;

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const strokeCss = (s: Stroke | null) => (s ? `${s.w}mm ${s.style} ${s.color}` : "none");

const BLOCKS = new Set(["DIV", "P", "UL", "OL", "LI"]);

/**
 * HTML текста: в редакторе поле — подписью («Клиент»), при печати —
 * значением. hideEmpty — абзац (или строка до <br>), где все поля пустые,
 * не печатается.
 */
export function textHtml(el: TextEl, data: BlankData | null, target: Target): string {
  if (!data) return el.html.replace(/<span data-f="([a-zA-Z0-9]+)"><\/span>/g, (_, k) => `<span class="bf-chip" data-f="${k}" contenteditable="false">${escapeHtml(fieldLabel(target, k))}</span>`);
  const doc = new DOMParser().parseFromString(`<body>${el.html}</body>`, "text/html");
  const body = doc.body;
  const fill = (root: ParentNode) => {
    for (const s of Array.from(root.querySelectorAll("span[data-f]"))) {
      const v = data.values[s.getAttribute("data-f") ?? ""] ?? "";
      const frag = doc.createDocumentFragment();
      v.split("\n").forEach((line, i) => {
        if (i) frag.appendChild(doc.createElement("br"));
        frag.appendChild(doc.createTextNode(line));
      });
      s.replaceWith(frag);
    }
  };
  if (el.hideEmpty) {
    const empty = (nodes: Node[]) => {
      const fields = nodes.flatMap((n) => (n instanceof Element ? [...(n.matches("span[data-f]") ? [n] : []), ...Array.from(n.querySelectorAll("span[data-f]"))] : []));
      return fields.length > 0 && fields.every((f) => !(data.values[f.getAttribute("data-f") ?? ""] ?? "").trim());
    };
    // Блоки — каждый своим абзацем; строчное между блоками — строками до <br>.
    const walk = (parent: Element) => {
      let run: Node[] = [];
      const flush = (br: Node | null) => {
        if (run.length && empty(run)) {
          run.forEach((n) => n.parentNode?.removeChild(n));
          br?.parentNode?.removeChild(br);
        }
        run = [];
      };
      for (const n of Array.from(parent.childNodes)) {
        if (n instanceof Element && BLOCKS.has(n.tagName)) {
          flush(null);
          if (n.tagName === "UL" || n.tagName === "OL") walk(n);
          else if (empty([n])) n.remove();
          continue;
        }
        if (n instanceof Element && n.tagName === "BR") {
          flush(n);
          continue;
        }
        run.push(n);
      }
      flush(null);
    };
    walk(body);
  }
  fill(body);
  return body.innerHTML;
}

/** Текст есть хоть какой-то — для «весь текст из пустых полей — не печатать». */
const hasContent = (html: string) => html.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim().length > 0;

export const textStyleCss = (el: TextEl): CSSProperties => ({
  fontFamily: fontCss(el.st.font),
  fontSize: `${el.st.size}pt`,
  lineHeight: el.st.leading,
  color: el.st.color,
  textAlign: el.st.align,
  fontWeight: el.st.bold ? 700 : 400,
  fontStyle: el.st.italic ? "italic" : "normal",
  textDecoration: el.st.underline ? "underline" : "none",
  textTransform: el.st.upper ? "uppercase" : "none",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
});

/** Рамка текстового блока: заливка, линии, отступ. */
export const textBoxCss = (el: TextEl): CSSProperties => {
  const b = el.st.border;
  const line = b ? strokeCss(b) : undefined;
  return {
    background: el.st.fill ?? undefined,
    padding: `${el.st.pad}mm`,
    borderTop: b && (b.sides === "all" || b.sides === "top" || b.sides === "tb") ? line : undefined,
    borderBottom: b && (b.sides === "all" || b.sides === "bottom" || b.sides === "tb") ? line : undefined,
    borderLeft: b && b.sides === "all" ? line : undefined,
    borderRight: b && b.sides === "all" ? line : undefined,
    display: "flex",
    flexDirection: "column",
    justifyContent: el.st.valign === "middle" ? "center" : el.st.valign === "bottom" ? "flex-end" : "flex-start",
  };
};

const pos = (el: { x: number; y: number; w: number }, top: number, h: number | "auto"): CSSProperties => ({
  position: "absolute",
  left: `${el.x}mm`,
  top: `${top}mm`,
  width: `${el.w}mm`,
  height: h === "auto" ? "auto" : `${h}mm`,
});

// ------------------------------------------------------------ элементы

function TextView({ el, html, top, h, edit }: { el: TextEl; html: string; top: number; h: number | "auto"; edit?: boolean }) {
  // В редакторе текст «по тексту» виден целиком: рамка растёт вместе с ним.
  const auto = edit && el.grow;
  return (
    <div style={{ ...pos(el, top, auto ? "auto" : h), ...(auto ? { minHeight: `${el.h}mm` } : {}), ...textBoxCss(el), overflow: edit && !auto ? "hidden" : "visible" }} data-el={el.id}>
      <div className="bf-text" style={textStyleCss(el)} dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

function LineView({ el, top }: { el: LineEl; top: number }) {
  const s = el.stroke;
  const h = el.dir === "h";
  const line: CSSProperties = h
    ? { position: "absolute", left: el.cut ? "4.2mm" : 0, right: 0, top: "50%", borderTop: strokeCss(s), transform: `translateY(-${s.w / 2}mm)` }
    : { position: "absolute", top: el.cut ? "4.2mm" : 0, bottom: 0, left: "50%", borderLeft: strokeCss(s), transform: `translateX(-${s.w / 2}mm)` };
  return (
    <div style={{ ...pos(el, top, el.h) }} data-el={el.id}>
      {el.cut && (
        <span
          style={{
            position: "absolute",
            left: h ? 0 : "50%",
            top: h ? "50%" : 0,
            transform: h ? "translateY(-55%)" : "translateX(-50%) rotate(90deg)",
            fontSize: "11pt",
            lineHeight: 1,
            color: s.color,
            fontFamily: "Arial, sans-serif",
          }}
        >
          ✂
        </span>
      )}
      <div style={line} />
    </div>
  );
}

function RectView({ el, top }: { el: RectEl; top: number }) {
  return <div data-el={el.id} style={{ ...pos(el, top, el.h), border: strokeCss(el.stroke), background: el.fill ?? undefined, borderRadius: `${el.radius}mm` }} />;
}

function ImageView({ el, top, logo }: { el: ImageEl; top: number; logo: string | null }) {
  const src = el.src === "logo" ? logo : el.src;
  return (
    <div data-el={el.id} style={pos(el, top, el.h)}>
      {src ? (
        <img src={src} alt="" style={{ width: "100%", height: "100%", objectFit: el.fit, display: "block" }} draggable={false} />
      ) : (
        <div style={{ width: "100%", height: "100%", border: "0.3mm dashed #9aa3af", display: "flex", alignItems: "center", justifyContent: "center", font: "8pt Arial", color: "#6b7280", textAlign: "center" }}>
          {el.src === "logo" ? "Логотип из «Бланков»" : "Картинка"}
        </div>
      )}
    </div>
  );
}

/** Значение кода: поля {number} заменяются данными; штрихкод — только цифры. */
export function codeValue(el: CodeEl, data: BlankData | null): string {
  const v = el.value.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (_, k) => (data ? (data.values[k] ?? "") : k === "number" ? "2026001234" : "0"));
  return el.kind === "code128" ? v.replace(/\D/g, "") : v;
}

function CodeView({ el, top, data }: { el: CodeEl; top: number; data: BlankData | null }) {
  const value = codeValue(el, data);
  const body = useMemo(() => {
    if (!value) return null;
    if (el.kind === "qr") {
      try {
        const q = qrcode(0, "M");
        q.addData(value);
        q.make();
        const n = q.getModuleCount();
        let d = "";
        for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
        return (
          <svg viewBox={`-1 -1 ${n + 2} ${n + 2}`} width="100%" height="100%" preserveAspectRatio="xMidYMid meet" shapeRendering="crispEdges">
            <path d={d} fill="#000" />
          </svg>
        );
      } catch {
        return null;
      }
    }
    const { bars, modules } = code128Bars(value.slice(0, 40));
    const capH = el.caption ? 3.4 : 0;
    return (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column" }}>
        <svg viewBox={`0 0 ${modules} 10`} width="100%" style={{ flex: 1, minHeight: 0 }} preserveAspectRatio="none" shapeRendering="crispEdges">
          {bars.map(([x, w]) => (
            <rect key={x} x={x} y={0} width={w} height={10} fill="#000" />
          ))}
        </svg>
        {el.caption && <div style={{ height: `${capH}mm`, font: "8pt/1 Arial, sans-serif", textAlign: "center", paddingTop: "0.6mm", letterSpacing: "0.08em" }}>{value}</div>}
      </div>
    );
  }, [value, el.kind, el.caption]);
  return (
    <div data-el={el.id} style={pos(el, top, el.h)}>
      {body ?? <div style={{ width: "100%", height: "100%", border: "0.3mm dashed #9aa3af", font: "8pt Arial", color: "#6b7280", display: "flex", alignItems: "center", justifyContent: "center" }}>нет данных</div>}
    </div>
  );
}

function cellCss(el: TableEl, head: boolean, align: string): CSSProperties {
  const line = "0.2mm solid " + el.st.color;
  return {
    padding: `${el.st.pad * 0.6}mm ${el.st.pad}mm`,
    textAlign: align as CSSProperties["textAlign"],
    border: el.st.grid === "all" ? line : undefined,
    borderBottom: el.st.grid === "rows" ? line : el.st.grid === "all" ? line : undefined,
    borderTop: el.st.grid === "rows" && head ? line : undefined,
    fontWeight: head && el.st.headBold ? 700 : 400,
    background: head && el.st.headFill ? el.st.headFill : undefined,
  };
}

/** Таблица целиком или кусок (строки from…to) — для переноса на следующий лист. */
export function TableView({
  el,
  rows,
  top,
  h,
  from = 0,
  to,
  showTotal = true,
}: {
  el: TableEl;
  rows: Row[];
  top: number;
  h?: number;
  from?: number;
  to?: number;
  showTotal?: boolean;
}) {
  const list = rows.slice(from, to ?? rows.length);
  const total = rows.reduce((a, r) => a + r.sumNum, 0);
  const sumAt = el.cols.findIndex((c) => c.key === "sum");
  const w = el.cols.reduce((a, c) => a + c.w, 0);
  return (
    <div data-el={el.id} style={{ ...pos(el, top, h ?? "auto"), overflow: h !== undefined ? "hidden" : undefined }}>
      <table className="bf-table" style={{ width: `${w}mm`, fontFamily: fontCss(el.st.font), fontSize: `${el.st.size}pt`, lineHeight: 1.25, color: el.st.color }}>
        <colgroup>
          {el.cols.map((c, i) => (
            <col key={i} style={{ width: `${c.w}mm` }} />
          ))}
        </colgroup>
        <thead>
          <tr data-row="head">
            {el.cols.map((c, i) => (
              <th key={i} style={cellCss(el, true, c.align)}>
                {c.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && from === 0 ? (
            <tr data-row="empty">
              <td colSpan={el.cols.length} style={{ ...cellCss(el, false, "left"), color: "#555" }}>
                {el.emptyText}
              </td>
            </tr>
          ) : (
            list.map((r, i) => (
              <tr key={from + i} data-row={from + i}>
                {el.cols.map((c, j) => (
                  <td key={j} style={cellCss(el, false, c.align)}>
                    {r[c.key]}
                  </td>
                ))}
              </tr>
            ))
          )}
          {el.total && showTotal && (
            <tr data-row="total">
              <td colSpan={sumAt > 0 ? sumAt : Math.max(1, el.cols.length - 1)} style={{ ...cellCss(el, false, "right"), fontWeight: 700 }}>
                {el.totalLabel}
              </td>
              {sumAt >= 0 ? (
                <>
                  <td style={{ ...cellCss(el, false, el.cols[sumAt].align), fontWeight: 700 }}>{total ? `${total.toLocaleString("ru-RU", { minimumFractionDigits: total % 1 ? 2 : 0, maximumFractionDigits: 2 })} ₽` : ""}</td>
                  {el.cols.slice(sumAt + 1).map((_, j) => (
                    <td key={j} style={cellCss(el, false, "left")} />
                  ))}
                </>
              ) : (
                <td style={cellCss(el, false, "left")} />
              )}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/** Строки таблицы: при печати — данные, в редакторе — пример. */
export const rowsOf = (el: TableEl, data: BlankData | null, sample: BlankData | null): Row[] => (data ?? sample)?.tables[el.source] ?? [];

/** Элемент на месте из бланка. В редакторе (data = null) поля — подписями. */
export function ElView({ el, data, target, sample, top, h }: { el: BlankEl; data: BlankData | null; target: Target; sample?: BlankData | null; top?: number; h?: number }) {
  const y = top ?? el.y;
  switch (el.type) {
    case "text":
      return <TextView el={el} html={textHtml(el, data, target)} top={y} h={h ?? el.h} edit={!data} />;
    case "line":
      return <LineView el={el} top={y} />;
    case "rect":
      return <RectView el={el} top={y} />;
    case "image":
      return <ImageView el={el} top={y} logo={(data ?? sample)?.logo ?? null} />;
    case "table":
      return <TableView el={el} rows={rowsOf(el, data, sample ?? null)} top={y} h={h ?? el.h} />;
    case "code":
      return <CodeView el={el} top={y} data={data} />;
  }
}

// ------------------------------------------------------------ лист целиком

interface Placed {
  el: BlankEl;
  top: number; // мм от начала своего листа
  h: number | undefined; // undefined — высота по содержимому
  page: number;
  from?: number;
  to?: number;
  showTotal?: boolean;
  html?: string;
}

/** Шрифты, которые нужны бланку: дождаться их до измерения, иначе строки перенесутся иначе. */
function fontsOf(d: BlankDesign): string[] {
  const keys = new Set<string>();
  for (const e of d.els) {
    if (e.type === "text") {
      keys.add(e.st.font);
      for (const f of FONTS) if (e.html.includes(f.name)) keys.add(f.key);
    }
    if (e.type === "table") keys.add(e.st.font);
  }
  const names: string[] = [];
  for (const k of keys) {
    const f = FONTS.find((x) => x.key === k);
    if (f && !["arial", "times"].includes(f.key)) names.push(f.name);
  }
  return names;
}

/**
 * Бланк с данными — листами. Сначала прячем растущие элементы в невидимый
 * слой и меряем, потом раскладываем:
 *   растущий вырос на N мм → всё, что целиком ниже него, сдвигается на N мм;
 *   сдвинутое не влезает в поля листа → переезжает на следующий лист,
 *   таблица делится по строкам и повторяет шапку.
 */
export function BlankPages({
  design,
  data,
  target,
  onReady,
  screen = true,
}: {
  design: BlankDesign;
  data: BlankData;
  target: Target;
  onReady?: () => void;
  /** На экране — листы с тенью и промежутком; при печати — встык. */
  screen?: boolean;
}) {
  const [pw, ph] = pageSize(design.page);
  const measureRef = useRef<HTMLDivElement>(null);
  const [placed, setPlaced] = useState<{ pages: number; items: Placed[] } | null>(null);
  const htmls = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of design.els) if (e.type === "text") m.set(e.id, textHtml(e, data, target));
    return m;
  }, [design, data, target]);

  useLayoutEffect(() => {
    let alive = true;
    setPlaced(null);
    const run = async () => {
      const fonts = fontsOf(design);
      try {
        await Promise.all(fonts.flatMap((n) => ["400", "700"].flatMap((w) => [document.fonts.load(`${w} 12px "${n}"`, "Аа1"), document.fonts.load(`italic ${w} 12px "${n}"`, "Аа1")])));
        await document.fonts.ready;
      } catch {
        /* без шрифта — системным */
      }
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      if (!alive || !measureRef.current) return;
      setPlaced(layout(design, data, htmls, measureRef.current, ph));
    };
    void run();
    return () => {
      alive = false;
    };
  }, [design, data, htmls, ph]);

  useEffect(() => {
    if (!placed || !onReady) return;
    const t = requestAnimationFrame(() => requestAnimationFrame(() => onReady()));
    return () => cancelAnimationFrame(t);
  }, [placed, onReady]);

  const pages = placed ? Array.from({ length: placed.pages }, (_, i) => i) : [];
  return (
    <>
      <style>{BLANK_CSS + `@media print { @page { size: ${design.page.size} ${design.page.landscape ? "landscape" : "portrait"}; margin: 0; } .bf-page { box-shadow: none !important; margin: 0 !important; break-after: page; height: ${ph - 0.6}mm !important; } .bf-page:last-child { break-after: auto; } }`}</style>
      {/* Невидимый слой для измерения растущих элементов. */}
      <div ref={measureRef} aria-hidden className="bf-sheet" style={{ position: "absolute", left: -20000, top: 0, width: `${pw}mm`, visibility: "hidden", pointerEvents: "none" }}>
        {design.els.map((e) =>
          e.type === "table" ? (
            <div key={e.id} data-measure={e.id} style={{ position: "relative" }}>
              <TableView el={e} rows={data.tables[e.source] ?? []} top={0} />
            </div>
          ) : e.type === "text" && e.grow ? (
            <div key={e.id} data-measure={e.id} style={{ position: "relative" }}>
              <TextView el={e} html={htmls.get(e.id) ?? ""} top={0} h="auto" />
            </div>
          ) : null
        )}
      </div>
      {!placed && <div className="p-8 text-[14px] text-white print:hidden">Раскладываем бланк…</div>}
      {pages.map((p) => (
        <div
          key={p}
          className={"bf-page bf-sheet relative overflow-hidden bg-white " + (screen ? "mx-auto my-6 shadow-lg" : "")}
          data-blank-page={p + 1}
          style={{ width: `${pw}mm`, height: `${ph}mm` }}
        >
          {placed!.items
            .filter((it) => it.page === p)
            .map((it, i) =>
              it.el.type === "table" ? (
                <TableView key={`${it.el.id}-${i}`} el={it.el} rows={data.tables[it.el.source] ?? []} top={it.top} from={it.from} to={it.to} showTotal={it.showTotal} />
              ) : it.el.type === "text" ? (
                <TextView key={`${it.el.id}-${i}`} el={it.el} html={htmls.get(it.el.id) ?? ""} top={it.top} h={it.h ?? "auto"} />
              ) : (
                <ElView key={`${it.el.id}-${i}`} el={it.el} data={data} target={target} top={it.top} />
              )
            )}
        </div>
      ))}
    </>
  );
}

/** Раскладка по листам — по измеренным высотам. */
function layout(design: BlankDesign, data: BlankData, htmls: Map<string, string>, box: HTMLElement, ph: number): { pages: number; items: Placed[] } {
  const margin = design.page.margin;
  const nat = new Map<string, number>(); // естественная высота, мм
  const rowH = new Map<string, { head: number; rows: number[]; total: number; empty: number }>();
  for (const e of design.els) {
    const node = box.querySelector(`[data-measure="${e.id}"]`) as HTMLElement | null;
    if (!node) continue;
    if (e.type === "table") {
      const h = (sel: string) => {
        const r = node.querySelector(`tr[data-row="${sel}"]`) as HTMLElement | null;
        return r ? pxToMm(r.getBoundingClientRect().height) : 0;
      };
      const rows = (data.tables[e.source] ?? []).map((_, i) => h(String(i)));
      const m = { head: h("head"), rows, total: e.total ? h("total") : 0, empty: h("empty") };
      rowH.set(e.id, m);
      nat.set(e.id, m.head + (rows.length ? rows.reduce((a, b) => a + b, 0) : m.empty) + m.total);
    } else {
      nat.set(e.id, pxToMm((node.firstElementChild as HTMLElement).getBoundingClientRect().height));
    }
  }

  // Пустой текст из одних пустых полей — не печатается и места не занимает.
  const els = design.els.filter((e) => !(e.type === "text" && !hasContent(htmls.get(e.id) ?? "") && /data-f=/.test(e.html)));
  const order = [...els].sort((a, b) => a.y - b.y || a.x - b.x);
  const grow = (e: BlankEl) => {
    const n = nat.get(e.id);
    if (n === undefined) return 0;
    return Math.max(0, n - e.h);
  };
  const shift = new Map<string, number>();
  for (const e of order) {
    let s = 0;
    for (const a of order) {
      if (a === e) break;
      if (a.y + a.h <= e.y + 0.01) s = Math.max(s, (shift.get(a.id) ?? 0) + grow(a));
    }
    shift.set(e.id, s);
  }

  // По листам: «длинный лист», лист k — [k·ph, (k+1)·ph).
  const items: Placed[] = [];
  let extra = 0;
  const sorted = [...order].sort((a, b) => a.y + (shift.get(a.id) ?? 0) - (b.y + (shift.get(b.id) ?? 0)) || a.x - b.x);
  const limitOf = (top: number) => Math.floor(top / ph) * ph + ph - margin;
  const nextTop = (top: number) => (Math.floor(top / ph) + 1) * ph + margin;
  const put = (el: BlankEl, top: number, h: number | undefined, more: Partial<Placed> = {}) => {
    const page = Math.max(0, Math.floor(top / ph));
    items.push({ el, top: top - page * ph, h, page, ...more });
  };
  for (const e of sorted) {
    const moved = (shift.get(e.id) ?? 0) + extra;
    let top = e.y + moved;
    const g = grow(e);
    const height = Math.max(e.h, nat.get(e.id) ?? e.h);
    if (e.type === "table") {
      const m = rowH.get(e.id);
      const rows = m?.rows ?? [];
      if (!m || (moved <= 0.01 && g <= 0.01) || top + (nat.get(e.id) ?? e.h) <= limitOf(top) || !rows.length) {
        put(e, top, undefined);
        continue;
      }
      // Делим по строкам: сколько влезает до поля листа, остальное — на следующий, с шапкой.
      const start = top;
      let i = 0;
      while (i < rows.length) {
        const pageStart = Math.floor(top / ph) * ph;
        const room = limitOf(top) - top - m.head;
        let used = 0;
        let j = i;
        while (j < rows.length && used + rows[j] <= room) used += rows[j++];
        // итог не влез — последняя строка уходит на следующий лист вместе с ним
        if (j >= rows.length && used + m.total > room && j - i > 1) {
          j -= 1;
          used -= rows[j];
        }
        if (j === i) {
          if (top <= pageStart + margin + 0.01) {
            used = rows[j];
            j += 1; // строка выше целого листа — печатаем как есть
          } else {
            top = nextTop(top);
            continue;
          }
        }
        const lastFrag = j >= rows.length;
        put(e, top, undefined, { from: i, to: j, showTotal: lastFrag });
        i = j;
        top = lastFrag ? top + m.head + used + m.total : nextTop(top);
      }
      extra += Math.max(0, top - (start + height));
      continue;
    }
    if (moved > 0.01 || g > 0.01) {
      if (top + height > limitOf(top) && height <= ph - margin * 2) {
        const nt = nextTop(top);
        extra += nt - top;
        top = nt;
      }
    }
    put(e, top, e.type === "text" ? (e.grow ? height : e.h) : undefined);
  }
  const pages = Math.max(1, ...items.map((it) => it.page + 1));
  return { pages, items };
}
