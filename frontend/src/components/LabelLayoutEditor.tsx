import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as RPointerEvent } from "react";
import { code128Bars, DOT_MM, moduleWidth, type LabelField, type LabelSettings } from "../lib/labels";
import { EL_NAME, FIELD_OF, elOn, isText, type ElKind, type LabelLayout, type LayoutEl } from "../lib/labelLayout";
import { LayoutElements, type LabelData } from "./Label";
import { Button } from "./ui";

/**
 * Редактор своего макета наклейки.
 *
 * Под рамками лежит настоящая наклейка (LayoutElements — тот же код, что
 * печатает), поверх — рамки элементов: тянуть за середину — двигать, за
 * уголки и стороны — менять размер. Шаг — 0,5 мм; элементы прилипают к краям
 * и центру этикетки и друг к другу, на прилипании видна направляющая.
 * Клавиатура: стрелки — 0,5 мм (с Shift — 0,1), Delete — убрать с наклейки,
 * Esc — снять выбор, Ctrl+Z / Ctrl+Shift+Z — отменить и вернуть.
 *
 * Редактируется содержимое в своей ориентации: с «Повернуть» — уже
 * повёрнутое, как его читают. Как ляжет на рулон — видно в предпросмотре.
 */

const PX_PER_MM = 96 / 25.4;
const STEP = 0.5;
const MIN = 1;

type Handle = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const HANDLES: Exclude<Handle, "move">[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const CURSOR: Record<Handle, string> = {
  move: "move",
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  nw: "nwse-resize",
  se: "nwse-resize",
};

const r2 = (v: number) => Math.round(v * 100) / 100;
const snapStep = (v: number, step: number) => r2(Math.round(v / step) * step);

interface Guides {
  x: number[];
  y: number[];
}

/** Прилипание: сдвиг, при котором одна из линий элемента совпадёт с ближайшей целью. */
function snapTo(lines: number[], targets: number[], thr: number): { shift: number; at: number | null } {
  let best: { shift: number; at: number | null; d: number } = { shift: 0, at: null, d: thr };
  for (const l of lines) for (const t of targets) {
    const d = Math.abs(t - l);
    if (d < best.d) best = { shift: t - l, at: t, d };
  }
  return { shift: best.shift, at: best.at };
}

export function LabelLayoutEditor({
  settings,
  layout,
  data,
  overflow,
  onChange,
  onToggleField,
}: {
  settings: LabelSettings;
  layout: LabelLayout;
  data: LabelData;
  /** Не влезшие элементы — красная рамка. */
  overflow: ElKind[];
  onChange: (l: LabelLayout) => void;
  onToggleField: (f: LabelField) => void;
}) {
  const [sel, setSel] = useState<ElKind | null>(null);
  const [draft, setDraftState] = useState<LabelLayout | null>(null);
  // Черновик перетаскивания — и в состоянии (рисовать), и в ссылке (отпустили — записать).
  const draftRef = useRef<LabelLayout | null>(null);
  const setDraft = (l: LabelLayout | null) => {
    draftRef.current = l;
    setDraftState(l);
  };
  const [guides, setGuides] = useState<Guides>({ x: [], y: [] });
  const past = useRef<LabelLayout[]>([]);
  const future = useRef<LabelLayout[]>([]);
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(480);

  // Масштаб — под ширину колонки: макет должен быть крупным, иначе в уголок не попасть.
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const L = draft ?? layout;
  const scale = Math.max(1, Math.min((width - 8) / (L.w * PX_PER_MM), 420 / (L.h * PX_PER_MM), 4));
  const px = PX_PER_MM * scale; // точек экрана на миллиметр
  const shown = L.elements.filter((e) => elOn(settings, e.kind));
  const selEl = shown.find((e) => e.kind === sel) ?? null;

  const commit = useCallback(
    (next: LabelLayout) => {
      past.current = [...past.current.slice(-49), layout];
      future.current = [];
      onChange(next);
    },
    [layout, onChange]
  );
  const patchEl = (kind: ElKind, p: Partial<LayoutEl>) =>
    commit({ ...layout, elements: layout.elements.map((e) => (e.kind === kind ? { ...e, ...p } : e)) });

  const undo = () => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current = [layout, ...future.current];
    onChange(prev);
  };
  const redo = () => {
    const [next, ...rest] = future.current;
    if (!next) return;
    future.current = rest;
    past.current = [...past.current, layout];
    onChange(next);
  };

  // ---------------------------------------------------------------- мышь и палец

  const drag = useRef<{ kind: ElKind; handle: Handle; sx: number; sy: number; orig: LayoutEl; moved: boolean } | null>(null);
  // Слушатели окна — те, что поставлены в начале перетаскивания: перерисовка их не меняет.
  const listening = useRef<{ move: (ev: PointerEvent) => void; end: () => void } | null>(null);
  const unlisten = () => {
    const l = listening.current;
    if (!l) return;
    window.removeEventListener("pointermove", l.move);
    window.removeEventListener("pointerup", l.end);
    window.removeEventListener("pointercancel", l.end);
    listening.current = null;
  };

  function start(e: RPointerEvent, kind: ElKind, handle: Handle) {
    e.preventDefault();
    e.stopPropagation();
    setSel(kind);
    wrap.current?.focus({ preventScroll: true });
    const orig = layout.elements.find((x) => x.kind === kind);
    if (!orig) return;
    unlisten();
    drag.current = { kind, handle, sx: e.clientX, sy: e.clientY, orig, moved: false };
    listening.current = { move, end };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }

  function geometry(d: NonNullable<typeof drag.current>, dx: number, dy: number, fine: boolean): { el: LayoutEl; guides: Guides } {
    const o = d.orig;
    const step = fine ? 0.1 : STEP;
    const thr = 6 / px; // 6 точек экрана
    const others = layout.elements.filter((x) => x.kind !== o.kind && elOn(settings, x.kind));
    const tx = [0, L.w / 2, L.w, ...others.flatMap((x) => [x.x, x.x + x.w / 2, x.x + x.w])];
    const ty = [0, L.h / 2, L.h, ...others.flatMap((x) => [x.y, x.y + x.h / 2, x.y + x.h])];
    const g: Guides = { x: [], y: [] };
    let { x, y, w, h } = o;

    if (d.handle === "move") {
      x = snapStep(o.x + dx, step);
      y = snapStep(o.y + dy, step);
      const sx = snapTo([x, x + w / 2, x + w], tx, thr);
      const sy = snapTo([y, y + h / 2, y + h], ty, thr);
      x = r2(x + sx.shift);
      y = r2(y + sy.shift);
      if (sx.at !== null) g.x.push(sx.at);
      if (sy.at !== null) g.y.push(sy.at);
      x = Math.min(Math.max(0, x), r2(L.w - w));
      y = Math.min(Math.max(0, y), r2(L.h - h));
      return { el: { ...o, x, y }, guides: g };
    }

    const hz = d.handle.includes("e") ? 1 : d.handle.includes("w") ? -1 : 0;
    const vt = d.handle.includes("s") ? 1 : d.handle.startsWith("n") ? -1 : 0;
    let left = o.x, right = o.x + o.w, top = o.y, bottom = o.y + o.h;
    if (hz === 1) {
      right = snapStep(right + dx, step);
      const s = snapTo([right], tx, thr);
      right += s.shift;
      if (s.at !== null) g.x.push(s.at);
    }
    if (hz === -1) {
      left = snapStep(left + dx, step);
      const s = snapTo([left], tx, thr);
      left += s.shift;
      if (s.at !== null) g.x.push(s.at);
    }
    if (vt === 1) {
      bottom = snapStep(bottom + dy, step);
      const s = snapTo([bottom], ty, thr);
      bottom += s.shift;
      if (s.at !== null) g.y.push(s.at);
    }
    if (vt === -1) {
      top = snapStep(top + dy, step);
      const s = snapTo([top], ty, thr);
      top += s.shift;
      if (s.at !== null) g.y.push(s.at);
    }
    left = Math.max(0, Math.min(left, right - MIN));
    right = Math.min(L.w, Math.max(right, left + MIN));
    top = Math.max(0, Math.min(top, bottom - MIN));
    bottom = Math.min(L.h, Math.max(bottom, top + MIN));
    x = left;
    y = top;
    w = right - left;
    h = bottom - top;
    // Логотип и QR-код не искажаем: угол тянет обе стороны в прежней пропорции.
    const keep = o.kind === "logo" || (o.kind === "code" && settings.code === "qr");
    if (keep && hz !== 0 && vt !== 0) {
      const ratio = o.w / o.h;
      if (w / h > ratio) w = h * ratio;
      else h = w / ratio;
      if (hz === -1) x = right - w;
      if (vt === -1) y = bottom - h;
    }
    return { el: { ...o, x: r2(x), y: r2(y), w: r2(w), h: r2(h) }, guides: g };
  }

  function move(ev: PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const dx = (ev.clientX - d.sx) / px;
    const dy = (ev.clientY - d.sy) / px;
    if (!d.moved && Math.abs(ev.clientX - d.sx) + Math.abs(ev.clientY - d.sy) < 3) return;
    d.moved = true;
    const { el, guides: g } = geometry(d, dx, dy, ev.altKey);
    setGuides(g);
    setDraft({ ...layout, elements: layout.elements.map((x) => (x.kind === el.kind ? el : x)) });
  }

  function end() {
    unlisten();
    const d = drag.current;
    drag.current = null;
    setGuides({ x: [], y: [] });
    const cur = draftRef.current;
    setDraft(null);
    if (d?.moved && cur) commit(cur);
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => unlisten, []);

  // ---------------------------------------------------------------- клавиатура

  function onKey(e: KeyboardEvent) {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === "z" || e.key === "я" || e.code === "KeyZ")) {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (mod && (e.code === "KeyY")) {
      e.preventDefault();
      redo();
      return;
    }
    if (!selEl) return;
    if (e.key === "Escape") return setSel(null);
    if ((e.key === "Delete" || e.key === "Backspace") && FIELD_OF[selEl.kind]) {
      e.preventDefault();
      onToggleField(FIELD_OF[selEl.kind]!);
      setSel(null);
      return;
    }
    const step = e.shiftKey ? 0.1 : STEP;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!d) return;
    e.preventDefault();
    patchEl(selEl.kind, {
      x: r2(Math.min(Math.max(0, selEl.x + d[0]), L.w - selEl.w)),
      y: r2(Math.min(Math.max(0, selEl.y + d[1]), L.h - selEl.h)),
    });
  }

  // ---------------------------------------------------------------- рисуем

  const line = 1 / scale; // одна точка экрана внутри уменьшенного в мм поля
  const handleSize = 9 / px;

  return (
    <div className="min-w-0">
      <div
        ref={wrap}
        tabIndex={0}
        onKeyDown={onKey}
        onPointerDown={() => setSel(null)}
        className="flex justify-center rounded-card bg-[#6B7280] p-1 outline-none focus-visible:ring-2 focus-visible:ring-brand"
        aria-label="Макет наклейки: перетаскивайте элементы, уголки меняют размер"
      >
        <div style={{ width: L.w * px, height: L.h * px, position: "relative" }}>
          <div
            data-layout-canvas
            style={{
              width: `${L.w}mm`,
              height: `${L.h}mm`,
              transform: `scale(${scale})`,
              transformOrigin: "top left",
              position: "relative",
              background: "#fff",
              color: "#000",
              fontFamily: "Inter, Arial, sans-serif",
              // сетка: миллиметр и каждые пять
              backgroundImage:
                "linear-gradient(to right, rgba(0,0,0,.06) 0.1mm, transparent 0.1mm), linear-gradient(to bottom, rgba(0,0,0,.06) 0.1mm, transparent 0.1mm)," +
                "linear-gradient(to right, rgba(0,0,0,.12) 0.1mm, transparent 0.1mm), linear-gradient(to bottom, rgba(0,0,0,.12) 0.1mm, transparent 0.1mm)",
              backgroundSize: "1mm 1mm, 1mm 1mm, 5mm 5mm, 5mm 5mm",
              boxShadow: "0 4px 16px rgba(0,0,0,.35)",
            }}
          >
            <LayoutElements layout={L} settings={settings} data={data} placeholders />
            {guides.x.map((g) => (
              <div key={`gx${g}`} style={{ position: "absolute", left: `${g}mm`, top: 0, bottom: 0, width: line * 1.5, marginLeft: -line * 0.75, background: "#E0336F", pointerEvents: "none" }} />
            ))}
            {guides.y.map((g) => (
              <div key={`gy${g}`} style={{ position: "absolute", top: `${g}mm`, left: 0, right: 0, height: line * 1.5, marginTop: -line * 0.75, background: "#E0336F", pointerEvents: "none" }} />
            ))}
            {shown.map((e) => {
              const on = e.kind === sel;
              const bad = overflow.includes(e.kind);
              const frame: CSSProperties = {
                position: "absolute",
                left: `${e.x}mm`,
                top: `${e.y}mm`,
                width: `${e.w}mm`,
                height: `${e.h}mm`,
                outline: `${(on ? 2 : 1) * line}px ${on || bad ? "solid" : "dashed"} ${bad ? "#DC2626" : on ? "#2A7FD0" : "rgba(42,127,208,.55)"}`,
                background: on ? "rgba(42,127,208,.08)" : bad ? "rgba(220,38,38,.08)" : "transparent",
                cursor: "move",
                touchAction: "none",
                // выбранный — поверх соседей: его уголки не должны прятаться под чужой рамкой
                zIndex: on ? 2 : 1,
              };
              return (
                <div
                  key={e.kind}
                  data-frame={e.kind}
                  role="button"
                  aria-label={EL_NAME[e.kind]}
                  aria-pressed={on}
                  style={frame}
                  onPointerDown={(ev) => start(ev, e.kind, "move")}
                >
                  {on && (
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
                        {EL_NAME[e.kind]} · {e.w}×{e.h} мм
                      </span>
                      {HANDLES.map((hd) => {
                        const cx = hd.includes("e") ? "100%" : hd.includes("w") ? "0%" : "50%";
                        const cy = hd.includes("s") ? "100%" : hd.startsWith("n") ? "0%" : "50%";
                        return (
                          <span
                            key={hd}
                            data-handle={hd}
                            onPointerDown={(ev) => start(ev, e.kind, hd)}
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
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[12.5px] text-ink-dim">
        <span>Тяните элемент, уголки — размер. Стрелки — 0,5 мм, с Shift — 0,1. С Alt — без шага сетки.</span>
        <span className="flex gap-1.5">
          <Button type="button" variant="ghost" disabled={!past.current.length} onClick={undo} className="min-h-[34px] px-3 text-[12.5px]">
            Отменить
          </Button>
          <Button type="button" variant="ghost" disabled={!future.current.length} onClick={redo} className="min-h-[34px] px-3 text-[12.5px]">
            Вернуть
          </Button>
        </span>
      </div>

      {selEl ? (
        <Props el={selEl} settings={settings} data={data} onPatch={(p) => patchEl(selEl.kind, p)} onRemove={FIELD_OF[selEl.kind] ? () => { onToggleField(FIELD_OF[selEl.kind]!); setSel(null); } : undefined} />
      ) : (
        <p className="mt-3 rounded-field border border-dashed border-line px-3 py-2.5 text-[13px] text-ink-dim">
          Нажмите на элемент на макете — здесь появятся его размер, шрифт и выравнивание.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- свойства

function Num({ label, value, onChange, step = 0.5, min, max, suffix }: { label: string; value: number; onChange: (v: number) => void; step?: number; min: number; max: number; suffix: string }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const put = (v: number) => onChange(r2(Math.min(max, Math.max(min, v))));
  const btn = "w-9 shrink-0 bg-surface-raised text-[16px] font-bold text-ink-muted transition-colors hover:bg-surface hover:text-ink";
  return (
    <label className="flex min-w-0 flex-col gap-1 text-[12px] font-semibold text-ink-muted">
      <span>
        {label}, <span className="font-normal text-ink-dim">{suffix}</span>
      </span>
      <span className="flex h-9 min-w-0 overflow-hidden rounded-field border border-line focus-within:border-brand">
        <button type="button" aria-label={`${label}: меньше`} onClick={() => put(value - step)} className={btn + " border-r border-line"}>
          −
        </button>
        <input
          aria-label={label}
          inputMode="decimal"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => {
            const v = Number(text.replace(",", "."));
            if (Number.isFinite(v)) put(v);
            else setText(String(value));
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          className="w-full min-w-0 flex-1 bg-surface-input px-1 text-center text-[14px] tabular-nums text-ink outline-none"
        />
        <button type="button" aria-label={`${label}: больше`} onClick={() => put(value + step)} className={btn + " border-l border-line"}>
          +
        </button>
      </span>
    </label>
  );
}

function Seg<T extends string | number>({ items, value, onPick, label }: { items: Array<[T, string]>; value: T; onPick: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex overflow-hidden rounded-field border border-line">
      {items.map(([v, t]) => (
        <button
          key={String(v)}
          type="button"
          role="radio"
          aria-checked={value === v}
          onClick={() => onPick(v)}
          className={"min-h-[34px] flex-1 px-2.5 text-[12.5px] font-semibold transition-colors " + (value === v ? "bg-brand-tint text-brand-ink" : "bg-surface-raised text-ink-muted hover:text-ink")}
        >
          {t}
        </button>
      ))}
    </div>
  );
}

function Props({
  el,
  settings,
  data,
  onPatch,
  onRemove,
}: {
  el: LayoutEl;
  settings: LabelSettings;
  data: LabelData;
  onPatch: (p: Partial<LayoutEl>) => void;
  onRemove?: () => void;
}) {
  const dots = el.kind === "code" && settings.code === "code128" ? moduleWidth(code128Bars(data.code).modules, el.w).dots : null;
  const tooNarrow = el.kind === "code" && settings.code === "code128" && code128Bars(data.code).modules * DOT_MM > el.w;
  return (
    <div className="mt-3 space-y-3 rounded-card border border-line bg-surface-raised/50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[14px] font-bold">{el.kind === "code" && settings.code === "qr" ? "QR-код" : EL_NAME[el.kind]}</p>
        {onRemove && (
          <button type="button" onClick={onRemove} className="text-[12.5px] font-semibold text-state-off hover:underline">
            Убрать с наклейки
          </button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
        <Num label="X" value={el.x} min={0} max={160} onChange={(x) => onPatch({ x })} suffix="мм" />
        <Num label="Y" value={el.y} min={0} max={160} onChange={(y) => onPatch({ y })} suffix="мм" />
        <Num label="Ширина" value={el.w} min={MIN} max={160} onChange={(w) => onPatch(el.kind === "code" && settings.code === "qr" ? { w, h: w } : { w })} suffix="мм" />
        <Num label="Высота" value={el.h} min={MIN} max={160} onChange={(h) => onPatch(el.kind === "code" && settings.code === "qr" ? { w: h, h } : { h })} suffix="мм" />
      </div>
      {isText(el.kind) && (
        <>
          <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
            <Num label="Шрифт" value={el.size ?? 8} step={1} min={3} max={72} onChange={(size) => onPatch({ size })} suffix="пт" />
            <div className="flex flex-col gap-1 text-[12px] font-semibold text-ink-muted">
              Строк
              <Seg label="Строк" items={[[1, "1"], [2, "2"], [3, "3"]]} value={el.lines ?? 1} onPick={(lines) => onPatch({ lines })} />
            </div>
            <div className="col-span-2 flex flex-col gap-1 text-[12px] font-semibold text-ink-muted">
              Начертание
              <div className="flex flex-wrap gap-1.5">
                <Seg label="Жирный" items={[[0, "Обычный"], [1, "Жирный"]]} value={el.bold ? 1 : 0} onPick={(v) => onPatch({ bold: v === 1 })} />
                <Seg label="Заглавные" items={[[0, "Аа"], [1, "АА"]]} value={el.upper ? 1 : 0} onPick={(v) => onPatch({ upper: v === 1 })} />
              </div>
            </div>
          </div>
        </>
      )}
      <div className="flex flex-col gap-1 text-[12px] font-semibold text-ink-muted">
        Выравнивание
        <Seg
          label="Выравнивание"
          items={[
            ["left", "Влево"],
            ["center", "По центру"],
            ["right", "Вправо"],
          ]}
          value={el.align ?? (el.kind === "code" ? "center" : "left")}
          onPick={(align) => onPatch({ align })}
        />
      </div>
      {dots !== null && (
        <p className={"text-[12.5px] " + (tooNarrow || dots < 2 ? "text-state-waiting" : "text-ink-dim")}>
          {tooNarrow
            ? "Штрихкод не помещается в такую ширину — сделайте шире."
            : dots < 2
              ? "Штрихкод получается слишком плотным — сканер может его не прочитать. Сделайте шире."
              : `Полоса штрихкода — ${dots} ${dots === 1 ? "точка" : dots < 5 ? "точки" : "точек"} принтера: сканер прочитает.`}
        </p>
      )}
    </div>
  );
}
