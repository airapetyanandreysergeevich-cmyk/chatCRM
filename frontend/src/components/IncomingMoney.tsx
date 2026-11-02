import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { money } from "../lib/orders";
import { incomingApi, type IncomingPayment } from "../lib/payMethods";
import { announceUnreadChanged, onUnreadChanged } from "../lib/unread";
import { Modal } from "./Modal";
import { Banner, Button } from "./ui";

/**
 * 💵 в шапке (03.11.2026): деньги клиентов, принятые на сотрудника, — пока он
 * не подтвердит. Нажал — окно «Зачислено на ваш счёт»: сумма, способ, заказ,
 * кто выдал клиенту, и «Принять» / «Не получал». Ответ уходит тому, кто
 * принимал оплату (push), колокольчик гаснет.
 */

export function useIncoming(enabled: boolean) {
  const [items, setItems] = useState<IncomingPayment[]>([]);
  const reload = useCallback(() => {
    if (!enabled) return;
    incomingApi
      .list()
      .then((r) => setItems(r.items))
      .catch(() => undefined);
  }, [enabled]);
  useEffect(() => {
    if (!enabled) return;
    reload();
    const t = setInterval(reload, 60_000);
    // Пришло оповещение (колокольчик перечитался) — и деньги заодно.
    const off = onUnreadChanged(reload);
    return () => {
      clearInterval(t);
      off();
    };
  }, [enabled, reload]);
  return { items, reload };
}

/** Купюры с числом — только когда есть что подтверждать. */
export function MoneyButton({ count, onOpen, size = "md" }: { count: number; onOpen: () => void; size?: "sm" | "md" }) {
  if (!count) return null;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Деньги на подтверждение: ${count}`}
      title="Зачислено на ваш счёт — подтвердите"
      className={
        "relative flex shrink-0 items-center justify-center rounded-field text-state-done transition-colors duration-150 hover:bg-surface-raised " +
        (size === "sm" ? "h-9 w-8" : "h-9 w-9")
      }
      data-money-button
    >
      <IconBills />
      <span className="absolute -right-1 -top-1 flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-state-done px-1 text-[10.5px] font-bold text-white">
        {count}
      </span>
    </button>
  );
}

function IconBills() {
  return (
    <svg viewBox="0 0 24 24" className="h-[19px] w-[19px]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden>
      <rect x="2.5" y="7" width="15" height="10" rx="1.5" />
      <path d="M6.5 4.5h13a2 2 0 0 1 2 2v8.5" />
      <circle cx="10" cy="12" r="2.2" />
    </svg>
  );
}

export function IncomingDialog({ items, onClose, onChanged }: { items: IncomingPayment[]; onClose: () => void; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function answer(p: IncomingPayment, ok: boolean) {
    setBusy(p.id);
    setError(null);
    try {
      if (ok) await incomingApi.confirm(p.id);
      else await incomingApi.dispute(p.id);
      setDone(ok ? `Принято: ${money(p.amount)}${p.takenBy ? ` — ${p.takenBy} получит подтверждение` : ""}` : "Отмечено «Не получал» — владелец разберётся");
      setAsking(null);
      announceUnreadChanged();
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Не получилось — проверьте связь");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal title="Зачислено на ваш счёт" onClose={onClose}>
      <div className="space-y-3" data-incoming-dialog>
        {error && <Banner tone="error">{error}</Banner>}
        {done && <Banner>{done}</Banner>}
        {items.length === 0 && <p className="text-[14px] text-ink-muted">Всё подтверждено.</p>}
        {items.map((p) => (
          <div key={p.id} className="rounded-card border border-line bg-surface-raised p-4" data-incoming={p.id}>
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-[24px] font-extrabold tracking-tight">{money(p.amount)}</p>
              <p className="text-[12.5px] text-ink-dim">{formatDateTime(p.at)}</p>
            </div>
            <p className="mt-1 text-[14px] leading-snug">
              {p.method ?? "Оплата"}
              {p.order ? (
                <>
                  {" · оплата за заказ "}
                  <Link to={`/orders/${p.order.id}`} onClick={onClose} className="font-mono font-semibold text-brand-ink hover:underline">
                    {p.order.number}
                  </Link>
                  {p.order.device ? ` (${p.order.device})` : ""}
                </>
              ) : p.sale ? (
                " · продажа со склада"
              ) : null}
            </p>
            {p.order?.customer && <p className="text-[13px] text-ink-muted">Клиент: {p.order.customer}</p>}
            <p className="mt-0.5 text-[13px] text-ink-muted" data-incoming-taker>
              {p.order ? "Выдал(а) клиенту" : "Принял(а) оплату"}: <b className="text-ink">{p.takenBy ?? "—"}</b>
            </p>
            {asking === p.id ? (
              <div className="mt-3 space-y-2 rounded-field border border-state-off/40 bg-state-off/[0.06] p-3">
                <p className="text-[13px]">Точно не получали? {p.takenBy ?? "Тот, кто принял оплату"} и владелец получат оповещение, а в зарплате сумма не будет считаться полученной.</p>
                <div className="flex gap-2">
                  <Button variant="secondary" className="flex-1" disabled={!!busy} onClick={() => void answer(p, false)} data-incoming-dispute-yes>
                    Да, не получал
                  </Button>
                  <Button variant="ghost" className="flex-1" disabled={!!busy} onClick={() => setAsking(null)}>
                    Отмена
                  </Button>
                </div>
              </div>
            ) : (
              <div className="mt-3 flex gap-2">
                <Button variant="ghost" className="flex-1" disabled={!!busy} onClick={() => setAsking(p.id)} data-incoming-dispute>
                  Не получал
                </Button>
                <Button className="flex-[2]" disabled={!!busy} onClick={() => void answer(p, true)} data-incoming-accept>
                  {busy === p.id ? "Сохраняем…" : "Принять"}
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>
    </Modal>
  );
}
