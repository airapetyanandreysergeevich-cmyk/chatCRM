import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError } from "../lib/api";
import { formatDateTime, plural } from "../lib/format";
import { money } from "../lib/orders";
import { PAYMENT_LABEL, salesApi, warrantyLabel, type Sale, type SalesPage } from "../lib/salesApi";
import { Modal } from "./Modal";
import { Banner, Button, SearchInput, Spinner } from "./ui";
import { IconPrint, IconReturn } from "./icons";

/**
 * Журнал продаж со склада: кто, что, за сколько и как платили. Отсюда же —
 * товарный чек ещё раз и возврат продажи целиком.
 */
export function SalesJournal({
  canReturn,
  onClose,
  onChanged,
}: {
  canReturn: boolean;
  onClose: () => void;
  /** Возврат изменил остатки — склад перечитать. */
  onChanged: () => void;
}) {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [data, setData] = useState<SalesPage | null>(null);
  const [rows, setRows] = useState<Sale[]>([]);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [returning, setReturning] = useState<Sale | null>(null);

  const load = useCallback(
    async (p: number, term: string) => {
      try {
        const r = await salesApi.list({ q: term.trim() || undefined, page: p, pageSize: 30 });
        setData(r);
        setRows((cur) => (p === 1 ? r.rows : [...cur, ...r.rows]));
        setError(null);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Не удалось загрузить продажи");
      }
    },
    []
  );

  useEffect(() => {
    const t = setTimeout(() => {
      setPage(1);
      void load(1, q);
    }, 250);
    return () => clearTimeout(t);
  }, [q, load]);

  const replace = (s: Sale) => setRows((rs) => rs.map((r) => (r.id === s.id ? s : r)));

  return (
    <Modal title="Продажи со склада" onClose={onClose} wide>
      <div className="space-y-4" data-sales-journal>
        <SearchInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Номер продажи, товар, артикул или клиент" aria-label="Найти продажу" />
        {error && <Banner tone="error">{error}</Banner>}
        {!data ? (
          <Spinner label="Загружаем продажи" />
        ) : rows.length === 0 ? (
          <p className="rounded-card border border-dashed border-line px-4 py-8 text-center text-[13.5px] text-ink-muted">
            {q.trim() ? "Ничего не нашлось." : "Продаж ещё не было. Продают кнопкой «Продать» на складе."}
          </p>
        ) : (
          <>
            <p className="text-[13px] text-ink-muted">
              {plural(data.total, "продажа", "продажи", "продаж")} · {money(data.sum)} без возвратов
            </p>
            <div className="divide-y divide-line overflow-hidden rounded-card border border-line">
              {rows.map((s) => {
                const isOpen = open === s.id;
                return (
                  <div key={s.id} data-sale-row={s.id} className={s.returnedAt ? "bg-surface-raised/30" : ""}>
                    <button
                      type="button"
                      onClick={() => setOpen(isOpen ? null : s.id)}
                      className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-4 py-3 text-left hover:bg-surface-raised/50 sm:grid-cols-[150px_minmax(0,1fr)_auto]"
                    >
                      <span className="text-[13px]">
                        <span className="block font-mono font-semibold">{s.number}</span>
                        <span className="text-ink-dim">{formatDateTime(s.createdAt)}</span>
                      </span>
                      <span className="order-3 col-span-2 min-w-0 truncate text-[13.5px] text-ink-soft sm:order-none sm:col-span-1">
                        {s.items.map((i) => (i.qty > 1 ? `${i.name} ×${i.qty}` : i.name)).join(", ")}
                        {s.customer && <span className="text-ink-dim"> · {s.customer.name}</span>}
                      </span>
                      <span className="text-right">
                        <b className={"block tabular-nums " + (s.returnedAt ? "text-ink-dim line-through" : "")}>{money(s.total)}</b>
                        <span className={"text-[12px] " + (s.returnedAt ? "font-semibold text-state-off" : "text-ink-dim")}>
                          {s.returnedAt ? "возврат" : PAYMENT_LABEL[s.payment]}
                        </span>
                      </span>
                    </button>
                    {isOpen && (
                      <div className="space-y-3 border-t border-dashed border-line px-4 pb-4 pt-3 text-[13.5px]" data-sale-detail>
                        <table className="w-full">
                          <tbody>
                            {s.items.map((i) => (
                              <tr key={i.id} className="align-top">
                                <td className="py-1 pr-3">
                                  {i.name}
                                  {i.sku && <span className="ml-1.5 font-mono text-[11.5px] text-ink-dim">{i.sku}</span>}
                                </td>
                                <td className="whitespace-nowrap py-1 pr-3 text-right text-ink-muted tabular-nums">
                                  {i.qty} × {money(i.price)}
                                </td>
                                <td className="whitespace-nowrap py-1 text-right font-semibold tabular-nums">{money(i.sum)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        <div className="flex flex-wrap gap-x-5 gap-y-1 text-[12.5px] text-ink-muted">
                          {s.discount > 0 && <span>Скидка {money(s.discount)}</span>}
                          <span>Оплата: {PAYMENT_LABEL[s.payment]}</span>
                          <span>Гарантия: {warrantyLabel(s.warrantyDays ?? 0)}</span>
                          {s.soldBy && <span>Продал: {s.soldBy.fullName}</span>}
                        </div>
                        {s.returnedAt && (
                          <Banner tone="warning">
                            Возвращено {formatDateTime(s.returnedAt)}
                            {s.returnedBy ? `, ${s.returnedBy.fullName}` : ""}
                            {s.returnReason ? `: ${s.returnReason}` : ""}. Товар вернулся на склад, деньги — расходом из кассы.
                          </Banner>
                        )}
                        <div className="flex flex-wrap gap-2">
                          <Button variant="secondary" icon={<IconPrint />} className="min-h-[38px] text-[13px]" onClick={() => navigate(`/sales/${s.id}/print`)}>
                            Товарный чек
                          </Button>
                          {canReturn && !s.returnedAt && (
                            <Button variant="secondary" icon={<IconReturn />} className="min-h-[38px] text-[13px]" onClick={() => setReturning(s)} data-sale-return>
                              Возврат…
                            </Button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {data.page < data.pages && (
              <Button
                variant="secondary"
                className="w-full"
                onClick={() => {
                  const next = page + 1;
                  setPage(next);
                  void load(next, q);
                }}
              >
                Показать ещё
              </Button>
            )}
          </>
        )}
      </div>
      {returning && (
        <ReturnDialog
          sale={returning}
          onClose={() => setReturning(null)}
          onDone={(s) => {
            replace(s);
            setReturning(null);
            onChanged();
          }}
        />
      )}
    </Modal>
  );
}

function ReturnDialog({ sale, onClose, onDone }: { sale: Sale; onClose: () => void; onDone: (s: Sale) => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function go() {
    setBusy(true);
    setError(null);
    try {
      onDone(await salesApi.returnSale(sale.id, reason.trim()));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось оформить возврат");
      setBusy(false);
    }
  }
  return (
    <Modal title={`Возврат ${sale.number}`} onClose={onClose}>
      <div className="space-y-4" data-return-dialog>
        <p className="text-[14px] leading-relaxed text-ink-soft">
          Товар ({plural(sale.items.reduce((n, i) => n + i.qty, 0), "штука", "штуки", "штук")}) вернётся на склад, покупателю — {money(sale.total)} расходом из
          кассы, куда пришла оплата.
        </p>
        <label className="block">
          <span className="mb-1.5 block text-[13px] font-semibold">Причина</span>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={300}
            placeholder="Не подошло, брак, передумал…"
            className="h-11 w-full rounded-field border border-line bg-surface-input px-3 text-[14px] outline-none focus:border-brand"
            data-return-reason
          />
        </label>
        {error && <Banner tone="error">{error}</Banner>}
        <div className="flex flex-col gap-2 sm:flex-row-reverse">
          <Button variant="danger" disabled={busy} onClick={go} className="sm:flex-1" data-return-confirm>
            {busy ? "Оформляем…" : `Вернуть ${money(sale.total)}`}
          </Button>
          <Button variant="secondary" onClick={onClose} className="sm:flex-1">
            Отмена
          </Button>
        </div>
      </div>
    </Modal>
  );
}
