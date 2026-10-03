import { useEffect, useState } from "react";
import { ApiError } from "../lib/api";
import { LABEL_FIELDS, LABEL_SIZES, SAMPLE_LABEL, labelsApi, type LabelField, type LabelSettings } from "../lib/labels";
import { printAndWait, type PrintJob, type TargetView } from "../lib/printing";
import { Label, barcodeDots } from "./Label";
import { Banner, Button, Checkbox, Input } from "./ui";

/**
 * Конструктор наклейки: размер, что на ней, на какие вещи — своя.
 * Справа — живой предпросмотр в масштабе, с теми же правилами, что при печати.
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

const sameSettings = (a: LabelSettings, b: LabelSettings) => JSON.stringify(a) === JSON.stringify(b);

export function LabelDesigner({
  initial,
  completeness,
  printer,
  workshop,
  onSaved,
}: {
  initial: LabelSettings;
  /** Пункты комплектности мастерской — из них выбирают, на что своя наклейка. */
  completeness: string[];
  /** Принтер этикеток, на который пойдёт пробная наклейка. */
  printer: TargetView | null;
  workshop: string;
  onSaved: (s: LabelSettings) => void;
}) {
  const [s, setS] = useState<LabelSettings>(initial);
  const [saved, setSaved] = useState<LabelSettings>(initial);
  const [custom, setCustom] = useState(() => !LABEL_SIZES.some(([w, h]) => w === initial.width && h === initial.height));
  const [overflow, setOverflow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [test, setTest] = useState<PrintJob | null>(null);
  const [sample, setSample] = useState<"device" | "accessory">("accessory");

  useEffect(() => {
    setS(initial);
    setSaved(initial);
  }, [initial]);

  const dirty = !sameSettings(s, saved);
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

  const data =
    sample === "accessory"
      ? { ...SAMPLE_LABEL, workshop: workshop || SAMPLE_LABEL.workshop }
      : { ...SAMPLE_LABEL, workshop: workshop || SAMPLE_LABEL.workshop, item: { title: "Ноутбук", index: 1, total: 3, accessory: false } };
  const dots = s.code === "code128" ? barcodeDots(s, SAMPLE_LABEL.code) : 3;
  // Предпросмотр — не шире 360 точек и не выше 300.
  const scale = Math.min(360 / (s.width * PX_PER_MM), 300 / (s.height * PX_PER_MM), 2.4);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await labelsApi.save(s);
      setSaved(s);
      onSaved(s);
      setNotice("Наклейка сохранена");
      setTimeout(() => setNotice(null), 3500);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось сохранить");
    } finally {
      setBusy(false);
    }
  }

  async function printTest() {
    if (!printer) return;
    setError(null);
    setTest(null);
    try {
      if (dirty) await save();
      const job = await printAndWait({ doc: "label-test", stationId: printer.stationId, printer: printer.printer }, setTest);
      setTest(job);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось отправить пробную наклейку");
    }
  }

  return (
    <div className="mt-4 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,400px)]">
      <div className="min-w-0 space-y-5">
        <section>
          <p className="text-[14px] font-semibold">Размер этикетки, мм</p>
          <p className="mt-0.5 text-[12.5px] text-ink-dim">Ширина × высота, как написано на рулоне: ширина — поперёк рулона.</p>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {LABEL_SIZES.map(([w, h]) => (
              <Pill
                key={`${w}x${h}`}
                on={!custom && s.width === w && s.height === h}
                onClick={() => {
                  setCustom(false);
                  set({ width: w, height: h });
                }}
              >
                {w} × {h}
              </Pill>
            ))}
            <Pill on={custom} onClick={() => setCustom(true)}>
              Свой
            </Pill>
          </div>
          {custom && (
            <div className="mt-2.5 flex flex-wrap items-center gap-2 text-[13px] text-ink-muted">
              <Input
                aria-label="Ширина, мм"
                type="number"
                min={15}
                max={150}
                value={s.width}
                onChange={(e) => set({ width: Math.min(150, Math.max(15, Number(e.target.value) || 15)) })}
                className="w-[90px]"
              />
              ×
              <Input
                aria-label="Высота, мм"
                type="number"
                min={15}
                max={150}
                value={s.height}
                onChange={(e) => set({ height: Math.min(150, Math.max(15, Number(e.target.value) || 15)) })}
                className="w-[90px]"
              />
              мм
            </div>
          )}
          <div className="mt-2.5">
            <Checkbox
              checked={s.rotate}
              onChange={(v) => set({ rotate: v })}
              label="Повернуть надписи на 90° — если этикетка выходит из принтера узкой стороной вперёд"
            />
          </div>
        </section>

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

        <section>
          <p className="text-[14px] font-semibold">Что напечатать рядом с кодом</p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {LABEL_FIELDS.map((f) => (
              <Checkbox key={f.id} checked={s.fields[f.id]} onChange={() => toggleField(f.id)} label={f.label} />
            ))}
          </div>
        </section>

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
      </div>

      <div className="min-w-0 lg:sticky lg:top-4 lg:self-start">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[14px] font-semibold">Как выглядит</p>
          <div className="flex gap-1.5">
            <Pill on={sample === "device"} onClick={() => setSample("device")}>
              Техника
            </Pill>
            <Pill on={sample === "accessory"} onClick={() => setSample("accessory")}>
              Из комплекта
            </Pill>
          </div>
        </div>
        <div className="mt-3 flex justify-center rounded-card bg-[#6B7280] p-5">
          <div style={{ width: s.width * PX_PER_MM * scale, height: s.height * PX_PER_MM * scale }}>
            <div style={{ width: `${s.width}mm`, transform: `scale(${scale})`, transformOrigin: "top left" }} className="shadow-[0_4px_16px_rgba(0,0,0,0.35)]">
              <Label settings={s} data={data} onOverflow={setOverflow} />
            </div>
          </div>
        </div>
        <p className="mt-2 text-center text-[12.5px] text-ink-dim">
          {s.width} × {s.height} мм · пример заказа
        </p>

        <div className="mt-3 space-y-2">
          {overflow && (
            <Banner tone="warning">
              Не всё влезает на {s.width} × {s.height} мм — нижние строки обрежутся. Уберите строку или выберите этикетку больше.
            </Banner>
          )}
          {s.code === "code128" && dots < 2 && (
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
      </div>
    </div>
  );
}
