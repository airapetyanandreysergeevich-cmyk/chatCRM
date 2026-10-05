import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "../lib/api";
import {
  LABEL_FIELDS,
  LONG_LABEL,
  MAX_TEMPLATES,
  SAMPLE_LABEL,
  labelsApi,
  useLabelLogo,
  type LabelField,
  type LabelSettings,
  type LabelTemplate,
  type LabelsView,
} from "../lib/labels";
import { Modal } from "./Modal";
import { activeLayout, autoLayout, EL_NAME, overlapping, type ElKind } from "../lib/labelLayout";
import { LabelLayoutEditor } from "./LabelLayoutEditor";
import { printAndWait, type PrintJob, type TargetView } from "../lib/printing";
import { Label, barcodeDots } from "./Label";
import { Banner, Button, Checkbox, Input } from "./ui";

/**
 * Конструктор наклейки: шаблоны (до шести, с названиями), размер, что на
 * наклейке, на какие вещи — своя. Справа — живой предпросмотр в масштабе,
 * с теми же правилами, что при печати.
 *
 * Правится выбранный шаблон; «Сохранить» записывает все шаблоны разом.
 * Основной печатается сам после приёма, в окне «Наклейки» выбирают любой.
 */

/** 1 мм на экране — 96 / 25,4 точки. */
const PX_PER_MM = 96 / 25.4;

function Pill({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={
        "rounded-pill border px-3 py-1.5 text-[13px] font-semibold tabular-nums transition-colors duration-150 " +
        (on ? "border-brand bg-brand-tint text-brand-ink" : "border-line bg-surface-raised text-ink-muted hover:text-ink")
      }
    >
      {children}
    </button>
  );
}

type Config = { perItem: string[]; templates: LabelTemplate[]; main: string };
const configOf = (v: LabelsView): Config => ({ perItem: v.perItem, templates: v.templates, main: v.main });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const newId = () => "t" + Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36);

export function LabelDesigner({
  initial,
  completeness,
  printer,
  workshop,
  onSaved,
}: {
  initial: LabelsView;
  /** Пункты комплектности мастерской — из них выбирают, на что своя наклейка. */
  completeness: string[];
  /** Принтер этикеток, на который пойдёт пробная наклейка. */
  printer: TargetView | null;
  workshop: string;
  onSaved: () => void;
}) {
  const [cfg, setCfg] = useState<Config>(() => configOf(initial));
  const [saved, setSaved] = useState<Config>(() => configOf(initial));
  /** Какой шаблон сейчас правится. */
  const [cur, setCur] = useState<string>(initial.main);
  const [overflow, setOverflow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [test, setTest] = useState<PrintJob | null>(null);
  const [sample, setSample] = useState<"device" | "accessory" | "long">("accessory");
  const [overKinds, setOverKinds] = useState<ElKind[]>([]);
  /** Окно названия: «как новый» или «переименовать»; окно удаления. */
  const [naming, setNaming] = useState<null | "new" | "rename">(null);
  const [deleting, setDeleting] = useState(false);

  const dirty = !same(cfg, saved);
  // Страница «Периферия» перезагружает настройки каждые 20 секунд (компьютеры с принтерами появляются и
  // пропадают) — и каждый раз приходит новый объект. Несохранённую правку он не затирает: принимаем его,
  // только если настройка и правда изменилась (сохранили с другого компьютера), а у нас ничего не начато.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const initialKey = JSON.stringify(configOf(initial));
  useEffect(() => {
    const next = configOf(initial);
    setSaved((prev) => (same(prev, next) ? prev : next));
    if (!dirtyRef.current) setCfg((c) => (same(c, next) ? c : next));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialKey]);

  // Выбранного шаблона нет (удалили с другого компьютера) — на основной.
  const tpl = cfg.templates.find((t) => t.id === cur) ?? cfg.templates.find((t) => t.id === cfg.main) ?? cfg.templates[0];
  const s: LabelSettings = { ...stripId(tpl), perItem: cfg.perItem };
  /** Правка выбранного шаблона; «вещи со своей наклейкой» — общие на все шаблоны. */
  const setS = (fn: (x: LabelSettings) => LabelSettings) =>
    setCfg((c) => {
      const t = c.templates.find((x) => x.id === tpl.id) ?? tpl;
      const before: LabelSettings = { ...stripId(t), perItem: c.perItem };
      const { perItem, ...rest } = fn(before);
      return { ...c, perItem, templates: c.templates.map((x) => (x.id === t.id ? { ...x, ...rest } : x)) };
    });
  const set = (patch: Partial<LabelSettings>) => setS((x) => ({ ...x, ...patch }));
  const toggleField = (f: LabelField) => setS((x) => ({ ...x, fields: { ...x.fields, [f]: !x.fields[f] } }));
  const hasItem = (label: string) => s.perItem.some((x) => x.toLowerCase() === label.toLowerCase());
  const toggleItem = (label: string) =>
    setS((x) => ({
      ...x,
      perItem: hasItem(label) ? x.perItem.filter((v) => v.toLowerCase() !== label.toLowerCase()) : [...x.perItem, label],
    }));
  // Отмеченные раньше пункты, которых уже нет среди кнопок, тоже показываем — чтобы их можно было снять.
  const itemChoices = [...completeness, ...s.perItem.filter((p) => !completeness.some((c) => c.toLowerCase() === p.toLowerCase()))];

  const logo = useLabelLogo(s.fields.logo);
  const base = { ...SAMPLE_LABEL, workshop: workshop || SAMPLE_LABEL.workshop, logo: logo.logo };
  const data =
    sample === "accessory"
      ? base
      : sample === "long"
        ? { ...LONG_LABEL, logo: logo.logo }
        : { ...base, item: { title: "Ноутбук", index: 1, total: 3, accessory: false } };
  // Свой макет: тот, что печатается (подогнан под размер этикетки, с включёнными элементами).
  const customMode = s.mode === "custom";
  const layout = customMode ? activeLayout(s) : null;
  const crossed = layout ? overlapping(layout, s) : [];
  const setMode = (mode: "auto" | "custom") =>
    setS((x) => ({ ...x, mode, layout: mode === "custom" && !x.layout ? autoLayout(x) : x.layout }));
  const dots = s.code === "code128" ? barcodeDots(s, SAMPLE_LABEL.code) : 3;
  // Предпросмотр — по ширине колонки (на телефоне уже), не шире 360 точек и не выше 300.
  const previewBox = useRef<HTMLDivElement>(null);
  const [previewW, setPreviewW] = useState(400);
  useEffect(() => {
    const el = previewBox.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setPreviewW(el.clientWidth));
    ro.observe(el);
    setPreviewW(el.clientWidth);
    return () => ro.disconnect();
  }, [customMode]);
  const scale = Math.min(Math.min(360, previewW - 40) / (s.width * PX_PER_MM), 300 / (s.height * PX_PER_MM), 2.4);

  async function persist(next: Config, message: string) {
    setBusy(true);
    setError(null);
    try {
      await labelsApi.save(next);
      setCfg(next);
      setSaved(next);
      onSaved();
      setNotice(message);
      setTimeout(() => setNotice(null), 3500);
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось сохранить");
      return false;
    } finally {
      setBusy(false);
    }
  }
  const save = () => persist(cfg, "Наклейка сохранена");

  /** «Сохранить как новый»: правки уходят в новый шаблон, исходный остаётся каким был. */
  function saveAsNew(name: string) {
    const id = newId();
    const original = saved.templates.find((t) => t.id === tpl.id);
    const copy: LabelTemplate = { ...tpl, id, name };
    const templates = [...cfg.templates.map((t) => (t.id === tpl.id && original ? original : t)), copy];
    void persist({ ...cfg, templates }, `Шаблон «${name}» сохранён`).then((ok) => ok && setCur(id));
  }
  function rename(name: string) {
    void persist({ ...cfg, templates: cfg.templates.map((t) => (t.id === tpl.id ? { ...t, name } : t)) }, `Шаблон переименован: «${name}»`);
  }
  function makeMain() {
    void persist({ ...cfg, main: tpl.id }, `«${tpl.name}» — основной: он печатается после приёма`);
  }
  function remove() {
    const templates = cfg.templates.filter((t) => t.id !== tpl.id);
    const main = cfg.main === tpl.id ? templates[0].id : cfg.main;
    setDeleting(false);
    void persist({ ...cfg, templates, main }, `Шаблон «${tpl.name}» удалён`).then((ok) => ok && setCur(main));
  }

  async function printTest() {
    if (!printer) return;
    setError(null);
    setTest(null);
    try {
      if (dirty && !(await save())) return;
      const job = await printAndWait(
        { doc: "label-test", stationId: printer.stationId, printer: printer.printer, template: tpl.id },
        setTest
      );
      setTest(job);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось отправить пробную наклейку");
    }
  }

  const sampleTabs = (
    <div className="flex flex-wrap gap-1.5">
      <Pill on={sample === "device"} onClick={() => setSample("device")}>
        Техника
      </Pill>
      <Pill on={sample === "accessory"} onClick={() => setSample("accessory")}>
        Из комплекта
      </Pill>
      <Pill on={sample === "long"} onClick={() => setSample("long")}>
        Длинные данные
      </Pill>
    </div>
  );

  const preview = (
    <>
      <div ref={previewBox} className="mt-3 flex justify-center overflow-hidden rounded-card bg-[#6B7280] p-5">
        <div style={{ width: s.width * PX_PER_MM * scale, height: s.height * PX_PER_MM * scale }}>
          <div style={{ width: `${s.width}mm`, transform: `scale(${scale})`, transformOrigin: "top left" }} className="shadow-[0_4px_16px_rgba(0,0,0,0.35)]">
            <Label settings={s} data={data} onOverflow={setOverflow} onOverflowKinds={setOverKinds} />
          </div>
        </div>
      </div>
      <p className="mt-2 text-center text-[12.5px] text-ink-dim">
        {s.width} × {s.height} мм{s.rotate ? ", надписи повёрнуты" : ""} · {sample === "long" ? "длинные данные" : "пример заказа"}
      </p>
    </>
  );

  const warnings = (
    <div className="mt-3 space-y-2">
      {overflow &&
        (customMode ? (
          <Banner tone="warning">
            Не влезает: {overKinds.map((k) => EL_NAME[k]).join(", ") || "часть элементов"} — на макете они обведены красным. Увеличьте
            рамку, уменьшите шрифт или добавьте строку.
          </Banner>
        ) : (
          <Banner tone="warning">
            Не всё влезает на {s.width} × {s.height} мм — нижние строки обрежутся. Уберите строку или выберите этикетку больше.
          </Banner>
        ))}
      {crossed.length > 0 && (
        <Banner tone="warning">
          Накладываются: {crossed.map(([a, b]) => `${EL_NAME[a]} и ${EL_NAME[b]}`).join("; ")} — надписи слипнутся
          {crossed.some((p) => p.includes("code")) ? ", а штрихкод может не прочитаться" : ""}. Раздвиньте рамки.
        </Banner>
      )}
      {!customMode && s.code === "code128" && dots < 2 && (
        <Banner tone="warning">
          Штрихкод выходит слишком плотным для такой ширины — сканер может его не прочитать. Возьмите этикетку шире, снимите
          поворот или выберите QR-код.
        </Banner>
      )}
      {error && <Banner tone="error">{error}</Banner>}
      {notice && <Banner>{notice}</Banner>}
      {test && (
        <Banner tone={test.status === "FAILED" ? "error" : "info"}>
          {test.status === "DONE"
            ? "Пробная наклейка напечатана."
            : test.status === "FAILED"
              ? `Не напечатано: ${test.error ?? "причина неизвестна"}`
              : "Печатаем пробную наклейку…"}
        </Banner>
      )}
    </div>
  );

  const actions = (
    <>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row-reverse">
        <Button type="button" disabled={!dirty || busy} onClick={() => void save()} className="sm:flex-1">
          {busy ? "Сохраняем…" : dirty ? "Сохранить" : "Сохранено"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={!printer || !printer.online || busy}
          title={!printer ? "Сначала назначьте принтер этикеток" : !printer.online ? "Компьютер с принтером этикеток не на связи" : undefined}
          onClick={() => void printTest()}
          className="sm:flex-1"
        >
          Пробная наклейка
        </Button>
      </div>
      <p className="mt-2.5 text-[12.5px] text-ink-dim">
        В свойствах принтера этикеток в Windows («Настройки печати → Бумага») поставьте тот же размер — {s.width} × {s.height} мм.
      </p>
    </>
  );

  const fieldsSection = (
    <section>
      <p className="text-[14px] font-semibold">{customMode ? "Что есть на наклейке" : "Что напечатать рядом с кодом"}</p>
      <div className={"mt-2 grid gap-2 " + (customMode ? "grid-cols-2 sm:grid-cols-3 xl:grid-cols-4" : "sm:grid-cols-2")}>
        {LABEL_FIELDS.map((f) => (
          <Checkbox key={f.id} checked={s.fields[f.id]} onChange={() => toggleField(f.id)} label={f.label} />
        ))}
      </div>
      {s.fields.logo && logo.ready && logo.missing && (
        <p className="mt-2 text-[12.5px] text-state-waiting">
          Логотип не загружен. Он берётся из{" "}
          <Link to="/settings/print" className="font-semibold underline">
            «Настройки → Бланки»
          </Link>{" "}
          — тот же, что на квитанции.
        </p>
      )}
      {s.fields.logo && logo.logo && (
        <p className="mt-2 text-[12.5px] text-ink-dim">Логотип — из «Бланков», для термопринтера переведён в чёрно-белый: так он и выйдет на наклейке.</p>
      )}
    </section>
  );

  const modeSection = (
    <section className="mt-4">
      <p className="text-[14px] font-semibold">Компоновка</p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Pill on={!customMode} onClick={() => setMode("auto")}>
          Автоматически
        </Pill>
        <Pill on={customMode} onClick={() => setMode("custom")}>
          Свой макет
        </Pill>
        {customMode && (
          <button
            type="button"
            onClick={() => set({ layout: autoLayout(s) })}
            className="ml-1 text-[12.5px] font-semibold text-brand-ink hover:underline"
          >
            Сбросить к автоматической
          </button>
        )}
      </div>
      <p className="mt-1.5 text-[12.5px] text-ink-dim">
        {customMode
          ? "Элементы стоят там, где вы их поставили. Начало — автоматическая раскладка; двигайте, меняйте размер и шрифт."
          : "Строки встают сами, сверху вниз, шрифт подбирается под этикетку. «Свой макет» — расставить всё вручную."}
      </p>
    </section>
  );

  const sizeSection = (
    <section>
      <p className="text-[14px] font-semibold">Размер этикетки, мм</p>
      <p className="mt-0.5 text-[12.5px] text-ink-dim">Ширина × высота, как написано на рулоне: ширина — поперёк рулона.</p>
      <div className="mt-2.5 flex flex-wrap items-center gap-2 text-[13px] text-ink-muted">
        <SizeInput label="Ширина, мм" value={s.width} onChange={(width) => set({ width })} />
        ×
        <SizeInput label="Высота, мм" value={s.height} onChange={(height) => set({ height })} />
        мм
      </div>
      <div className="mt-2.5">
        <Checkbox
          checked={s.rotate}
          onChange={(v) => set({ rotate: v })}
          label="Повернуть надписи на 90° — если этикетка выходит из принтера узкой стороной вперёд"
        />
      </div>
    </section>
  );

  const templatesSection = (
    <section data-templates>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[14px] font-semibold">Шаблоны</p>
        <span className="text-[12.5px] text-ink-dim">
          ★ — основной: печатается после приёма. В окне «Наклейки» можно выбрать любой.
        </span>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Шаблоны наклейки">
        {cfg.templates.map((t) => {
          const changed = !same(t, saved.templates.find((x) => x.id === t.id));
          return (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={t.id === tpl.id}
              onClick={() => setCur(t.id)}
              className={
                "inline-flex items-center gap-1.5 rounded-pill border px-3 py-1.5 text-[13px] font-semibold transition-colors duration-150 " +
                (t.id === tpl.id ? "border-brand bg-brand-tint text-brand-ink" : "border-line bg-surface-raised text-ink-muted hover:text-ink")
              }
            >
              {t.id === cfg.main && (
                <>
                  <span aria-hidden>★</span>
                  <span className="sr-only">основной:</span>
                </>
              )}
              {t.name}
              <span className="font-normal tabular-nums opacity-70">
                {t.width}×{t.height}
              </span>
              {changed && <span title="Есть несохранённые изменения" className="h-1.5 w-1.5 rounded-full bg-state-waiting" />}
            </button>
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[13px] font-semibold">
        <button
          type="button"
          disabled={busy || cfg.templates.length >= MAX_TEMPLATES}
          title={cfg.templates.length >= MAX_TEMPLATES ? `Не больше ${MAX_TEMPLATES} шаблонов — удалите ненужный` : undefined}
          onClick={() => setNaming("new")}
          className="text-brand-ink hover:underline disabled:cursor-not-allowed disabled:opacity-50 disabled:no-underline"
        >
          Сохранить как новый…
        </button>
        <button type="button" disabled={busy} onClick={() => setNaming("rename")} className="text-ink-muted hover:text-ink hover:underline">
          Переименовать
        </button>
        {tpl.id !== cfg.main && (
          <button type="button" disabled={busy} onClick={makeMain} className="text-ink-muted hover:text-ink hover:underline">
            Сделать основным
          </button>
        )}
        {cfg.templates.length > 1 && (
          <button type="button" disabled={busy} onClick={() => setDeleting(true)} className="text-state-off hover:underline">
            Удалить
          </button>
        )}
      </div>
      {naming && (
        <NameDialog
          title={naming === "new" ? "Сохранить как новый шаблон" : "Переименовать шаблон"}
          initial={naming === "new" ? "" : tpl.name}
          taken={cfg.templates.filter((t) => naming === "new" || t.id !== tpl.id).map((t) => t.name)}
          hint={
            naming === "new"
              ? `Новый шаблон — с тем, что сейчас на экране: размер, поля, расстановка. «${tpl.name}» останется каким был сохранён.`
              : undefined
          }
          onClose={() => setNaming(null)}
          onDone={(name) => {
            const mode = naming;
            setNaming(null);
            if (mode === "new") saveAsNew(name);
            else rename(name);
          }}
        />
      )}
      {deleting && (
        <Modal title={`Удалить шаблон «${tpl.name}»?`} onClose={() => setDeleting(false)}>
          <p className="text-[14px] text-ink-muted">
            {tpl.id === cfg.main
              ? `Он основной — основным станет «${cfg.templates.find((t) => t.id !== tpl.id)!.name}».`
              : "Остальные шаблоны не изменятся."}
          </p>
          <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="secondary" onClick={() => setDeleting(false)}>
              Отмена
            </Button>
            <Button type="button" variant="danger" onClick={remove}>
              Удалить
            </Button>
          </div>
        </Modal>
      )}
    </section>
  );

  const codeSection = (
        <section>
          <p className="text-[14px] font-semibold">Код</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Pill on={s.code === "code128"} onClick={() => set({ code: "code128" })}>
              Штрихкод
            </Pill>
            <Pill on={s.code === "qr"} onClick={() => set({ code: "qr" })}>
              QR-код
            </Pill>
          </div>
          <p className="mt-1.5 text-[12.5px] text-ink-dim">
            В коде — цифры номера заказа. Сканер в FineCRM сразу открывает заказ. QR-код читают и сканеры, и камера телефона, и
            он помещается на маленькие этикетки.
          </p>
        </section>
  );

  const itemsSection = (
        <section>
          <p className="text-[14px] font-semibold">Своя наклейка на вещи из комплекта</p>
          <p className="mt-0.5 text-[12.5px] text-ink-dim">
            На саму технику наклейка печатается всегда. Отмеченное здесь, если его приняли вместе с техникой, получит свою:
            ноутбук с сумкой и блоком питания — три наклейки, «1/3», «2/3», «3/3».
          </p>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {itemChoices.map((c) => (
              <Pill key={c} on={hasItem(c)} onClick={() => toggleItem(c)}>
                {c}
              </Pill>
            ))}
          </div>
        </section>
  );

  if (customMode && layout) {
    return (
      <div>
        {templatesSection}
        {modeSection}
        <div className="mt-4 grid gap-6 xl:grid-cols-2">
          <div className="min-w-0">
            <p className="mb-3 text-[14px] font-semibold">Макет</p>
            <LabelLayoutEditor
              key={tpl.id}
              settings={s}
              layout={layout}
              data={data}
              overflow={overKinds}
              onChange={(l) => set({ layout: l })}
              onToggleField={(f) => toggleField(f)}
            />
          </div>
          <div className="min-w-0 xl:sticky xl:top-4 xl:self-start">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[14px] font-semibold">Как напечатается</p>
              {sampleTabs}
            </div>
            {preview}
            {warnings}
            {actions}
          </div>
        </div>
        <div className="mt-6 space-y-5">{fieldsSection}</div>
        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          <div className="space-y-5">
            {sizeSection}
            {codeSection}
          </div>
          {itemsSection}
        </div>
      </div>
    );
  }

  return (
    <div>
      {templatesSection}
      {modeSection}
      <div className="mt-4 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,400px)]">
        <div className="min-w-0 space-y-5">
          {sizeSection}
          {codeSection}
          {fieldsSection}
          {itemsSection}
        </div>
        <div className="min-w-0 lg:sticky lg:top-4 lg:self-start">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[14px] font-semibold">Как выглядит</p>
            {sampleTabs}
          </div>
          {preview}
          {warnings}
          {actions}
        </div>
      </div>
    </div>
  );
}

const stripId = (t: LabelTemplate): Omit<LabelSettings, "perItem"> => {
  const { id: _id, name: _name, ...rest } = t;
  return rest;
};

/** Поле размера: набирают как удобно, применяется по уходу из поля или Enter (15–150 мм). */
function SizeInput({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const apply = () => {
    const v = Math.round(Number(text.replace(",", ".")));
    if (Number.isFinite(v) && v > 0) onChange(Math.min(150, Math.max(15, v)));
    else setText(String(value));
  };
  return (
    <span className="block w-[90px]">
      <Input
        aria-label={label}
        inputMode="numeric"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={apply}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        className="text-center tabular-nums"
      />
    </span>
  );
}

function NameDialog({
  title,
  initial,
  taken,
  hint,
  onClose,
  onDone,
}: {
  title: string;
  initial: string;
  taken: string[];
  hint?: string;
  onClose: () => void;
  onDone: (name: string) => void;
}) {
  const [name, setName] = useState(initial);
  const n = name.trim();
  const clash = taken.some((t) => t.toLowerCase() === n.toLowerCase());
  return (
    <Modal title={title} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (n && !clash) onDone(n.slice(0, 40));
        }}
      >
        <label className="block text-[13px] font-semibold text-ink-soft">
          Название
          <Input autoFocus value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="Например: Маленькая на зарядку" className="mt-1.5" />
        </label>
        {clash && <p className="mt-1.5 text-[12.5px] text-state-off">Шаблон с таким названием уже есть.</p>}
        {hint && <p className="mt-2 text-[12.5px] text-ink-dim">{hint}</p>}
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="secondary" onClick={onClose}>
            Отмена
          </Button>
          <Button type="submit" disabled={!n || clash}>
            Сохранить
          </Button>
        </div>
      </form>
    </Modal>
  );
}
