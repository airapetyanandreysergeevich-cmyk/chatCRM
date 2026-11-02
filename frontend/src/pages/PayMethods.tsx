import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Modal } from "../components/Modal";
import { Banner, Button, Card, Checkbox, Field, Input, PageHeader, Select, Spinner } from "../components/ui";
import { ApiError } from "../lib/api";
import { ACT_TEXT, dropPayMethodsCache, payMethodsApi, type ActKind, type PayMethod, type PayMethodInput } from "../lib/payMethods";

/**
 * «Настройки → Способы оплаты» (03.11.2026).
 *
 * Наличные и безнал есть всегда. Свои способы — «Банковский перевод»,
 * «Криптовалюта» — появляются кнопками в окне выдачи, при погашении долга и
 * в продаже. У своего способа:
 *  — как он выглядит в акте: наличный или безналичный расчёт;
 *  — касса, куда идут деньги;
 *  — комиссия, % (эквайринг, обменник) — расходом в ту же кассу;
 *  — кто может принять деньги на себя: деньги сразу уходят сотруднику
 *    выплатой в зарплату, он подтверждает получение (💵 в шапке).
 */

type Data = Awaited<ReturnType<typeof payMethodsApi.manage>>;

const empty: PayMethodInput = { name: "", actKind: "CARD", cashRegisterId: null, commissionPct: null, recipientIds: [] };

export default function PayMethodsPage() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; form: PayMethodInput } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    payMethodsApi
      .manage()
      .then(setData)
      .catch((e) => setError(e instanceof ApiError ? e.message : "Не удалось загрузить способы оплаты"));
  useEffect(() => {
    void load();
  }, []);

  if (!data) return error ? <Banner tone="error">{error}</Banner> : <Spinner label="Открываем способы оплаты" />;
  const active = data.items.filter((m) => m.isActive);
  const off = data.items.filter((m) => !m.isActive);

  async function act(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      dropPayMethodsCache();
      await load();
      setNotice(done);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Не получилось");
    } finally {
      setBusy(false);
    }
  }

  const move = (id: string, d: -1 | 1) => {
    const ids = active.map((m) => m.id);
    const i = ids.indexOf(id);
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    void act(() => payMethodsApi.reorder(ids), "Порядок кнопок сохранён");
  };

  const formOf = (m: PayMethod): PayMethodInput => ({
    name: m.name,
    actKind: m.actKind,
    cashRegisterId: m.cashRegisterId,
    commissionPct: m.commissionPct,
    recipientIds: m.recipients.map((r) => r.id),
  });

  return (
    <div className="space-y-5">
      <Link to="/settings" className="text-[13.5px] font-semibold text-ink-muted hover:text-ink">
        ‹ Настройки
      </Link>
      <PageHeader
        eyebrow="Настройки"
        title="Способы оплаты"
        subtitle="Свои способы появляются кнопками при выдаче заказа, погашении долга и в продаже со склада."
        actions={
          data.canManage ? (
            <Button onClick={() => setEditing({ id: null, form: { ...empty } })} data-pay-method-new>
              + Новый способ
            </Button>
          ) : undefined
        }
      />
      {!data.canManage && <Banner>Способы оплаты настраивает владелец или тот, кто ведёт кассу.</Banner>}
      {error && <Banner tone="error">{error}</Banner>}
      {notice && <Banner>{notice}</Banner>}

      <div className="space-y-2.5">
        {[
          { name: "Наличные", act: "CASH" as ActKind, text: "В наличную кассу" },
          { name: "Безнал", act: "CARD" as ActKind, text: "Карта — в эквайринговую кассу" },
        ].map((b) => (
          <Card key={b.name} className="p-4">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <p className="text-[15px] font-bold">{b.name}</p>
              <span className="text-[12.5px] text-ink-dim">
                всегда · {b.text} · в акте: {ACT_TEXT[b.act]}
              </span>
            </div>
          </Card>
        ))}
        {active.map((m, i) => (
          <Card key={m.id} className="p-4">
            <div className="flex flex-wrap items-start gap-3" data-pay-method-row={m.name}>
              <div className="min-w-0 flex-1">
                <p className="text-[15px] font-bold">{m.name}</p>
                <p className="mt-0.5 text-[12.5px] leading-snug text-ink-muted">
                  в акте: {ACT_TEXT[m.actKind]} · касса: {m.register ?? "по умолчанию"}
                  {m.commissionPct ? ` · комиссия ${String(m.commissionPct).replace(".", ",")}%` : ""}
                </p>
                {m.recipients.length > 0 && (
                  <p className="mt-1 text-[12.5px] text-ink-soft" data-pay-method-recipients>
                    💵 Принимают на себя: {m.recipients.map((r) => r.name).join(", ")}
                  </p>
                )}
              </div>
              {data.canManage && (
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button variant="ghost" className="min-h-[38px] px-2.5" disabled={busy || i === 0} onClick={() => move(m.id, -1)} aria-label="Выше">
                    ↑
                  </Button>
                  <Button variant="ghost" className="min-h-[38px] px-2.5" disabled={busy || i === active.length - 1} onClick={() => move(m.id, 1)} aria-label="Ниже">
                    ↓
                  </Button>
                  <Button variant="secondary" className="min-h-[38px]" disabled={busy} onClick={() => setEditing({ id: m.id, form: formOf(m) })}>
                    Изменить
                  </Button>
                </div>
              )}
            </div>
          </Card>
        ))}
        {active.length === 0 && (
          <p className="px-1 text-[13.5px] text-ink-dim">
            Своих способов пока нет. Например: «Банковский перевод» (в акте — безналичный расчёт) с сотрудниками, которым
            клиент переводит на карту.
          </p>
        )}
        {off.length > 0 && (
          <div className="pt-2">
            <p className="mb-1.5 px-1 text-[12px] font-bold uppercase tracking-[0.1em] text-ink-dim">Выключены</p>
            {off.map((m) => (
              <div key={m.id} className="flex items-center gap-3 rounded-field px-1 py-1.5 text-[13.5px] text-ink-muted">
                <span className="flex-1">{m.name}</span>
                {data.canManage && (
                  <Button variant="ghost" className="min-h-[34px]" disabled={busy} onClick={() => void act(() => payMethodsApi.update(m.id, { isActive: true }), `«${m.name}» снова включён`)}>
                    Включить
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {editing && (
        <EditModal
          data={data}
          id={editing.id}
          initial={editing.form}
          busy={busy}
          onClose={() => setEditing(null)}
          onSave={(form) =>
            void act(async () => {
              if (editing.id) await payMethodsApi.update(editing.id, form);
              else await payMethodsApi.create(form);
              setEditing(null);
            }, editing.id ? "Способ оплаты сохранён" : `Способ «${form.name}» добавлен — он уже есть в окне выдачи и в продаже`)
          }
          onDisable={
            editing.id
              ? () =>
                  void act(async () => {
                    await payMethodsApi.update(editing.id!, { isActive: false });
                    setEditing(null);
                  }, "Способ выключен — в старых оплатах он остаётся")
              : undefined
          }
        />
      )}
    </div>
  );
}

function EditModal({
  data,
  id,
  initial,
  busy,
  onClose,
  onSave,
  onDisable,
}: {
  data: Data;
  id: string | null;
  initial: PayMethodInput;
  busy: boolean;
  onClose: () => void;
  onSave: (f: PayMethodInput) => void;
  onDisable?: () => void;
}) {
  const [f, setF] = useState(initial);
  const [fee, setFee] = useState(initial.commissionPct ? String(initial.commissionPct).replace(".", ",") : "");
  const feeNum = fee.trim() ? Number(fee.replace(",", ".")) : null;
  const feeOk = feeNum === null || (Number.isFinite(feeNum) && feeNum >= 0 && feeNum <= 50);
  const toggle = (uid: string) =>
    setF((x) => ({ ...x, recipientIds: x.recipientIds.includes(uid) ? x.recipientIds.filter((y) => y !== uid) : [...x.recipientIds, uid] }));
  return (
    <Modal title={id ? "Способ оплаты" : "Новый способ оплаты"} onClose={onClose}>
      <div className="space-y-4" data-pay-method-form>
        <Field label="Название">
          <Input value={f.name} maxLength={40} autoFocus placeholder="Банковский перевод" onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <div>
          <p className="mb-1.5 text-[13px] font-semibold text-ink-soft">Как в акте</p>
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Как в акте">
            {(["CARD", "CASH"] as ActKind[]).map((k) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={f.actKind === k}
                onClick={() => setF({ ...f, actKind: k })}
                data-pay-act={k}
                className={
                  "min-h-[46px] rounded-field border px-3 text-[14px] font-semibold " +
                  (f.actKind === k ? "border-brand bg-brand-tint text-ink" : "border-line text-ink-muted hover:text-ink")
                }
              >
                {k === "CARD" ? "Безналичный расчёт" : "Наличный расчёт"}
              </button>
            ))}
          </div>
        </div>
        <Field label="Касса" hint="Куда приходят деньги этим способом">
          <Select value={f.cashRegisterId ?? ""} onChange={(e) => setF({ ...f, cashRegisterId: e.target.value || null })}>
            <option value="">По умолчанию — {f.actKind === "CASH" ? "наличная касса" : "эквайринговая касса"}</option>
            {data.registers.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Комиссия, %" hint="Эквайринг, обменник: расход «Комиссия за приём оплаты» в ту же кассу. Пусто — без комиссии." error={feeOk ? undefined : "От 0 до 50"}>
          <Input inputMode="decimal" value={fee} placeholder="0" onChange={(e) => setFee(e.target.value)} invalid={!feeOk} />
        </Field>
        <div>
          <p className="text-[13px] font-semibold text-ink-soft">Кто может принять деньги на себя</p>
          <p className="mt-0.5 text-[12.5px] leading-snug text-ink-dim">
            Клиент переводит сотруднику на карту — при оплате выбирают его. Деньги приходят в кассу и сразу уходят ему
            выплатой в зарплату; он подтверждает получение (💵 в шапке, push на телефон).
          </p>
          <div className="mt-2 grid gap-1.5 sm:grid-cols-2" data-pay-method-staff>
            {data.staff.map((u) => (
              <Checkbox key={u.id} checked={f.recipientIds.includes(u.id)} onChange={() => toggle(u.id)} label={u.name} />
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row-reverse">
          <Button
            className="sm:flex-1"
            disabled={busy || f.name.trim().length < 2 || !feeOk}
            onClick={() => onSave({ ...f, name: f.name.trim(), commissionPct: feeNum })}
            data-pay-method-save
          >
            {busy ? "Сохраняем…" : "Сохранить"}
          </Button>
          {onDisable && (
            <Button variant="ghost" className="sm:flex-1" disabled={busy} onClick={onDisable}>
              Выключить
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
