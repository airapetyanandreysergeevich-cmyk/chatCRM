import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "../lib/api";
import { STAGES } from "../lib/stages";
import {
  DEFAULT_TILE,
  MULTILINE,
  normalizeTile,
  sameTile,
  TILE_LABEL,
  tileApi,
  WIDTH_LABEL,
  type TileAlign,
  type TileElement,
  type TileKey,
  type TileLayout,
  type TileState,
  type TileWidth,
} from "../lib/tile";
import { summaryApi, type BoardCard } from "../lib/workshop";
import { Modal } from "./Modal";
import { TileBody } from "./OrderTile";
import { Panel } from "./Panel";
import { Banner, Button, Checkbox, Spinner } from "./ui";

/**
 * «Настройки → Интерфейс → Редактор панелей заказа».
 *
 * Слева — колонка главного экрана с настоящими заказами: щёлкнул по элементу —
 * он выбран, потянул — переставил. Справа — список элементов (галочка
 * «показывать», стрелки порядка — для телефона, где перетаскивать нечем) и
 * свойства выбранного: размер шрифта, жирный, выравнивание, строки, ширина.
 * Снизу — поля карточки и расстояние между строками.
 *
 * Своё у каждого сотрудника; владелец может «Сделать так у всех». Ctrl+Z /
 * Ctrl+Shift+Z — отмена и возврат, как в редакторе наклеек.
 */

/** Пример на случай, когда на доске пусто: всё заполнено, чтобы было что настраивать. */
const SAMPLE: BoardCard = {
  id: "sample",
  number: "Р-2026-00123",
  isUrgent: true,
  acceptedAt: new Date().toISOString(),
  dueAt: new Date(Date.now() + 86400000).toISOString(),
  status: { id: "s", name: "В работе", group: "IN_PROGRESS", color: "" },
  device: { kind: "Ноутбук", brand: "ASUS", model: "VivoBook X515EA" },
  master: { id: "m", fullName: "Олег Иванов" },
  customer: { id: "c", type: "INDIVIDUAL", name: "Мария Кузнецова", color: "green" },
  complaint: "Не включается после залития, клиент просит сохранить данные",
  total: 4500,
};

const WIDTHS = [
  { key: "narrow", label: "Узкая", px: 240 },
  { key: "normal", label: "Обычная", px: 300 },
  { key: "wide", label: "Широкая", px: 380 },
] as const;

function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Array<{ key: T; label: string }>;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-field border border-line bg-surface-input p-0.5">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          role="radio"
          aria-checked={o.key === value}
          onClick={() => onChange(o.key)}
          className={
            "min-h-[34px] rounded-[8px] px-3 text-[13px] font-semibold transition-colors " +
            (o.key === value ? "bg-brand text-white" : "text-ink-soft hover:text-ink")
          }
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Stepper({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (v: number) => void;
}) {
  const set = (v: number) => onChange(Math.min(max, Math.max(min, Math.round(v / step) * step)));
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 sm:flex-nowrap">
      <span className="w-full shrink-0 text-[13px] text-ink-muted sm:w-[130px]">{label}</span>
      <button type="button" aria-label={`${label}: меньше`} className="h-8 w-8 rounded-field border border-line text-[16px] hover:bg-surface-hover" onClick={() => set(value - step)}>
        −
      </button>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => set(Number(e.target.value))}
        className="min-w-0 flex-1 accent-[rgb(var(--brand))]"
      />
      <button type="button" aria-label={`${label}: больше`} className="h-8 w-8 rounded-field border border-line text-[16px] hover:bg-surface-hover" onClick={() => set(value + step)}>
        +
      </button>
      <span className="w-[52px] shrink-0 text-right font-mono text-[13px] tabular-nums" data-value={label}>
        {String(value).replace(".", ",")} {unit}
      </span>
    </div>
  );
}

export function TileEditor() {
  const [state, setState] = useState<TileState | null>(null);
  const [cards, setCards] = useState<BoardCard[]>([]);
  const [draft, setDraft] = useState<TileLayout>(DEFAULT_TILE);
  const [selected, setSelected] = useState<TileKey | null>("device");
  const [width, setWidth] = useState<(typeof WIDTHS)[number]["key"]>("normal");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  // Отмена и возврат: снимки раскладки до каждой правки.
  const past = useRef<TileLayout[]>([]);
  const future = useRef<TileLayout[]>([]);
  const [, bump] = useState(0);

  const load = useCallback(async () => {
    try {
      const [t, s] = await Promise.all([tileApi.get(), summaryApi.get().catch(() => null)]);
      setState(t);
      setDraft(t.effective);
      past.current = [];
      future.current = [];
      // До трёх настоящих заказов с доски — с разных стадий, если есть.
      const pool = (s?.stages ?? []).flatMap((st) => st.items.slice(0, 2));
      const pick = [...(s?.stages ?? []).map((st) => st.items[0]).filter(Boolean), ...pool];
      const uniq = pick.filter((c, i) => pick.findIndex((x) => x.id === c.id) === i).slice(0, 3);
      setCards(uniq.length ? uniq : [SAMPLE]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось загрузить настройки карточки");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const change = useCallback((next: TileLayout | ((t: TileLayout) => TileLayout)) => {
    setDraft((cur) => {
      const n = typeof next === "function" ? next(cur) : next;
      if (sameTile(n, cur)) return cur;
      past.current = [...past.current.slice(-99), cur];
      future.current = [];
      bump((x) => x + 1);
      return n;
    });
  }, []);

  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev) return;
    setDraft((cur) => {
      future.current.push(cur);
      return prev;
    });
    bump((x) => x + 1);
  }, []);
  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return;
    setDraft((cur) => {
      past.current.push(cur);
      return next;
    });
    bump((x) => x + 1);
  }, []);

  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!box.current?.contains(document.activeElement) && document.activeElement !== document.body) return;
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (tag === "INPUT" && (document.activeElement as HTMLInputElement).type !== "range") return;
      if (!(e.ctrlKey || e.metaKey) || e.code !== "KeyZ") return;
      if (!box.current?.offsetParent) return; // панель свёрнута
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [undo, redo]);

  const setEl = (k: TileKey, patch: Partial<TileElement>) =>
    change((t) => ({ ...t, els: t.els.map((e) => (e.k === k ? { ...e, ...patch } : e)) }));

  const move = (from: TileKey, to: TileKey, before: boolean) =>
    change((t) => {
      const item = t.els.find((e) => e.k === from)!;
      const rest = t.els.filter((e) => e.k !== from);
      let i = rest.findIndex((e) => e.k === to);
      if (!before) i += 1;
      return { ...t, els: [...rest.slice(0, i), item, ...rest.slice(i)] };
    });

  const shift = (k: TileKey, dir: -1 | 1) =>
    change((t) => {
      const i = t.els.findIndex((e) => e.k === k);
      const j = i + dir;
      if (j < 0 || j >= t.els.length) return t;
      const els = [...t.els];
      [els[i], els[j]] = [els[j], els[i]];
      return { ...t, els };
    });

  const saved = state ? (state.mine ?? state.workshop ?? DEFAULT_TILE) : DEFAULT_TILE;
  const dirty = !!state && !sameTile(draft, saved);
  const source = !state ? "" : state.mine ? "своя карточка" : state.workshop ? "общая карточка мастерской" : "стандартная карточка";

  async function save() {
    setBusy(true);
    setError(null);
    try {
      // Совпало с общей (или стандартной) — своей не держим: изменят общую — изменится и у этого сотрудника.
      const base = state?.workshop ?? DEFAULT_TILE;
      const r = await tileApi.save(sameTile(draft, base) ? null : draft);
      setState((s) => (s ? { ...s, ...r } : s));
      setDraft(r.effective);
      flash("Карточка сохранена — главный экран уже такой");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось сохранить");
    } finally {
      setBusy(false);
    }
  }

  async function share() {
    setBusy(true);
    setError(null);
    try {
      const r = await tileApi.share(sameTile(draft, DEFAULT_TILE) ? null : draft);
      setState((s) => (s ? { ...s, ...r } : s));
      setDraft(r.effective);
      setSharing(false);
      flash("Теперь у всех сотрудников такая карточка");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось сохранить");
    } finally {
      setBusy(false);
    }
  }

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function flash(text: string) {
    setNotice(text);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setNotice(null), 4000);
  }

  const sel = draft.els.find((e) => e.k === selected) ?? null;
  const hiddenFor = useMemo(() => {
    const out = new Map<TileKey, string>();
    if (state && !state.contacts) out.set("customer", "вам не видно: нет доступа к контактам");
    if (state && !state.money) out.set("total", "вам не видно: нет доступа к деньгам");
    return out;
  }, [state]);
  const stage = STAGES.find((s) => s.key === "IN_PROGRESS")!;
  const colPx = WIDTHS.find((w) => w.key === width)!.px;

  return (
    <Panel id="interface:Редактор панелей заказа" title="Редактор панелей заказа" summary={source ? `Сейчас: ${source}` : undefined}>
      {!state ? (
        error ? <Banner tone="error">{error}</Banner> : <Spinner label="Загружаем карточку" />
      ) : (
        <div ref={box} className="space-y-4" data-tile-editor>
          <p className="text-[13.5px] leading-relaxed text-ink-muted">
            Как выглядит заказ на главном экране. Щёлкните по элементу на карточке, чтобы выбрать его, и потяните, чтобы
            переставить. {state.personal ? "Настройка ваша — у других сотрудников карточка своя." : ""}
          </p>

          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
            {/* Предпросмотр: колонка доски с настоящими заказами */}
            <div className="min-w-0 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] text-ink-muted">Колонка</span>
                <Segmented label="Ширина колонки" value={width} options={WIDTHS.map((w) => ({ key: w.key, label: w.label }))} onChange={setWidth} />
              </div>
              <div className="overflow-x-auto rounded-panel bg-bg/60 p-3">
                <section
                  className="relative mx-auto rounded-panel border border-line bg-surface p-3"
                  style={{ width: `min(${colPx}px, 100%)` }}
                  data-tile-preview
                >
                  <span aria-hidden className={"absolute inset-x-3.5 -top-px h-[2px] rounded-pill " + stage.glow} />
                  <p className="flex items-center gap-1.5 pb-3 text-[12.5px] font-bold uppercase tracking-[0.05em] text-ink-soft">
                    <span aria-hidden className={"h-[7px] w-[7px] rounded-full " + stage.dot} />
                    {stage.label} <span className="font-mono text-ink">{cards.length}</span>
                  </p>
                  <div className="space-y-2">
                    {cards.map((c) => (
                      <div key={c.id} className="rounded-card border border-line bg-surface-raised" style={{ padding: `${draft.pad}px` }}>
                        <TileBody card={c} tile={draft} editing={{ selected, onPick: setSelected, onMove: move }} />
                      </div>
                    ))}
                  </div>
                </section>
              </div>
              <div className="space-y-2">
                <Stepper label="Поля карточки" value={draft.pad} min={4} max={24} step={1} unit="пкс" onChange={(v) => change((t) => ({ ...t, pad: v }))} />
                <Stepper label="Между строками" value={draft.gap} min={0} max={16} step={1} unit="пкс" onChange={(v) => change((t) => ({ ...t, gap: v }))} />
              </div>
            </div>

            {/* Элементы и свойства выбранного */}
            <div className="min-w-0 space-y-4">
              <ul className="divide-y divide-line rounded-card border border-line" aria-label="Элементы карточки">
                {draft.els.map((e, i) => (
                  <li
                    key={e.k}
                    data-tile-row={e.k}
                    className={"flex items-center gap-2 px-3 py-1.5 " + (selected === e.k ? "bg-brand-tint/50" : "")}
                  >
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={e.on}
                      aria-label={`Показывать: ${TILE_LABEL[e.k]}`}
                      onClick={() => {
                        setEl(e.k, { on: !e.on });
                        setSelected(e.k);
                      }}
                      className={
                        "flex h-[20px] w-[20px] shrink-0 items-center justify-center rounded-[5px] border transition-colors " +
                        (e.on ? "border-brand bg-brand text-white" : "border-line-strong")
                      }
                    >
                      {e.on && (
                        <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2.4}>
                          <path d="m3.5 8.5 3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelected(e.k)}
                      className={"min-w-0 flex-1 truncate py-1 text-left text-[14px] " + (e.on ? "text-ink" : "text-ink-dim")}
                    >
                      {TILE_LABEL[e.k]}
                      {hiddenFor.has(e.k) && <span className="ml-2 text-[12px] text-ink-dim">({hiddenFor.get(e.k)})</span>}
                    </button>
                    <button type="button" aria-label={`Выше: ${TILE_LABEL[e.k]}`} disabled={i === 0} onClick={() => shift(e.k, -1)} className="h-8 w-8 rounded-field text-ink-muted hover:bg-surface-hover disabled:opacity-30">
                      ↑
                    </button>
                    <button type="button" aria-label={`Ниже: ${TILE_LABEL[e.k]}`} disabled={i === draft.els.length - 1} onClick={() => shift(e.k, 1)} className="h-8 w-8 rounded-field text-ink-muted hover:bg-surface-hover disabled:opacity-30">
                      ↓
                    </button>
                  </li>
                ))}
              </ul>

              {sel && (
                <div className="space-y-3 rounded-card border border-line p-3" data-tile-props>
                  <p className="text-[14px] font-bold">
                    {TILE_LABEL[sel.k]}
                    {!sel.on && <span className="ml-2 text-[12.5px] font-normal text-ink-dim">скрыт — включите галочкой</span>}
                  </p>
                  <Stepper label="Размер шрифта" value={sel.size} min={10} max={22} step={0.5} unit="пкс" onChange={(v) => setEl(sel.k, { size: v })} />
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="w-[130px] shrink-0 text-[13px] text-ink-muted">Ширина</span>
                    <Segmented
                      label="Ширина"
                      value={sel.w}
                      options={(["full", "half", "auto"] as TileWidth[]).map((w) => ({ key: w, label: WIDTH_LABEL[w] }))}
                      onChange={(w) => setEl(sel.k, { w })}
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="w-[130px] shrink-0 text-[13px] text-ink-muted">Выравнивание</span>
                    <Segmented
                      label="Выравнивание"
                      value={sel.align}
                      options={[
                        { key: "left" as TileAlign, label: "Слева" },
                        { key: "center" as TileAlign, label: "По центру" },
                        { key: "right" as TileAlign, label: "Справа" },
                      ]}
                      onChange={(align) => setEl(sel.k, { align })}
                    />
                  </div>
                  {MULTILINE.has(sel.k) && (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="w-[130px] shrink-0 text-[13px] text-ink-muted">Строк</span>
                      <Segmented
                        label="Строк"
                        value={String(sel.lines) as "1" | "2" | "3"}
                        options={[
                          { key: "1", label: "1" },
                          { key: "2", label: "2" },
                          { key: "3", label: "3" },
                        ]}
                        onChange={(v) => setEl(sel.k, { lines: Number(v) })}
                      />
                    </div>
                  )}
                  <Checkbox label="Жирный" checked={sel.bold} onChange={(bold) => setEl(sel.k, { bold })} />
                  {sel.w === "half" && (
                    <p className="text-[12.5px] leading-snug text-ink-dim">Две «половины» подряд встают рядом. Половина без пары занимает всю строку.</p>
                  )}
                  {sel.w === "auto" && (
                    <p className="text-[12.5px] leading-snug text-ink-dim">«По тексту» встаёт рядом с соседями — как «срочный» после номера.</p>
                  )}
                </div>
              )}
            </div>
          </div>

          {notice && <Banner>{notice}</Banner>}
          {error && <Banner tone="error">{error}</Banner>}

          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" disabled={!dirty || busy} onClick={() => void save()}>
              {busy ? "Сохраняем…" : "Сохранить"}
            </Button>
            <Button type="button" variant="secondary" disabled={!dirty || busy} onClick={() => change(saved)}>
              Отменить изменения
            </Button>
            <Button type="button" variant="secondary" disabled={busy || sameTile(draft, DEFAULT_TILE)} onClick={() => change(normalizeTile(DEFAULT_TILE)!)}>
              Вернуть как было
            </Button>
            <Button type="button" variant="ghost" aria-label="Отменить правку" title="Отменить (Ctrl+Z)" disabled={!past.current.length} onClick={undo}>
              ↶
            </Button>
            <Button type="button" variant="ghost" aria-label="Вернуть правку" title="Вернуть (Ctrl+Shift+Z)" disabled={!future.current.length} onClick={redo}>
              ↷
            </Button>
            {state.canShare && (
              <Button type="button" variant="secondary" className="sm:ml-auto" disabled={busy} onClick={() => setSharing(true)}>
                Сделать так у всех
              </Button>
            )}
          </div>
        </div>
      )}

      {sharing && (
        <Modal title="Сделать так у всех" onClose={() => setSharing(false)}>
          <div className="space-y-4">
            <p className="text-[14px] leading-relaxed text-ink-soft">
              Карточка заказа станет такой, как сейчас в редакторе, у всех сотрудников — и у новых тоже. Кто настраивал
              свою, получит эту: его настройка карточки сбросится. Панели, сортировка и фильтры у каждого останутся свои.
            </p>
            <div className="flex flex-col gap-2 sm:flex-row-reverse">
              <Button type="button" disabled={busy} onClick={() => void share()} className="sm:flex-1">
                {busy ? "Сохраняем…" : "Сделать у всех"}
              </Button>
              <Button type="button" variant="secondary" onClick={() => setSharing(false)} className="sm:flex-1">
                Отмена
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </Panel>
  );
}
