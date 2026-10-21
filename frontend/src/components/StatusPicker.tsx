import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { statusPill, type OrderStatus, type StatusGroup } from "../lib/orders";
import { StatusPill } from "./ui";

/**
 * Статус «таблеткой», по которой можно щёлкнуть и выбрать другой (Андрей,
 * 21.10.2026: «как в HelloClient»). Список — те же таблетки, каждая в цвете
 * своей стадии: глазом ищут цвет, а не слово.
 *
 * Сама смена — снаружи (useOrderMenu().changeStatus): там подсказка внизу с
 * «Отменить», предложение SMS у «Готов» и все проверки, как в карточке.
 * Выданный заказ отсюда не меняют: «Вернуть в работу» — с причиной, в меню.
 */

const GROUP_LABEL: Partial<Record<StatusGroup, string>> = {
  NEW: "Диагностика",
  WAITING: "Согласование",
  IN_PROGRESS: "Ремонт",
  DONE: "Готов",
};

const TONE: Record<StatusGroup, "new" | "waiting" | "progress" | "done" | "issued" | "cancelled"> = {
  NEW: "new",
  WAITING: "waiting",
  IN_PROGRESS: "progress",
  DONE: "done",
  CLOSED: "issued",
  CANCELLED: "cancelled",
};

export function StatusPicker({
  order,
  statuses,
  canChange,
  onPick,
  className = "",
}: {
  order: { number: string; status: OrderStatus; issuedAt?: string | null; completedAt?: string | null };
  statuses: OrderStatus[] | undefined;
  canChange: boolean;
  onPick: (s: OrderStatus) => void;
  className?: string;
}) {
  const pill = statusPill(order);
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const list = (statuses ?? []).filter((s) => s.group !== "CLOSED" && s.group !== "CANCELLED");

  if (!canChange || order.issuedAt || !list.length) {
    return (
      <StatusPill tone={pill.tone} className={"whitespace-nowrap " + className}>
        {pill.label}
      </StatusPill>
    );
  }

  return (
    <>
      <button
        ref={btn}
        type="button"
        data-status-picker={order.number}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Сменить статус"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onContextMenu={(e) => e.stopPropagation()}
        className={
          "tag inline-flex items-center gap-1 whitespace-nowrap px-3 py-1 text-[12.5px] transition-[filter] duration-100 hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand " +
          `tag-${pill.tone} ` +
          className
        }
      >
        <span className="min-w-0 truncate">{pill.label}</span>
        <svg aria-hidden viewBox="0 0 16 16" className="h-3 w-3 shrink-0 opacity-75" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m4 6 4 4 4-4" />
        </svg>
      </button>
      {open && btn.current &&
        createPortal(
          <Popover
            anchor={btn.current}
            current={order.status.id}
            statuses={list}
            onClose={() => setOpen(false)}
            onPick={(s) => {
              setOpen(false);
              if (s.id !== order.status.id) onPick(s);
            }}
          />,
          document.body
        )}
    </>
  );
}

function Popover({
  anchor,
  current,
  statuses,
  onClose,
  onPick,
}: {
  anchor: HTMLElement;
  current: string;
  statuses: OrderStatus[];
  onClose: () => void;
  onPick: (s: OrderStatus) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const el = box.current;
    const w = el?.offsetWidth ?? 220;
    const h = el?.offsetHeight ?? 300;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    const below = r.bottom + 6;
    const top = below + h + 8 > window.innerHeight ? Math.max(8, r.top - h - 6) : below;
    setPos({ left, top });
  }, [anchor]);

  useEffect(() => {
    box.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus({ preventScroll: true });
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

  function onKey(e: React.KeyboardEvent) {
    const items = [...(box.current?.querySelectorAll<HTMLElement>("[role=menuitemradio]") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      items[(i + 1) % items.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    }
  }

  let lastGroup: StatusGroup | null = null;
  return (
    <div
      ref={box}
      role="menu"
      aria-label="Сменить статус"
      data-status-menu
      onKeyDown={onKey}
      // Через портал события React всё равно всплывают к строке заказа
      // (ссылка, меню по правой кнопке, долгое нажатие) — дальше не пускаем.
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      className="fixed z-[95] max-h-[min(440px,calc(100vh-16px))] w-max min-w-[200px] max-w-[300px] overflow-y-auto rounded-field border border-line bg-surface-raised p-2 shadow-raised"
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
    >
      <p className="px-1.5 pb-1.5 text-[11px] font-bold uppercase tracking-[0.08em] text-ink-dim">Сменить статус</p>
      {statuses.map((s) => {
        const head = s.group !== lastGroup && statuses.filter((x) => x.group === s.group).length > 1 ? GROUP_LABEL[s.group] : null;
        lastGroup = s.group;
        const here = s.id === current;
        return (
          <div key={s.id}>
            {head && <p className="px-1.5 pb-0.5 pt-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-ink-dim/80">{head}</p>}
            <button
              type="button"
              role="menuitemradio"
              aria-checked={here}
              data-status-option={s.name}
              onClick={() => onPick(s)}
              className="flex w-full items-center gap-2 rounded-[8px] px-1.5 py-1 text-left hover:bg-surface-input focus:bg-surface-input focus:outline-none [@media(hover:none)]:py-1.5"
            >
              <span className={`tag tag-${TONE[s.group]} px-3 py-1 text-[12.5px] ` + (here ? "ring-2 ring-current ring-offset-1 ring-offset-surface-raised" : "")}>
                {s.name}
              </span>
              {here && <span className="ml-auto pl-2 text-[11.5px] text-ink-dim">сейчас</span>}
            </button>
          </div>
        );
      })}
      <p className="px-1.5 pt-1.5 text-[11px] leading-snug text-ink-dim">Выдают клиенту — из карточки заказа: там оплата.</p>
    </div>
  );
}
