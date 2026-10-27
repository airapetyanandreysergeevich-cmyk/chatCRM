import { useEffect, useRef, useState } from "react";
import { IconChevronDown } from "./icons";

export interface OutsourceOption {
  /** any — только аутсорс, none — без аутсорса, иначе id компании. "" — все. */
  key: string;
  label: string;
  count: number;
}

/**
 * «Аутсорс ▾» над таблицей главной (мастерская-клиент, 27.10.2026: «есть
 * номера аутсорса, но нет сортировки по аутсорсу и конкретному аутсорсу»).
 * Все заказы / только аутсорс / конкретная компания / без аутсорса — с
 * числами. Выбор хранится в виде таблицы, как сортировка: вкладка «РСС»
 * так и открывается — с заказами РСС.
 */
export function OutsourceFilter({
  value,
  options,
  onChange,
  title = "Аутсорс",
  id = "outsource",
}: {
  value: string;
  options: OutsourceOption[];
  onChange: (key: string) => void;
  /** Подпись на кнопке: «Аутсорс», «Тип заказа». */
  title?: string;
  /** Имя для data-атрибутов: data-<id>-filter, data-<id>-option, data-<id>-menu. */
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState({ top: 0, left: 0 });
  const box = useRef<HTMLSpanElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const current = options.find((o) => o.key === value);
  const active = !!value && !!current;

  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const opened = Date.now();
    const away = (e: Event) => {
      // Прокрутка списка компаний внутри меню — не повод его закрывать; и
      // доезжающая прокрутка ленты сразу после касания — тоже.
      if (e.type === "scroll" && (box.current?.contains(e.target as Node) || Date.now() - opened < 400)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", down);
    document.addEventListener("keydown", key);
    window.addEventListener("resize", away);
    window.addEventListener("scroll", away, true);
    return () => {
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("keydown", key);
      window.removeEventListener("resize", away);
      window.removeEventListener("scroll", away, true);
    };
  }, [open]);

  const companies = options.filter((o) => o.key !== "" && o.key !== "any" && o.key !== "none");
  const item = (o: OutsourceOption) => (
    <button
      key={o.key || "all"}
      type="button"
      role="menuitemradio"
      aria-checked={value === o.key}
      onClick={() => {
        onChange(o.key);
        setOpen(false);
      }}
      {...{ [`data-${id}-option`]: o.key || "all" }}
      className={
        "flex w-full items-center gap-3 rounded-[8px] px-2.5 py-2 text-left text-[13.5px] transition-colors duration-100 " +
        (value === o.key ? "bg-brand-tint font-semibold text-ink" : "text-ink-soft hover:bg-surface-input hover:text-ink")
      }
    >
      <span className="min-w-0 flex-1 truncate">{o.label}</span>
      <span className="text-[12px] tabular-nums text-ink-dim">{o.count}</span>
    </button>
  );

  return (
    <span ref={box} className="relative inline-flex shrink-0">
      <button
        type="button"
        ref={btn}
        onClick={() => {
          // Меню — поверх всего (position: fixed): на телефоне ряд чипов
          // прокручивается вбок и обрезал бы выпадающий список.
          const r = btn.current!.getBoundingClientRect();
          setAt({ top: r.bottom + 6, left: Math.max(8, Math.min(r.right - 260, window.innerWidth - 268)) });
          setOpen((v) => !v);
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        {...{ [`data-${id}-filter`]: value || "all" }}
        className={
          "inline-flex h-[30px] items-center gap-1.5 whitespace-nowrap rounded-pill border px-3 text-[12.5px] font-semibold transition-colors duration-100 " +
          (active ? "border-brand/60 bg-brand-tint text-ink" : "border-line bg-surface-input text-ink-soft hover:border-line-strong hover:text-ink")
        }
      >
        {active ? `${title}: ${current!.label}` : title}
        {active && <span className="rounded-full bg-surface-raised px-1.5 text-[11px] tabular-nums text-ink-muted">{current!.count}</span>}
        <IconChevronDown className={"h-3.5 w-3.5 transition-transform duration-150 " + (open ? "rotate-180" : "")} />
      </button>
      {open && (
        <div
          role="menu"
          style={{ top: at.top, left: at.left }}
          className="fixed z-50 w-[260px] rounded-field border border-line-strong bg-surface-raised p-1.5 shadow-raised"
          {...{ [`data-${id}-menu`]: "" }}
        >
          {options.filter((o) => o.key === "" || o.key === "any").map(item)}
          {companies.length > 0 && <div className="mx-1 my-1 h-px bg-line" />}
          <div className="max-h-[280px] overflow-y-auto">{companies.map(item)}</div>
          {options.some((o) => o.key === "none") && <div className="mx-1 my-1 h-px bg-line" />}
          {options.filter((o) => o.key === "none").map(item)}
        </div>
      )}
    </span>
  );
}
