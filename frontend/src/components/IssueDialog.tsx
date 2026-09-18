import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { Banner, Button, Field, Input, Spinner } from "./ui";
import { debtApi, type OrderBalance, type PaymentMethod } from "../lib/debt";
import { money } from "../lib/orders";

/**
 * Чем платит клиент, когда забирает технику.
 *
 * Три кнопки, а не список: их всего три, они видны сразу, и приёмщик жмёт
 * одну, не открывая ничего. Сумма к оплате показана крупно над ними — это
 * первое, что у него спросит клиент, и считать её в уме, вычитая предоплату,
 * приёмщик не должен.
 *
 * «Задолженность» — это тоже способ закрыть выдачу, а не отказ от неё:
 * техника уезжает, деньги остаются за клиентом. Поэтому дата обещанного
 * платежа спрашивается здесь же и сразу, пока клиент стоит перед вами:
 * позвонить и спросить её завтра будет уже неловко.
 */

const DAY = 24 * 60 * 60 * 1000;

/** Дата для поля: input[type=date] понимает только «2026-09-21». */
const asInput = (d: Date) => d.toISOString().slice(0, 10);

export function IssueDialog({
  orderId,
  onClose,
  onIssue,
}: {
  orderId: string;
  onClose: () => void;
  /** Возвращает промис, чтобы окно закрылось только после успешной выдачи. */
  onIssue: (payment: { method: PaymentMethod; promisedAt?: string }) => Promise<void>;
}) {
  const [balance, setBalance] = useState<OrderBalance | null>(null);
  const [method, setMethod] = useState<PaymentMethod | null>(null);
  // По умолчанию неделя: круглый срок, который называют чаще всего, и его
  // видно сразу — пустое поле даты человек заполняет дольше, чем правит.
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

  async function issue(m: PaymentMethod) {
    setBusy(true);
    setError("");
    try {
      await onIssue({
        method: m,
        // Дату шлём на конец дня: обещание «до 21 сентября» не должно
        // становиться просрочкой в полночь этого же числа.
        ...(m === "DEBT" ? { promisedAt: new Date(`${promised}T23:59:59`).toISOString() } : {}),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не получилось выдать заказ");
      setBusy(false);
    }
  }

  return (
    <Modal title="Выдача клиенту" onClose={onClose}>
      {!balance ? (
        <Spinner label="Считаем остаток" />
      ) : (
        <div className="space-y-4">
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
              <Button className="w-full" disabled={busy} onClick={() => void issue("CASH")}>
                Выдать
              </Button>
            </>
          ) : (
            <>
              <div className="grid gap-2 sm:grid-cols-3">
                <Button disabled={busy} onClick={() => void issue("CASH")}>
                  Наличные
                </Button>
                <Button disabled={busy} onClick={() => void issue("CARD")}>
                  Безнал
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => setMethod(method === "DEBT" ? null : "DEBT")}
                >
                  Задолженность
                </Button>
              </div>

              {method === "DEBT" && (
                <div className="space-y-3 rounded-card border border-state-waiting/40 bg-state-waiting/[0.07] p-4">
                  <Field label="Когда клиент обещал заплатить" hint="Когда срок пройдёт, долг попадёт на главную">
                    <Input
                      type="date"
                      value={promised}
                      min={asInput(new Date())}
                      autoFocus
                      onChange={(e) => setPromised(e.target.value)}
                    />
                  </Field>
                  <Button
                    className="w-full"
                    disabled={busy || !promised}
                    onClick={() => void issue("DEBT")}
                  >
                    Выдать в долг: {money(due)}
                  </Button>
                </div>
              )}

              <p className="text-[12.5px] leading-relaxed text-ink-dim">
                Наличные и безнал сразу проводятся приходом в кассу — отдельно проводить их в разделе
                «Касса» не нужно.
              </p>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
