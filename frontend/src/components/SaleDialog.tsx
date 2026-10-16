import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ApiError } from "../lib/api";
import { money, ordersApi, type CustomerHit } from "../lib/orders";
import {
  PAYMENT_LABEL,
  WARRANTY_CHOICES,
  rememberWarranty,
  rememberedWarranty,
  salesApi,
  warrantyLabel,
  type Sale,
  type SalePayment,
} from "../lib/salesApi";
import { stockApi, type StockItem } from "../lib/workshop";
import { Modal } from "./Modal";
import { Banner, Button, SearchInput, Select } from "./ui";
import { IconCard, IconCart, IconCash, IconClose, IconPerson, IconPrint, IconTransfer } from "./icons";

/**
 * Окно продажи со склада — «чек поверх склада» (вариант Б, выбран Андреем
 * 16.10.2026).
 *
 * Слева чек: поиск по складу сверху (название, артикул, сканер штрихкода),
 * строки с количеством и ценой. Справа итог, клиент, оплата, гарантия и две
 * кнопки. Продать то, чего нет на складе, нельзя — такие товары в поиске
 * видны, но не добавляются: в минус склад не уходит.
 */

type Line = { item: StockItem; qty: number; price: string };

const cx = (...p: Array<string | false | null | undefined>) => p.filter(Boolean).join(" ");
const toNum = (s: string) => {
  const v = Number(String(s).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(v) ? v : NaN;
};
const r2 = (v: number) => Math.round(v * 100) / 100;

const PAY: Array<{ v: SalePayment; icon: ReactNode }> = [
  { v: "CASH", icon: <IconCash /> },
  { v: "CARD", icon: <IconCard /> },
  { v: "TRANSFER", icon: <IconTransfer /> },
];

export function SaleDialog({
  initial = [],
  canPickCustomer,
  onClose,
  onSold,
}: {
  /** Что уже в чеке при открытии: «Продать» из меню позиции или выбранное на складе. */
  initial?: StockItem[];
  /** Выбор клиента — тем, кто видит клиентов. */
  canPickCustomer: boolean;
  onClose: () => void;
  onSold: (sale: Sale, print: boolean) => void;
}) {
  const [lines, setLines] = useState<Line[]>(() =>
    initial.filter((i) => i.qty > 0).map((item) => ({ item, qty: 1, price: item.salePrice ? String(item.salePrice) : "" }))
  );
  const [q, setQ] = useState("");
  const [found, setFound] = useState<StockItem[] | null>(null);
  const [hl, setHl] = useState(0);
  const [discount, setDiscount] = useState("");
  const [payment, setPayment] = useState<SalePayment>("CASH");
  const [warranty, setWarranty] = useState<number>(() => rememberedWarranty());
  const [customer, setCustomer] = useState<CustomerHit | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState<false | "sell" | "print">(false);
  const [error, setError] = useState<string | null>(null);
  const searchRef = useRef<HTMLDivElement>(null);
  const skipped = initial.filter((i) => i.qty <= 0);

  // Поиск по складу: по набранному, с паузой — сканер штрихкода печатает быстрее человека.
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setFound(null);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      stockApi
        .list({ search: term, page: 1 })
        .then((r) => {
          if (!alive) return;
          setFound(r.items.slice(0, 8));
          setHl(Math.max(0, r.items.slice(0, 8).findIndex((i) => i.qty > 0)));
        })
        .catch(() => alive && setFound([]));
    }, 220);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q]);

  const inCart = (id: string) => lines.find((l) => l.item.id === id)?.qty ?? 0;

  function add(item: StockItem) {
    if (item.qty <= 0) return;
    setError(null);
    setLines((ls) => {
      const at = ls.findIndex((l) => l.item.id === item.id);
      if (at < 0) return [...ls, { item, qty: 1, price: item.salePrice ? String(item.salePrice) : "" }];
      return ls.map((l, i) => (i === at ? { ...l, qty: Math.min(l.item.qty, l.qty + 1) } : l));
    });
    setQ("");
    setFound(null);
  }

  const setQty = (id: string, qty: number) =>
    setLines((ls) => ls.map((l) => (l.item.id === id ? { ...l, qty: Math.max(1, Math.min(l.item.qty, qty)) } : l)));
  const setPrice = (id: string, price: string) => setLines((ls) => ls.map((l) => (l.item.id === id ? { ...l, price } : l)));
  const remove = (id: string) => setLines((ls) => ls.filter((l) => l.item.id !== id));

  const subtotal = useMemo(() => r2(lines.reduce((s, l) => s + l.qty * (toNum(l.price) || 0), 0)), [lines]);
  // Скидка рублями или процентом: «300» или «10%».
  const discountValue = useMemo(() => {
    const t = discount.trim();
    if (!t) return 0;
    if (t.endsWith("%")) {
      const p = toNum(t.slice(0, -1));
      return Number.isFinite(p) && p >= 0 ? r2((subtotal * Math.min(p, 100)) / 100) : NaN;
    }
    return toNum(t);
  }, [discount, subtotal]);
  const total = r2(subtotal - (Number.isFinite(discountValue) ? discountValue : 0));
  const noPrice = lines.filter((l) => !(toNum(l.price) >= 0) || l.price.trim() === "");
  const units = lines.reduce((s, l) => s + l.qty, 0);

  async function sell(print: boolean) {
    setError(null);
    if (!lines.length) return setError("Добавьте в чек хотя бы один товар");
    if (noPrice.length) return setError(`Укажите цену: «${noPrice[0].item.name}»`);
    if (!Number.isFinite(discountValue) || discountValue < 0) return setError("Скидка — число рублей или процент, например 300 или 10%");
    if (discountValue > subtotal) return setError("Скидка больше суммы чека");
    setBusy(print ? "print" : "sell");
    try {
      const sale = await salesApi.create({
        items: lines.map((l) => ({ stockItemId: l.item.id, qty: l.qty, price: r2(toNum(l.price)) })),
        discount: discountValue,
        payment,
        customerId: customer?.id ?? null,
        warrantyDays: warranty || null,
      });
      rememberWarranty(warranty);
      onSold(sale, print);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось провести продажу — проверьте связь и попробуйте ещё раз");
      setBusy(false);
    }
  }

  function onSearchKey(e: KeyboardEvent<HTMLInputElement>) {
    if (!found?.length) {
      if (e.key === "Enter") e.preventDefault();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHl((h) => Math.min(found.length - 1, h + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHl((h) => Math.max(0, h - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      // Сканер штрихкода: точное совпадение артикула — сразу в чек.
      const exact = found.find((i) => i.sku && i.sku.toLowerCase() === q.trim().toLowerCase());
      const pick = exact ?? found[hl];
      if (pick) add(pick);
    }
  }

  return (
    <Modal title="Продажа" onClose={onClose} wide="xl">
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]" data-sale-dialog>
        {/* ----- чек ----- */}
        <div className="min-w-0">
          <div className="relative" ref={searchRef}>
            <SearchInput
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={onSearchKey}
              placeholder="Название, артикул или штрихкод"
              aria-label="Найти товар на складе"
              autoComplete="off"
              data-sale-search
            />
            {found && (
              <div
                className="absolute inset-x-0 top-[calc(100%+6px)] z-20 max-h-[320px] overflow-y-auto rounded-card border border-line-strong bg-surface-raised p-1.5 shadow-modal"
                data-sale-found
              >
                {found.length === 0 ? (
                  <p className="px-3 py-2.5 text-[13.5px] text-ink-muted">На складе такого нет.</p>
                ) : (
                  found.map((i, n) => {
                    const left = i.qty - inCart(i.id);
                    const out = i.qty <= 0;
                    return (
                      <button
                        key={i.id}
                        type="button"
                        disabled={out || left <= 0}
                        onMouseEnter={() => setHl(n)}
                        onClick={() => add(i)}
                        data-sale-option={i.id}
                        className={cx(
                          "grid w-full grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 rounded-[10px] px-3 py-2 text-left text-[13.5px]",
                          n === hl && !out && "bg-brand-tint",
                          (out || left <= 0) && "cursor-not-allowed opacity-60"
                        )}
                      >
                        <span className="min-w-0">
                          <span className="block truncate font-semibold">{i.name}</span>
                          <span className="block truncate font-mono text-[11.5px] text-ink-dim">
                            {[i.sku, i.location].filter(Boolean).join(" · ") || "—"}
                          </span>
                        </span>
                        <span
                          className={cx(
                            "whitespace-nowrap rounded-pill px-2 py-0.5 text-[12px] font-semibold",
                            out ? "bg-state-off/15 text-state-off" : "bg-state-done/15 text-state-done"
                          )}
                        >
                          {out ? "нет на складе" : left <= 0 ? "всё в чеке" : `${left} ${i.unit}`}
                        </span>
                        <span className="whitespace-nowrap text-right font-semibold tabular-nums">{i.salePrice ? money(i.salePrice) : "—"}</span>
                      </button>
                    );
                  })
                )}
              </div>
            )}
          </div>

          {skipped.length > 0 && (
            <div className="mt-3">
              <Banner tone="warning">
                Нет на складе — не добавлено: {skipped.map((i) => `«${i.name}»`).join(", ")}.
              </Banner>
            </div>
          )}

          {lines.length === 0 ? (
            <div className="mt-4 flex flex-col items-center gap-2 rounded-card border border-dashed border-line px-4 py-10 text-center text-[13.5px] text-ink-muted">
              <IconCart className="h-7 w-7 text-ink-dim" />
              Чек пуст. Найдите товар по названию или артикулу — или отсканируйте штрихкод.
            </div>
          ) : (
            <div className="mt-3" data-sale-lines>
              {lines.map((l, n) => {
                const sum = l.qty * (toNum(l.price) || 0);
                return (
                  <div
                    key={l.item.id}
                    data-sale-line={l.item.id}
                    className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 border-b border-dashed border-line py-3 sm:grid-cols-[20px_minmax(0,1fr)_auto_100px_92px_28px]"
                  >
                    <span className="hidden text-right text-[12px] text-ink-dim sm:block">{n + 1}</span>
                    <div className="col-span-2 min-w-0 sm:col-span-1">
                      <div className="text-[14px] font-semibold leading-snug">{l.item.name}</div>
                      <div className="truncate text-[12px] text-ink-dim">
                        {l.item.sku && <span className="font-mono">{l.item.sku} · </span>}
                        осталось {l.item.qty - l.qty} {l.item.unit}
                      </div>
                    </div>
                    <div className="flex h-9 items-center rounded-[10px] border border-line bg-surface-input" data-sale-qty>
                      <button type="button" aria-label="Меньше" disabled={l.qty <= 1} onClick={() => setQty(l.item.id, l.qty - 1)} className="h-full w-8 text-[17px] text-ink-muted disabled:opacity-40">
                        −
                      </button>
                      <span className="min-w-[28px] text-center text-[14px] font-bold tabular-nums">{l.qty}</span>
                      <button type="button" aria-label="Больше" disabled={l.qty >= l.item.qty} onClick={() => setQty(l.item.id, l.qty + 1)} className="h-full w-8 text-[17px] text-ink-muted disabled:opacity-40">
                        +
                      </button>
                    </div>
                    <label className="flex h-9 items-center gap-1 rounded-[10px] border border-line bg-surface-input px-2.5 focus-within:border-brand">
                      <input
                        inputMode="decimal"
                        value={l.price}
                        onChange={(e) => setPrice(l.item.id, e.target.value)}
                        aria-label={`Цена: ${l.item.name}`}
                        placeholder="цена"
                        className="w-full min-w-0 bg-transparent text-right text-[13.5px] font-semibold tabular-nums outline-none"
                        data-sale-price
                      />
                      <span className="text-[12.5px] text-ink-dim">₽</span>
                    </label>
                    <span className="text-right text-[14px] font-bold tabular-nums">{money(r2(sum))}</span>
                    <button
                      type="button"
                      aria-label={`Убрать «${l.item.name}»`}
                      title="Убрать из чека"
                      onClick={() => remove(l.item.id)}
                      className="col-start-3 row-start-1 flex h-7 w-7 items-center justify-center justify-self-end rounded-[8px] text-ink-dim hover:bg-surface-raised hover:text-ink sm:col-start-auto sm:row-start-auto [&>svg]:h-3.5 [&>svg]:w-3.5"
                    >
                      <IconClose />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          <p className="mt-3 hidden text-[12px] text-ink-dim sm:block">
            Enter — добавить найденное, ↑↓ — выбрать. Сканер штрихкода кладёт товар в чек сразу. Цену можно поправить в строке.
          </p>
        </div>

        {/* ----- итог и оплата ----- */}
        <div className="flex flex-col gap-4 rounded-card border border-line bg-surface-raised/40 p-4 lg:sticky lg:top-0 lg:self-start">
          <div>
            <div className="flex justify-between text-[13.5px] text-ink-muted">
              <span>Товары, {units} шт.</span>
              <b className="font-semibold tabular-nums text-ink">{money(subtotal)}</b>
            </div>
            <label className="mt-2 flex items-center justify-between gap-3 text-[13.5px] text-ink-muted">
              <span>Скидка</span>
              <input
                value={discount}
                onChange={(e) => setDiscount(e.target.value)}
                placeholder="0 ₽ или 10%"
                inputMode="decimal"
                aria-label="Скидка: рубли или проценты"
                className="h-9 w-[120px] rounded-[10px] border border-line bg-surface-input px-2.5 text-right font-semibold tabular-nums text-ink outline-none focus:border-brand"
                data-sale-discount
              />
            </label>
            {discountValue > 0 && discount.trim().endsWith("%") && (
              <p className="mt-1 text-right text-[12px] text-ink-dim">− {money(discountValue)}</p>
            )}
            <div className="mt-3 flex items-baseline justify-between border-t border-dashed border-line-strong pt-3">
              <span className="text-[15px] font-semibold text-ink-soft">Итого</span>
              <b className="text-[28px] font-extrabold tabular-nums tracking-tight" data-sale-total>
                {money(Math.max(0, total))}
              </b>
            </div>
          </div>

          {canPickCustomer && (
            <div>
              <div className="mb-1.5 text-[11px] font-bold uppercase tracking-[.12em] text-ink-dim">Клиент</div>
              {customer ? (
                <div className="flex items-center gap-2 rounded-field border border-line bg-surface-input px-3 py-2 text-[13.5px]" data-sale-customer>
                  <IconPerson className="h-4 w-4 shrink-0 text-ink-dim" />
                  <span className="min-w-0 flex-1 truncate font-semibold">
                    {customer.name}
                    <span className="ml-1.5 font-normal text-ink-dim">{customer.phone}</span>
                  </span>
                  <button type="button" onClick={() => setCustomer(null)} className="text-[12.5px] font-semibold text-brand-ink hover:underline">
                    убрать
                  </button>
                </div>
              ) : picking ? (
                <CustomerPick
                  onPick={(c) => {
                    setCustomer(c);
                    setPicking(false);
                  }}
                  onCancel={() => setPicking(false)}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setPicking(true)}
                  className="flex w-full items-center gap-2 rounded-field border border-line bg-surface-input px-3 py-2.5 text-left text-[13.5px] hover:border-line-strong"
                  data-sale-pick-customer
                >
                  <IconPerson className="h-4 w-4 text-ink-dim" />
                  <span className="flex-1">Без клиента</span>
                  <span className="font-semibold text-brand-ink">Выбрать</span>
                </button>
              )}
            </div>
          )}

          <div>
            <div className="mb-1.5 text-[11px] font-bold uppercase tracking-[.12em] text-ink-dim">Оплата</div>
            <div role="radiogroup" aria-label="Оплата" className="grid grid-cols-3 gap-1 rounded-field border border-line bg-surface-input p-[3px]">
              {PAY.map((p) => (
                <button
                  key={p.v}
                  type="button"
                  role="radio"
                  aria-checked={payment === p.v}
                  onClick={() => setPayment(p.v)}
                  data-sale-pay={p.v}
                  className={cx(
                    "flex h-9 items-center justify-center gap-1.5 rounded-[9px] text-[13px] font-semibold [&>svg]:h-4 [&>svg]:w-4",
                    payment === p.v ? "bg-surface-raised text-ink ring-1 ring-line-strong" : "text-ink-muted hover:text-ink"
                  )}
                >
                  {p.icon}
                  {PAYMENT_LABEL[p.v]}
                </button>
              ))}
            </div>
          </div>

          <label className="block">
            <div className="mb-1.5 text-[11px] font-bold uppercase tracking-[.12em] text-ink-dim">Гарантия</div>
            <Select value={String(warranty)} onChange={(e) => setWarranty(Number(e.target.value))} data-sale-warranty>
              {WARRANTY_CHOICES.map((d) => (
                <option key={d} value={d}>
                  {warrantyLabel(d)}
                </option>
              ))}
            </Select>
          </label>

          {error && <Banner tone="error">{error}</Banner>}

          <div className="grid gap-2">
            <button
              type="button"
              disabled={!!busy || !lines.length}
              onClick={() => void sell(false)}
              data-sale-sell
              className="flex min-h-[50px] items-center justify-center gap-2 rounded-[14px] bg-state-done px-4 text-[15.5px] font-bold text-[#0E2A1C] transition-all duration-150 hover:brightness-105 active:scale-[.985] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === "sell" ? "Проводим…" : `Продать · ${money(Math.max(0, total))}`}
            </button>
            <Button variant="secondary" icon={<IconPrint />} disabled={!!busy || !lines.length} onClick={() => void sell(true)} data-sale-sell-print>
              {busy === "print" ? "Проводим…" : "Продать и напечатать чек"}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** Выбор клиента: по имени или телефону, из уже заведённых. */
function CustomerPick({ onPick, onCancel }: { onPick: (c: CustomerHit) => void; onCancel: () => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<CustomerHit[] | null>(null);
  useEffect(() => {
    const t = q.trim();
    const digits = t.replace(/\D/g, "");
    if (digits.length < 3 && t.length < 2) {
      setHits(null);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      ordersApi
        .suggestCustomers(digits.length >= 3 && digits.length >= t.replace(/\s/g, "").length - 2 ? { phone: digits } : { name: t })
        .then((r) => alive && setHits(r))
        .catch(() => alive && setHits([]));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [q]);
  return (
    <div className="rounded-field border border-brand bg-surface-input p-1.5" data-sale-customer-pick>
      <div className="flex items-center gap-1">
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Имя или телефон"
          aria-label="Найти клиента"
          className="h-9 min-w-0 flex-1 bg-transparent px-2 text-[13.5px] outline-none"
        />
        <button type="button" onClick={onCancel} className="px-2 text-[12.5px] font-semibold text-ink-muted hover:text-ink">
          Отмена
        </button>
      </div>
      {hits && (
        <div className="mt-1 max-h-[200px] overflow-y-auto border-t border-line pt-1">
          {hits.length === 0 ? (
            <p className="px-2 py-2 text-[12.5px] text-ink-muted">Не нашли. Продайте без клиента — карточку можно завести потом.</p>
          ) : (
            hits.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => onPick(c)}
                className="flex w-full items-baseline justify-between gap-2 rounded-[8px] px-2 py-1.5 text-left text-[13.5px] hover:bg-surface-raised"
              >
                <span className="min-w-0 truncate font-semibold">{c.name}</span>
                <span className="shrink-0 text-[12px] text-ink-dim">{c.phone}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
