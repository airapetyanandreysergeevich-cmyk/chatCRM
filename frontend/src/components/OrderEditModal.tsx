import { useEffect, useState, type FormEvent } from "react";
import { ApiError } from "../lib/api";
import { EMPTY_HINTS, hintsApi, matchHints, withBuiltIn, withoutHint, type Hints } from "../lib/hints";
import { ordersApi, type Order, type Reference } from "../lib/orders";
import { ChipInput, Chips, hasPhrase, joinItems, togglePhrase } from "./ChipInput";
import { Modal } from "./Modal";
import { SuggestInput } from "./SuggestInput";
import { Banner, Button, Checkbox, Field, Input, SectionLabel, Select, Textarea } from "./ui";

/**
 * Правка заказа после приёма.
 *
 * Ошибаются у стойки постоянно: перепутали модель, не дописали блок питания,
 * клиент позвонил и уточнил неисправность. Раньше на карточке менялись только
 * мастер и статус, и поправить приёмку было нельзя вовсе — оставалось
 * удалять заказ и принимать заново, теряя номер и историю.
 *
 * На сервер уходят только изменённые поля, и в журнал пишется «было → стало»:
 * если потом спросят, кто переписал жалобу клиента, ответ найдётся.
 *
 * Клиента здесь не меняем: карточка клиента общая для всех его заказов, её
 * правят в разделе «Клиенты».
 */

/** Дата для поля type="date" — по местному времени, как её показывает карточка. */
function dateInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const numText = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v));
const num = (v: string) => (v.trim() === "" ? null : Number(v.replace(",", ".").replace(/\s/g, "")));

export function OrderEditModal({
  order,
  reference,
  onClose,
  onSaved,
}: {
  order: Order;
  reference: Reference;
  onClose: () => void;
  onSaved: () => void;
}) {
  const seesMoney = order.estimatedCost !== undefined;
  const initial = {
    kind: order.kind,
    isUrgent: order.isUrgent,
    dueAt: dateInput(order.dueAt),
    complaint: order.complaint ?? "",
    receptionNote: order.receptionNote ?? "",
    devicePasscode: order.devicePasscode ?? "",
    storageLocation: order.storageLocation ?? "",
    completeness: joinItems(order.completeness ?? []),
    appearance: joinItems(order.appearance ?? []),
    estimatedCost: numText(order.estimatedCost),
    approvedLimit: numText(order.approvedLimit),
  };
  const initialDevice = {
    kind: order.device?.kind ?? "",
    brand: order.device?.brand ?? "",
    model: order.device?.model ?? "",
    serial: order.device?.serial ?? "",
  };

  const [form, setForm] = useState(initial);
  const [device, setDevice] = useState(initialDevice);
  const [hints, setHints] = useState<Hints>(EMPTY_HINTS);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    hintsApi.list().then(setHints).catch(() => {});
  }, []);

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  /** Только то, что правда поменяли: остальное сервер не трогает и в журнал не пишет. */
  function patch(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const text = (k: keyof typeof form) => {
      if (form[k] !== initial[k]) out[k] = String(form[k]).trim();
    };
    if (form.kind !== initial.kind) out.kind = form.kind;
    if (form.isUrgent !== initial.isUrgent) out.isUrgent = form.isUrgent;
    if (form.dueAt !== initial.dueAt) out.dueAt = form.dueAt ? new Date(form.dueAt).toISOString() : null;
    text("complaint");
    text("receptionNote");
    text("devicePasscode");
    text("storageLocation");
    if (form.completeness !== initial.completeness) out.completeness = form.completeness;
    if (form.appearance !== initial.appearance) out.appearance = form.appearance;
    if (seesMoney && form.estimatedCost !== initial.estimatedCost) out.estimatedCost = num(form.estimatedCost);
    if (form.approvedLimit !== initial.approvedLimit) out.approvedLimit = num(form.approvedLimit);

    const dev: Record<string, string> = {};
    for (const k of ["kind", "brand", "model", "serial"] as const) {
      if (device[k] !== initialDevice[k]) dev[k] = device[k].trim();
    }
    if (Object.keys(dev).length) out.device = dev;
    return out;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const body = patch();
    if (!Object.keys(body).length) return onClose();
    for (const k of ["estimatedCost", "approvedLimit"]) {
      if (typeof body[k] === "number" && Number.isNaN(body[k])) {
        setError(new ApiError(400, "Сумму укажите числом, например 3500"));
        return;
      }
    }
    setBusy(true);
    setError(null);
    try {
      await ordersApi.update(order.id, body);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "Сервер недоступен"));
    } finally {
      setBusy(false);
    }
  }

  const fieldError = (path: string) => error?.field(path);
  const forget = (hint: { id: string }) => {
    setHints((h) => withoutHint(h, hint.id));
    hintsApi.remove(hint.id).catch(() => {});
  };

  return (
    <Modal title={`Изменить заказ ${order.number}`} onClose={onClose} wide>
      <form onSubmit={submit} className="space-y-6">
        {error && <Banner tone="error">{error.message}</Banner>}

        <section className="space-y-4">
          <SectionLabel>Техника</SectionLabel>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Тип" error={fieldError("device.kind")} interactive>
              <SuggestInput
                value={device.kind}
                onChange={(kind) => setDevice({ ...device, kind })}
                items={matchHints(withBuiltIn(hints.kind, reference.deviceKinds), device.kind)}
                onForget={forget}
              />
            </Field>
            <Field label="Бренд" interactive>
              <SuggestInput
                value={device.brand}
                onChange={(brand) => setDevice({ ...device, brand })}
                items={matchHints(hints.brand, device.brand)}
                onForget={forget}
              />
            </Field>
            <Field label="Модель" interactive>
              <SuggestInput
                value={device.model}
                onChange={(model) => setDevice({ ...device, model })}
                items={matchHints(hints.model, device.model, device.brand)}
                onForget={forget}
              />
            </Field>
            <Field label="Серийный номер">
              <Input value={device.serial} onChange={(e) => setDevice({ ...device, serial: e.target.value })} />
            </Field>
            <Field label="Пароль, PIN или графический ключ">
              <Input value={form.devicePasscode} onChange={(e) => set("devicePasscode", e.target.value)} />
            </Field>
            <Field label="Место хранения">
              <Input value={form.storageLocation} onChange={(e) => set("storageLocation", e.target.value)} />
            </Field>
          </div>
        </section>

        <section className="space-y-4">
          <SectionLabel>Заявка</SectionLabel>
          <div>
            <span className="mb-1.5 block text-[13px] font-semibold text-ink-soft">Неисправность со слов клиента</span>
            <Textarea
              aria-label="Неисправность со слов клиента"
              value={form.complaint}
              onChange={(e) => set("complaint", e.target.value)}
              invalid={!!fieldError("complaint")}
            />
            <Chips
              value={form.complaint}
              onChange={(complaint) => set("complaint", complaint)}
              options={reference.complaint}
              has={hasPhrase}
              toggle={togglePhrase}
            />
            {fieldError("complaint") && (
              <span className="mt-1.5 block text-[12.5px] text-state-off">{fieldError("complaint")}</span>
            )}
          </div>
          <Field label="Примечания приёмщика">
            <Textarea value={form.receptionNote} onChange={(e) => set("receptionNote", e.target.value)} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Тип обращения">
              <Select value={form.kind} onChange={(e) => set("kind", e.target.value as Order["kind"])}>
                {reference.orderKinds.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Срок готовности">
              <Input type="date" value={form.dueAt} onChange={(e) => set("dueAt", e.target.value)} />
            </Field>
            <div className="flex items-end">
              <Checkbox label="Срочный заказ" checked={form.isUrgent} onChange={(v) => set("isUrgent", v)} />
            </div>
          </div>
        </section>

        <section className="grid gap-5 sm:grid-cols-2">
          <div className="space-y-3">
            <SectionLabel>Комплектность</SectionLabel>
            <ChipInput
              value={form.completeness}
              onChange={(v) => set("completeness", v)}
              options={reference.completeness}
            />
          </div>
          <div className="space-y-3">
            <SectionLabel>Внешнее состояние</SectionLabel>
            <ChipInput value={form.appearance} onChange={(v) => set("appearance", v)} options={reference.appearance} />
          </div>
        </section>

        <section className="grid gap-4 sm:grid-cols-2">
          {seesMoney && (
            <Field label="Предварительная стоимость, ₽" error={fieldError("estimatedCost")}>
              <Input
                inputMode="decimal"
                value={form.estimatedCost}
                onChange={(e) => set("estimatedCost", e.target.value)}
              />
            </Field>
          )}
          <Field
            label="Клиент согласовал до, ₽"
            hint="Пусто — без ограничения"
            error={fieldError("approvedLimit")}
          >
            <Input inputMode="decimal" value={form.approvedLimit} onChange={(e) => set("approvedLimit", e.target.value)} />
          </Field>
        </section>

        <p className="text-[12.5px] text-ink-dim">
          Контакты клиента меняются в разделе «Клиенты»: карточка клиента общая для всех его заказов.
        </p>

        <div className="flex flex-col gap-2 sm:flex-row-reverse">
          <Button type="submit" disabled={busy} className="sm:min-w-[200px]">
            {busy ? "Сохраняем…" : "Сохранить"}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose}>
            Отмена
          </Button>
        </div>
      </form>
    </Modal>
  );
}
