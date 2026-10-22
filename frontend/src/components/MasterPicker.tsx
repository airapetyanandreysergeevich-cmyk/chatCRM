import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { shortName } from "../lib/format";
import type { Reference } from "../lib/orders";

/**
 * Мастер заказа — кнопкой в списке заказов и в таблице (Андрей, 22.10.2026):
 * щелчок — мастера мастерской с числом заказов в работе у каждого, у
 * пустых — «+ Назначить». Менять может тот, у кого право «Назначает и меняет
 * мастера»; у остальных имя — просто текстом.
 */
export function MasterPicker({
  number,
  master,
  masters,
  canChange,
  onPick,
  className = "",
}: {
  number: string;
  master: { id: string; fullName: string } | null;
  masters: Reference["masters"] | undefined;
  canChange: boolean;
  onPick: (m: { id: string; fullName: string } | null) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);

  if (!canChange || !masters) {
    return master ? (
      <span className={"truncate " + className} title={master.fullName}>
        {shortName(master.fullName)}
      </span>
    ) : (
      <span className="text-ink-dim">—</span>
    );
  }

  return (
    <>
      <button
        ref={btn}
        type="button"
        data-master-picker={number}
        aria-haspopup="menu"
        aria-expanded={open}
        title={master ? `Мастер: ${master.fullName}. Сменить` : "Назначить мастера"}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className={
          "inline-flex max-w-full items-center gap-1 rounded-[8px] px-1.5 py-0.5 text-left transition-colors duration-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand " +
          (master
            ? "hover:bg-surface-raised hover:text-ink"
            : "border border-dashed border-brand/50 text-brand-ink hover:bg-brand-tint") +
          (open ? " bg-surface-raised" : "") +
          " " +
          className
        }
      >
        <span className="min-w-0 truncate">{master ? shortName(master.fullName) : "+ Назначить"}</span>
        {master && (
          <svg aria-hidden viewBox="0 0 16 16" className="h-3 w-3 shrink-0 opacity-50" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="m4 6 4 4 4-4" />
          </svg>
        )}
      </button>
      {open &&
        btn.current &&
        createPortal(
          <Menu
            anchor={btn.current}
            number={number}
            current={master?.id ?? null}
            masters={masters}
            onClose={() => setOpen(false)}
            onPick={(m) => {
              setOpen(false);
              if ((m?.id ?? null) !== (master?.id ?? null)) onPick(m);
            }}
          />,
          document.body
        )}
    </>
  );
}

function Menu({
  anchor,
  number,
  current,
  masters,
  onClose,
  onPick,
}: {
  anchor: HTMLElement;
  number: string;
  current: string | null;
  masters: Reference["masters"];
  onClose: () => void;
  onPick: (m: { id: string; fullName: string } | null) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const w = box.current?.offsetWidth ?? 250;
    const h = box.current?.offsetHeight ?? 260;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    const below = r.bottom + 6;
    setPos({ left, top: below + h + 8 > window.innerHeight ? Math.max(8, r.top - h - 6) : below });
  }, [anchor]);

  useEffect(() => {
    box.current?.querySelector<HTMLElement>('[aria-checked="true"], [role=menuitemradio]')?.focus({ preventScroll: true });
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

  const item = "flex w-full items-center gap-2.5 rounded-[9px] px-2 py-1.5 text-left text-[13.5px] hover:bg-surface-input focus:bg-surface-input focus:outline-none [@media(hover:none)]:py-2";
  return (
    <div
      ref={box}
      role="menu"
      aria-label={`Мастер заказа ${number}`}
      data-master-menu
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      className="fixed z-[95] max-h-[min(420px,calc(100vh-16px))] w-[260px] max-w-[calc(100vw-16px)] overflow-y-auto rounded-field border border-line bg-surface-raised p-1.5 shadow-raised"
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
    >
      <p className="px-2 pb-1.5 pt-1 text-[11px] font-bold uppercase tracking-[0.08em] text-ink-dim">Мастер · {number}</p>
      {masters.map((m) => (
        <button
          key={m.id}
          type="button"
          role="menuitemradio"
          aria-checked={m.id === current}
          data-master-option={m.fullName}
          onClick={() => onPick({ id: m.id, fullName: m.fullName })}
          className={item + (m.id === current ? " bg-surface-input/70" : "")}
        >
          <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full bg-surface-input text-[11px] font-bold text-ink-soft">
            {m.fullName.trim()[0]?.toUpperCase() ?? "?"}
          </span>
          <span className="min-w-0 flex-1 truncate">
            {m.fullName}
            {m.isOwner ? <span className="text-ink-dim"> · владелец</span> : m.isCoOwner ? <span className="text-ink-dim"> · совладелец</span> : null}
          </span>
          <span className="shrink-0 text-[12px] text-ink-dim" title="Заказов в работе">
            {m.active ?? 0}
          </span>
        </button>
      ))}
      <div className="my-1 h-px bg-line" />
      <button type="button" role="menuitemradio" aria-checked={current === null} data-master-option="" onClick={() => onPick(null)} className={item + " text-ink-muted"}>
        Не назначен
      </button>
      <p className="px-2 pb-1 pt-1 text-[11px] text-ink-dim">Число справа — заказов в работе.</p>
    </div>
  );
}
