import { ACT_TEXT, BUILTIN, type PayChoice, type PayMethod } from "../lib/payMethods";

/**
 * Чем платит клиент (03.11.2026): «Наличные», «Безнал» и свои способы
 * мастерской. У своего способа со списком сотрудников — «Кому»: в кассу или
 * сотруднику на руки (деньги из кассы сразу уходят ему выплатой, он
 * подтверждает получение 💵).
 *
 * С onCommit — быстрый режим окна выдачи: нажали способ без сотрудников или
 * выбрали «Кому» — сразу проводим. Без него — обычный выбор (продажа, долг).
 */
export function PayPicker({
  value,
  onChange,
  own,
  disabled,
  onCommit,
  columns = 3,
}: {
  value: PayChoice | null;
  onChange: (c: PayChoice) => void;
  own: PayMethod[];
  disabled?: boolean;
  onCommit?: (c: PayChoice) => void;
  columns?: 2 | 3;
}) {
  const all = [...BUILTIN.map((b) => ({ ...b, recipients: [] as PayMethod["recipients"] })), ...own];
  const chosen = value ? all.find((m) => m.id === value.method) : null;
  const pick = (id: string) => {
    const m = all.find((x) => x.id === id);
    const next = { method: id, recipientId: null };
    onChange(next);
    if (onCommit && m && m.recipients.length === 0) onCommit(next);
  };
  const btn = (on: boolean) =>
    "min-h-[46px] rounded-field border px-3 text-[14.5px] font-semibold transition-colors duration-150 disabled:opacity-50 " +
    (on ? "border-brand bg-brand text-white" : "border-line bg-surface-raised text-ink hover:border-line-strong");
  return (
    <div className="space-y-2.5" data-pay-picker>
      <div className={"grid gap-2 " + (columns === 3 ? "grid-cols-2 sm:grid-cols-3" : "grid-cols-2")}>
        {all.map((m) => (
          <button
            key={m.id}
            type="button"
            disabled={disabled}
            onClick={() => pick(m.id)}
            className={btn(value?.method === m.id)}
            data-pay-method={m.id}
            title={`В акте: ${ACT_TEXT[m.actKind]}`}
          >
            {m.name}
          </button>
        ))}
      </div>
      {chosen && chosen.recipients.length > 0 && (
        <div className="rounded-card border border-line bg-surface-raised/60 p-3" data-pay-recipients>
          <p className="mb-2 text-[12.5px] font-semibold text-ink-soft">Кому деньги</p>
          <div className="flex flex-wrap gap-1.5">
            {[{ id: null as string | null, name: "В кассу" }, ...chosen.recipients].map((r) => {
              const on = value?.recipientId === r.id;
              return (
                <button
                  key={r.id ?? "register"}
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    const next = { method: chosen.id, recipientId: r.id };
                    onChange(next);
                    onCommit?.(next);
                  }}
                  className={
                    "rounded-pill border px-3.5 py-1.5 text-[13.5px] font-semibold transition-colors " +
                    (on ? "border-brand bg-brand-tint text-ink" : "border-line text-ink-muted hover:text-ink")
                  }
                  data-pay-recipient={r.id ?? "register"}
                >
                  {r.id ? "💵 " : ""}
                  {r.name}
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-[12px] leading-snug text-ink-dim">
            Сотруднику — деньги приходят в кассу и сразу уходят ему выплатой в зарплату. Он подтвердит получение.
          </p>
        </div>
      )}
      {chosen && (
        <p className="text-[12px] text-ink-dim" data-pay-act>
          В акте: {ACT_TEXT[chosen.actKind]}
        </p>
      )}
    </div>
  );
}
