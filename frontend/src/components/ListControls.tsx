import { useEffect, useRef, useState } from "react";
import { CUSTOMER_COLORS, customerColor } from "../lib/customerColor";

/**
 * Сортировка и отбор по метке — рядом с поиском в списках.
 *
 * Сортировка — обычный выпадающий список: на телефоне он открывается
 * системным колесом, к которому все привыкли. Метка — своё меню: цвет
 * выбирают глазами, а в системном списке кружок не нарисовать.
 */

export interface SortOption<T extends string> {
  value: T;
  label: string;
}

export function SortSelect<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: ReadonlyArray<SortOption<T>>;
  onChange: (next: T) => void;
}) {
  return (
    <label className="relative inline-flex min-h-[46px] w-full items-center rounded-field border border-line bg-surface-input sm:w-auto">
      <span className="pointer-events-none pl-3.5 text-[13px] font-semibold text-ink-dim">Сортировка:</span>
      <select
        aria-label="Сортировка"
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="min-h-[44px] flex-1 cursor-pointer appearance-none bg-transparent pl-1.5 pr-9 text-[14.5px] font-semibold text-ink outline-none"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <Chevron />
    </label>
  );
}

/** Значение фильтра по метке: пусто — все, "none" — без метки, иначе ключ цвета. */
export type ColorFilterValue = "" | "none" | (typeof CUSTOMER_COLORS)[number]["key"];

export const COLOR_FILTER_VALUES: readonly ColorFilterValue[] = ["", "none", ...CUSTOMER_COLORS.map((c) => c.key)];

const Dot = ({ color }: { color: string | null }) =>
  color ? (
    <span className="h-[12px] w-[12px] shrink-0 rounded-full" style={{ backgroundColor: color }} />
  ) : (
    <span className="h-[12px] w-[12px] shrink-0 rounded-full border border-dashed border-ink-dim" />
  );

export function ColorFilter({ value, onChange }: { value: ColorFilterValue; onChange: (next: ColorFilterValue) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  // Меню закрывается щелчком мимо и клавишей Esc — как любое меню.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent | TouchEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("touchstart", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("touchstart", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const current = customerColor(value === "none" ? null : value);
  const label = value === "" ? "Все" : value === "none" ? "Без метки" : current?.label ?? "Все";

  const items: Array<{ value: ColorFilterValue; label: string; dot: string | null | undefined }> = [
    { value: "", label: "Все клиенты", dot: undefined },
    ...CUSTOMER_COLORS.map((c) => ({ value: c.key as ColorFilterValue, label: c.label, dot: c.dot })),
    { value: "none", label: "Без метки", dot: null },
  ];

  return (
    <div ref={box} className="relative w-full sm:w-auto">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={
          "relative inline-flex min-h-[46px] w-full items-center gap-2 rounded-field border bg-surface-input pl-3.5 pr-9 text-left transition-colors duration-150 sm:w-auto " +
          (value ? "border-brand" : "border-line")
        }
      >
        <span className="text-[13px] font-semibold text-ink-dim">Метка:</span>
        {value !== "" && <Dot color={current?.dot ?? null} />}
        <span className="text-[14.5px] font-semibold text-ink">{label}</span>
        <Chevron />
      </button>

      {open && (
        <ul
          role="listbox"
          aria-label="Метка клиента"
          className="absolute right-0 z-30 mt-1.5 w-full min-w-[200px] overflow-hidden rounded-field border border-line bg-surface-raised py-1 shadow-raised sm:w-auto"
        >
          {items.map((it) => (
            <li key={it.value || "all"}>
              <button
                type="button"
                role="option"
                aria-selected={value === it.value}
                onClick={() => {
                  onChange(it.value);
                  setOpen(false);
                }}
                className={
                  "flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-[14.5px] transition-colors duration-100 hover:bg-surface-input " +
                  (value === it.value ? "font-bold text-ink" : "text-ink-soft")
                }
              >
                {it.dot === undefined ? <span className="h-[12px] w-[12px] shrink-0" /> : <Dot color={it.dot} />}
                {it.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Chevron() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 20 20"
      className="pointer-events-none absolute right-3 h-[16px] w-[16px] text-ink-dim"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 8l5 5 5-5" />
    </svg>
  );
}
