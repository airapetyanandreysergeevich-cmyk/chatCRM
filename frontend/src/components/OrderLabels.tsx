import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { ApiError } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { LabelDot } from "../lib/labelIcons";
import { ordersApi, type LabelDef, type LabelMark } from "../lib/orders";

/**
 * Ярлыки заказа — «Индивидуальные оповещения» (Андрей, 22.10.2026).
 *
 * Кружки со значками рядом со статусом: в списке заказов, на доске, в
 * таблице и в карточке. Щелчок (или «+») открывает список ярлыков мастерской
 * с галочками: отметил — поставил, снял — убрал. Каждое «поставил / снял» —
 * строкой в истории ремонта.
 */

/** Может ли человек ставить ярлыки на этот заказ — так же решает сервер. */
export function canLabel(can: (...codes: string[]) => boolean, myId: string | null, masterId: string | null | undefined) {
  return can("orders.edit", "orders.status", "orders.assign") || (can("orders.status.own") && !!myId && masterId === myId);
}

const tip = (def: LabelDef, mark: LabelMark) =>
  `${def.name} · ${mark.setBy ? `поставил(а) ${mark.setBy}, ` : ""}${formatDateTime(mark.setAt)}`;

export function OrderLabels({
  order,
  defs,
  canEdit,
  onChanged,
  size = "sm",
  add = "hover",
  className = "",
}: {
  order: { id: string; number: string; labels?: LabelMark[] };
  defs: LabelDef[] | undefined;
  canEdit: boolean;
  /** После смены — перечитать список (подсказка внизу — забота вызывающего). */
  onChanged?: () => unknown;
  size?: "sm" | "md";
  /** «+» рядом с кружками: всегда, при наведении на строку или никогда. */
  add?: "always" | "hover" | "never";
  className?: string;
}) {
  const [marks, setMarks] = useState<LabelMark[]>(order.labels ?? []);
  useEffect(() => setMarks(order.labels ?? []), [order.labels]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const anchor = useRef<HTMLButtonElement>(null);
  const byId = new Map((defs ?? []).map((d) => [d.id, d]));
  // Ярлыки — в порядке мастерской, а не в порядке, в каком их ставили.
  const shown = (defs ?? []).filter((d) => marks.some((m) => m.id === d.id));
  if (!shown.length && (!canEdit || add === "never" || !defs?.length)) return null;

  async function toggle(def: LabelDef) {
    const on = !marks.some((m) => m.id === def.id);
    const before = marks;
    setMarks(on ? [...marks, { id: def.id, setAt: new Date().toISOString(), setBy: null }] : marks.filter((m) => m.id !== def.id));
    setError(null);
    try {
      await ordersApi.setLabel(order.id, def.id, on);
      await onChanged?.();
    } catch (err) {
      setMarks(before);
      setError(err instanceof ApiError ? err.message : "Не удалось");
    }
  }

  const dots = shown.map((d) => {
    const m = marks.find((x) => x.id === d.id)!;
    return <LabelDot key={d.id} icon={d.icon} color={d.color} size={size} title={tip(d, m)} />;
  });

  if (!canEdit) {
    return (
      <span className={"inline-flex items-center gap-1 " + className} data-order-labels={order.number}>
        {dots}
      </span>
    );
  }

  const plusSize = size === "md" ? "h-[26px] w-[26px] text-[15px]" : "h-[22px] w-[22px] text-[13px]";
  return (
    <>
      <button
        ref={anchor}
        type="button"
        data-order-labels={order.number}
        aria-haspopup="menu"
        aria-expanded={open}
        title={shown.length ? "Ярлыки заказа" : "Поставить ярлык"}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onContextMenu={(e) => e.stopPropagation()}
        className={"inline-flex items-center gap-1 rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand " + className}
      >
        {dots}
        {add !== "never" && (
          <span
            aria-hidden
            className={
              "inline-flex items-center justify-center rounded-full border border-dashed border-line-strong leading-none text-ink-dim hover:border-brand hover:text-brand-ink " +
              plusSize +
              (add === "hover" && shown.length ? " opacity-0 group-hover:opacity-100 [@media(hover:none)]:hidden" : "") +
              (add === "hover" && !shown.length ? " opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-60" : "")
            }
          >
            +
          </span>
        )}
      </button>
      {open &&
        anchor.current &&
        createPortal(
          <Picker
            anchor={anchor.current}
            number={order.number}
            defs={defs ?? []}
            marks={marks}
            byId={byId}
            error={error}
            onToggle={(d) => void toggle(d)}
            onClose={() => setOpen(false)}
          />,
          document.body
        )}
    </>
  );
}

function Picker({
  anchor,
  number,
  defs,
  marks,
  error,
  onToggle,
  onClose,
}: {
  anchor: HTMLElement;
  number: string;
  defs: LabelDef[];
  marks: LabelMark[];
  byId: Map<string, LabelDef>;
  error: string | null;
  onToggle: (d: LabelDef) => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const w = box.current?.offsetWidth ?? 280;
    const h = box.current?.offsetHeight ?? 300;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    const below = r.bottom + 6;
    setPos({ left, top: below + h + 8 > window.innerHeight ? Math.max(8, r.top - h - 6) : below });
  }, [anchor, defs.length]);

  useEffect(() => {
    box.current?.querySelector<HTMLElement>("[role=menuitemcheckbox]")?.focus({ preventScroll: true });
    const down = (e: Event) => {
      if (box.current?.contains(e.target as Node) || anchor.contains(e.target as Node)) return;
      onClose();
    };
    const opened = Date.now();
    const scrolled = (e: Event) => {
      if (box.current?.contains(e.target as Node)) return;
      if (Date.now() - opened > 200) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", down);
    document.addEventListener("touchstart", down);
    document.addEventListener("keydown", key);
    window.addEventListener("scroll", scrolled, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("touchstart", down);
      document.removeEventListener("keydown", key);
      window.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("resize", onClose);
    };
  }, [anchor, onClose]);

  return (
    <div
      ref={box}
      role="menu"
      aria-label={`Ярлыки заказа ${number}`}
      data-label-menu
      // Через портал события React всё равно всплывают к строке заказа.
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      className="fixed z-[95] max-h-[min(460px,calc(100vh-16px))] w-[290px] max-w-[calc(100vw-16px)] overflow-y-auto rounded-field border border-line bg-surface-raised p-1.5 shadow-raised"
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
    >
      <p className="px-2 pb-1.5 pt-1 text-[11px] font-bold uppercase tracking-[0.08em] text-ink-dim">Ярлыки · {number}</p>
      {defs.length === 0 ? (
        <p className="px-2 pb-2 text-[13px] text-ink-muted">Ярлыков пока нет.</p>
      ) : (
        defs.map((d) => {
          const on = marks.some((m) => m.id === d.id);
          return (
            <button
              key={d.id}
              type="button"
              role="menuitemcheckbox"
              aria-checked={on}
              data-label-option={d.name}
              onClick={() => onToggle(d)}
              className="flex w-full items-center gap-2.5 rounded-[9px] px-2 py-1.5 text-left text-[13.5px] hover:bg-surface-input focus:bg-surface-input focus:outline-none [@media(hover:none)]:py-2"
            >
              <LabelDot icon={d.icon} color={d.color} />
              <span className="min-w-0 flex-1 truncate">{d.name}</span>
              {on && (
                <svg aria-hidden viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-state-done" fill="none" stroke="currentColor" strokeWidth="2.6">
                  <path d="m5 12 5 5 9-10" />
                </svg>
              )}
            </button>
          );
        })
      )}
      {error && <p className="px-2 pb-1 pt-1 text-[12px] font-semibold text-state-off">{error}</p>}
      <div className="my-1 h-px bg-line" />
      <Link to="/settings/interface#labels" onClick={onClose} className="block px-2 py-1.5 text-[12px] leading-snug text-ink-dim hover:text-ink">
        Свои ярлыки — «Настройки → Интерфейс → Индивидуальные оповещения»
      </Link>
    </div>
  );
}
