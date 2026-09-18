import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { Banner, Button, Field, Input, SectionLabel, Select } from "./ui";
import { debtApi, type CustomerDebt, type PaidBy } from "../lib/debt";
import { api } from "../lib/api";
import { money } from "../lib/orders";
import { formatDate } from "../lib/format";

/**
 * Задолженность клиента в его анкете.
 *
 * Панель показывается, только когда долг есть. Строка «Задолженность: 0 ₽» в
 * каждой карточке — это шум, который перестают замечать, и вместе с ним
 * перестают замечать непустую.
 *
 * Сумма приходит с сервера уже сложенной: если складывать её здесь, копейки
 * округлятся дважды, итог разойдётся со строками, и объяснять эту копейку
 * клиенту будет приёмщик.
 */

export function DebtPanel({ customerId, onPaid }: { customerId: string; onPaid?: () => void }) {
  const [debt, setDebt] = useState<CustomerDebt | null>(null);
  const [paying, setPaying] = useState(false);

  const load = () =>
    api
      .get<{ debt: CustomerDebt }>(`/customers/${customerId}`)
      .then((d) => setDebt(d.debt))
      .catch(() => setDebt(null));

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);

  if (!debt || debt.total <= 0) return null;

  const overdue = debt.orders.filter((o) => o.overdue).length;

  return (
    <>
      <div className="rounded-card border border-state-waiting/40 bg-state-waiting/[0.07] p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <SectionLabel>Задолженность</SectionLabel>
            <p className="mt-1 text-[22px] font-extrabold leading-none tracking-tight">
              {money(debt.total)}
            </p>
            <p className="mt-1.5 text-[12.5px] text-ink-muted">
              {debt.orders.length === 1
                ? `заказ ${debt.orders[0].number}`
                : `по ${debt.orders.length} заказам`}
              {overdue > 0 && <span className="text-state-off"> · просрочено {overdue}</span>}
            </p>
          </div>
          <Button type="button" onClick={() => setPaying(true)}>
            Погасить
          </Button>
        </div>
      </div>

      {paying && (
        <PayModal
          debt={debt}
          onClose={() => setPaying(false)}
          onDone={async () => {
            setPaying(false);
            await load();
            onPaid?.();
          }}
        />
      )}
    </>
  );
}

/**
 * Погашение.
 *
 * Заказ выбирается руками, а не гасится «с самого старого»: приёмщик обычно
 * знает, за что именно принёс деньги клиент, и молча зачесть их в другой
 * заказ — значит соврать в двух карточках сразу.
 *
 * «Полностью» и «Частично» — две кнопки, а не одна с полем. Полное погашение
 * встречается чаще, и заставлять ради него набирать сумму, которая и так
 * написана выше, незачем. «Частично» же не срабатывает, пока сумма не введена:
 * пустое частичное погашение — это ноль, а ноль в кассе никому не нужен.
 */
function PayModal({
  debt,
  onClose,
  onDone,
}: {
  debt: CustomerDebt;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [orderId, setOrderId] = useState(debt.orders[0]?.orderId ?? "");
  const [method, setMethod] = useState<PaidBy>("CASH");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const chosen = debt.orders.find((o) => o.orderId === orderId) ?? debt.orders[0];
  const part = Number(amount.replace(",", "."));
  const partOk = Number.isFinite(part) && part > 0 && chosen && part <= chosen.due;

  async function pay(full: boolean) {
    if (!chosen) return;
    setBusy(true);
    setError("");
    try {
      await debtApi.pay({
        orderId: chosen.orderId,
        method,
        ...(full ? {} : { amount: part }),
      });
      await onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не получилось провести оплату");
      setBusy(false);
    }
  }

  return (
    <Modal title="Погашение задолженности" onClose={onClose}>
      <div className="space-y-4">
        {error && <Banner tone="error">{error}</Banner>}

        <Field label="По какому заказу">
          <Select value={orderId} onChange={(e) => setOrderId(e.target.value)}>
            {debt.orders.map((o) => (
              <option key={o.orderId} value={o.orderId}>
                {o.number} — {money(o.due)}
                {o.debtDueAt ? ` (обещали до ${formatDate(o.debtDueAt)})` : ""}
              </option>
            ))}
          </Select>
        </Field>

        <div className="rounded-card border border-line bg-surface-raised p-4 text-center">
          <p className="text-[12.5px] uppercase tracking-wide text-ink-muted">Долг по заказу</p>
          <p className="mt-1 text-[26px] font-extrabold leading-none tracking-tight">
            {money(chosen?.due ?? 0)}
          </p>
        </div>

        <Field label="Чем платит">
          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant={method === "CASH" ? "primary" : "secondary"}
              onClick={() => setMethod("CASH")}
            >
              Наличные
            </Button>
            <Button
              type="button"
              variant={method === "CARD" ? "primary" : "secondary"}
              onClick={() => setMethod("CARD")}
            >
              Безнал
            </Button>
          </div>
        </Field>

        <Field
          label="Сумма"
          hint={chosen ? `Не больше долга по заказу — ${money(chosen.due)}` : undefined}
        >
          <Input
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0"
            invalid={amount.trim() !== "" && !partOk}
          />
        </Field>

        <div className="flex flex-col gap-2 sm:flex-row-reverse">
          <Button type="button" disabled={busy} onClick={() => void pay(true)} className="sm:flex-1">
            Полностью
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={busy || !partOk}
            onClick={() => void pay(false)}
            className="sm:flex-1"
          >
            Частично
          </Button>
        </div>

        <p className="text-[12.5px] leading-relaxed text-ink-dim">
          Деньги сразу проводятся приходом в кассу — отдельно проводить их в разделе «Касса» не нужно.
        </p>
      </div>
    </Modal>
  );
}
