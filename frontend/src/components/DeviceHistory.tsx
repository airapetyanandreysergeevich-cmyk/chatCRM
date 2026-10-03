import { useEffect, useState } from "react";
import { formatDate } from "../lib/format";
import { ordersApi, type HistoryRow } from "../lib/orders";
import { OrderPeek } from "./OrderPeek";

/**
 * «История этой техники» в карточке заказа: прошлые и другие заказы той же
 * вещи — по карточке устройства и по серийному номеру. Нажатие открывает
 * заказ окном поверх, текущий ремонт остаётся на месте.
 *
 * Нет истории — карточки нет вовсе: пустой блок на каждом первом заказе
 * только отвлекал бы.
 */

export const OUTCOME_LABEL: Record<HistoryRow["outcome"], { label: string; cls: string }> = {
  ok: { label: "отремонтирован", cls: "text-state-done" },
  no: { label: "без ремонта", cls: "text-state-off" },
  work: { label: "в работе", cls: "text-brand-ink" },
};

export const deviceName = (d: HistoryRow["device"]) =>
  [d?.kind, d?.brand, d?.model].filter((x) => x && x.trim()).join(" ") || "Техника не указана";

export function DeviceHistory({ orderId }: { orderId: string }) {
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [peek, setPeek] = useState<string | null>(null);

  useEffect(() => {
    setRows(null);
    ordersApi
      .deviceHistory(orderId)
      .then((r) => setRows(r.items))
      .catch(() => setRows([]));
  }, [orderId]);

  if (!rows || rows.length === 0) return null;

  return (
    <section className="min-w-0 rounded-panel border border-line bg-surface p-4 shadow-card sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[15px] font-bold">История этой техники</h2>
        <span className="text-[12.5px] text-ink-dim">
          {rows.length === 1 ? "ещё 1 заказ" : `ещё ${rows.length} ${rows.length < 5 ? "заказа" : "заказов"}`} · нажмите, чтобы
          посмотреть
        </span>
      </div>
      <ul className="mt-3 divide-y divide-line">
        {rows.map((r) => {
          const o = OUTCOME_LABEL[r.outcome];
          return (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => setPeek(r.id)}
                className="flex w-full flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded-field px-2 py-2.5 text-left transition-colors duration-150 hover:bg-surface-raised"
              >
                <span className="font-mono text-[13.5px] font-semibold text-brand-ink">{r.number}</span>
                <span className="text-[13px] text-ink-dim">{formatDate(r.acceptedAt)}</span>
                <span className={"text-[13px] font-semibold " + o.cls}>{o.label}</span>
                {r.otherCustomer && (
                  <span className="rounded-pill bg-state-waiting/15 px-2 py-0.5 text-[11.5px] font-bold text-state-waiting">у другого клиента</span>
                )}
                {!r.sameDevice && !r.otherCustomer && (
                  <span className="text-[12px] text-ink-dim">тот же серийный номер</span>
                )}
                <span className="line-clamp-2 w-full min-w-0 break-words text-[13.5px] text-ink-soft">
                  {r.complaint || "—"}
                  {r.diagnosis && <span className="text-ink-dim"> → {r.diagnosis}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {peek && <OrderPeek orderId={peek} onClose={() => setPeek(null)} />}
    </section>
  );
}
