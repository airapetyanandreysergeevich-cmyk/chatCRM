import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/**
 * Графики раздела «Статистика» — свои, на SVG, без библиотек.
 *
 * Библиотека графиков весит больше всего приложения и красится по-своему.
 * Здесь пять видов, и каждый берёт цвета из темы программы: в светлой и
 * тёмной, в любой палитре из «Интерфейса» они свои.
 *
 * Правила, которых держимся везде:
 *  — одна ось: две величины разного масштаба — два графика, не две шкалы;
 *  — подписи — цветом текста, цвет несёт только сама метка;
 *  — у каждого графика есть подсказка при наведении и таблица с теми же
 *    цифрами (кнопка «Таблица» в карточке), чтобы ничего не держалось на
 *    одном цвете и одной мыши.
 */

// Цвета — токены темы (в CSS они «R G B»).
export const C = {
  brand: "rgb(var(--brand))",
  good: "rgb(var(--state-done))",
  bad: "rgb(var(--state-off))",
  teal: "rgb(var(--state-progress))",
  amber: "rgb(var(--state-waiting))",
  ghost: "rgb(var(--ink-dim))",
  surface: "rgb(var(--surface))",
  line: "rgb(var(--line))",
  ink: "rgb(var(--ink))",
  inkDim: "rgb(var(--ink-dim))",
};

// ---------------------------------------------------------------- подсказка

type TipRow = [name: string, value: string, color?: string, line?: boolean];

/**
 * Одна подсказка на всё приложение, прямо в DOM: движение мыши по графику
 * не должно перерисовывать React-дерево на каждый пиксель.
 */
let tipEl: HTMLDivElement | null = null;
function tipNode() {
  if (tipEl) return tipEl;
  tipEl = document.createElement("div");
  tipEl.className =
    "pointer-events-none fixed z-[80] min-w-[140px] max-w-[280px] rounded-[10px] border border-line-strong bg-surface-raised px-2.5 py-2 text-[12.5px] text-ink shadow-raised";
  tipEl.hidden = true;
  document.body.append(tipEl);
  return tipEl;
}

export function showTip(ev: { clientX: number; clientY: number }, title: string, rows: TipRow[]) {
  const el = tipNode();
  el.replaceChildren();
  const t = document.createElement("div");
  t.className = "mb-1 text-[12px] text-ink-muted";
  t.textContent = title;
  el.append(t);
  for (const [name, value, color, line] of rows) {
    const r = document.createElement("div");
    r.className = "flex items-center justify-between gap-3";
    const left = document.createElement("span");
    left.className = "inline-flex items-center gap-1.5 text-ink-muted";
    if (color) {
      const k = document.createElement("i");
      k.style.cssText = `display:inline-block;background:${color};${line ? "width:14px;height:2px;border-radius:1px" : "width:10px;height:10px;border-radius:3px"}`;
      left.append(k);
    }
    left.append(document.createTextNode(name));
    const b = document.createElement("b");
    b.className = "text-[13.5px] tabular-nums";
    b.textContent = value;
    r.append(left, b);
    el.append(r);
  }
  el.hidden = false;
  const pad = 14;
  const w = el.offsetWidth, h = el.offsetHeight;
  let x = ev.clientX + pad, y = ev.clientY + pad;
  if (x + w > innerWidth - 8) x = ev.clientX - w - pad;
  if (y + h > innerHeight - 8) y = ev.clientY - h - pad;
  el.style.left = `${Math.max(8, x)}px`;
  el.style.top = `${Math.max(8, y)}px`;
}
export const hideTip = () => {
  if (tipEl) tipEl.hidden = true;
};

/** Уходя со страницы, подсказку прячем: иначе она осталась бы висеть над другим разделом. */
export function useHideTipOnUnmount() {
  useEffect(() => hideTip, []);
}

// ---------------------------------------------------------------- ширина

function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW((prev) => (Math.abs(prev - el.clientWidth) > 3 ? el.clientWidth : prev)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

// ---------------------------------------------------------------- оси

/** Круглый шаг сетки: 1, 2, 5 × 10ⁿ. */
function niceStep(v: number) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}
const nf = new Intl.NumberFormat("ru-RU");
const roundTop = (x: number, y: number, w: number, h: number, r: number) => {
  if (h <= 0 || w <= 0) return "";
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
};

// ---------------------------------------------------------------- столбики и линии

export interface Series {
  name: string;
  values: number[];
  color: string;
  /** bar — столбик, line — линия, area — линия с заливкой, ghost — прошлый год, тонкая серая. */
  kind: "bar" | "line" | "area" | "ghost";
}

export function ColumnChart({
  labels,
  full,
  series,
  stacked = false,
  percent = false,
  height = 240,
  fmt = (v: number) => nf.format(Math.round(v)),
  axisFmt,
  onClick,
  selected,
  title,
}: {
  labels: string[];
  full: string[];
  series: Series[];
  stacked?: boolean;
  percent?: boolean;
  height?: number;
  fmt?: (v: number) => string;
  axisFmt?: (v: number) => string;
  onClick?: (i: number) => void;
  selected?: number | null;
  title: string;
}) {
  const [ref, W0] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const W = Math.max(280, W0);
  const H = height;
  const m = { l: 50, r: 10, t: 10, b: 26 };
  const n = labels.length;
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const bars = series.filter((s) => s.kind === "bar");
  let max = 0;
  for (let i = 0; i < n; i++) {
    if (stacked) max = Math.max(max, bars.reduce((a, s) => a + (s.values[i] ?? 0), 0));
    else for (const s of series) max = Math.max(max, s.values[i] ?? 0);
  }
  const step = percent ? 0.25 : Math.max(1, niceStep(max / 4));
  const top = percent ? 1 : Math.max(step, Math.ceil((max * 1.02) / step) * step);
  const ticks = Math.round(top / step);
  const y = (v: number) => m.t + ih - (v / top) * ih;
  const band = n ? iw / n : iw;
  const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(iw / 48))));
  const gw = stacked ? Math.min(24, band * 0.64) : Math.min(bars.length > 1 ? 14 : 24, (band * 0.7 - 2 * (bars.length - 1)) / Math.max(1, bars.length));
  const af = axisFmt ?? ((v: number) => nf.format(v));

  const rows = (i: number): TipRow[] => {
    const tot = bars.reduce((a, b) => a + (b.values[i] ?? 0), 0);
    const list: TipRow[] = series.map((s) => [
      s.name,
      percent && s.kind === "bar" ? `${fmt(s.values[i] ?? 0)} · ${tot ? Math.round(((s.values[i] ?? 0) / tot) * 100) : 0}%` : fmt(s.values[i] ?? 0),
      s.color,
      s.kind !== "bar",
    ]);
    if (stacked && bars.length > 1 && !percent) list.push(["Всего", fmt(tot)]);
    return list;
  };

  return (
    <div ref={ref} className="relative w-full">
      {W0 > 0 && (
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label={title} className="block overflow-visible">
          {Array.from({ length: ticks + 1 }, (_, k) => {
            const v = step * k;
            return (
              <g key={k}>
                <line x1={m.l} x2={W - m.r} y1={y(v)} y2={y(v)} stroke={C.line} strokeWidth={1} />
                <text x={m.l - 8} y={y(v) + 4} textAnchor="end" fontSize={11} fill={C.inkDim}>
                  {percent ? `${Math.round(v * 100)}%` : af(v)}
                </text>
              </g>
            );
          })}
          {labels.map((lb, i) =>
            i % every ? null : (
              <text key={i} x={m.l + band * i + band / 2} y={H - 8} textAnchor="middle" fontSize={11} fill={C.inkDim}>
                {lb}
              </text>
            )
          )}
          {(hover !== null || (selected ?? null) !== null) && (
            <rect
              x={m.l + band * (hover ?? selected ?? 0)}
              y={m.t}
              width={band}
              height={ih}
              rx={6}
              fill={C.ink}
              opacity={hover !== null ? 0.05 : 0.08}
            />
          )}
          {series
            .filter((s) => s.kind === "area")
            .map((s) => {
              const pts = s.values.map((v, i) => `${(m.l + band * i + band / 2).toFixed(1)},${y(v ?? 0).toFixed(1)}`);
              return n ? (
                <path key={`a${s.name}`} d={`M${m.l + band / 2},${y(0)}L${pts.join("L")}L${m.l + band * (n - 1) + band / 2},${y(0)}Z`} fill={s.color} opacity={0.12} />
              ) : null;
            })}
          {Array.from({ length: n }, (_, i) => {
            const cx = m.l + band * i + band / 2;
            if (stacked) {
              const tot = bars.reduce((a, s) => a + (s.values[i] ?? 0), 0);
              let acc = 0;
              const segs = bars
                .map((s) => {
                  const v = percent ? (tot ? (s.values[i] ?? 0) / tot : 0) : s.values[i] ?? 0;
                  const r = { s, v, y0: acc };
                  acc += v;
                  return r;
                })
                .filter((g) => g.v > 0);
              return (
                <g key={i}>
                  {segs.map((g, j) => {
                    const last = j === segs.length - 1;
                    const y1 = y(g.y0 + g.v), y0 = y(g.y0);
                    // Зазор 2 px цветом фона между сегментами — сверху каждого, кроме верхнего.
                    const yy = last ? y1 : y1 + 2;
                    const h = Math.max(0, y0 - yy);
                    return <path key={j} d={last ? roundTop(cx - gw / 2, yy, gw, h, 4) : `M${cx - gw / 2},${yy}h${gw}v${h}h${-gw}Z`} fill={g.s.color} />;
                  })}
                </g>
              );
            }
            return (
              <g key={i}>
                {bars.map((s, j) => {
                  const x = cx - (bars.length * gw + (bars.length - 1) * 2) / 2 + j * (gw + 2);
                  const v = s.values[i] ?? 0;
                  return <path key={j} d={roundTop(x, y(v), gw, y(0) - y(v), 4)} fill={s.color} />;
                })}
              </g>
            );
          })}
          {series
            .filter((s) => s.kind !== "bar")
            .map((s) => {
              const pts = s.values.map((v, i) => [m.l + band * i + band / 2, y(v ?? 0)] as const);
              if (!pts.length) return null;
              const last = pts[pts.length - 1];
              return (
                <g key={`l${s.name}`}>
                  <path
                    d={`M${pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("L")}`}
                    fill="none"
                    stroke={s.color}
                    strokeWidth={s.kind === "ghost" ? 1.5 : 2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                  {s.kind !== "ghost" && <circle cx={last[0]} cy={last[1]} r={4} fill={s.color} stroke={C.surface} strokeWidth={2} />}
                </g>
              );
            })}
          {Array.from({ length: n }, (_, i) => (
            <rect
              key={`h${i}`}
              x={m.l + band * i}
              y={m.t}
              width={band}
              height={ih}
              fill="transparent"
              style={onClick ? { cursor: "pointer" } : undefined}
              onPointerMove={(ev) => {
                setHover(i);
                showTip(ev, full[i], rows(i));
              }}
              onPointerLeave={() => {
                setHover(null);
                hideTip();
              }}
              onClick={onClick ? () => onClick(i) : undefined}
            />
          ))}
        </svg>
      )}
      {W0 === 0 && <div style={{ height: H }} />}
    </div>
  );
}

// ---------------------------------------------------------------- полосы

export function HBars({
  rows,
  fmt = (v: number) => nf.format(Math.round(v)),
  color = C.brand,
  share = true,
  unit = "Заказов",
}: {
  rows: Array<{ label: string; n: number; color?: string }>;
  fmt?: (v: number) => string;
  color?: string;
  share?: boolean;
  unit?: string;
}) {
  if (!rows.length) return <p className="text-[13px] text-ink-dim">За период ничего нет</p>;
  const max = Math.max(1, ...rows.map((r) => r.n));
  const tot = rows.reduce((a, r) => a + r.n, 0) || 1;
  return (
    <div className="grid grid-cols-[minmax(80px,max-content)_1fr_auto] items-center gap-x-3 gap-y-2">
      {rows.map((r) => {
        const tip = (ev: React.PointerEvent) => showTip(ev, r.label, [[unit, `${fmt(r.n)}${share ? ` · ${Math.round((r.n / tot) * 1000) / 10}%` : ""}`, r.color ?? color]]);
        return (
          <div key={r.label} className="contents" onPointerMove={tip} onPointerLeave={hideTip}>
            <span className="truncate text-[13px] text-ink-soft" title={r.label}>
              {r.label}
            </span>
            <span className="relative h-3.5 min-w-0">
              <span
                className="absolute inset-y-0 left-0 rounded-r-[4px]"
                style={{ width: `${Math.max(0.8, (r.n / max) * 100)}%`, background: r.color ?? color }}
              />
            </span>
            <span className="whitespace-nowrap text-right text-[13px] font-bold tabular-nums">
              {fmt(r.n)}
              {share && <span className="ml-1.5 font-medium text-ink-dim">{String(Math.round((r.n / tot) * 1000) / 10).replace(".", ",")}%</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- кольцо

export function Donut({
  parts,
  center,
  caption,
  fmt = (v: number) => nf.format(Math.round(v)),
  unit = "Заказов",
}: {
  parts: Array<{ label: string; n: number; color: string }>;
  center: string;
  caption: string;
  fmt?: (v: number) => string;
  unit?: string;
}) {
  const S = 170, R0 = 78, R1 = 56, c = S / 2;
  const tot = parts.reduce((a, p) => a + p.n, 0);
  const live = parts.filter((p) => p.n > 0);
  const gap = live.length > 1 ? 0.025 : 0;
  let a = -Math.PI / 2;
  const P = (r: number, t: number) => `${(c + r * Math.cos(t)).toFixed(2)},${(c + r * Math.sin(t)).toFixed(2)}`;
  return (
    <div className="flex flex-wrap items-center gap-5">
      <svg viewBox={`0 0 ${S} ${S}`} width={S} height={S} className="max-w-full shrink-0" role="img" aria-label={`${center} ${caption}`}>
        {tot === 0 && <circle cx={c} cy={c} r={(R0 + R1) / 2} fill="none" stroke={C.line} strokeWidth={R0 - R1} />}
        {live.map((p) => {
          const da = (p.n / tot) * Math.PI * 2;
          // Одна часть — целое кольцо: дуга от точки к той же точке не рисуется.
          const a0 = a + gap / 2, a1 = a + da - gap / 2 - (live.length === 1 ? 0.0001 : 0);
          a += da;
          const big = a1 - a0 > Math.PI ? 1 : 0;
          return (
            <path
              key={p.label}
              d={`M${P(R0, a0)}A${R0},${R0} 0 ${big} 1 ${P(R0, a1)}L${P(R1, a1)}A${R1},${R1} 0 ${big} 0 ${P(R1, a0)}Z`}
              fill={p.color}
              onPointerMove={(ev) => showTip(ev, p.label, [[unit, `${fmt(p.n)} · ${Math.round((p.n / tot) * 1000) / 10}%`, p.color]])}
              onPointerLeave={hideTip}
            />
          );
        })}
        <text x={c} y={c + 3} textAnchor="middle" fontSize={Math.min(26, Math.floor(170 / Math.max(1, center.length)))} fontWeight={800} fill={C.ink}>
          {center}
        </text>
        <text x={c} y={c + 21} textAnchor="middle" fontSize={10.5} fill={C.inkDim}>
          {caption}
        </text>
      </svg>
      <div className="grid min-w-[180px] flex-1 gap-2">
        {parts.map((p) => (
          <div key={p.label} className="flex items-center gap-2 text-[13px]">
            <i className="inline-block h-2.5 w-2.5 rounded-[3px]" style={{ background: p.color }} />
            <span className="flex-1 text-ink-soft">{p.label}</span>
            <b className="tabular-nums">{fmt(p.n)}</b>
            <span className="w-[48px] text-right tabular-nums text-ink-dim">{tot ? `${String(Math.round((p.n / tot) * 1000) / 10).replace(".", ",")}%` : "—"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- тепловая карта

export function Heatmap({
  grid,
  rows,
  cols,
  cellTitle,
  title,
}: {
  grid: number[][];
  rows: string[];
  cols: number[];
  cellTitle: (row: number, col: number) => string;
  title: string;
}) {
  const [ref, W0] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<[number, number] | null>(null);
  const W = Math.max(280, W0);
  const m = { l: 30, t: 2, b: 22 };
  const cw = (W - m.l) / Math.max(1, cols.length);
  const ch = Math.min(30, Math.max(20, cw * 0.62));
  const H = m.t + ch * rows.length + m.b;
  const max = Math.max(1, ...grid.flat());
  const labelEvery = cw < 26 ? 3 : cw < 40 ? 2 : 1;
  return (
    <div ref={ref} className="w-full">
      {W0 > 0 && (
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label={title} className="block">
          {rows.map((rl, i) => (
            <g key={rl}>
              <text x={0} y={m.t + ch * i + ch / 2 + 4} fontSize={11.5} fill={C.inkDim}>
                {rl}
              </text>
              {cols.map((cl, j) => {
                const v = grid[i]?.[j] ?? 0;
                const on = hover && hover[0] === i && hover[1] === j;
                return (
                  <rect
                    key={cl}
                    x={m.l + cw * j + 1}
                    y={m.t + ch * i + 1}
                    width={Math.max(0, cw - 2)}
                    height={ch - 2}
                    rx={4}
                    fill={`color-mix(in oklab, rgb(var(--brand)) ${Math.round(8 + (v / max) * 92)}%, rgb(var(--surface)))`}
                    stroke={on ? C.ink : "none"}
                    strokeWidth={1.5}
                    onPointerMove={(ev) => {
                      setHover([i, j]);
                      showTip(ev, cellTitle(i, j), [["Принято заказов", nf.format(v)]]);
                    }}
                    onPointerLeave={() => {
                      setHover(null);
                      hideTip();
                    }}
                  />
                );
              })}
            </g>
          ))}
          {cols.map((cl, j) =>
            j % labelEvery ? null : (
              <text key={cl} x={m.l + cw * j + cw / 2} y={H - 6} textAnchor="middle" fontSize={11} fill={C.inkDim}>
                {cl}
              </text>
            )
          )}
        </svg>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- мини-график

export function Sparkline({ values, color = C.brand }: { values: number[]; color?: string }) {
  if (values.length < 2) return null;
  const W = 96, H = 30;
  const max = Math.max(...values), min = Math.min(...values);
  const x = (i: number) => 2 + (i / (values.length - 1)) * (W - 6);
  const y = (v: number) => 3 + (H - 6) * (1 - (v - min) / (max - min || 1));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} aria-hidden="true" className="shrink-0">
      <path d={`M${values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("L")}`} fill="none" stroke={C.ghost} strokeWidth={1.5} strokeLinejoin="round" />
      <circle cx={x(values.length - 1)} cy={y(values[values.length - 1])} r={3.5} fill={color} stroke={C.surface} strokeWidth={2} />
    </svg>
  );
}

// ---------------------------------------------------------------- карточка графика

export function Legend({ items }: { items: Array<[string, string, boolean?]> }) {
  return (
    <div className="mb-1.5 flex flex-wrap gap-x-3.5 gap-y-1 text-[12.5px] text-ink-muted">
      {items.map(([name, color, line]) => (
        <span key={name} className="inline-flex items-center gap-1.5">
          <i className={"inline-block " + (line ? "h-[2px] w-3.5 rounded-[1px]" : "h-2.5 w-2.5 rounded-[3px]")} style={{ background: color }} />
          {name}
        </span>
      ))}
    </div>
  );
}

/**
 * Карточка с графиком: заголовок, пояснение, кнопка «Таблица» — те же
 * цифры строками, для тех, кому удобнее читать, чем смотреть.
 */
export function ChartCard({
  title,
  hint,
  table,
  actions,
  className = "",
  children,
}: {
  title: string;
  hint?: ReactNode;
  table?: () => { cols: string[]; rows: Array<Array<string>> };
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const data = open && table ? table() : null;
  return (
    <section className={`min-w-0 rounded-panel border border-line bg-surface p-4 shadow-card sm:p-5 ${className}`}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0">
          <h2 className="text-[15px] font-bold">{title}</h2>
          {hint && <p className="mt-0.5 text-[12.5px] text-ink-dim">{hint}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {actions}
          {table && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              className="whitespace-nowrap text-[12.5px] font-semibold text-brand-ink hover:underline"
            >
              {open ? "Скрыть таблицу" : "Таблица"}
            </button>
          )}
        </div>
      </div>
      {children}
      {data && (
        <div className="mt-3 max-h-[280px] overflow-auto">
          <DataTable cols={data.cols} rows={data.rows} />
        </div>
      )}
    </section>
  );
}

export function DataTable({ cols, rows }: { cols: string[]; rows: Array<Array<ReactNode>> }) {
  return (
    <table className="w-full border-collapse text-[13px] tabular-nums">
      <thead>
        <tr>
          {cols.map((c, i) => (
            <th key={c} className={"whitespace-nowrap border-b border-line px-2 py-1.5 text-[12px] font-semibold text-ink-dim " + (i ? "text-right" : "text-left")}>
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            {r.map((v, j) => (
              <td key={j} className={"whitespace-nowrap border-b border-line px-2 py-1.5 " + (j ? "text-right" : "text-left")}>
                {v}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
