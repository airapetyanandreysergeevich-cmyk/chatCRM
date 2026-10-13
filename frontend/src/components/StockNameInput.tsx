import { useEffect, useRef, useState } from "react";
import { money } from "../lib/orders";
import { stockApi, type StockLookupItem } from "../lib/workshop";
import { GrowText } from "./ui";

/**
 * Название запчасти с подсказками со склада.
 *
 * От двух знаков — позиции склада по словам в названии и артикуле: остаток,
 * место, цена продажи. Выбор подставляет название, цену продажи и «Со
 * склада» и связывает строку с позицией — при сохранении заказа она
 * спишется со склада сама (backend stock/catalog.ts → syncOrderStock).
 * Поменяли название руками — связь снимается: это уже другая запчасть.
 */
export function StockNameInput({
  value,
  linked,
  onChange,
  onPick,
}: {
  value: string;
  /** Строка связана с позицией склада. */
  linked: boolean;
  onChange: (name: string) => void;
  onPick: (item: StockLookupItem) => void;
}) {
  const [open, setOpen] = useState(false);
  const [hits, setHits] = useState<StockLookupItem[]>([]);
  const [highlight, setHighlight] = useState(0);
  const typed = useRef(false);
  const seq = useRef(0);

  useEffect(() => {
    const q = value.trim();
    if (!typed.current || q.replace(/\s+/g, "").length < 2) {
      setHits([]);
      return;
    }
    const my = ++seq.current;
    const t = setTimeout(() => {
      stockApi
        .lookup(q)
        .then((r) => my === seq.current && (setHits(r.items), setHighlight(0)))
        .catch(() => my === seq.current && setHits([]));
    }, 200);
    return () => clearTimeout(t);
  }, [value]);

  const show = open && hits.length > 0;

  function pick(item: StockLookupItem) {
    typed.current = false;
    setHits([]);
    setOpen(false);
    onPick(item);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape") return setOpen(false);
    if (!show) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => (h + 1) % hits.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => (h - 1 + hits.length) % hits.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(hits[highlight] ?? hits[0]);
    }
  }

  return (
    <div className="relative" data-stock-name>
      <GrowText
        value={value}
        placeholder="Наименование — от 2 букв подскажем со склада"
        autoComplete="off"
        aria-label="Наименование"
        onChange={(e) => {
          typed.current = true;
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {linked && (
        <p className="mt-1 text-[12px] text-state-done" data-stock-linked>
          Со склада — списывается при сохранении, «Убрать» вернёт на склад
        </p>
      )}
      {show && (
        <div
          role="listbox"
          aria-label="Со склада"
          className="absolute left-0 right-0 top-full z-20 mt-1 max-h-[320px] overflow-y-auto rounded-field border border-line bg-surface-raised shadow-modal"
        >
          <p className="border-b border-line px-3 py-1.5 text-[11.5px] font-bold uppercase tracking-wide text-ink-dim">Со склада</p>
          {hits.map((s, i) => (
            <button
              key={s.id}
              type="button"
              role="option"
              aria-selected={i === highlight}
              onMouseDown={(e) => {
                // onMouseDown: клик иначе сначала снимает фокус, и список закрывается раньше выбора.
                e.preventDefault();
                pick(s);
              }}
              onMouseEnter={() => setHighlight(i)}
              className={
                "flex w-full items-start gap-3 border-b border-line px-3 py-2 text-left text-[13.5px] last:border-b-0 " +
                (i === highlight ? "bg-surface-hover text-ink" : "text-ink-soft")
              }
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate">{s.name}</span>
                <span className="block truncate text-[12px] text-ink-dim">
                  {[s.sku, s.qty > 0 ? `в наличии ${s.qty} ${s.unit}` : "нет в наличии", s.location ? `место: ${s.location}` : null]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              <span className={"shrink-0 font-semibold " + (s.qty > 0 ? "text-ink-muted" : "text-ink-dim")}>
                {s.salePrice ? money(s.salePrice) : "—"}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
