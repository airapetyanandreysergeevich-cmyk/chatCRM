import { useState, type ReactNode } from "react";
import { COL_LABEL, COLS_OF, fieldsOf, SOURCES } from "../../lib/blankData";
import { FONTS, pageSize, type BlankDesign, type BlankEl, type ColKey, type LineStyle, type Sides, type TableEl, type Target, type TextEl } from "../../lib/blankModel";
import { EL_NAME } from "./BlankCanvas";

/**
 * Левая колонка редактора: инструменты, свойства выбранного, лист.
 * Место и размер задаются мышью на листе; здесь — точные числа и то, чего
 * мышью не сделать: шрифт таблицы, столбцы, рамка, «по тексту».
 */

export type Tool = "text" | "field" | "hline" | "vline" | "rect" | "image" | "logo" | "table" | "barcode" | "qr" | "cut" | "sign";

const TOOLS: Array<{ key: Tool; label: string; icon: ReactNode }> = [
  { key: "text", label: "Текст", icon: <b className="text-[15px]">T</b> },
  { key: "field", label: "Поле", icon: <span className="font-mono text-[12px] font-bold">{"{ }"}</span> },
  { key: "table", label: "Таблица", icon: <Svg d="M4 5h16v14H4zM4 10h16M4 15h16M10 5v14" /> },
  { key: "hline", label: "Линия", icon: <Svg d="M4 12h16" /> },
  { key: "vline", label: "Верт. линия", icon: <Svg d="M12 4v16" /> },
  { key: "rect", label: "Рамка", icon: <Svg d="M5 6h14v12H5z" /> },
  { key: "image", label: "Картинка", icon: <Svg d="M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9.5a1 1 0 1 0 0-.01" /> },
  { key: "logo", label: "Логотип", icon: <Svg d="M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5" /> },
  { key: "barcode", label: "Штрихкод", icon: <Svg d="M4 6v12M7 6v12M9 6v12M12 6v12M15 6v12M17 6v12M20 6v12" /> },
  { key: "qr", label: "QR-код", icon: <Svg d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 18h2v2h-2zM14 18h2M18 14h2" /> },
  { key: "sign", label: "Подпись", icon: <Svg d="M4 18h16M6 14c2-4 3-6 4-6s0 6 2 6 2-3 3-3 1 2 3 2" /> },
  { key: "cut", label: "Линия отреза", icon: <span className="text-[15px]">✂</span> },
];

function Svg({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

export function Tools({ target, onAdd }: { target: Target; onAdd: (t: Tool, field?: string) => void }) {
  const [pick, setPick] = useState(false);
  const [q, setQ] = useState("");
  const fields = fieldsOf(target).filter((f) => !q || f.label.toLowerCase().includes(q.toLowerCase()));
  return (
    <div>
      <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4 lg:grid-cols-3" data-blank-tools>
        {TOOLS.map((t) => (
          <button
            key={t.key}
            type="button"
            data-tool={t.key}
            onClick={() => (t.key === "field" ? setPick(!pick) : onAdd(t.key))}
            className={
              "flex min-h-[54px] flex-col items-center justify-center gap-1 rounded-field border px-1 text-[11.5px] font-semibold leading-tight transition-colors " +
              (t.key === "field" && pick ? "border-brand bg-brand-tint text-brand-ink" : "border-line bg-surface-raised text-ink-muted hover:border-line-strong hover:text-ink")
            }
          >
            {t.icon}
            <span className="text-center">{t.label}</span>
          </button>
        ))}
      </div>
      {pick && (
        <div className="mt-2 rounded-field border border-line bg-surface-raised p-1.5" data-field-list>
          <input value={q} onChange={(e) => setQ(e.target.value)} autoFocus placeholder="Найти поле…" className="mb-1 h-8 w-full rounded-[8px] border border-line bg-surface-input px-2 text-[13px] text-ink outline-none focus:border-brand" />
          <div className="max-h-[260px] overflow-auto">
            {fields.map((f) => (
              <button
                key={f.key}
                type="button"
                data-add-field={f.key}
                onClick={() => {
                  onAdd("field", f.key);
                  setPick(false);
                  setQ("");
                }}
                className="flex w-full items-baseline justify-between gap-2 rounded-[7px] px-2 py-1 text-left text-[13px] text-ink hover:bg-surface-hover"
              >
                <span className="truncate">{f.label}</span>
                <span className="shrink-0 text-[11px] text-ink-dim">{f.group}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------ поля ввода

function Num({ label, value, onChange, step = 0.5, min, max, suffix = "мм", w = "w-[64px]" }: { label: string; value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number; suffix?: string; w?: string }) {
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? String(Math.round(value * 100) / 100).replace(".", ",");
  return (
    <label className="flex items-center gap-1 text-[12px] text-ink-dim">
      <span className="min-w-[14px]">{label}</span>
      <input
        inputMode="decimal"
        value={shown}
        aria-label={label}
        onFocus={() => setText(shown)}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const v = Number((text ?? "").replace(",", "."));
          setText(null);
          if (Number.isFinite(v)) onChange(Math.min(max ?? 10_000, Math.max(min ?? -10_000, v)));
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const v = Math.round((value + (e.key === "ArrowUp" ? step : -step)) * 100) / 100;
            onChange(Math.min(max ?? 10_000, Math.max(min ?? -10_000, v)));
          }
        }}
        className={`h-8 ${w} rounded-[8px] border border-line bg-surface-input px-1.5 text-right text-[13px] tabular-nums text-ink outline-none focus:border-brand`}
      />
      {suffix && <span>{suffix}</span>}
    </label>
  );
}

function Color({ label, value, onChange, allowNone }: { label: string; value: string | null; onChange: (v: string | null) => void; allowNone?: boolean }) {
  return (
    <span className="flex items-center gap-1.5 text-[12px] text-ink-dim">
      {label}
      <label className="relative inline-flex h-8 w-9 cursor-pointer items-center justify-center rounded-[8px] border border-line bg-surface-input">
        <span className="h-4 w-5 rounded-[3px] border border-black/20" style={{ background: value ?? "transparent", backgroundImage: value ? undefined : "linear-gradient(135deg, transparent 45%, #dc2626 45%, #dc2626 55%, transparent 55%)" }} />
        <input type="color" aria-label={label} className="absolute inset-0 cursor-pointer opacity-0" value={value ?? "#ffffff"} onChange={(e) => onChange(e.target.value)} />
      </label>
      {allowNone && value && (
        <button type="button" onClick={() => onChange(null)} className="text-[11.5px] font-semibold text-ink-dim hover:text-ink">
          нет
        </button>
      )}
    </span>
  );
}

function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: Array<[T, string]>; onChange: (v: T) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="inline-flex flex-wrap rounded-[9px] border border-line bg-surface-input p-0.5">
      {options.map(([v, t]) => (
        <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(v)} className={"rounded-[7px] px-2 py-1 text-[12px] font-semibold " + (value === v ? "bg-brand text-white" : "text-ink-muted hover:text-ink")}>
          {t}
        </button>
      ))}
    </div>
  );
}

function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="flex cursor-pointer items-start gap-2 text-[12.5px] leading-snug text-ink-muted">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-[2px] h-4 w-4 accent-[var(--brand,#2a7fd0)]" />
      <span>{children}</span>
    </label>
  );
}

const Row = ({ children }: { children: ReactNode }) => <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">{children}</div>;
const Title = ({ children }: { children: ReactNode }) => <p className="text-[11.5px] font-bold uppercase tracking-[0.08em] text-ink-dim">{children}</p>;

const STYLES: Array<[LineStyle, string]> = [
  ["solid", "—"],
  ["dashed", "- -"],
  ["dotted", "···"],
];

// ------------------------------------------------------------ свойства

export function Props({
  design,
  target,
  selected,
  onPatch,
  onPage,
  onDelete,
  onDuplicate,
  onOrder,
  onAlign,
  onImage,
}: {
  design: BlankDesign;
  target: Target;
  selected: BlankEl[];
  onPatch: (id: string, p: Partial<BlankEl>) => void;
  onPage: (p: Partial<BlankDesign["page"]>) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onOrder: (dir: "front" | "back") => void;
  onAlign: (how: "left" | "hcenter" | "right" | "top" | "vmiddle" | "bottom" | "pageh") => void;
  onImage: (id: string) => void;
}) {
  if (!selected.length) return <PageProps design={design} onPage={onPage} />;
  if (selected.length > 1) {
    return (
      <div className="space-y-3" data-blank-props="many">
        <Title>Выбрано: {selected.length}</Title>
        <div className="flex flex-wrap gap-1">
          {(
            [
              ["left", "По левому краю", "M5 4v16M9 7h10M9 12h6M9 17h8"],
              ["hcenter", "По центру", "M12 4v16M6 7h12M8 12h8M7 17h10"],
              ["right", "По правому краю", "M19 4v16M5 7h10M9 12h6M7 17h8"],
              ["top", "По верху", "M4 5h16M7 9v10M12 9v6M17 9v8"],
              ["vmiddle", "По середине", "M4 12h16M7 6v12M12 8v8M17 7v10"],
              ["bottom", "По низу", "M4 19h16M7 5v10M12 9v6M17 7v8"],
            ] as const
          ).map(([k, t, d]) => (
            <button key={k} type="button" title={t} aria-label={t} onClick={() => onAlign(k)} className="flex h-9 w-9 items-center justify-center rounded-[8px] border border-line bg-surface-raised text-ink-muted hover:text-ink">
              <Svg d={d} />
            </button>
          ))}
        </div>
        <Actions onDelete={onDelete} onDuplicate={onDuplicate} onOrder={onOrder} />
      </div>
    );
  }
  const el = selected[0];
  const patch = (p: Partial<BlankEl>) => onPatch(el.id, p);
  const [pw] = pageSize(design.page);
  return (
    <div className="space-y-3" data-blank-props={el.type}>
      <div className="flex items-center justify-between gap-2">
        <Title>{EL_NAME[el.type]}</Title>
        <button type="button" onClick={() => patch({ locked: !el.locked })} className="text-[12px] font-semibold text-ink-dim hover:text-ink" aria-pressed={!!el.locked}>
          {el.locked ? "🔒 Закреплён" : "Закрепить"}
        </button>
      </div>
      <Row>
        <Num label="X" value={el.x} onChange={(x) => patch({ x })} />
        <Num label="Y" value={el.y} onChange={(y) => patch({ y })} />
      </Row>
      <Row>
        <Num label="Ш" value={el.w} min={1} onChange={(w) => patch(el.type === "table" ? scaleCols(el, w) : { w })} />
        <Num label="В" value={el.h} min={1} onChange={(h) => patch({ h })} />
        <button type="button" onClick={() => onAlign("pageh")} className="text-[12px] font-semibold text-brand hover:underline">
          по центру листа
        </button>
      </Row>
      {el.type === "text" && <TextProps el={el} patch={patch} />}
      {el.type === "line" && (
        <>
          <Row>
            <Seg label="Тип" value={el.stroke.style} options={STYLES} onChange={(style) => patch({ stroke: { ...el.stroke, style } })} />
            <Num label="толщина" value={el.stroke.w} step={0.1} min={0.05} max={5} onChange={(w) => patch({ stroke: { ...el.stroke, w } })} />
          </Row>
          <Row>
            <Color label="Цвет" value={el.stroke.color} onChange={(c) => c && patch({ stroke: { ...el.stroke, color: c } })} />
            <Check checked={el.cut} onChange={(cut) => patch({ cut })}>
              ✂ линия отреза
            </Check>
          </Row>
        </>
      )}
      {el.type === "rect" && (
        <>
          <Row>
            <Seg label="Линия" value={el.stroke ? el.stroke.style : ("none" as LineStyle)} options={[["none" as LineStyle, "нет"], ...STYLES]} onChange={(style) => patch({ stroke: (style as string) === "none" ? null : { w: el.stroke?.w ?? 0.3, color: el.stroke?.color ?? "#000000", style } })} />
          </Row>
          {el.stroke && (
            <Row>
              <Num label="толщина" value={el.stroke.w} step={0.1} min={0.05} max={5} onChange={(w) => patch({ stroke: { ...el.stroke!, w } })} />
              <Color label="Цвет" value={el.stroke.color} onChange={(c) => c && patch({ stroke: { ...el.stroke!, color: c } })} />
            </Row>
          )}
          <Row>
            <Color label="Заливка" value={el.fill} allowNone onChange={(fill) => patch({ fill })} />
            <Num label="скругление" value={el.radius} step={0.5} min={0} max={50} onChange={(radius) => patch({ radius })} />
          </Row>
        </>
      )}
      {el.type === "image" && (
        <>
          <Row>
            <Seg label="Вписать" value={el.fit} options={[["contain", "целиком"], ["cover", "заполнить"], ["fill", "растянуть"]]} onChange={(fit) => patch({ fit })} />
          </Row>
          <Row>
            <button type="button" onClick={() => onImage(el.id)} className="text-[12.5px] font-semibold text-brand hover:underline">
              Заменить картинку…
            </button>
            {el.src !== "logo" && (
              <button type="button" onClick={() => patch({ src: "logo" })} className="text-[12.5px] font-semibold text-ink-dim hover:text-ink">
                Логотип из «Бланков»
              </button>
            )}
          </Row>
        </>
      )}
      {el.type === "table" && <TableProps el={el} target={target} patch={patch} pageW={pw} />}
      {el.type === "code" && (
        <>
          <Row>
            <Seg label="Вид" value={el.kind} options={[["code128", "Штрихкод"], ["qr", "QR-код"]]} onChange={(kind) => patch({ kind, ...(kind === "qr" ? { h: el.w } : {}) })} />
          </Row>
          <label className="block text-[12px] text-ink-dim">
            Что зашито — поле или своя ссылка
            <input
              value={el.value}
              onChange={(e) => patch({ value: e.target.value })}
              onKeyDown={(e) => e.stopPropagation()}
              className="mt-1 h-9 w-full rounded-[8px] border border-line bg-surface-input px-2 font-mono text-[12.5px] text-ink outline-none focus:border-brand"
              data-code-value
            />
          </label>
          <Row>
            {[
              ["{number}", "Номер"],
              ["https://", "Ссылка (отзыв)"],
            ].map(([v, t]) => (
              <button key={v} type="button" onClick={() => patch({ value: v })} className="rounded-pill border border-line px-2 py-0.5 text-[12px] text-ink-muted hover:text-ink">
                {t}
              </button>
            ))}
          </Row>
          {el.kind === "code128" ? (
            <>
              <Check checked={el.caption} onChange={(caption) => patch({ caption })}>
                Цифры под штрихкодом
              </Check>
              <p className="text-[11.5px] leading-snug text-ink-dim">В штрихкод идут только цифры — как на наклейках: сканер находит заказ по ним.</p>
            </>
          ) : (
            <p className="text-[11.5px] leading-snug text-ink-dim">Ссылка на отзыв, сайт или поле: {"{number}"} — номер заказа.</p>
          )}
        </>
      )}
      <Actions onDelete={onDelete} onDuplicate={onDuplicate} onOrder={onOrder} />
    </div>
  );
}

function scaleCols(el: TableEl, w: number): Partial<TableEl> {
  const sum = el.cols.reduce((a, c) => a + c.w, 0) || 1;
  return { w, cols: el.cols.map((c) => ({ ...c, w: Math.round((c.w / sum) * w * 100) / 100 })) };
}

function Actions({ onDelete, onDuplicate, onOrder }: { onDelete: () => void; onDuplicate: () => void; onOrder: (d: "front" | "back") => void }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 border-t border-line pt-2.5 text-[12.5px] font-semibold">
      <button type="button" onClick={onDuplicate} className="text-ink-muted hover:text-ink">
        Копия <span className="text-ink-dim">Ctrl+D</span>
      </button>
      <button type="button" onClick={() => onOrder("front")} className="text-ink-muted hover:text-ink">
        Вперёд
      </button>
      <button type="button" onClick={() => onOrder("back")} className="text-ink-muted hover:text-ink">
        Назад
      </button>
      <button type="button" onClick={onDelete} className="ml-auto text-state-off hover:underline" data-el-delete>
        Удалить
      </button>
    </div>
  );
}

function TextProps({ el, patch }: { el: TextEl; patch: (p: Partial<TextEl>) => void }) {
  const st = el.st;
  const set = (p: Partial<TextEl["st"]>) => patch({ st: { ...st, ...p } });
  const b = st.border;
  return (
    <>
      <p className="text-[12px] leading-snug text-ink-dim">Шрифт, размер, цвет, интервал — на панели над текстом. Двойной щелчок — писать прямо на листе.</p>
      <Row>
        <Seg label="По вертикали" value={st.valign} options={[["top", "верх"], ["middle", "середина"], ["bottom", "низ"]]} onChange={(valign) => set({ valign })} />
      </Row>
      <Row>
        <Seg<Sides | "none">
          label="Рамка"
          value={b ? b.sides : "none"}
          options={[["none", "без рамки"], ["all", "рамка"], ["bottom", "снизу"], ["tb", "сверху и снизу"]]}
          onChange={(sides) => set({ border: sides === "none" ? null : { w: b?.w ?? 0.3, color: b?.color ?? "#000000", style: b?.style ?? "solid", sides } })}
        />
      </Row>
      {b && (
        <Row>
          <Seg label="Тип линии" value={b.style} options={STYLES} onChange={(style) => set({ border: { ...b, style } })} />
          <Num label="толщина" value={b.w} step={0.1} min={0.05} max={5} onChange={(w) => set({ border: { ...b, w } })} />
          <Color label="" value={b.color} onChange={(c) => c && set({ border: { ...b, color: c } })} />
        </Row>
      )}
      <Row>
        <Color label="Заливка" value={st.fill} allowNone onChange={(fill) => set({ fill })} />
        <Num label="отступ" value={st.pad} step={0.5} min={0} max={20} onChange={(pad) => set({ pad })} />
      </Row>
      <Check checked={el.grow} onChange={(grow) => patch({ grow })}>
        <b className="text-ink">Высота по тексту</b> — длинный текст растягивает рамку и сдвигает вниз всё, что под ней
      </Check>
      <Check checked={el.hideEmpty} onChange={(hideEmpty) => patch({ hideEmpty })}>
        Не печатать строку, если её поля пустые («Второй телефон:» без номера)
      </Check>
    </>
  );
}

function TableProps({ el, target, patch, pageW }: { el: TableEl; target: Target; patch: (p: Partial<TableEl>) => void; pageW: number }) {
  const st = el.st;
  const set = (p: Partial<TableEl["st"]>) => patch({ st: { ...st, ...p } });
  const avail = COLS_OF[el.source];
  const has = new Set(el.cols.map((c) => c.key));
  const total = el.cols.reduce((a, c) => a + c.w, 0);
  const setCols = (cols: TableEl["cols"]) => patch({ cols, w: Math.round(cols.reduce((a, c) => a + c.w, 0) * 100) / 100 });
  return (
    <>
      <label className="block text-[12px] text-ink-dim">
        Что в строках
        <select value={el.source} onChange={(e) => patch({ source: e.target.value as TableEl["source"], cols: el.cols.filter((c) => COLS_OF[e.target.value as TableEl["source"]].includes(c.key)) })} className="mt-1 h-9 w-full rounded-[8px] border border-line bg-surface-input px-2 text-[13px] text-ink">
          {SOURCES[target].map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <div className="space-y-1">
        <p className="text-[12px] text-ink-dim">
          Столбцы · ширина таблицы {Math.round(total)} мм{total > pageW ? " — шире листа!" : ""}
        </p>
        {el.cols.map((c, i) => (
          <div key={c.key} className="flex items-center gap-1" data-col={c.key}>
            <input
              value={c.title}
              onChange={(e) => setCols(el.cols.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))}
              onKeyDown={(e) => e.stopPropagation()}
              aria-label={`Заголовок: ${COL_LABEL[c.key]}`}
              className="h-8 min-w-0 flex-1 rounded-[8px] border border-line bg-surface-input px-1.5 text-[12.5px] text-ink outline-none focus:border-brand"
            />
            <Num label="" value={c.w} min={3} max={400} w="w-[52px]" onChange={(w) => setCols(el.cols.map((x, j) => (j === i ? { ...x, w } : x)))} />
            <button type="button" title="Выравнивание" onClick={() => setCols(el.cols.map((x, j) => (j === i ? { ...x, align: x.align === "left" ? "center" : x.align === "center" ? "right" : "left" } : x)))} className="h-8 w-7 rounded-[7px] text-[11px] font-bold text-ink-muted hover:bg-surface-hover">
              {c.align === "left" ? "⇤" : c.align === "center" ? "↔" : "⇥"}
            </button>
            <button type="button" title="Выше" disabled={i === 0} onClick={() => setCols(swap(el.cols, i, i - 1))} className="h-8 w-6 rounded-[7px] text-ink-muted hover:bg-surface-hover disabled:opacity-30">
              ↑
            </button>
            <button type="button" title="Убрать столбец" disabled={el.cols.length < 2} onClick={() => setCols(el.cols.filter((_, j) => j !== i))} className="h-8 w-6 rounded-[7px] text-state-off hover:bg-surface-hover disabled:opacity-30">
              ×
            </button>
          </div>
        ))}
        <div className="flex flex-wrap gap-1 pt-0.5">
          {avail
            .filter((k) => !has.has(k))
            .map((k: ColKey) => (
              <button key={k} type="button" onClick={() => setCols([...el.cols, { key: k, title: COL_LABEL[k], w: k === "name" ? 60 : 20, align: k === "name" || k === "sku" ? "left" : "right" }])} className="rounded-pill border border-dashed border-line-strong px-2 py-0.5 text-[12px] text-ink-muted hover:text-ink">
                + {COL_LABEL[k]}
              </button>
            ))}
        </div>
      </div>
      <Row>
        <label className="flex items-center gap-1 text-[12px] text-ink-dim">
          Шрифт
          <select value={st.font} onChange={(e) => set({ font: e.target.value as TableEl["st"]["font"] })} className="h-8 rounded-[8px] border border-line bg-surface-input px-1 text-[12.5px] text-ink">
            {FONTS.map((f) => (
              <option key={f.key} value={f.key}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
        <Num label="" value={st.size} step={0.5} min={5} max={24} suffix="пт" w="w-[52px]" onChange={(size) => set({ size })} />
      </Row>
      <Row>
        <Seg label="Сетка" value={st.grid} options={[["all", "все линии"], ["rows", "между строками"], ["none", "без линий"]]} onChange={(grid) => set({ grid })} />
      </Row>
      <Row>
        <Check checked={st.headBold} onChange={(headBold) => set({ headBold })}>
          Шапка жирным
        </Check>
        <Color label="Шапка" value={st.headFill} allowNone onChange={(headFill) => set({ headFill })} />
      </Row>
      <Row>
        <Check checked={el.total} onChange={(t) => patch({ total: t })}>
          Строка «Итого»
        </Check>
        {el.total && <input value={el.totalLabel} onChange={(e) => patch({ totalLabel: e.target.value })} onKeyDown={(e) => e.stopPropagation()} className="h-8 w-[110px] rounded-[8px] border border-line bg-surface-input px-1.5 text-[12.5px] text-ink" aria-label="Подпись итога" />}
      </Row>
      <p className="text-[11.5px] leading-snug text-ink-dim">Рамку таблицы ставьте на 1–2 строки: вниз она растянется сама и сдвинет всё, что ниже. Не влезла — продолжится на следующем листе с шапкой.</p>
    </>
  );
}

const swap = <T,>(a: T[], i: number, j: number) => {
  const b = [...a];
  [b[i], b[j]] = [b[j], b[i]];
  return b;
};

function PageProps({ design, onPage }: { design: BlankDesign; onPage: (p: Partial<BlankDesign["page"]>) => void }) {
  const pg = design.page;
  return (
    <div className="space-y-3" data-blank-props="page">
      <Title>Лист</Title>
      <Row>
        <Seg label="Размер" value={pg.size} options={[["A4", "A4"], ["A5", "A5"]]} onChange={(size) => onPage({ size })} />
        <Seg label="Ориентация" value={pg.landscape ? "l" : "p"} options={[["p", "книжная"], ["l", "альбомная"]]} onChange={(v) => onPage({ landscape: v === "l" })} />
      </Row>
      <Num label="Поля" value={pg.margin} step={1} min={0} max={40} onChange={(margin) => onPage({ margin })} />
      <p className="text-[12px] leading-snug text-ink-dim">
        Поля — розовая пунктирная рамка. Принтер обычно не печатает у самого края (3–5 мм). Сдвинутое ростом таблицы не заходит за нижнее поле — переезжает на следующий лист.
      </p>
      <p className="text-[12px] leading-snug text-ink-dim">Выберите элемент на листе — здесь появятся его свойства. Рамкой по пустому месту выбирается несколько.</p>
    </div>
  );
}

/** Список элементов: выбрать мелкий или спрятанный под другим. */
export function Layers({ design, target, selected, onSelect }: { design: BlankDesign; target: Target; selected: string[]; onSelect: (ids: string[]) => void }) {
  const label = (e: BlankEl) => {
    if (e.type === "text") {
      const t = e.html.replace(/<span data-f="([a-zA-Z0-9]+)"><\/span>/g, (_, k) => `[${fieldsOf(target).find((f) => f.key === k)?.label ?? k}]`).replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
      return t || "пустой текст";
    }
    if (e.type === "table") return SOURCES[target].find((s) => s.key === e.source)?.label ?? "Таблица";
    if (e.type === "line") return e.cut ? "линия отреза" : e.dir === "h" ? "горизонтальная" : "вертикальная";
    if (e.type === "image") return e.src === "logo" ? "логотип" : "картинка";
    if (e.type === "code") return e.kind === "qr" ? "QR-код" : "штрихкод";
    return "";
  };
  const sorted = [...design.els].sort((a, b) => a.y - b.y || a.x - b.x);
  return (
    <div className="max-h-[260px] space-y-0.5 overflow-auto" data-blank-layers>
      {sorted.map((e) => (
        <button
          key={e.id}
          type="button"
          onClick={(ev) => onSelect(ev.shiftKey ? [...new Set([...selected, e.id])] : [e.id])}
          className={"flex w-full items-baseline gap-2 rounded-[7px] px-2 py-1 text-left text-[12.5px] " + (selected.includes(e.id) ? "bg-brand-tint text-brand-ink" : "text-ink-muted hover:bg-surface-hover")}
        >
          <span className="w-[62px] shrink-0 font-semibold">{EL_NAME[e.type]}</span>
          <span className="min-w-0 truncate">{label(e)}</span>
          {e.locked && <span className="ml-auto">🔒</span>}
        </button>
      ))}
      {!sorted.length && <p className="px-2 py-1 text-[12.5px] text-ink-dim">Лист пустой — добавьте элементы инструментами выше.</p>}
    </div>
  );
}
