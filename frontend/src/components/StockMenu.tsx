import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { IconChevronLeft, IconChevronRight, IconClose, IconPlus, IconSearch } from "./icons";
import { Button } from "./ui";
import { flatTree, type TreeNode } from "./StockTree";

/**
 * Меню склада по правой кнопке: у позиций и у категорий.
 *
 * На компьютере — у курсора, подменю («Переместить в», «Наценка») выезжает
 * справа. На телефоне — долгое нажатие, лист снизу; подменю открывается в
 * том же листе со стрелкой «назад». Устроено как меню заказа
 * (components/OrderMenu.tsx), но пункты задаёт тот, кто открывает.
 */

export type MenuEntry =
  | { sep: true }
  | { node: ReactNode }
  | {
      label: string;
      icon?: ReactNode;
      hint?: string;
      danger?: boolean;
      disabled?: boolean;
      onClick?: () => void;
      /** Подменю: содержимое панели; close — закрыть всё меню. */
      sub?: (close: () => void) => ReactNode;
    };

export interface MenuAt {
  x: number;
  y: number;
  /** Телефон: лист снизу вместо меню у курсора. */
  sheet: boolean;
  title: string;
}

const LONG_PRESS = 550;

/**
 * Обработчики для строки или карточки: правая кнопка мыши и долгое нажатие
 * пальцем открывают меню; отпускание пальца после долгого нажатия не
 * считается щелчком.
 */
export function useMenuTrigger() {
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const suppress = useRef(false);
  const pointer = useRef("mouse");

  return useCallback(
    (open: (x: number, y: number, sheet: boolean) => void) => ({
      onContextMenu: (e: React.MouseEvent) => {
        const touch = pointer.current === "touch" || pointer.current === "pen";
        // Правая кнопка по полю ввода — родное меню браузера (вставить, проверка орфографии).
        if (!touch && (e.target as Element).closest?.("input,textarea")) return;
        e.preventDefault();
        e.stopPropagation();
        if (touch) {
          // Android присылает contextmenu на долгое нажатие — лист уже открыт таймером или откроется сейчас.
          if (press.current) clearTimeout(press.current.timer);
          press.current = null;
          suppress.current = true;
          open(0, 0, true);
          return;
        }
        open(e.clientX, e.clientY, false);
      },
      onPointerDown: (e: React.PointerEvent) => {
        pointer.current = e.pointerType;
        if (e.pointerType === "mouse") return;
        if (press.current) clearTimeout(press.current.timer);
        const x = e.clientX, y = e.clientY;
        press.current = {
          x,
          y,
          timer: setTimeout(() => {
            press.current = null;
            suppress.current = true;
            navigator.vibrate?.(12);
            open(x, y, true);
          }, LONG_PRESS),
        };
      },
      onPointerMove: (e: React.PointerEvent) => {
        const p = press.current;
        if (p && Math.abs(e.clientX - p.x) + Math.abs(e.clientY - p.y) > 10) {
          clearTimeout(p.timer);
          press.current = null;
        }
      },
      onPointerUp: () => {
        if (press.current) clearTimeout(press.current.timer);
        press.current = null;
      },
      onPointerCancel: () => {
        if (press.current) clearTimeout(press.current.timer);
        press.current = null;
      },
      onClickCapture: (e: React.MouseEvent) => {
        if (suppress.current) {
          suppress.current = false;
          e.preventDefault();
          e.stopPropagation();
        }
      },
    }),
    []
  );
}

export function ContextMenu({ at, entries, onClose }: { at: MenuAt; entries: MenuEntry[]; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const subBox = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: at.x, top: at.y, ready: at.sheet });
  /** Открытое подменю: номер пункта и где оно встаёт (компьютер). */
  const [sub, setSub] = useState<{ i: number; left: number; top: number; ready: boolean } | null>(null);
  /**
   * Лист на телефоне открывается долгим нажатием прямо под пальцем, и
   * отпускание пальца браузер может засчитать щелчком по пункту, оказавшемуся
   * под ним. Поэтому пункты листа срабатывают только после нового касания.
   */
  const armed = useRef(!at.sheet);
  const arm = () => void (armed.current = true);

  // У края окна — открываемся влево и вверх.
  useLayoutEffect(() => {
    if (at.sheet || !box.current) return;
    const r = box.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(at.x + 2, window.innerWidth - r.width - 8));
    const top = at.y + r.height + 8 > window.innerHeight ? Math.max(8, at.y - r.height - 2) : at.y + 4;
    setPos({ left, top, ready: true });
  }, [at]);

  useLayoutEffect(() => {
    if (at.sheet || !sub || sub.ready || !subBox.current || !box.current) return;
    const menu = box.current.getBoundingClientRect();
    const r = subBox.current.getBoundingClientRect();
    const right = menu.right + 4;
    const left = right + r.width + 8 > window.innerWidth ? Math.max(8, menu.left - r.width - 4) : right;
    const top = Math.max(8, Math.min(sub.top, window.innerHeight - r.height - 8));
    setSub({ ...sub, left, top, ready: true });
  }, [at.sheet, sub]);

  // Фокус — на первый пункт, когда меню уже видно.
  useEffect(() => {
    if (!pos.ready || at.sheet) return;
    box.current?.querySelector<HTMLElement>("[role=menuitem]:not([disabled])")?.focus({ preventScroll: true });
  }, [pos.ready, at.sheet]);

  useEffect(() => {
    const inside = (t: EventTarget | null) => box.current?.contains(t as Node) || subBox.current?.contains(t as Node);
    const down = (e: Event) => {
      if (inside(e.target)) return;
      onClose();
    };
    const opened = Date.now();
    const close = () => onClose();
    const scrolled = (e: Event) => !inside(e.target) && Date.now() - opened > 200 && onClose();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !inside(document.activeElement)) onClose();
    };
    document.addEventListener("keydown", key);
    document.addEventListener("mousedown", down);
    document.addEventListener("touchstart", down);
    if (!at.sheet) window.addEventListener("scroll", scrolled, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("keydown", key);
      document.removeEventListener("mousedown", down);
      document.removeEventListener("touchstart", down);
      window.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [at.sheet, onClose]);

  const openSub = (i: number, el: HTMLElement) => {
    if (sub?.i === i) return;
    const r = el.getBoundingClientRect();
    setSub({ i, left: r.right, top: r.top - 6, ready: false });
  };

  function onKey(e: React.KeyboardEvent) {
    const scope = (e.target as HTMLElement).closest("[data-menu-panel]") as HTMLElement | null;
    const items = [...(scope?.querySelectorAll<HTMLElement>("[role=menuitem]:not([disabled])") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const inSub = scope === subBox.current;
    if (e.key === "Escape") {
      e.preventDefault();
      if (sub) {
        const back = box.current?.querySelector<HTMLElement>(`[data-entry="${sub.i}"]`);
        setSub(null);
        back?.focus();
      } else onClose();
    } else if (e.key === "ArrowDown" && items.length && !(e.target as HTMLElement).matches("input")) {
      e.preventDefault();
      items[(i + 1) % items.length]?.focus();
    } else if (e.key === "ArrowUp" && items.length && !(e.target as HTMLElement).matches("input")) {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    } else if (e.key === "ArrowRight" && (document.activeElement as HTMLElement)?.dataset.sub) {
      e.preventDefault();
      (document.activeElement as HTMLElement).click();
    } else if (e.key === "ArrowLeft" && (inSub || (at.sheet && sub))) {
      e.preventDefault();
      setSub(null);
    }
  }

  // Подменю выехало — фокус в него (поле поиска или первый пункт).
  useEffect(() => {
    if (!sub || at.sheet || !sub.ready) return;
    const target = subBox.current?.querySelector<HTMLElement>("input,[role=menuitem]:not([disabled])");
    target?.focus({ preventScroll: true });
  }, [sub, at.sheet]);

  const big = at.sheet;
  const item = (e: MenuEntry, i: number) => {
    if ("sep" in e) return <div key={i} role="separator" className="my-1 border-t border-line" />;
    if ("node" in e) return <div key={i}>{e.node}</div>;
    return (
      <MenuItem
        key={i}
        big={big}
        data-entry={i}
        icon={e.icon}
        hint={e.hint}
        danger={e.danger}
        disabled={e.disabled}
        sub={!!e.sub}
        active={sub?.i === i}
        onHover={(el) => (!at.sheet && e.sub && !e.disabled ? openSub(i, el) : !at.sheet && sub && setSub(null))}
        onClick={(el) => {
          if (!armed.current) return;
          if (e.sub) return at.sheet ? setSub({ i, left: 0, top: 0, ready: true }) : openSub(i, el);
          onClose();
          e.onClick?.();
        }}
      >
        {e.label}
      </MenuItem>
    );
  };

  const subEntry = sub ? entries[sub.i] : null;
  const subBody = subEntry && "sub" in subEntry && subEntry.sub ? subEntry.sub(onClose) : null;

  if (at.sheet) {
    return (
      <div className="fixed inset-0 z-[70] flex items-end bg-[rgba(6,8,13,.55)]" onContextMenu={(e) => e.preventDefault()} onPointerDownCapture={arm} onKeyDownCapture={arm}>
        <div
          ref={box}
          role="menu"
          data-menu-panel
          aria-label={at.title}
          onKeyDown={onKey}
          data-stock-menu
          className="max-h-[85vh] w-full overflow-y-auto rounded-t-panel border-t border-line bg-surface-raised pb-[max(12px,env(safe-area-inset-bottom))] pt-2 shadow-modal"
        >
          {subBody && subEntry && "label" in subEntry ? (
            <>
              <MenuItem big icon={<IconChevronLeft className="h-[17px] w-[17px]" />} onClick={() => armed.current && setSub(null)}>
                {subEntry.label}
              </MenuItem>
              <div className="my-1 border-t border-line" />
              <div className="px-2">{subBody}</div>
            </>
          ) : (
            <>
              <p className="truncate px-4 pb-2 pt-1 text-[12px] font-bold uppercase tracking-[0.07em] text-ink-dim">{at.title}</p>
              {entries.map(item)}
            </>
          )}
          <div className="px-4 pt-2">
            <Button type="button" variant="secondary" className="w-full" onClick={() => armed.current && onClose()}>
              Закрыть
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div
        ref={box}
        role="menu"
        data-menu-panel
        data-stock-menu
        aria-label={at.title}
        onKeyDown={onKey}
        onContextMenu={(e) => e.preventDefault()}
        className="fixed z-[90] max-h-[calc(100vh-16px)] w-[256px] overflow-y-auto rounded-field border border-line bg-surface-raised py-1 shadow-raised"
        style={{ left: pos.left, top: pos.top, visibility: pos.ready ? "visible" : "hidden" }}
      >
        <p className="truncate px-3 pb-1 pt-1 text-[11.5px] font-bold uppercase tracking-[0.07em] text-ink-dim">{at.title}</p>
        {entries.map(item)}
      </div>
      {sub && subBody && (
        <div
          ref={subBox}
          role="menu"
          data-menu-panel
          data-stock-submenu
          onKeyDown={onKey}
          onContextMenu={(e) => e.preventDefault()}
          className="fixed z-[91] max-h-[calc(100vh-16px)] w-[272px] overflow-y-auto rounded-field border border-line bg-surface-raised p-1 shadow-raised"
          style={{ left: sub.left, top: sub.top, visibility: sub.ready ? "visible" : "hidden" }}
        >
          {subBody}
        </div>
      )}
    </>
  );
}

export function MenuItem({
  icon,
  children,
  onClick,
  onHover,
  sub,
  danger,
  hint,
  disabled,
  active,
  big,
  ...rest
}: {
  icon?: ReactNode;
  children: ReactNode;
  onClick: (el: HTMLElement) => void;
  onHover?: (el: HTMLElement) => void;
  sub?: boolean;
  danger?: boolean;
  hint?: string;
  disabled?: boolean;
  active?: boolean;
  big?: boolean;
  "data-entry"?: number;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      data-sub={sub ? "1" : undefined}
      disabled={disabled}
      onClick={(e) => onClick(e.currentTarget)}
      onMouseEnter={(e) => onHover?.(e.currentTarget)}
      {...rest}
      className={
        "flex w-full items-center gap-2.5 text-left transition-colors duration-100 hover:bg-surface-input focus:bg-surface-input focus:outline-none disabled:opacity-45 disabled:hover:bg-transparent " +
        (big ? "min-h-[48px] px-4 text-[15px] " : "rounded-[9px] px-3 py-[7px] text-[13.5px] ") +
        (active ? "bg-surface-input " : "") +
        (danger ? "text-state-off" : "text-ink")
      }
    >
      <span className={"flex w-[18px] shrink-0 justify-center " + (danger ? "" : "text-ink-dim")}>{icon}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="max-w-[45%] shrink-0 truncate text-[12px] text-ink-dim">{hint}</span>}
      {sub && <IconChevronRight className="h-4 w-4 shrink-0 text-ink-dim" />}
    </button>
  );
}

/**
 * Выбор категории: поиск и дерево. none — строка «Без категории» (или «На
 * верхний уровень» для категорий); exclude — куда нельзя (сама категория и
 * её подкатегории при переносе категории).
 */
export function CategoryPicker({
  roots,
  colors,
  current,
  exclude,
  none,
  onPick,
  onNew,
  big,
}: {
  roots: TreeNode[];
  colors: Map<string, string>;
  current?: string | null;
  exclude?: Set<string>;
  none?: string;
  onPick: (id: string | null) => void;
  onNew?: () => void;
  big?: boolean;
}) {
  const [q, setQ] = useState("");
  const flat = useMemo(() => flatTree(roots).filter((n) => !exclude?.has(n.id)), [roots, exclude]);
  const needle = q.trim().toLowerCase();
  const shown = needle ? flat.filter((n) => n.name.toLowerCase().includes(needle)) : flat;
  const row = big ? "min-h-[46px] px-3 text-[15px]" : "py-[7px] px-2.5 text-[13.5px]";
  return (
    <div data-category-picker>
      <label className="mb-1 flex items-center gap-2 rounded-[9px] border border-line bg-surface-input px-2.5">
        <IconSearch className="h-4 w-4 shrink-0 text-ink-dim" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Найти категорию"
          aria-label="Найти категорию"
          className="h-9 min-w-0 flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-ink-dim"
          onKeyDown={(e) => {
            if (e.key === "Enter" && shown.length) {
              e.preventDefault();
              onPick(shown[0].id);
            }
            if (e.key === "Escape" && q) {
              e.preventDefault();
              e.stopPropagation();
              setQ("");
            }
          }}
        />
        {q && (
          <button
            type="button"
            data-search-clear
            aria-label="Очистить поиск"
            onClick={() => setQ("")}
            className="-mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] text-ink-dim hover:bg-surface-raised hover:text-ink [&>svg]:h-3.5 [&>svg]:w-3.5"
          >
            <IconClose />
          </button>
        )}
      </label>
      <div className="max-h-[300px] overflow-y-auto">
        {none && !needle && (
          <button type="button" role="menuitem" onClick={() => onPick(null)} className={"flex w-full items-center gap-2 rounded-[9px] text-left text-ink-soft hover:bg-surface-input focus:bg-surface-input focus:outline-none " + row}>
            <span className="h-[9px] w-[9px] shrink-0 rounded-[3px] border border-line-strong" />
            <span className="min-w-0 flex-1 truncate">{none}</span>
            {current === null && <span className="text-[12px] text-ink-dim">сейчас</span>}
          </button>
        )}
        {shown.map((n) => (
          <button
            key={n.id}
            type="button"
            role="menuitem"
            onClick={() => onPick(n.id)}
            className={"flex w-full items-center gap-2 rounded-[9px] text-left hover:bg-surface-input focus:bg-surface-input focus:outline-none " + row}
            style={{ paddingLeft: needle ? undefined : `${(big ? 12 : 10) + n.depth * 16}px` }}
          >
            {n.depth === 0 ? <span className="h-[9px] w-[9px] shrink-0 rounded-[3px]" style={{ background: colors.get(n.id) }} /> : <span className="w-[9px] shrink-0" />}
            <span className="min-w-0 flex-1 truncate">{n.name}</span>
            {n.id === current ? <span className="text-[12px] text-ink-dim">сейчас</span> : <span className="font-mono text-[11.5px] text-ink-dim">{n.total}</span>}
          </button>
        ))}
        {needle && !shown.length && <p className="px-3 py-2 text-[13px] text-ink-dim">Такой категории нет</p>}
      </div>
      {onNew && (
        <button
          type="button"
          role="menuitem"
          onClick={onNew}
          className={"mt-1 flex w-full items-center gap-2 border-t border-line text-left font-semibold text-brand-ink hover:bg-surface-input focus:bg-surface-input focus:outline-none " + row}
        >
          <IconPlus className="h-4 w-4" />
          Новая категория…
        </button>
      )}
    </div>
  );
}
