import { Panel } from "../components/Panel";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { PrintSheet, type Doc } from "../components/PrintSheet";
import { Banner, Button, Checkbox, Input, PageHeader, Spinner, Textarea } from "../components/ui";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { LOGO_TYPES, prepareLogo } from "../lib/branding";
import type { Order } from "../lib/orders";
import {
  CUSTOM_MAX,
  DEFAULT_TEXTS,
  DEFAULT_WARRANTY_TITLE,
  defaultLayout,
  defaultTalon,
  FIELD_HINTS,
    newCustomKey,
  printFormsApi,
  TEXT_LEADING,
  TEXT_SIZE,
  type DocTexts,
  type PrintForms,
  type SheetField,
  type SheetSection,
  type Talon,
} from "../lib/printForms";

/**
 * «Настройки → Бланки»: квитанция и акт так, как их увидит клиент.
 *
 * Слева — то, что мастерская пишет сама и что не меняется от заказа к
 * заказу: логотип, реквизиты, условия, гарантия, подписи. Справа — живой лист
 * A4 на примере заказа: каждая буква видна на бумаге сразу, пока её набирают.
 * Предпросмотр — тот же компонент, что печатается (components/PrintSheet),
 * а не похожая картинка: иначе они разошлись бы в первый же день.
 *
 * Правим поле акта — справа сам открывается акт. Искать глазами, куда
 * делся набранный текст, человеку не придётся.
 */

/** Пример заказа для предпросмотра. Выдуман, но похож на настоящий. */
function sampleOrder(): Order {
  const day = (d: number, h = 12, m = 0) => {
    const x = new Date();
    x.setDate(x.getDate() + d);
    x.setHours(h, m, 0, 0);
    return x.toISOString();
  };
  return {
    id: "sample",
    number: "Р-2026-00123",
    kind: "REPAIR",
    isUrgent: false,
    status: { id: "s", name: "Готов", group: "DONE", color: "#2E9E4F" },
    branch: null,
    acceptedAt: day(-5, 11, 20),
    dueAt: day(-1, 18),
    completedAt: day(-1, 16, 40),
    issuedAt: day(0, 17, 30),
    customer: { id: "c", type: "INDIVIDUAL", name: "Иван Петров", phone: "+7 912 345-67-89" },
    device: { id: "d", kind: "Ноутбук", brand: "ASUS", model: "VivoBook 15 X1504", serial: "N3NRKD0123456" },
    complaint: "Не включается после попадания воды, до этого грелся и шумел.",
    receptionNote: null,
    devicePasscode: null,
    completeness: ["Зарядное устройство", "Сумка"],
    appearance: ["Потёртости на крышке", "Следы влаги"],
    appearanceNote: null,
    hasOpenTraces: false,
    hasWaterDamage: true,
    storageLocation: null,
    approvedLimit: 6000,
    diagnosis: "Окисление в цепи питания, вышел из строя контроллер заряда.",
    masterComment: null,
    internalComment: null,
    recommendation: "Не ставить ноутбук на мягкую поверхность — перекрывается вентиляция.",
    warrantyDays: 90,
    warrantyUntil: day(90),
    acceptedBy: { id: "a", fullName: "Марина Орлова" },
    assignedMaster: { id: "m", fullName: "Олег Иванов" },
    issuedBy: null,
    works: [
      { id: "w1", name: "Чистка платы от окислов", qty: 1, price: 1500 },
      { id: "w2", name: "Замена контроллера заряда", qty: 1, price: 2000 },
    ] as Order["works"],
    parts: [{ id: "p1", name: "Контроллер заряда BQ24780S", qty: 1, price: 1200 }] as Order["parts"],
    attachments: [],
    totalWork: 3500,
    totalParts: 1200,
    previousRepair: null,
    parentOrderId: null,
    estimatedCost: 4500,
    prepayment: 1000,
    discount: 0,
    total: 4700,
  } as unknown as Order;
}

/** Предел текста условий и гарантии — с запасом на 5–6 страниц; совпадает с сервером (settings.routes.ts). */
const TEXT_MAX = 20000;

/** Ширина A4 в пикселях экрана: 210 мм при 96 точках на дюйм. */
const A4_PX = 793.7;

/**
 * Лист, уменьшенный целиком под ширину колонки — как картинка. Ужимать сам
 * лист нельзя: строки переносились бы не так, как на бумаге.
 */
function ScaledSheet({ children }: { children: ReactNode }) {
  const box = useRef<HTMLDivElement | null>(null);
  const sheet = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(0.5);
  const [height, setHeight] = useState(0);

  useLayoutEffect(() => {
    const measure = () => {
      if (!box.current || !sheet.current) return;
      const s = Math.min(1, box.current.clientWidth / A4_PX);
      setScale(s);
      setHeight(sheet.current.offsetHeight * s);
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (box.current) ro.observe(box.current);
    if (sheet.current) ro.observe(sheet.current);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={box} className="relative w-full overflow-hidden" style={{ height }}>
      <div
        ref={sheet}
        className="absolute left-0 top-0 origin-top-left rounded-[3px] shadow-[0_10px_40px_rgb(0_0_0/0.35)]"
        style={{ transform: `scale(${scale})`, width: A4_PX }}
      >
        {children}
      </div>
    </div>
  );
}

/** Подпись поля с кнопкой «Вернуть стандартный» и счётчиком. */
function FieldHead({
  label,
  onReset,
  count,
  max,
}: {
  label: string;
  onReset?: () => void;
  count?: number;
  max?: number;
}) {
  return (
    <div className="mb-1.5 flex items-baseline justify-between gap-3">
      <span className="text-[13px] font-semibold text-ink-soft">{label}</span>
      <span className="flex items-baseline gap-3">
        {max !== undefined && count !== undefined && count > max * 0.8 && (
          <span className={"text-[12px] tabular-nums " + (count > max ? "text-state-off" : "text-ink-dim")}>
            {count} / {max}
          </span>
        )}
        {onReset && (
          <button
            type="button"
            onClick={onReset}
            className="text-[12.5px] font-semibold text-brand-ink hover:underline"
          >
            Вернуть стандартный
          </button>
        )}
      </span>
    </div>
  );
}

/**
 * Ползунок с числом и кнопками ±: ползунком — быстро и на глаз, кнопками —
 * точно на шаг, число — чтобы запомнить, что подошло.
 */
function Stepper({
  label,
  value,
  min,
  max,
  step,
  show,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  show: (v: number) => string;
  disabled: boolean;
  onChange: (v: number) => void;
}) {
  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v / step) * step));
  const btn =
    "grid h-8 w-8 shrink-0 place-items-center rounded-field border border-line bg-surface-raised text-[16px] font-semibold text-ink-muted " +
    "hover:border-line-strong hover:text-ink disabled:opacity-40";
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-[12.5px] font-semibold text-ink-muted">{label}</span>
        <span className="text-[13px] font-semibold tabular-nums">{show(value)}</span>
      </div>
      <div className="flex items-center gap-2">
        <button type="button" className={btn} disabled={disabled || value <= min} onClick={() => onChange(clamp(value - step))} aria-label={`${label}: меньше`}>
          −
        </button>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(clamp(Number(e.target.value)))}
          aria-label={label}
          className="h-2 min-w-0 flex-1 cursor-pointer accent-brand"
        />
        <button type="button" className={btn} disabled={disabled || value >= max} onClick={() => onChange(clamp(value + step))} aria-label={`${label}: больше`}>
          +
        </button>
      </div>
    </div>
  );
}

/** 9.5 → «9,5», 10 → «10», 1.45 → «1,45». */
const decimal = (v: number, digits: number) => String(Number(v.toFixed(digits))).replace(".", ",");

const Hint = ({ children }: { children: ReactNode }) => (
  <p className="mt-1.5 text-[12.5px] leading-snug text-ink-dim">{children}</p>
);

function DocCard({
  title,
  kind,
  texts,
  onChange,
  onFocus,
  disabled,
  bodyLabel,
  bodyHint,
  staffHint,
  extraTitle,
}: {
  title: string;
  kind: "intake" | "act";
  /** Второй заголовок — квитанция при приёме по гарантии. */
  extraTitle?: { value: string; fallback: string; onChange: (v: string) => void };
  texts: DocTexts;
  onChange: (next: DocTexts) => void;
  onFocus: () => void;
  disabled: boolean;
  bodyLabel: string;
  bodyHint: string;
  staffHint: string;
}) {
  const d = DEFAULT_TEXTS[kind];
  const set = (k: keyof DocTexts) => (v: string | number) => onChange({ ...texts, [k]: v });
  const reset = (k: keyof DocTexts) => (texts[k] !== d[k] ? () => onChange({ ...texts, [k]: d[k] }) : undefined);

  return (
    <Panel id={`print:${title}`} title={title}>
      <div className="mt-4 space-y-4" onFocusCapture={onFocus}>
        <div>
          <FieldHead label="Заголовок" onReset={reset("title")} />
          <Input value={texts.title} maxLength={80} disabled={disabled} onChange={(e) => set("title")(e.target.value)} />
        </div>
        {extraTitle && (
          <div>
            <FieldHead
              label="Заголовок при приёме по гарантии"
              onReset={extraTitle.value !== extraTitle.fallback ? () => extraTitle.onChange(extraTitle.fallback) : undefined}
            />
            <Input value={extraTitle.value} maxLength={80} disabled={disabled} onChange={(e) => extraTitle.onChange(e.target.value)} />
          </div>
        )}
        <div>
          <FieldHead label={bodyLabel} onReset={reset("body")} count={texts.body.length} max={TEXT_MAX} />
          <Textarea
            rows={7}
            value={texts.body}
            maxLength={TEXT_MAX}
            disabled={disabled}
            onChange={(e) => set("body")(e.target.value)}
          />
          <Hint>{bodyHint}</Hint>
          <div className="mt-3 rounded-field border border-line px-3 pb-3 pt-2.5">
            <div className="mb-2 flex items-baseline justify-between gap-3">
              <span className="text-[12.5px] font-semibold text-ink-soft">Текст на листе</span>
              {(texts.size !== d.size || texts.leading !== d.leading) && !disabled && (
                <button
                  type="button"
                  onClick={() => onChange({ ...texts, size: d.size, leading: d.leading })}
                  className="text-[12.5px] font-semibold text-brand-ink hover:underline"
                >
                  Вернуть стандартный
                </button>
              )}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Stepper
                label="Размер шрифта"
                value={texts.size}
                {...TEXT_SIZE}
                show={(v) => `${decimal(v, 1)} пт`}
                disabled={disabled}
                onChange={(v) => set("size")(v)}
              />
              <Stepper
                label="Межстрочный интервал"
                value={texts.leading}
                {...TEXT_LEADING}
                show={(v) => decimal(v, 2)}
                disabled={disabled}
                onChange={(v) => set("leading")(Math.round(v * 100) / 100)}
              />
            </div>
          </div>
        </div>
        {/* Подписи одна под другой: фразы длинные, и в две колонки поле
            обрезает их на середине — не видно, что именно правишь. */}
        <div className="space-y-4">
          <div>
            <FieldHead label="Подпись клиента" onReset={reset("signClient")} />
            <Input
              value={texts.signClient}
              maxLength={100}
              disabled={disabled}
              onChange={(e) => set("signClient")(e.target.value)}
            />
          </div>
          <div>
            <FieldHead label="Подпись мастерской" onReset={reset("signStaff")} />
            <Input
              value={texts.signStaff}
              maxLength={100}
              disabled={disabled}
              onChange={(e) => set("signStaff")(e.target.value)}
            />
            <Hint>{staffHint}</Hint>
          </div>
        </div>
      </div>
    </Panel>
  );
}

/** Маленькая галочка в строке — большая кнопка Checkbox здесь заняла бы полстроки. */
function Tick({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled: boolean; label: string }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={
        "grid h-[22px] w-[22px] shrink-0 place-items-center rounded-[6px] border transition-colors duration-150 disabled:opacity-50 " +
        (checked ? "border-brand bg-brand text-white" : "border-line-strong bg-surface-input hover:border-ink-dim")
      }
    >
      {checked && (
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden>
          <path d="M3.5 8.5l3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  );
}

const iconBtn =
  "grid h-8 w-8 shrink-0 place-items-center rounded-field border border-line bg-surface-raised text-[14px] font-semibold text-ink-muted " +
  "hover:border-line-strong hover:text-ink disabled:opacity-30";

/**
 * Строки раздела: галочка, название (пусто — стандартное), ↑↓, у своих —
 * текст и «убрать». Порядок здесь — порядок на листе.
 */
function FieldRows({
  fields,
  defaults,
  onChange,
  disabled,
  attr,
}: {
  fields: SheetField[];
  defaults: SheetField[];
  onChange: (next: SheetField[]) => void;
  disabled: boolean;
  attr: string;
}) {
  const set = (i: number, p: Partial<SheetField>) => onChange(fields.map((f, j) => (j === i ? { ...f, ...p } : f)));
  const move = (i: number, d: -1 | 1) => {
    const next = [...fields];
    const [x] = next.splice(i, 1);
    next.splice(i + d, 0, x);
    onChange(next);
  };
  const customs = fields.filter((f) => f.custom).length;
  return (
    <div className="space-y-1.5">
      {fields.map((f, i) => {
        const def = defaults.find((d) => d.key === f.key);
        const hint = FIELD_HINTS[f.key];
        return (
          <div
            key={f.key}
            data-print-field={`${attr}:${f.key}`}
            className={"rounded-field border px-2 py-1.5 " + (f.on ? "border-line bg-surface-input/40" : "border-line/60 opacity-70")}
          >
            <div className="flex items-center gap-2">
              <Tick checked={f.on} disabled={disabled} label={`Печатать «${f.label}»`} onChange={(on) => set(i, { on })} />
              <Input
                value={f.label}
                maxLength={60}
                disabled={disabled}
                placeholder={def?.label ?? "Название поля"}
                aria-label="Название на бланке"
                className="!min-h-[34px] h-[34px] min-w-0 flex-1 !px-2.5 !text-[13.5px]"
                onChange={(e) => set(i, { label: e.target.value })}
                onBlur={() => !f.label.trim() && set(i, { label: def?.label ?? "Своё поле" })}
              />
              <button type="button" className={iconBtn} disabled={disabled || i === 0} onClick={() => move(i, -1)} aria-label="Выше">
                ↑
              </button>
              <button type="button" className={iconBtn} disabled={disabled || i === fields.length - 1} onClick={() => move(i, 1)} aria-label="Ниже">
                ↓
              </button>
              {f.custom && (
                <button
                  type="button"
                  className={iconBtn}
                  disabled={disabled}
                  onClick={() => onChange(fields.filter((_, j) => j !== i))}
                  aria-label="Убрать поле"
                  data-print-field-remove
                >
                  ×
                </button>
              )}
            </div>
            {f.custom ? (
              <Input
                value={f.text ?? ""}
                maxLength={200}
                disabled={disabled}
                placeholder="Текст; пусто — черта для руки"
                className="mt-1.5 !min-h-[34px] h-[34px] !px-2.5 !text-[13px]"
                data-print-field-text
                onChange={(e) => set(i, { text: e.target.value || null })}
              />
            ) : (
              (hint || (def && f.label !== def.label)) && (
                <p className="mt-0.5 pl-[30px] text-[11.5px] text-ink-dim">
                  {[def && f.label !== def.label ? `было «${def.label}»` : "", hint].filter(Boolean).join(" · ")}
                </p>
              )
            )}
          </div>
        );
      })}
      {!disabled && customs < CUSTOM_MAX && (
        <button
          type="button"
          data-print-field-add={attr}
          className="text-[13px] font-semibold text-brand-ink hover:underline"
          onClick={() => onChange([...fields, { key: newCustomKey(), on: true, label: "Своё поле", text: null, custom: true }])}
        >
          + Своё поле
        </button>
      )}
    </div>
  );
}

/** «Поля на листе»: разделы квитанции или акта — включить, переименовать, строки внутри. */
function LayoutCard({
  title,
  kind,
  sections,
  onChange,
  onFocus,
  disabled,
}: {
  title: string;
  kind: "intake" | "act";
  sections: SheetSection[];
  onChange: (next: SheetSection[]) => void;
  onFocus: () => void;
  disabled: boolean;
}) {
  const defaults = defaultLayout(kind);
  const set = (key: string, p: Partial<SheetSection>) => onChange(sections.map((s) => (s.key === key ? { ...s, ...p } : s)));
  const changed = JSON.stringify(sections) !== JSON.stringify(defaults);
  const customs = sections.reduce((n, s) => n + s.fields.filter((f) => f.custom).length, 0);
  const summary = !changed
    ? "Стандартные поля"
    : ["Настроены", customs ? `своих полей: ${customs}` : ""].filter(Boolean).join(" · ");
  return (
    <Panel id={`print:${title}`} title={title} summary={summary}>
      <div className="mt-4 space-y-4" onFocusCapture={onFocus} onClickCapture={onFocus} data-print-layout={kind}>
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <Hint>
            Галочка — печатать. Название можно поменять, строки — переставить стрелками. Пустые поля заказа на лист не
            попадают.
          </Hint>
          {changed && !disabled && (
            <button type="button" onClick={() => onChange(defaults)} className="text-[12.5px] font-semibold text-brand-ink hover:underline">
              Вернуть стандартные
            </button>
          )}
        </div>
        {sections.map((sec) => {
          const def = defaults.find((d) => d.key === sec.key)!;
          return (
            <div key={sec.key} data-print-section={`${kind}:${sec.key}`} className="rounded-field border border-line p-2.5">
              <div className="flex items-center gap-2">
                <Tick checked={sec.on} disabled={disabled} label={`Печатать раздел «${sec.title}»`} onChange={(on) => set(sec.key, { on })} />
                <Input
                  value={sec.title}
                  maxLength={60}
                  disabled={disabled}
                  placeholder={def.title}
                  aria-label="Название раздела"
                  className="!min-h-[34px] h-[34px] min-w-0 flex-1 !px-2.5 !text-[13.5px] font-semibold"
                  onChange={(e) => set(sec.key, { title: e.target.value })}
                  onBlur={() => !sec.title.trim() && set(sec.key, { title: def.title })}
                />
              </div>
              {sec.on && !sec.block && (
                <div className="mt-2">
                  <FieldRows
                    attr={`${kind}:${sec.key}`}
                    fields={sec.fields}
                    defaults={def.fields}
                    disabled={disabled}
                    onChange={(fields) => set(sec.key, { fields })}
                  />
                </div>
              )}
              {sec.key === "money" && <Hint>Суммы печатаются только тем, кому они видны в заказе.</Hint>}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

/** Отрезной талон под квитанцией. */
function TalonCard({ talon, onChange, onFocus, disabled }: { talon: Talon; onChange: (t: Talon) => void; onFocus: () => void; disabled: boolean }) {
  const d = defaultTalon();
  return (
    <Panel id="print:Отрезной талон" title="Отрезной талон" summary={talon.on ? "Печатается внизу квитанции" : "Выключен"}>
      <div className="mt-4 space-y-4" onFocusCapture={onFocus} onClickCapture={onFocus} data-print-talon-card>
        <div className="sm:max-w-[460px]">
          <Checkbox
            checked={talon.on}
            disabled={disabled}
            onChange={(on) => onChange({ ...talon, on })}
            label="Печатать талон внизу квитанции — по линии ✂ отрезать и отдать клиенту"
          />
        </div>
        {talon.on && (
          <>
            <div>
              <FieldHead label="Заголовок талона" onReset={talon.title !== d.title ? () => onChange({ ...talon, title: d.title }) : undefined} />
              <Input value={talon.title} maxLength={60} disabled={disabled} onChange={(e) => onChange({ ...talon, title: e.target.value })} />
              <Hint>Номер заказа, название и реквизиты мастерской на талоне есть всегда.</Hint>
            </div>
            <div>
              <FieldHead label="Строки талона" />
              <FieldRows attr="talon" fields={talon.fields} defaults={d.fields} disabled={disabled} onChange={(fields) => onChange({ ...talon, fields })} />
            </div>
            <div>
              <FieldHead label="Текст на талоне" count={(talon.note ?? "").length} max={300} />
              <Textarea
                rows={2}
                value={talon.note ?? ""}
                maxLength={300}
                disabled={disabled}
                placeholder="Технику выдают по этому талону. Потеряли — с паспортом."
                onChange={(e) => onChange({ ...talon, note: e.target.value || null })}
              />
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}

export default function PrintFormsPage() {
  const { me, can } = useAuth();
  const mayEdit = can("settings.manage");

  const [saved, setSaved] = useState<PrintForms | null>(null);
  const [draft, setDraft] = useState<PrintForms | null>(null);
  const [doc, setDoc] = useState<Doc>("intake");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const order = useMemo(sampleOrder, []);

  useEffect(() => {
    printFormsApi
      .get()
      .then((f) => {
        setSaved(f);
        setDraft(f);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Не удалось загрузить бланки"));
  }, []);

  const workshop =
    me?.kind === "tenant"
      ? (me.tenant?.name ?? "Мастерская")
      : me?.kind === "platform"
        ? (me.impersonating?.name ?? "Мастерская")
        : "Мастерская";

  if (!draft || !saved) {
    return error ? <Banner tone="error">{error}</Banner> : <Spinner label="Открываем бланки" />;
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const patch = (p: Partial<PrintForms>) => {
    setNotice(null);
    // Пустое поле — это «не задано», как и в сохранённом: иначе стёртая
    // строка считалась бы правкой, и кнопка «Сохранить» не гасла бы.
    for (const k of ["name", "requisites", "footer"] as const) {
      if (k in p && p[k] === "") p[k] = null;
    }
    setDraft((d) => (d ? { ...d, ...p } : d));
  };

  async function onSave() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      await printFormsApi.save(draft);
      // Перечитываем: сервер хранит только отличия, и вернувшееся — это то,
      // что действительно будет печататься.
      const fresh = await printFormsApi.get();
      setSaved(fresh);
      setDraft(fresh);
      setNotice("Бланки сохранены — следующая квитанция и акт выйдут уже такими");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось сохранить");
    } finally {
      setBusy(false);
    }
  }

  async function onLogoPicked(file: File) {
    setError(null);
    try {
      patch({ logo: await prepareLogo(file) });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось прочитать картинку");
    }
  }

  return (
    <div className="space-y-5">
      <Link to="/settings" className="text-[13.5px] font-semibold text-ink-muted hover:text-ink">
        ‹ Настройки
      </Link>

      <PageHeader
        eyebrow="Настройки"
        title="Бланки"
        subtitle="Квитанция о приёме и акт работ: что мастерская пишет на них сама. Всё, что относится к заказу, — клиент, техника, работы, суммы — подставится само."
        actions={
          // На узком экране лист — в самом низу, под полями.
          <Button
            variant="secondary"
            className="xl:hidden"
            onClick={() => document.getElementById("print-preview")?.scrollIntoView({ behavior: "smooth", block: "start" })}
          >
            Посмотреть бланк
          </Button>
        }
      />

      {!mayEdit && <Banner>Бланки настраивает владелец мастерской. Здесь можно посмотреть, как они выглядят.</Banner>}
      {error && <Banner tone="error">{error}</Banner>}
      {notice && <Banner>{notice}</Banner>}

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {/* ------------------------------------------------------ поля */}
        <div className="space-y-5">
          <Panel id="print:Шапка" title="Шапка">
            <div className="mt-4 space-y-4">
              <div>
                <FieldHead label="Логотип на бланке" />
                <div className="flex flex-wrap items-center gap-4">
                  {/* Белая подложка — это бумага: так видно, как логотип
                      ляжет на лист, а не на тёмную панель настроек. */}
                  <div className="flex h-[76px] w-[180px] shrink-0 items-center justify-center rounded-field border border-line bg-white p-2">
                    {draft.logo ? (
                      <img src={draft.logo} alt="Логотип на бланке" className="max-h-full max-w-full object-contain" />
                    ) : (
                      <span className="text-[12.5px] text-black/40">Без логотипа</span>
                    )}
                  </div>
                  {mayEdit && (
                    <div className="flex flex-wrap gap-2">
                      <input
                        ref={fileInput}
                        type="file"
                        accept={LOGO_TYPES}
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          e.target.value = "";
                          if (file) void onLogoPicked(file);
                        }}
                      />
                      <Button variant="secondary" disabled={busy} onClick={() => fileInput.current?.click()}>
                        {draft.logo ? "Заменить" : "Загрузить"}
                      </Button>
                      {draft.logo && (
                        <Button variant="ghost" disabled={busy} onClick={() => patch({ logo: null })}>
                          Убрать
                        </Button>
                      )}
                    </div>
                  )}
                </div>
                <Hint>
                  Свой, отдельный от логотипа в окне программы. На офисном принтере лучше всего выходит тёмный логотип
                  на прозрачном или белом фоне.
                </Hint>
              </div>

              <div>
                <FieldHead label="Название на бланке" />
                <Input
                  value={draft.name ?? ""}
                  maxLength={80}
                  placeholder={workshop}
                  disabled={!mayEdit}
                  onChange={(e) => patch({ name: e.target.value })}
                />
                <Hint>Пусто — название мастерской. Можно указать юридическое: ИП Иванов И. И.</Hint>
              </div>

              <div>
                <FieldHead label="Реквизиты" count={(draft.requisites ?? "").length} max={400} />
                <Textarea
                  rows={4}
                  value={draft.requisites ?? ""}
                  maxLength={400}
                  disabled={!mayEdit}
                  placeholder={"г. Екатеринбург, ул. Ленина, 5\n+7 343 200-10-10 · ежедневно 10–20\nИНН 667000000000"}
                  onChange={(e) => patch({ requisites: e.target.value })}
                />
                <Hint>Печатается под названием, как набрано — с переносами строк.</Hint>
              </div>
            </div>
          </Panel>

          <DocCard
            title="Квитанция о приёме"
            kind="intake"
            texts={draft.intake}
            disabled={!mayEdit}
            onFocus={() => setDoc("intake")}
            onChange={(intake) => patch({ intake })}
            extraTitle={{ value: draft.warrantyTitle, fallback: DEFAULT_WARRANTY_TITLE, onChange: (warrantyTitle) => patch({ warrantyTitle }) }}
            bodyLabel="Условия приёма"
            bodyHint="Под этим клиент расписывается при сдаче техники. Абзацы — через Enter."
            staffHint="Под строкой — только эта надпись: расписывается тот, кто принимает технику."
          />

          <LayoutCard
            title="Квитанция: поля на листе"
            kind="intake"
            sections={draft.layout.intake}
            disabled={!mayEdit}
            onFocus={() => setDoc("intake")}
            onChange={(intake) => patch({ layout: { ...draft.layout, intake } })}
          />

          <TalonCard talon={draft.talon} disabled={!mayEdit} onFocus={() => setDoc("intake")} onChange={(talon) => patch({ talon })} />

          <DocCard
            title="Акт выполненных работ"
            kind="act"
            texts={draft.act}
            disabled={!mayEdit}
            onFocus={() => setDoc("act")}
            onChange={(act) => patch({ act })}
            bodyLabel="Условия гарантии"
            bodyHint="Срок гарантии берётся из заказа — здесь только общие условия."
            staffHint="Под строкой — только эта надпись: расписывается тот, кто выдаёт технику."
          />

          <LayoutCard
            title="Акт: поля на листе"
            kind="act"
            sections={draft.layout.act}
            disabled={!mayEdit}
            onFocus={() => setDoc("act")}
            onChange={(act) => patch({ layout: { ...draft.layout, act } })}
          />

          <Panel id="print:Низ листа" title="Низ листа">
            <div className="mt-4 space-y-4">
              <div>
                <FieldHead label="Строка внизу" count={(draft.footer ?? "").length} max={200} />
                <Input
                  value={draft.footer ?? ""}
                  maxLength={200}
                  disabled={!mayEdit}
                  placeholder="Спасибо, что выбрали нас! Отзывы и претензии: +7 343 200-10-10"
                  onChange={(e) => patch({ footer: e.target.value })}
                />
                <Hint>На обоих бланках, мелко по центру. Пусто — строки нет.</Hint>
              </div>
              <div className="sm:max-w-[420px]">
                <Checkbox
                  checked={draft.stamp}
                  disabled={!mayEdit}
                  onChange={(stamp) => patch({ stamp })}
                  label="«М.П.» у подписи мастерской — место для печати"
                />
              </div>
            </div>
          </Panel>

          {mayEdit && (
            // Прилипает к низу экрана, только когда есть что сохранить: пустая
            // панель «Всё сохранено» поверх полей только закрывала бы их.
            <div
              className={
                "z-20 flex flex-wrap items-center justify-between gap-3 rounded-panel border px-4 py-3 transition-colors duration-150 " +
                (dirty
                  ? "sticky bottom-[88px] border-brand/50 bg-surface-raised shadow-raised lg:bottom-4"
                  : "border-line bg-surface")
              }
            >
              <p className="text-[13.5px] text-ink-muted">{dirty ? "Есть несохранённые правки" : "Всё сохранено"}</p>
              <div className="flex gap-2">
                {dirty && (
                  <Button variant="ghost" disabled={busy} onClick={() => setDraft(saved)}>
                    Отменить
                  </Button>
                )}
                <Button disabled={busy || !dirty} onClick={() => void onSave()}>
                  {busy ? "Сохраняем…" : "Сохранить"}
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* ------------------------------------------------ предпросмотр */}
        <div id="print-preview" className="scroll-mt-4 xl:sticky xl:top-4">
          <div className="rounded-panel border border-line bg-surface p-3 sm:p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-ink-dim">Так выйдет на бумаге</p>
              <div className="inline-flex rounded-pill border border-line bg-surface-input p-0.5">
                {(
                  [
                    ["intake", "Квитанция"],
                    ["act", "Акт"],
                  ] as Array<[Doc, string]>
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setDoc(key)}
                    className={
                      "rounded-pill px-3.5 py-1.5 text-[13px] font-semibold transition-colors duration-150 " +
                      (doc === key ? "bg-brand text-white" : "text-ink-muted hover:text-ink")
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {/* Серый стол под листом — как на странице печати. */}
            <div className="max-h-[calc(100vh-150px)] overflow-y-auto rounded-field bg-[#6B7280] p-3 sm:p-5">
              <ScaledSheet>
                <PrintSheet order={order} doc={doc} forms={draft} workshop={workshop} preview />
              </ScaledSheet>
            </div>
            <p className="mt-2.5 text-[12px] text-ink-dim">
              Пример заказа выдуман. Клиент, техника, работы и суммы на настоящем бланке — из заказа.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
