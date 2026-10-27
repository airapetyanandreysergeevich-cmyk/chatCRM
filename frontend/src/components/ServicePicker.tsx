import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { money } from "../lib/orders";
import type { Service } from "../lib/services";
import { rootColor } from "./StockTree";
import { IconChevronDown, IconClose, IconFolder, IconSearch } from "./icons";
import { Button } from "./ui";

/**
 * Панель «+» в названии выполненной работы (Андрей, 28.10.2026): прайс
 * мастерской с категориями — «чтобы выбрать услугу, выбирая взглядом».
 *
 * Сверху поиск и «Частое», ниже категории — раскрываются щелчком (какие
 * раскрыты — помним на устройстве); внутри, как в проводнике, сначала папки
 * подкатегорий, потом услуги. Отмечать можно несколько услуг; внизу
 * «Отменить» и «Выбрать (N)». Клавиатура: ↑ ↓ — по услугам, пробел —
 * отметить, Enter — выбрать (ничего не отмечено — выбрать подсвеченную).
 * На компьютере панель у кнопки, на телефоне — снизу экрана.
 */

export interface PickerCategory {
  id: string;
  parentId: string | null;
  name: string;
  color?: string | null;
}

const OPEN_KEY = "finecrm.servicepicker.open";
const NONE = "none";

interface Group {
  id: string;
  name: string;
  depth: number;
  color: string;
  /** Услуги прямо в категории. */
  services: Service[];
  /** Вместе с подкатегориями — для числа у заголовка. */
  total: number;
  parentId: string | null;
}

export function ServicePicker({
  services,
  categories,
  anchor,
  onClose,
  onPick,
}: {
  services: Service[];
  categories: PickerCategory[];
  /** Кнопка, у которой открылась панель (на компьютере панель встаёт у неё). */
  anchor: HTMLElement | null;
  onClose: () => void;
  onPick: (picked: Service[]) => void;
}) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string[]>([]);
  const [hi, setHi] = useState(0);
  const [open, setOpen] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(OPEN_KEY) ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const sheet = typeof window !== "undefined" && window.matchMedia("(max-width: 639px)").matches;
  const [pos, setPos] = useState<{ left: number; top: number; maxH: number } | null>(null);

  // Дерево категорий по порядку: верхний уровень, под ним подкатегории.
  const groups = useMemo<Group[]>(() => {
    const byParent = new Map<string | null, PickerCategory[]>();
    for (const c of categories) byParent.set(c.parentId, [...(byParent.get(c.parentId) ?? []), c]);
    for (const l of byParent.values()) l.sort((a, b) => a.name.localeCompare(b.name, "ru"));
    const known = new Set(categories.map((c) => c.id));
    const direct = new Map<string, Service[]>();
    for (const s of services) {
      const k = s.categoryId && known.has(s.categoryId) ? s.categoryId : NONE;
      direct.set(k, [...(direct.get(k) ?? []), s]);
    }
    for (const l of direct.values()) l.sort((a, b) => a.name.localeCompare(b.name, "ru"));
    const out: Group[] = [];
    const walk = (parent: string | null, depth: number, color: string | null): number => {
      let sum = 0;
      for (const c of byParent.get(parent) ?? []) {
        const col = color ?? rootColor(c);
        const g: Group = { id: c.id, name: c.name, depth, color: col, services: direct.get(c.id) ?? [], total: 0, parentId: c.parentId };
        out.push(g);
        g.total = g.services.length + walk(c.id, depth + 1, col);
        sum += g.total;
      }
      return sum;
    };
    walk(null, 0, null);
    const none = direct.get(NONE) ?? [];
    if (none.length) out.push({ id: NONE, name: categories.length ? "Без категории" : "Все услуги", depth: 0, color: "#8A93A6", services: none, total: none.length, parentId: null });
    return out.filter((g) => g.total > 0);
  }, [services, categories]);

  const needle = q.trim().toLowerCase();
  const hit = (s: Service) => !needle || s.name.toLowerCase().includes(needle) || (s.note ?? "").toLowerCase().includes(needle);
  const byId = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups]);
  /** Видна ли группа: все её предки раскрыты (при поиске — всё раскрыто). */
  const visibleGroup = (g: Group) => {
    if (needle) return true;
    for (let p = g.parentId ? byId.get(g.parentId) : undefined; p; p = p.parentId ? byId.get(p.parentId) : undefined) if (!open.has(p.id)) return false;
    return true;
  };
  const isOpen = (g: Group) => !!needle || open.has(g.id) || (groups.length === 1 && g.id === NONE);
  // Подкатегории с совпадениями при поиске — тоже видны; пустые — нет.
  const matchesIn = (g: Group): number => g.services.filter(hit).length + groups.filter((x) => x.parentId === g.id).reduce((n, x) => n + matchesIn(x), 0);
  const shownGroups = groups.filter((g) => visibleGroup(g) && (!needle || matchesIn(g) > 0));
  // Как папки в проводнике (Андрей, 28.10.2026): внутри категории сначала
  // подкатегории, потом услуги.
  const kidsOf = (id: string | null) => shownGroups.filter((x) => x.parentId === id && (id !== null || x.depth === 0));
  /** Услуги по порядку на экране — для стрелок. */
  const flatOf = (g: Group): Service[] => (isOpen(g) ? [...kidsOf(g.id).flatMap(flatOf), ...g.services.filter(hit)] : []);
  const flat = kidsOf(null).flatMap(flatOf);
  const pinned = services.filter((s) => s.isPinned).slice(0, 8);

  const toggleGroup = (id: string) =>
    setOpen((o) => {
      const n = new Set(o);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      try {
        localStorage.setItem(OPEN_KEY, JSON.stringify([...n]));
      } catch {
        /* не запомнили — не беда */
      }
      return n;
    });
  const toggle = (id: string) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const picked = sel.map((id) => services.find((s) => s.id === id)).filter((s): s is Service => !!s);
  const sum = picked.reduce((n, s) => n + s.price, 0);

  const confirm = () => {
    if (picked.length) return onPick(picked);
    const h = flat[hi];
    if (h) onPick([h]);
  };

  useEffect(() => setHi(0), [needle]);
  useEffect(() => {
    input.current?.focus({ preventScroll: true });
  }, []);

  // Место панели: под кнопкой, по правому краю; не помещается снизу — над ней.
  useLayoutEffect(() => {
    if (sheet) return;
    const place = () => {
      const r = anchor?.getBoundingClientRect();
      const w = 400;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      if (!r) return setPos({ left: Math.max(8, (vw - w) / 2), top: 80, maxH: vh - 120 });
      const below = vh - r.bottom - 16;
      const above = r.top - 16;
      const left = Math.min(Math.max(8, r.right - w), vw - w - 8);
      if (below >= 420 || below >= above) setPos({ left, top: r.bottom + 6, maxH: Math.min(600, below) });
      else {
        const h = Math.min(600, above);
        setPos({ left, top: r.top - 6 - h, maxH: h });
      }
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchor, sheet]);

  // Щелчок мимо панели и Esc — закрыть, как «Отменить».
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (box.current?.contains(e.target as Node) || anchor?.contains(e.target as Node)) return;
      onClose();
    };
    document.addEventListener("pointerdown", down);
    return () => document.removeEventListener("pointerdown", down);
  }, [anchor, onClose]);

  // Подсвеченная строка — в зоне видимости.
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-hi="1"]`)?.scrollIntoView({ block: "nearest" });
  }, [hi]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (q) setQ("");
      else onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setHi((h) => Math.min(flat.length - 1, h + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHi((h) => Math.max(0, h - 1));
    } else if (e.key === " " && (e.target as HTMLElement).tagName !== "INPUT" && flat[hi]) {
      e.preventDefault();
      toggle(flat[hi].id);
    } else if (e.key === "Enter") {
      // Отмечено — выбрать отмеченные; ничего не отмечено — подсвеченную.
      e.preventDefault();
      confirm();
    }
  };

  let index = -1;
  const renderGroup = (g: Group): React.ReactNode => {
    const opened = isOpen(g);
    return (
      <div key={g.id} data-picker-group={g.name} data-open={opened ? "1" : "0"}>
        <button
          type="button"
          onClick={() => !needle && toggleGroup(g.id)}
          aria-expanded={opened}
          className={
            "flex w-full items-center gap-2 rounded-[9px] py-2 pr-2.5 text-left text-[13.5px] hover:bg-surface-input " +
            (g.depth === 0 ? "font-bold" : "font-semibold")
          }
          style={{ paddingLeft: 8 + g.depth * 18 }}
        >
          <IconChevronDown className={"h-3.5 w-3.5 shrink-0 text-ink-dim transition-transform " + (opened ? "" : "-rotate-90")} />
          {g.depth === 0 ? (
            <span className="mx-[3px] h-[9px] w-[9px] shrink-0 rounded-full" style={{ background: g.color }} />
          ) : (
            <IconFolder className="h-4 w-4 shrink-0" style={{ color: g.color }} />
          )}
          <span className="min-w-0 flex-1 truncate">{g.name}</span>
          <span className="font-mono text-[11.5px] font-medium text-ink-dim">{needle ? matchesIn(g) : g.total}</span>
        </button>
        {opened && kidsOf(g.id).map(renderGroup)}
        {opened &&
          g.services.filter(hit).map((s) => {
            index += 1;
            const i = index;
            const on = sel.includes(s.id);
            return (
              <button
                key={s.id}
                type="button"
                role="checkbox"
                aria-checked={on}
                data-hi={i === hi ? "1" : undefined}
                data-picker-service={s.name}
                onMouseEnter={() => setHi(i)}
                onClick={() => toggle(s.id)}
                className={
                  "flex w-full items-center gap-2.5 rounded-[9px] py-[7px] pr-2.5 text-left text-[13.5px] " +
                  (on ? "bg-brand/15 text-ink " : "text-ink-soft ") +
                  (i === hi ? "ring-1 ring-inset ring-brand/50 " : "")
                }
                style={{ paddingLeft: 30 + g.depth * 18 }}
              >
                <span
                  className={
                    "flex h-[17px] w-[17px] shrink-0 items-center justify-center rounded-[5px] border-[1.6px] " +
                    (on ? "border-brand bg-brand text-white" : "border-line-strong bg-surface-input")
                  }
                >
                  {on && (
                    <svg viewBox="0 0 12 10" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 5l3.5 3.5L11 1.5" />
                    </svg>
                  )}
                </span>
                <span className="min-w-0 flex-1 truncate" title={s.note ?? undefined}>
                  {s.name}
                </span>
                <span className="shrink-0 font-semibold tabular-nums text-ink-muted">{s.price ? money(s.price) : "—"}</span>
              </button>
            );
          })}
      </div>
    );
  };
  const panel = (
    <div
      ref={box}
      role="dialog"
      aria-label="Услуги из прайса"
      data-service-picker
      onKeyDown={onKey}
      className={
        sheet
          ? "fixed inset-x-0 bottom-0 z-[95] flex max-h-[82vh] flex-col rounded-t-[20px] border border-line-strong bg-surface-raised shadow-modal"
          : "fixed z-[95] flex w-[400px] flex-col overflow-hidden rounded-[14px] border border-line-strong bg-surface-raised shadow-modal"
      }
      style={sheet ? undefined : { left: pos?.left ?? -9999, top: pos?.top ?? -9999, maxHeight: pos?.maxH ?? 500 }}
    >
      {sheet && <div className="mx-auto mt-2 h-[4px] w-10 rounded-full bg-line-strong" />}
      <div className="border-b border-line p-2.5">
        <label className="flex items-center gap-2 rounded-[10px] border border-line bg-surface-input px-3">
          <IconSearch className="h-4 w-4 shrink-0 text-ink-dim" />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Найти услугу"
            aria-label="Найти услугу"
            className="h-10 min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-ink-dim"
            data-picker-search
          />
          {q && (
            <button type="button" aria-label="Очистить" onClick={() => setQ("")} className="-mr-1 flex h-7 w-7 items-center justify-center rounded-[7px] text-ink-dim hover:text-ink [&>svg]:h-3.5 [&>svg]:w-3.5">
              <IconClose />
            </button>
          )}
        </label>
      </div>

      <div ref={list} className="min-h-0 flex-1 overflow-y-auto p-1.5" data-picker-list>
        {!needle && pinned.length > 0 && (
          <>
            <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-bold uppercase tracking-[0.1em] text-ink-dim">Частое</p>
            <div className="flex flex-wrap gap-1.5 px-2.5 pb-2.5">
              {pinned.map((s) => {
                const on = sel.includes(s.id);
                return (
                  <button
                    key={s.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggle(s.id)}
                    data-picker-pinned={s.name}
                    className={
                      "rounded-pill border px-2.5 py-1 text-[12.5px] font-semibold transition-colors " +
                      (on ? "border-brand bg-brand-tint text-ink" : "border-line bg-surface-input text-ink-soft hover:border-line-strong hover:text-ink")
                    }
                  >
                    {on ? "✓ " : ""}
                    {s.name}
                  </button>
                );
              })}
            </div>
            <div className="mx-1.5 mb-1 h-px bg-line" />
          </>
        )}

        {kidsOf(null).map(renderGroup)}
        {!shownGroups.length && <p className="px-3 py-4 text-center text-[13px] text-ink-dim">{needle ? "Такой услуги в прайсе нет" : "Прайс пуст — заполните «Настройки → Услуги»"}</p>}
      </div>

      <div className="flex items-center gap-2 border-t border-line p-2.5 pb-[max(10px,env(safe-area-inset-bottom))]">
        <span className="min-w-0 flex-1 truncate px-1 text-[12.5px] text-ink-muted" data-picker-summary>
          {picked.length ? `Отмечено: ${picked.length} · ${money(sum)}` : "Отметьте одну или несколько"}
        </span>
        <Button type="button" variant="secondary" className="min-h-[38px] px-3.5 text-[13.5px]" onClick={onClose} data-picker-cancel>
          Отменить
        </Button>
        <Button type="button" className="min-h-[38px] px-3.5 text-[13.5px]" disabled={!picked.length} onClick={confirm} data-picker-ok>
          {picked.length ? `Выбрать (${picked.length})` : "Выбрать"}
        </Button>
      </div>
    </div>
  );

  return createPortal(
    <>
      {sheet && <div className="fixed inset-0 z-[94] bg-[rgba(6,8,13,.6)]" onClick={onClose} />}
      {panel}
    </>,
    document.body
  );
}
