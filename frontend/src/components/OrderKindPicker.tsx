import type { OrderKind } from "../lib/orders";
import { SectionLabel } from "./ui";

/**
 * «Тип заказа» наверху бланка приёма (27.10.2026). Раньше выбор прятался в
 * «Дополнительно», и его забывали менять: гарантийные заказы мастерской с
 * авторизацией брендов уходили «Ремонтом». Теперь — кнопками сразу под
 * заголовком, а для бренда из списка авторизаций — обязательный выбор.
 */
const LABEL: Partial<Record<OrderKind, string>> = {
  REPAIR: "Платный ремонт",
  WARRANTY: "Гарантийный возврат (наш)",
  REPEAT: "Повторное",
};
const DOT: Record<OrderKind, string> = {
  REPAIR: "rgb(var(--state-done))",
  BRAND_WARRANTY: "rgb(var(--tag-factory))",
  DIAGNOSTICS: "rgb(var(--brand))",
  WARRANTY: "rgb(var(--tag-warranty))",
  REPEAT: "rgb(var(--ink-dim))",
};

export function OrderKindPicker({
  kinds,
  value,
  onPick,
  needBrand,
  tried,
  showFactory,
}: {
  kinds: Array<{ value: OrderKind; label: string }>;
  /** Выбранный тип; null — ещё не выбран (бренд из авторизаций). */
  value: OrderKind | null;
  onPick: (k: OrderKind) => void;
  /** Бренд техники из списка авторизаций — выбор обязателен. */
  needBrand: string | null;
  /** Пытались принять заказ без выбора — подсветить красным. */
  tried: boolean;
  /** «Гарантия производителя» — только мастерским с авторизациями. */
  showFactory: boolean;
}) {
  const list = kinds.filter((k) => k.value !== "BRAND_WARRANTY" || showFactory || value === "BRAND_WARRANTY");
  const ask = !!needBrand && value === null;
  return (
    <section
      id="order-kind"
      data-order-kind-picker={value ?? "none"}
      className={
        "scroll-mt-20 rounded-panel border bg-surface px-5 py-4 shadow-card transition-[border-color,box-shadow] duration-200 " +
        (ask ? (tried ? "border-state-off/70 shadow-[0_0_0_3px_rgb(var(--state-off)/.18)]" : "border-state-waiting/60 shadow-[0_0_0_3px_rgb(var(--state-waiting)/.15)]") : "border-line")
      }
    >
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <SectionLabel>Тип заказа</SectionLabel>
        <div role="radiogroup" aria-label="Тип заказа" className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap">
          {list.map((k) => {
            const on = value === k.value;
            return (
              <button
                key={k.value}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => onPick(k.value)}
                data-order-kind={k.value}
                className={
                  "inline-flex min-h-[38px] items-center gap-2 rounded-field border px-3 py-1.5 text-left text-[13px] font-semibold leading-tight transition-colors duration-100 sm:px-3.5 sm:text-[13.5px] " +
                  (on ? "border-brand bg-brand-tint text-ink ring-1 ring-brand/40" : "border-line bg-surface-input text-ink-soft hover:border-line-strong hover:text-ink")
                }
              >
                <span aria-hidden className="h-[9px] w-[9px] shrink-0 rounded-full" style={{ background: DOT[k.value] }} />
                {LABEL[k.value] ?? k.label}
              </button>
            );
          })}
        </div>
      </div>
      {ask && (
        <p className={"mt-3 text-[13px] font-medium " + (tried ? "text-state-off" : "text-state-waiting")} data-order-kind-ask>
          {needBrand} — в списке ваших авторизаций. Выберите: платный ремонт или гарантия производителя — без выбора заказ не примется.
        </p>
      )}
    </section>
  );
}
