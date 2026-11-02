import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { PayPicker } from "./PayPicker";
import { Banner, Button, Field, Input, Select, Spinner } from "./ui";
import { debtApi, type OrderBalance } from "../lib/debt";
import { money } from "../lib/orders";
import { BUILTIN, usePayMethods, type PayChoice } from "../lib/payMethods";

/**
 * Чем платит клиент, когда забирает технику.
 *
 * Кнопки, а не список: они видны сразу, и приёмщик жмёт одну, не открывая
 * ничего. Сумма к оплате показана крупно над ними — это первое, что у него
 * спросит клиент, и считать её в уме, вычитая предоплату, приёмщик не должен.
 *
 * С 03.11.2026 — свои способы мастерской («Банковский перевод»…), «Кому»
 * у способов с сотрудниками и оплата частями: 3 000 наличными + 2 000
 * переводом; не хватило — остаток в долг.
 *
 * «Задолженность» — это тоже способ закрыть выдачу, а не отказ от неё:
 * техника уезжает, деньги остаются за клиентом. Поэтому дата обещанного
 * платежа спрашивается здесь же и сразу, пока клиент стоит перед вами.
 */

const DAY = 24 * 60 * 60 * 1000;

/** Дата для поля: input[type=date] понимает только «2026-09-21». */
const asInput = (d: Date) => d.toISOString().slice(0, 10);

export interface IssuePayment {
  method: string;
  recipientId?: string | null;
  promisedAt?: string;
  parts?: Array<{ method: string; amount: number; recipientId?: string | null }>;
}

interface PartRow {
  key: number;
  method: string;
  recipientId: string | null;
  amount: string;
}

const num = (s: string) => {
  const v = Number(s.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(v) ? v : 0;
};

export function IssueDialog({
  orderId,
  onClose,
  onIssue,
}: {
  orderId: string;
  onClose: () => void;
  /** Возвращает промис, чтобы окно закрылось только после успешной выдачи. */
  onIssue: (payment: IssuePayment) => Promise<void>;
}) {
  const own = usePayMethods();
  const [balance, setBalance] = useState<OrderBalance | null>(null);
  const [choice, setChoice] = useState<PayChoice | null>(null);
  const [debt, setDebt] = useState(false);
  const [split, setSplit] = useState(false);
  const [parts, setParts] = useState<PartRow[]>([]);
  // По умолчанию неделя: круглый срок, который называют чаще всего.
  const [promised, setPromised] = useState(asInput(new Date(Date.now() + 7 * DAY)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    debtApi
      .balance(orderId)
      .then(setBalance)
      .catch(() => setBalance(null));
  }, [orderId]);

  const due = balance?.due ?? 0;
  // Дату шлём на конец дня: обещание «до 21 сентября» не должно становиться просрочкой в полночь.
  const promisedIso = () => new Date(`${promised}T23:59:59`).toISOString();

  async function issue(p: IssuePayment) {
    setBusy(true);
    setError("");
    try {
      await onIssue(p);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не получилось выдать заказ");
      setBusy(false);
    }
  }

  const methods = [...BUILTIN.map((b) => ({ id: b.id as string, name: b.name, recipients: [] as Array<{ id: string; name: string }> })), ...own];
  const partsSum = Math.round(parts.reduce((s, p) => s + num(p.amount), 0) * 100) / 100;
  const partsLeft = Math.round((due - partsSum) * 100) / 100;
  const startSplit = () => {
    setSplit(true);
    setDebt(false);
    setParts([
      { key: 1, method: "CASH", recipientId: null, amount: "" },
      { key: 2, method: "CARD", recipientId: null, amount: String(due) },
    ]);
  };
  const setPart = (key: number, p: Partial<PartRow>) => setParts((list) => list.map((x) => (x.key === key ? { ...x, ...p } : x)));

  return (
    <Modal title="Выдача клиенту" onClose={onClose}>
      {!balance ? (
        <Spinner label="Считаем остаток" />
      ) : (
        <div className="space-y-4" data-issue-dialog>
          {error && <Banner tone="error">{error}</Banner>}

          <div className="rounded-card border border-line bg-surface-raised p-4 text-center">
            <p className="text-[12.5px] uppercase tracking-wide text-ink-muted">К оплате</p>
            <p className="mt-1 text-[30px] font-extrabold leading-none tracking-tight">{money(due)}</p>
            {balance.paid > 0 && (
              <p className="mt-2 text-[12.5px] text-ink-muted">
                из {money(balance.total)}, уже внесено {money(balance.paid)}
              </p>
            )}
          </div>

          {due <= 0 ? (
            <>
              <Banner>Заказ полностью оплачен — остаётся только отдать технику.</Banner>
              <Button className="w-full" disabled={busy} onClick={() => void issue({ method: "CASH" })}>
                Выдать
              </Button>
            </>
          ) : split ? (
            <div className="space-y-3" data-issue-split>
              <p className="text-[13px] font-semibold text-ink-soft">Оплата частями</p>
              {parts.map((p) => {
                const m = methods.find((x) => x.id === p.method);
                return (
                  <div key={p.key} className="grid grid-cols-[minmax(0,1fr)_110px_auto] items-start gap-2" data-issue-part>
                    <div className="min-w-0 space-y-1.5">
                      <Select value={p.method} onChange={(e) => setPart(p.key, { method: e.target.value, recipientId: null })} aria-label="Способ">
                        {methods.map((x) => (
                          <option key={x.id} value={x.id}>
                            {x.name}
                          </option>
                        ))}
                      </Select>
                      {m && m.recipients.length > 0 && (
                        <Select value={p.recipientId ?? ""} onChange={(e) => setPart(p.key, { recipientId: e.target.value || null })} aria-label="Кому">
                          <option value="">В кассу</option>
                          {m.recipients.map((r) => (
                            <option key={r.id} value={r.id}>
                              💵 {r.name}
                            </option>
                          ))}
                        </Select>
                      )}
                    </div>
                    <Input inputMode="decimal" aria-label="Сумма" placeholder="0" value={p.amount} onChange={(e) => setPart(p.key, { amount: e.target.value })} />
                    <Button
                      variant="ghost"
                      className="min-h-[46px] px-3"
                      disabled={parts.length <= 1}
                      onClick={() => setParts((list) => list.filter((x) => x.key !== p.key))}
                      aria-label="Убрать часть"
                    >
                      ×
                    </Button>
                  </div>
                );
              })}
              {parts.length < 6 && (
                <button
                  type="button"
                  className="text-[13px] font-semibold text-brand-ink hover:underline"
                  onClick={() => setParts((list) => [...list, { key: Date.now(), method: "CASH", recipientId: null, amount: partsLeft > 0 ? String(partsLeft) : "" }])}
                >
                  + Ещё способ
                </button>
              )}
              <p className={"text-[13px] " + (partsLeft < -0.004 ? "text-state-off" : "text-ink-muted")} data-issue-left>
                {partsLeft > 0.004
                  ? `Не хватает ${money(partsLeft)} — останется долгом`
                  : partsLeft < -0.004
                    ? `Больше суммы к оплате на ${money(-partsLeft)}`
                    : "Сумма сходится"}
              </p>
              {partsLeft > 0.004 && (
                <Field label="Когда клиент обещал доплатить">
                  <Input type="date" value={promised} min={asInput(new Date())} onChange={(e) => setPromised(e.target.value)} />
                </Field>
              )}
              <div className="flex flex-col gap-2 sm:flex-row-reverse">
                <Button
                  className="sm:flex-1"
                  disabled={busy || partsSum <= 0 || partsLeft < -0.004}
                  onClick={() =>
                    void issue({
                      method: parts[0].method,
                      parts: parts.filter((p) => num(p.amount) > 0).map((p) => ({ method: p.method, amount: num(p.amount), recipientId: p.recipientId })),
                      ...(partsLeft > 0.004 ? { promisedAt: promisedIso() } : {}),
                    })
                  }
                  data-issue-split-ok
                >
                  Выдать: {money(partsSum)}
                  {partsLeft > 0.004 ? ` + долг ${money(partsLeft)}` : ""}
                </Button>
                <Button variant="ghost" className="sm:flex-1" disabled={busy} onClick={() => setSplit(false)}>
                  Одним способом
                </Button>
              </div>
            </div>
          ) : (
            <>
              <PayPicker
                value={choice}
                onChange={(c) => {
                  setChoice(c);
                  setDebt(false);
                }}
                own={own}
                disabled={busy}
                onCommit={(c) => void issue({ method: c.method, recipientId: c.recipientId })}
              />
              <div className="grid grid-cols-2 gap-2">
                <Button variant="secondary" disabled={busy} onClick={() => (setDebt(!debt), setChoice(null))} data-issue-debt>
                  Задолженность
                </Button>
                <Button variant="secondary" disabled={busy} onClick={startSplit} data-issue-split-open>
                  Частями
                </Button>
              </div>

              {debt && (
                <div className="space-y-3 rounded-card border border-state-waiting/40 bg-state-waiting/[0.07] p-4">
                  <Field label="Когда клиент обещал заплатить" hint="Когда срок пройдёт, долг попадёт на главную">
                    <Input type="date" value={promised} min={asInput(new Date())} autoFocus onChange={(e) => setPromised(e.target.value)} />
                  </Field>
                  <Button className="w-full" disabled={busy || !promised} onClick={() => void issue({ method: "DEBT", promisedAt: promisedIso() })}>
                    Выдать в долг: {money(due)}
                  </Button>
                </div>
              )}

              <p className="text-[12.5px] leading-relaxed text-ink-dim">
                Оплата сразу проводится приходом в кассу — отдельно проводить её в разделе «Касса» не нужно. Свои способы
                оплаты — в «Настройки → Способы оплаты».
              </p>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
