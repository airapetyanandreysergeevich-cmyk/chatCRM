import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from "react";
import { BLANK_CSS, ElView, PX_PER_MM, textBoxCss, textHtml, textStyleCss } from "./BlankRender";
import { TextToolbar, type EditorApi } from "./TextToolbar";
import { pageSize, sanitizeHtml, type BlankDesign, type BlankEl, type Target, type TextEl, type TextStyle } from "../../lib/blankModel";
import type { BlankData } from "../../lib/blankData";

/**
 * Лист в редакторе бланков: всё делается на самом листе.
 *
 *   щелчок — выбрать (Shift — добавить к выбору), рамкой по пустому месту — несколько;
 *   тянуть — двигать, ручки — размер; прилипание к краям листа, полям, центру и
 *   соседям — с розовой направляющей; Alt — без шага сетки;
 *   двойной щелчок по тексту — писать прямо на листе, панель как в Word;
 *   стрелки — 0,5 мм (Shift — 0,1), Delete, Ctrl+Z / Ctrl+Y, Ctrl+C / V, Ctrl+D, Ctrl+A, Esc.
 */

const STEP = 0.5;
const MIN = 1;
type Handle = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const ALL_HANDLES: Exclude<Handle, "move">[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const CURSOR: Record<Handle, string> = { move: "move", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", ne: "nesw-resize", sw: "nesw-resize", nw: "nwse-resize", se: "nwse-resize" };

const r2 = (v: number) => Math.round(v * 100) / 100;
const snapStep = (v: number, step: number) => r2(Math.round(v / step) * step);

export const EL_NAME: Record<BlankEl["type"], string> = { text: "Текст", line: "Линия", rect: "Рамка", image: "Картинка", table: "Таблица", code: "Код" };

function handlesOf(el: BlankEl): Exclude<Handle, "move">[] {
  if (el.type === "line") return el.dir === "h" ? ["w", "e"] : ["n", "s"];
  return ALL_HANDLES;
}

function snapTo(lines: number[], targets: number[], thr: number): { shift: number; at: number | null } {
  let best = { shift: 0, at: null as number | null, d: thr };
  for (const l of lines) for (const t of targets) {
    const d = Math.abs(t - l);
    if (d < best.d) best = { shift: t - l, at: t, d };
  }
  return { shift: best.shift, at: best.at };
}

export interface CanvasProps {
  design: BlankDesign;
  target: Target;
  sample: BlankData;
  selected: string[];
  editing: string | null;
  zoom: number | "fit";
  grid: boolean;
  onSelect: (ids: string[]) => void;
  onEdit: (id: string | null) => void;
  /** Новое состояние бланка; history=false — без шага в «Отменить» (набор текста). */
  onChange: (d: BlankDesign, history?: boolean) => void;
  onUndo: () => void;
  onRedo: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onPatchStyle: (ids: string[], p: Partial<TextStyle>) => void;
  onScale?: (s: number) => void;
}

export function BlankCanvas(p: CanvasProps) {
  const { design, target, sample, selected, editing, zoom, grid, onSelect, onEdit, onChange } = p;
  const [pw, ph] = pageSize(design.page);
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [draft, setDraftState] = useState<BlankDesign | null>(null);
  const draftRef = useRef<BlankDesign | null>(null);
  const setDraft = (d: BlankDesign | null) => {
    draftRef.current = d;
    setDraftState(d);
  };
  const [guides, setGuides] = useState<{ x: number[]; y: number[] }>({ x: [], y: [] });
  const [band, setBand] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [overflow, setOverflow] = useState<Set<string>>(new Set());
  // Высота текстов «по тексту» в редакторе — рамка выбора растёт вместе с ними.
  const [growH, setGrowH] = useState<Map<string, number>>(new Map());

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const D = draft ?? design;
  const fit = Math.max(0.3, Math.min(2, (width - 24) / (pw * PX_PER_MM)));
  const scale = zoom === "fit" ? fit : zoom;
  const px = PX_PER_MM * scale;
  useEffect(() => p.onScale?.(scale), [scale]); // eslint-disable-line react-hooks/exhaustive-deps
  const line = 1 / scale;
  const sel = D.els.filter((e) => selected.includes(e.id));
  const single = sel.length === 1 ? sel[0] : null;

  // Текст не влезает в рамку (без «по тексту») — красная рамка: при печати он вылезет на соседей.
  const sheetRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = sheetRef.current;
    if (!root) return;
    const out = new Set<string>();
    for (const e of design.els) {
      if (e.type !== "text" || e.grow) continue;
      const box = root.querySelector(`[data-el="${e.id}"]`) as HTMLElement | null;
      const inner = box?.firstElementChild as HTMLElement | null;
      if (box && inner && inner.scrollHeight > box.clientHeight + 1) out.add(e.id);
    }
    setOverflow((prev) => (prev.size === out.size && [...out].every((x) => prev.has(x)) ? prev : out));
    const gh = new Map<string, number>();
    for (const e of design.els) {
      if (e.type !== "text" || !e.grow) continue;
      const box = root.querySelector(`[data-el="${e.id}"]`) as HTMLElement | null;
      if (box) gh.set(e.id, Math.round((box.offsetHeight / PX_PER_MM) * 100) / 100);
    }
    setGrowH((prev) => (prev.size === gh.size && [...gh].every(([k, v]) => Math.abs((prev.get(k) ?? -1) - v) < 0.05) ? prev : gh));
  }, [design, scale]);

  // ---------------------------------------------------------------- перетаскивание

  const drag = useRef<{ handle: Handle; sx: number; sy: number; main: BlankEl; origs: BlankEl[]; moved: boolean } | null>(null);
  const listening = useRef<{ move: (e: PointerEvent) => void; end: () => void } | null>(null);
  const unlisten = () => {
    const l = listening.current;
    if (!l) return;
    window.removeEventListener("pointermove", l.move);
    window.removeEventListener("pointerup", l.end);
    window.removeEventListener("pointercancel", l.end);
    listening.current = null;
  };
  useEffect(() => unlisten, []);

  const listen = (move: (e: PointerEvent) => void, end: () => void) => {
    unlisten();
    listening.current = { move, end };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  function start(e: RPointerEvent, el: BlankEl, handle: Handle) {
    if (editing === el.id) return;
    e.preventDefault();
    e.stopPropagation();
    if (editing) onEdit(null);
    wrap.current?.focus({ preventScroll: true });
    let ids = selected;
    if (e.shiftKey && handle === "move") {
      ids = selected.includes(el.id) ? selected.filter((x) => x !== el.id) : [...selected, el.id];
      onSelect(ids);
      return;
    }
    if (!selected.includes(el.id)) {
      ids = [el.id];
      onSelect(ids);
    }
    if (el.locked) return;
    const origs = design.els.filter((x) => (handle === "move" ? ids.includes(x.id) && !x.locked : x.id === el.id));
    drag.current = { handle, sx: e.clientX, sy: e.clientY, main: el, origs, moved: false };
    listen(move, end);
  }

  function targets(skip: Set<string>) {
    const m = design.page.margin;
    const others = design.els.filter((x) => !skip.has(x.id));
    return {
      tx: [0, m, pw / 2, pw - m, pw, ...others.flatMap((x) => [x.x, x.x + x.w / 2, x.x + x.w])],
      ty: [0, m, ph / 2, ph - m, ph, ...others.flatMap((x) => [x.y, x.y + x.h / 2, x.y + x.h])],
    };
  }

  function move(ev: PointerEvent) {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.abs(ev.clientX - d.sx) + Math.abs(ev.clientY - d.sy) < 3) return;
    d.moved = true;
    const dx = (ev.clientX - d.sx) / px;
    const dy = (ev.clientY - d.sy) / px;
    const fine = ev.altKey;
    const step = fine ? 0.1 : STEP;
    const thr = fine ? 0 : 6 / px;
    const o = d.main;
    const { tx, ty } = targets(new Set(d.origs.map((x) => x.id)));
    const g = { x: [] as number[], y: [] as number[] };
    if (d.handle === "move") {
      let x = snapStep(o.x + dx, step);
      let y = snapStep(o.y + dy, step);
      const sx = snapTo([x, x + o.w / 2, x + o.w], tx, thr);
      const sy = snapTo([y, y + o.h / 2, y + o.h], ty, thr);
      x = r2(x + sx.shift);
      y = r2(y + sy.shift);
      if (sx.at !== null) g.x.push(sx.at);
      if (sy.at !== null) g.y.push(sy.at);
      const mx = x - o.x;
      const my = y - o.y;
      const moved = new Map(d.origs.map((e) => [e.id, { ...e, x: r2(e.x + mx), y: r2(e.y + my) } as BlankEl]));
      setGuides(g);
      setDraft({ ...design, els: design.els.map((e) => moved.get(e.id) ?? e) });
      return;
    }
    const hz = d.handle.includes("e") ? 1 : d.handle.includes("w") ? -1 : 0;
    const vt = d.handle.includes("s") ? 1 : d.handle.startsWith("n") ? -1 : 0;
    let left = o.x, right = o.x + o.w, top = o.y, bottom = o.y + o.h;
    const snapEdge = (v: number, list: number[], axis: "x" | "y") => {
      const s = snapTo([v], list, thr);
      if (s.at !== null) g[axis].push(s.at);
      return v + s.shift;
    };
    if (hz === 1) right = snapEdge(snapStep(right + dx, step), tx, "x");
    if (hz === -1) left = snapEdge(snapStep(left + dx, step), tx, "x");
    if (vt === 1) bottom = snapEdge(snapStep(bottom + dy, step), ty, "y");
    if (vt === -1) top = snapEdge(snapStep(top + dy, step), ty, "y");
    left = Math.min(left, right - MIN);
    right = Math.max(right, left + MIN);
    top = Math.min(top, bottom - MIN);
    bottom = Math.max(bottom, top + MIN);
    let x = left, y = top, w = right - left, h = bottom - top;
    const keep = o.type === "image" || (o.type === "code" && o.kind === "qr");
    if (keep && hz !== 0 && vt !== 0) {
      const ratio = o.w / o.h;
      if (w / h > ratio) w = h * ratio;
      else h = w / ratio;
      if (hz === -1) x = right - w;
      if (vt === -1) y = bottom - h;
    }
    let next: BlankEl = { ...o, x: r2(x), y: r2(y), w: r2(w), h: r2(h) } as BlankEl;
    // Таблица: столбцы делят новую ширину в прежних пропорциях.
    if (next.type === "table" && o.type === "table" && Math.abs(next.w - o.w) > 0.01) {
      const sum = o.cols.reduce((a, c) => a + c.w, 0) || 1;
      next = { ...next, cols: o.cols.map((c) => ({ ...c, w: r2((c.w / sum) * next.w) })) };
    }
    setGuides(g);
    setDraft({ ...design, els: design.els.map((e) => (e.id === o.id ? next : e)) });
  }

  function end() {
    unlisten();
    const d = drag.current;
    drag.current = null;
    setGuides({ x: [], y: [] });
    const cur = draftRef.current;
    setDraft(null);
    if (d?.moved && cur) onChange(cur);
  }

  // Рамка выбора по пустому месту листа.
  function startBand(e: RPointerEvent) {
    if (e.button !== 0) return;
    if (editing) onEdit(null);
    wrap.current?.focus({ preventScroll: true });
    const rect = sheetRef.current!.getBoundingClientRect();
    const at = (ev: { clientX: number; clientY: number }) => ({ x: (ev.clientX - rect.left) / px, y: (ev.clientY - rect.top) / px });
    const s = at(e);
    const additive = e.shiftKey;
    const base = additive ? selected : [];
    let moved = false;
    if (!additive) onSelect([]);
    listen(
      (ev) => {
        const c = at(ev);
        if (!moved && Math.abs(c.x - s.x) + Math.abs(c.y - s.y) < 1) return;
        moved = true;
        const b = { x1: Math.min(s.x, c.x), y1: Math.min(s.y, c.y), x2: Math.max(s.x, c.x), y2: Math.max(s.y, c.y) };
        setBand(b);
        const hit = design.els.filter((el) => el.x < b.x2 && el.x + el.w > b.x1 && el.y < b.y2 && el.y + el.h > b.y1).map((el) => el.id);
        onSelect([...new Set([...base, ...hit])]);
      },
      () => {
        unlisten();
        setBand(null);
      }
    );
  }

  // ---------------------------------------------------------------- клавиатура

  function onKey(e: React.KeyboardEvent) {
    if (editing) return; // в тексте клавиши — тексту
    const mod = e.ctrlKey || e.metaKey;
    const k = e.code;
    if (mod && k === "KeyZ") {
      e.preventDefault();
      if (e.shiftKey) p.onRedo();
      else p.onUndo();
      return;
    }
    if (mod && k === "KeyY") return void (e.preventDefault(), p.onRedo());
    if (mod && k === "KeyA") return void (e.preventDefault(), onSelect(design.els.map((x) => x.id)));
    if (mod && k === "KeyC") return void (e.preventDefault(), p.onCopy());
    if (mod && k === "KeyV") return void (e.preventDefault(), p.onPaste());
    if (mod && k === "KeyD") return void (e.preventDefault(), p.onDuplicate());
    if (e.key === "Escape") return onSelect([]);
    if (!sel.length) return;
    if (e.key === "Delete" || e.key === "Backspace") return void (e.preventDefault(), p.onDelete());
    if (e.key === "Enter" && single?.type === "text") return void (e.preventDefault(), onEdit(single.id));
    const step = e.shiftKey ? 0.1 : STEP;
    const d = ({ ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] } as Record<string, number[]>)[e.key];
    if (!d) return;
    e.preventDefault();
    onChange({ ...design, els: design.els.map((x) => (selected.includes(x.id) && !x.locked ? ({ ...x, x: r2(x.x + d[0]), y: r2(x.y + d[1]) } as BlankEl) : x)) });
  }

  // ---------------------------------------------------------------- текст на листе

  const editorRef = useRef<HTMLDivElement>(null);
  const editEl = editing ? (D.els.find((x) => x.id === editing) as TextEl | undefined) : undefined;
  const commitText = useCallback(
    (html: string) => {
      if (!editEl) return;
      const clean = sanitizeHtml(html);
      if (clean === editEl.html) return;
      onChange({ ...design, els: design.els.map((x) => (x.id === editEl.id ? { ...x, html: clean } : x)) }, false);
    },
    [design, editEl, onChange]
  );

  // Щелчок мимо текста и панели — конец правки.
  useEffect(() => {
    if (!editing) return;
    const down = (ev: PointerEvent) => {
      const t = ev.target as Node;
      if (editorRef.current?.contains(t)) return;
      if ((t as Element).closest?.("[data-text-toolbar]")) return;
      onEdit(null);
    };
    window.addEventListener("pointerdown", down, true);
    return () => window.removeEventListener("pointerdown", down, true);
  }, [editing, onEdit]);

  const api: EditorApi | null = editEl ? { el: editEl, node: editorRef, commit: commitText } : null;

  // ---------------------------------------------------------------- рисуем

  const m = design.page.margin;
  const handleSize = 9 / px;
  const toolbarFor = editEl ?? (single?.type === "text" ? single : null);
  const textSel = sel.filter((x): x is TextEl => x.type === "text");

  return (
    <div className="min-w-0">
      <style>{BLANK_CSS}</style>
      <div
        ref={wrap}
        tabIndex={0}
        onKeyDown={onKey}
        className="relative overflow-auto rounded-card bg-[#6B7280] p-3 outline-none focus-visible:ring-2 focus-visible:ring-brand"
        style={{ maxHeight: "calc(100vh - 170px)", minHeight: 360 }}
        aria-label="Лист бланка: щелчок — выбрать, тянуть — двигать, двойной щелчок по тексту — писать"
        data-blank-canvas
      >
        <div style={{ width: pw * px, height: ph * px, position: "relative", margin: "0 auto" }}>
          <div
            ref={sheetRef}
            className="bf-sheet"
            onPointerDown={startBand}
            style={{
              width: `${pw}mm`,
              height: `${ph}mm`,
              transform: `scale(${scale})`,
              transformOrigin: "top left",
              position: "relative",
              background: "#fff",
              boxShadow: "0 4px 18px rgba(0,0,0,.35)",
              backgroundImage: grid
                ? "linear-gradient(to right, rgba(0,0,0,.05) 0.1mm, transparent 0.1mm), linear-gradient(to bottom, rgba(0,0,0,.05) 0.1mm, transparent 0.1mm)"
                : undefined,
              backgroundSize: grid ? "5mm 5mm" : undefined,
            }}
          >
            {/* поля листа */}
            {m > 0 && (
              <div
                style={{ position: "absolute", left: `${m}mm`, top: `${m}mm`, right: `${m}mm`, bottom: `${m}mm`, outline: `${line}px dashed rgba(224,51,111,.35)`, pointerEvents: "none" }}
                data-margins
              />
            )}
            {D.els.map((el) =>
              el.id === editing && el.type === "text" ? (
                <EditableText key={el.id} el={el} target={target} nodeRef={editorRef} onInput={commitText} onDone={() => onEdit(null)} />
              ) : (
                <ElView key={el.id} el={el} data={null} target={target} sample={sample} />
              )
            )}
            {guides.x.map((g) => (
              <div key={`gx${g}`} style={{ position: "absolute", left: `${g}mm`, top: 0, bottom: 0, width: line * 1.5, marginLeft: -line * 0.75, background: "#E0336F", pointerEvents: "none" }} />
            ))}
            {guides.y.map((g) => (
              <div key={`gy${g}`} style={{ position: "absolute", top: `${g}mm`, left: 0, right: 0, height: line * 1.5, marginTop: -line * 0.75, background: "#E0336F", pointerEvents: "none" }} />
            ))}
            {band && (
              <div style={{ position: "absolute", left: `${band.x1}mm`, top: `${band.y1}mm`, width: `${band.x2 - band.x1}mm`, height: `${band.y2 - band.y1}mm`, border: `${line}px solid #2A7FD0`, background: "rgba(42,127,208,.1)", pointerEvents: "none" }} />
            )}
            {D.els.map((el) => {
              if (el.id === editing) return null;
              const on = selected.includes(el.id);
              const bad = overflow.has(el.id);
              const frame: CSSProperties = {
                position: "absolute",
                left: `${el.x}mm`,
                top: `${el.y}mm`,
                width: `${el.w}mm`,
                height: `${Math.max(el.h, growH.get(el.id) ?? 0)}mm`,
                outline: `${(on ? 2 : 1) * line}px ${on || bad ? "solid" : "dashed"} ${bad ? "#DC2626" : on ? "#2A7FD0" : "rgba(42,127,208,.35)"}`,
                background: on ? "rgba(42,127,208,.06)" : "transparent",
                cursor: el.locked ? "default" : "move",
                touchAction: "none",
                zIndex: on ? 3 : 2,
              };
              return (
                <div
                  key={el.id}
                  data-frame={el.id}
                  data-type={el.type}
                  role="button"
                  aria-label={EL_NAME[el.type]}
                  aria-pressed={on}
                  style={frame}
                  onPointerDown={(ev) => start(ev, el, "move")}
                  onDoubleClick={() => el.type === "text" && !el.locked && onEdit(el.id)}
                >
                  {on && single && (
                    <>
                      <span
                        style={{
                          position: "absolute",
                          bottom: "100%",
                          left: 0,
                          transform: `scale(${1 / scale})`,
                          transformOrigin: "bottom left",
                          whiteSpace: "nowrap",
                          background: "#2A7FD0",
                          color: "#fff",
                          font: "600 11px/1.6 Inter, sans-serif",
                          padding: "0 5px",
                          borderRadius: 3,
                          marginBottom: 2 / scale,
                          pointerEvents: "none",
                        }}
                      >
                        {EL_NAME[el.type]}
                        {el.locked ? " 🔒" : ""} · {r2(el.w)}×{r2(el.h)} мм
                        {el.type === "table" ? " · растянется по строкам" : el.type === "text" && el.grow ? " · по тексту" : ""}
                        {bad ? " · текст не влезает" : ""}
                      </span>
                      {!el.locked &&
                        handlesOf(el).map((hd) => {
                          const cx = hd.includes("e") ? "100%" : hd.includes("w") ? "0%" : "50%";
                          const cy = hd.includes("s") ? "100%" : hd.startsWith("n") ? "0%" : "50%";
                          return (
                            <span
                              key={hd}
                              data-handle={hd}
                              onPointerDown={(ev) => start(ev, el, hd)}
                              style={{
                                position: "absolute",
                                left: cx,
                                top: cy,
                                width: `${handleSize}mm`,
                                height: `${handleSize}mm`,
                                marginLeft: `${-handleSize / 2}mm`,
                                marginTop: `${-handleSize / 2}mm`,
                                background: "#fff",
                                border: `${1.5 * line}px solid #2A7FD0`,
                                borderRadius: hd.length === 2 ? 2 * line : "50%",
                                cursor: CURSOR[hd],
                                touchAction: "none",
                              }}
                            />
                          );
                        })}
                    </>
                  )}
                </div>
              );
            })}
          </div>
          {toolbarFor && (
            <TextToolbar
              key={toolbarFor.id + (editEl ? ":edit" : "")}
              el={toolbarFor}
              target={target}
              editor={api}
              anchor={{ x: toolbarFor.x * px, y: toolbarFor.y * px, w: toolbarFor.w * px, h: (growH.get(toolbarFor.id) ?? toolbarFor.h) * px }}
              onPatch={(st) => p.onPatchStyle(textSel.length ? textSel.map((x) => x.id) : [toolbarFor.id], st)}
              onEditStart={() => onEdit(toolbarFor.id)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** Текст, в котором пишут прямо на листе. */
function EditableText({ el, target, nodeRef, onInput, onDone }: { el: TextEl; target: Target; nodeRef: React.RefObject<HTMLDivElement>; onInput: (html: string) => void; onDone: () => void }) {
  useLayoutEffect(() => {
    const n = nodeRef.current;
    if (!n) return;
    n.innerHTML = normalizeBlocks(textHtml(el, null, target));
    try {
      document.execCommand("styleWithCSS", false, "true");
      document.execCommand("defaultParagraphSeparator", false, "div");
    } catch {
      /* старые браузеры */
    }
    n.focus();
    const r = document.createRange();
    r.selectNodeContents(n);
    r.collapse(false);
    const s = window.getSelection();
    s?.removeAllRanges();
    s?.addRange(r);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [el.id]);
  return (
    <div style={{ position: "absolute", left: `${el.x}mm`, top: `${el.y}mm`, width: `${el.w}mm`, minHeight: `${el.h}mm`, ...textBoxCss(el), outline: "0.35mm solid #2A7FD0", zIndex: 5, background: el.st.fill ?? "#fff" }}>
      <div
        ref={nodeRef}
        className="bf-text"
        contentEditable
        suppressContentEditableWarning
        data-text-editor
        spellCheck
        style={{ ...textStyleCss(el), outline: "none", minHeight: "1em", cursor: "text" }}
        onInput={(e) => onInput((e.target as HTMLDivElement).innerHTML)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onDone();
          }
          e.stopPropagation();
        }}
        onPaste={(e) => {
          e.preventDefault();
          const html = e.clipboardData.getData("text/html");
          const plain = e.clipboardData.getData("text/plain");
          const clean = html ? sanitizeHtml(html) : plain.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r?\n/g, "<br>");
          document.execCommand("insertHTML", false, clean);
          onInput((e.currentTarget as HTMLDivElement).innerHTML);
        }}
      />
    </div>
  );
}

/** Строчное содержимое верхнего уровня — в абзацы <div>: межстрочный интервал задаётся абзацу. */
function normalizeBlocks(html: string): string {
  const t = document.createElement("div");
  t.innerHTML = html;
  const out = document.createElement("div");
  let run: HTMLDivElement | null = null;
  for (const n of Array.from(t.childNodes)) {
    const block = n instanceof Element && ["DIV", "P", "UL", "OL"].includes(n.tagName);
    if (block) {
      run = null;
      out.appendChild(n);
      continue;
    }
    if (n instanceof Element && n.tagName === "BR") {
      if (!run) out.appendChild(document.createElement("div")).appendChild(document.createElement("br"));
      run = null;
      continue;
    }
    if (!run) run = out.appendChild(document.createElement("div"));
    run.appendChild(n);
  }
  if (!out.childNodes.length) out.appendChild(document.createElement("div")).appendChild(document.createElement("br"));
  return out.innerHTML;
}
