import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Modal } from "../components/Modal";
import { IconChevronDown, IconClose, IconDelete, IconEdit, IconFolder, IconMore, IconPlus, IconServices } from "../components/icons";
import { buildTree, CategoryDialog, flatTree, indent, rootColor, STOCK_PALETTE, type CategoryDialogKind, type TreeNode } from "../components/StockTree";
import { CategoryPicker, Check, ContextMenu, tidy, useMenuTrigger, type MenuAt, type MenuEntry } from "../components/StockMenu";
import { Badge, Banner, Button, Card, Checkbox, EmptyState, Field, Input, PageHeader, SearchInput, Select, Spinner } from "../components/ui";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { plural } from "../lib/format";
import { money } from "../lib/orders";
import { PINNED_LIMIT, servicesApi, type Service, type ServiceCategory } from "../lib/services";

/**
 * Прайс мастерской — с категориями, как склад (Андрей, 28.10.2026).
 *
 * Категории верхнего уровня — цветные карточки, раскрываются щелчком;
 * внутри — услуги категории и её подкатегории подзаголовками. Галочки —
 * действия разом (перенести, удалить), правая кнопка или «⋯» — меню.
 * Щелчок по услуге — правка; Ctrl или Shift — отметить.
 *
 * Отсюда берутся подсказки и панель «+» при наборе выполненных работ,
 * поэтому список стоит держать в порядке: чем точнее названия, тем реже
 * мастер пишет своё.
 */

const NONE = "none";
const NONE_COLOR = "#8A93A6";
const OPEN_KEY = "finecrm.services.open";

const readOpen = (): Set<string> | null => {
  try {
    const raw = localStorage.getItem(OPEN_KEY);
    return raw ? new Set(JSON.parse(raw) as string[]) : null;
  } catch {
    return null;
  }
};

type Editing = { service: Service | null; categoryId: string | null; copyOf?: Service };

export default function Services() {
  const { can } = useAuth();
  const canEdit = can("settings.manage");
  const [rows, setRows] = useState<Service[] | null>(null);
  const [cats, setCats] = useState<ServiceCategory[]>([]);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; tone?: "error" } | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [catDialog, setCatDialog] = useState<CategoryDialogKind | null>(null);
  const [menu, setMenu] = useState<{ at: MenuAt; entries: MenuEntry[] } | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null);
  const [open, setOpenState] = useState<Set<string> | null>(readOpen);
  const trigger = useMenuTrigger();

  const load = useCallback(async () => {
    try {
      const [list, c] = await Promise.all([servicesApi.list(), servicesApi.categories()]);
      setRows(list);
      setCats(c.items);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось загрузить услуги");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 3500);
    return () => clearTimeout(t);
  }, [notice]);

  const roots = useMemo(() => buildTree(cats), [cats]);
  const nodeById = useMemo(() => new Map(flatTree(roots).map((n) => [n.id, n])), [roots]);
  /** Цвет категории — цвет её карточки верхнего уровня. */
  const colorOf = useMemo(() => {
    const m = new Map<string, string>();
    const go = (n: TreeNode, c: string) => (m.set(n.id, c), n.children.forEach((k) => go(k, c)));
    roots.forEach((r) => go(r, rootColor(r)));
    return m;
  }, [roots]);
  const pathOf = (id: string | null | undefined): string => {
    const parts: string[] = [];
    for (let n = id ? nodeById.get(id) : undefined; n; n = n.parentId ? nodeById.get(n.parentId) : undefined) parts.unshift(n.name);
    return parts.join(" › ");
  };

  const q = search.trim().toLowerCase();
  const filtering = q.length > 0;
  const match = (s: Service) =>
    !q || s.name.toLowerCase().includes(q) || (s.note ?? "").toLowerCase().includes(q) || pathOf(s.categoryId).toLowerCase().includes(q);
  const visible = useMemo(() => (rows ?? []).filter(match), [rows, q, nodeById]); // eslint-disable-line react-hooks/exhaustive-deps
  const direct = useMemo(() => {
    const m = new Map<string, Service[]>();
    for (const s of visible) {
      const k = s.categoryId && nodeById.has(s.categoryId) ? s.categoryId : NONE;
      m.set(k, [...(m.get(k) ?? []), s]);
    }
    for (const list of m.values()) list.sort((a, b) => a.name.localeCompare(b.name, "ru"));
    return m;
  }, [visible, nodeById]);
  /** Услуги категории вместе с подкатегориями. */
  const allOf = (n: TreeNode | null): Service[] => (n ? [...(direct.get(n.id) ?? []), ...n.children.flatMap(allOf)] : (direct.get(NONE) ?? []));

  // Раскрытые карточки — помнятся на устройстве. Первый раз: одна карточка — раскрыта.
  const cardKeys = [...roots.map((r) => r.id), ...((direct.get(NONE)?.length ?? 0) > 0 || !roots.length ? [NONE] : [])];
  const isOpen = (key: string) => filtering || (open ? open.has(key) : cardKeys.length === 1);
  const toggleOpen = (key: string) => {
    const next = new Set(open ?? (cardKeys.length === 1 ? cardKeys : []));
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setOpenState(next);
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify([...next]));
    } catch {
      /* не запомнили — не беда */
    }
  };

  /** Раскрыть категорию и все папки над ней — чтобы новое было видно сразу. */
  const reveal = (id: string | null | undefined) => {
    const next = new Set(open ?? (cardKeys.length === 1 ? cardKeys : []));
    for (let n = id ? nodeById.get(id) : undefined; n; n = n.parentId ? nodeById.get(n.parentId) : undefined) next.add(n.id);
    setOpenState(next);
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify([...next]));
    } catch {
      /* не запомнили — не беда */
    }
  };

  const toggle = (id: string) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const selectMany = (ids: string[], on: boolean) =>
    setSel((s) => {
      const n = new Set(s);
      ids.forEach((id) => (on ? n.add(id) : n.delete(id)));
      return n;
    });

  const fail = (err: unknown, text: string) => setNotice({ text: err instanceof ApiError ? err.message : text, tone: "error" });

  async function moveServices(ids: string[], categoryId: string | null) {
    try {
      await servicesApi.bulk({ action: "move", ids, categoryId });
      setNotice({ text: `${plural(ids.length, "услуга", "услуги", "услуг")} → ${categoryId ? pathOf(categoryId) : "Без категории"}` });
      setSel(new Set());
      await load();
    } catch (err) {
      fail(err, "Не удалось перенести");
    }
  }

  async function togglePin(s: Service) {
    try {
      await servicesApi.update(s.id, { isPinned: !s.isPinned });
      await load();
    } catch (err) {
      fail(err, "Не удалось сохранить");
    }
  }

  const sheetNow = () => window.matchMedia("(max-width: 767px)").matches;
  const fromButton = (el: HTMLElement, openMenu: (x: number, y: number, sheet: boolean) => void) => {
    const r = el.getBoundingClientRect();
    openMenu(r.left, r.bottom, sheetNow());
  };
  const ico = "h-[17px] w-[17px]";

  const movePicker = (ids: string[], current: string | null | undefined, sheet: boolean) => (close: () => void) => (
    <CategoryPicker
      roots={roots}
      colors={colorOf}
      current={current}
      none="Без категории"
      big={sheet}
      onPick={(id) => {
        close();
        void moveServices(ids, id);
      }}
      onNew={() => {
        close();
        setCatDialog({ kind: "create", parentId: null });
      }}
    />
  );

  function serviceMenu(s: Service, x: number, y: number, sheet: boolean) {
    const ids = sel.has(s.id) && sel.size > 1 ? [...sel] : [s.id];
    const one = ids.length === 1;
    const entries: MenuEntry[] = [
      ...(one && canEdit ? [{ label: "Изменить…", icon: <IconEdit className={ico} />, hint: sheet ? undefined : "2× щелчок", onClick: () => setEditing({ service: s, categoryId: s.categoryId ?? null }) }] : []),
      ...(canEdit ? [{ label: "Переместить в", icon: <IconFolder className={ico} />, sub: movePicker(ids, one ? (s.categoryId ?? null) : undefined, sheet) }] : []),
      ...(one && canEdit ? [{ label: s.isPinned ? "Убрать кнопку из заказа" : "Вынести кнопкой в заказ", icon: <IconServices className={ico} />, onClick: () => void togglePin(s) }] : []),
      ...(one && canEdit ? [{ label: "Сделать копию…", icon: <IconPlus className={ico} />, onClick: () => setEditing({ service: null, categoryId: s.categoryId ?? null, copyOf: s }) }] : []),
      { label: sel.has(s.id) ? "Снять отметку" : "Отметить", icon: <span className="text-[13px] font-bold">✓</span>, onClick: () => toggle(s.id) },
      ...(canEdit ? ([{ sep: true }, { label: one ? "Удалить…" : `Удалить ${ids.length}…`, icon: <IconDelete className={ico} />, danger: true, hint: sheet ? undefined : "Del", onClick: () => setConfirmDelete(ids) }] as MenuEntry[]) : []),
    ];
    setMenu({ at: { x, y, sheet, title: one ? s.name : `Выбрано: ${ids.length}` }, entries: tidy(entries) });
  }

  function categoryMenu(node: TreeNode | null, x: number, y: number, sheet: boolean) {
    const list = allOf(node);
    const ids = list.map((s) => s.id);
    const allOn = ids.length > 0 && ids.every((id) => sel.has(id));
    const isRoot = !node || !node.parentId;
    const inside = new Set<string>();
    if (node) {
      const go = (n: TreeNode) => (inside.add(n.id), n.children.forEach(go));
      go(node);
    }
    const entries: MenuEntry[] = [
      ...(canEdit ? [{ label: "Новая услуга здесь…", icon: <IconPlus className={ico} />, onClick: () => setEditing({ service: null, categoryId: node?.id ?? null }) }] : []),
      { label: allOn ? "Снять отметку" : "Отметить все услуги", icon: <span className="text-[13px] font-bold">✓</span>, hint: String(ids.length), disabled: !ids.length, onClick: () => selectMany(ids, !allOn) },
      ...(!filtering
        ? [{ label: (isRoot ? isOpen(node?.id ?? NONE) : subOpen(node!.id)) ? "Свернуть" : "Развернуть", icon: <IconChevronDown className={ico} />, onClick: () => toggleOpen(node?.id ?? NONE) }]
        : []),
      ...(node && canEdit
        ? ([
            { sep: true },
            { label: "Подкатегория…", icon: <IconPlus className={ico} />, onClick: () => setCatDialog({ kind: "create", parentId: node.id }) },
            { label: "Переименовать…", icon: <IconEdit className={ico} />, onClick: () => setCatDialog({ kind: "edit", node }) },
            {
              label: "Переместить в",
              icon: <IconFolder className={ico} />,
              sub: (close: () => void) => (
                <CategoryPicker
                  roots={roots}
                  colors={colorOf}
                  current={node.parentId}
                  exclude={inside}
                  none="На верхний уровень"
                  big={sheet}
                  onPick={(parentId) => {
                    close();
                    servicesApi
                      .updateCategory(node.id, { parentId })
                      .then(() => (setNotice({ text: `«${node.name}» → ${parentId ? pathOf(parentId) : "верхний уровень"}` }), load()))
                      .catch((err) => fail(err, "Не удалось перенести категорию"));
                  }}
                />
              ),
            },
            ...(isRoot
              ? [
                  {
                    node: (
                      <div className="px-3 pb-1 pt-1.5">
                        <p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.07em] text-ink-dim">Цвет</p>
                        <div className="flex gap-1.5" data-category-colors>
                          {STOCK_PALETTE.map((c) => (
                            <button
                              key={c}
                              type="button"
                              aria-label={`Цвет ${c}`}
                              onClick={() => {
                                setMenu(null);
                                servicesApi
                                  .updateCategory(node.id, { color: c })
                                  .then(load)
                                  .catch((err) => fail(err, "Не удалось сменить цвет"));
                              }}
                              className={"h-[22px] w-[22px] rounded-[7px] transition-transform hover:scale-110 " + (colorOf.get(node.id) === c ? "ring-2 ring-ink ring-offset-2 ring-offset-surface-raised" : "")}
                              style={{ background: c }}
                            />
                          ))}
                        </div>
                      </div>
                    ),
                  },
                ]
              : []),
            { sep: true },
            { label: "Удалить категорию…", icon: <IconDelete className={ico} />, danger: true, onClick: () => setCatDialog({ kind: "delete", node }) },
          ] as MenuEntry[])
        : []),
    ];
    setMenu({ at: { x, y, sheet, title: node ? node.name : "Без категории" }, entries: tidy(entries) });
  }

  // Del — удалить отмеченные (как на складе).
  useEffect(() => {
    if (!canEdit) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key !== "Delete" || !sel.size) return;
      if (t.closest("input,textarea,select,[contenteditable=true]") || document.querySelector("[role=dialog],[data-stock-menu]")) return;
      setConfirmDelete([...sel]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sel, canEdit]);

  if (error) return <Banner tone="error">{error}</Banner>;

  const pinned = rows?.filter((s) => s.isPinned).length ?? 0;
  const priceFrom = (list: Service[]) => {
    const p = list.map((s) => s.price).filter((x) => x > 0);
    return p.length ? ` · от ${money(Math.min(...p))}` : "";
  };

  // ------------------------------------------------------------------ строка

  const row = (s: Service) => {
    const on = sel.has(s.id);
    return (
      <div
        key={s.id}
        data-service={s.name}
        onClick={(e) => {
          if ((e.target as Element).closest("button,input,a")) return;
          if (e.shiftKey || e.ctrlKey || e.metaKey) return toggle(s.id);
          if (canEdit) setEditing({ service: s, categoryId: s.categoryId ?? null });
        }}
        {...trigger((x, y, sheet) => serviceMenu(s, x, y, sheet))}
        className={
          "group grid cursor-default select-none grid-cols-[22px_minmax(0,1fr)_auto_32px] items-center gap-x-3 border-t border-line/70 px-3 py-2 sm:min-h-[48px] " +
          (on ? "bg-brand/10" : "hover:bg-surface-raised/60")
        }
        style={{ WebkitTouchCallout: "none" }}
      >
        <Check on={on} label={`Отметить: ${s.name}`} onClick={() => toggle(s.id)} />
        <div className="min-w-0 py-0.5">
          <p className="flex min-w-0 items-center gap-2 text-[14px] font-semibold leading-snug">
            <span className="truncate">{s.name}</span>
            {s.isPinned && (
              <span className="shrink-0" title="Вынесена кнопкой в карточку заказа">
                <Badge tone="brand">в заказе кнопкой</Badge>
              </span>
            )}
          </p>
          {s.note && <p className="truncate text-[12.5px] text-ink-muted">{s.note}</p>}
        </div>
        <span className="whitespace-nowrap text-right text-[14px] font-semibold tabular-nums">{s.price ? money(s.price) : <span className="text-ink-dim">договорная</span>}</span>
        <button
          type="button"
          aria-label={`Меню: ${s.name}`}
          onClick={(e) => fromButton(e.currentTarget, (x, y, sheet) => serviceMenu(s, x, y, sheet))}
          className="flex h-8 w-8 items-center justify-center rounded-[9px] text-ink-dim hover:bg-surface-raised hover:text-ink"
        >
          <IconMore className="h-[18px] w-[18px]" />
        </button>
      </div>
    );
  };

  /**
   * Подкатегория внутри карточки — как папка в проводнике (Андрей, 28.10.2026):
   * папки стоят выше отдельных услуг, щелчок раскрывает; внутри — снова
   * сначала папки, потом услуги. Раскрытые помнятся вместе с карточками.
   */
  const subOpen = (id: string) => filtering || (open?.has(id) ?? false);
  const sub = (n: TreeNode): React.ReactNode => {
    const list = allOf(n);
    if (filtering && !list.length) return null;
    const opened = subOpen(n.id);
    const pad = 12 + (n.depth - 1) * 20;
    const k = list.filter((s) => sel.has(s.id)).length;
    return (
      <div key={n.id} data-service-sub={n.name} data-open={opened ? "1" : "0"}>
        <div
          role="button"
          tabIndex={0}
          aria-expanded={opened}
          onClick={(e) => {
            if ((e.target as Element).closest("button,input")) return;
            if (!filtering) toggleOpen(n.id);
          }}
          onKeyDown={(e) => {
            if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget && !filtering) {
              e.preventDefault();
              toggleOpen(n.id);
            }
          }}
          {...trigger((x, y, sheet) => categoryMenu(n, x, y, sheet))}
          className="flex min-h-[44px] cursor-pointer select-none items-center gap-2 border-t border-line/70 py-1.5 pr-3 hover:bg-surface-raised/60"
          style={{ paddingLeft: pad, WebkitTouchCallout: "none" }}
          data-sub-head
        >
          <IconChevronDown className={"h-4 w-4 shrink-0 text-ink-dim transition-transform " + (opened ? "" : "-rotate-90")} />
          <IconFolder className="h-[18px] w-[18px] shrink-0 text-[var(--c)]" />
          <span className="min-w-0 flex-1 truncate text-[14px] font-semibold">{n.name}</span>
          {k > 0 && <span className="shrink-0 text-[12px] font-semibold text-brand-ink">отмечено {k}</span>}
          <span className="shrink-0 font-mono text-[12px] text-ink-dim">{list.length}</span>
          <button
            type="button"
            aria-label={`Меню: ${n.name}`}
            onClick={(e) => fromButton(e.currentTarget, (x, y, sheet) => categoryMenu(n, x, y, sheet))}
            className="flex h-7 w-7 items-center justify-center rounded-[8px] text-ink-dim hover:bg-surface-raised hover:text-ink"
          >
            <IconMore className="h-4 w-4" />
          </button>
        </div>
        {opened && (
          <>
            {n.children.map(sub)}
            <div style={{ paddingLeft: pad + 10 }}>{(direct.get(n.id) ?? []).map(row)}</div>
            {!list.length && (
              <p className="border-t border-line/70 py-2 text-[12.5px] text-ink-dim" style={{ paddingLeft: pad + 30 }}>
                Пусто
              </p>
            )}
          </>
        )}
      </div>
    );
  };

  const card = (root: TreeNode | null) => {
    const key = root?.id ?? NONE;
    const color = root ? (colorOf.get(root.id) ?? rootColor(root)) : NONE_COLOR;
    const all = allOf(root);
    if (filtering && !all.length) return null;
    const opened = isOpen(key);
    const n = all.filter((s) => sel.has(s.id)).length;
    const kids = root ? root.children.length : 0;
    return (
      <section
        key={key}
        data-service-card={root?.name ?? "Без категории"}
        className="overflow-hidden rounded-card border bg-surface"
        style={{ borderColor: opened ? `color-mix(in srgb, ${color} 38%, rgb(var(--line)))` : undefined, ["--c" as string]: color }}
      >
        <div
          role="button"
          tabIndex={0}
          aria-expanded={opened}
          onClick={(e) => {
            if ((e.target as Element).closest("button,input")) return;
            if (!filtering) toggleOpen(key);
          }}
          onKeyDown={(e) => {
            if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget && !filtering) {
              e.preventDefault();
              toggleOpen(key);
            }
          }}
          {...trigger((x, y, sheet) => categoryMenu(root, x, y, sheet))}
          className="relative flex min-h-[60px] cursor-pointer select-none items-center gap-3 py-2.5 pl-3 pr-2 before:absolute before:bottom-2.5 before:left-0 before:top-2.5 before:w-[3px] before:rounded-r-[3px] before:bg-[var(--c)] sm:pr-3"
          style={{ WebkitTouchCallout: "none" }}
          data-card-head
        >
          <Check on={n > 0 && n === all.length} part={n > 0 && n < all.length} label={`Отметить всё: ${root?.name ?? "Без категории"}`} disabled={!all.length} onClick={() => selectMany(all.map((s) => s.id), !(n > 0 && n === all.length))} />
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px]" style={{ background: `color-mix(in srgb, ${color} 18%, transparent)`, color }}>
            {root ? <IconServices className="h-[18px] w-[18px]" /> : <IconFolder className="h-[18px] w-[18px]" />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[15px] font-bold">{root?.name ?? "Без категории"}</span>
            <span className="block truncate text-[12.5px] text-ink-muted">
              {plural(all.length, "услуга", "услуги", "услуг")}
              {kids > 0 && ` · ${plural(kids, "подкатегория", "подкатегории", "подкатегорий")}`}
              {priceFrom(all)}
            </span>
          </span>
          <button
            type="button"
            aria-label={`Меню: ${root?.name ?? "Без категории"}`}
            onClick={(e) => fromButton(e.currentTarget, (x, y, sheet) => categoryMenu(root, x, y, sheet))}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] text-ink-dim hover:bg-surface-raised hover:text-ink"
          >
            <IconMore className="h-[18px] w-[18px]" />
          </button>
          {!filtering && <IconChevronDown className={"h-4 w-4 shrink-0 text-ink-dim transition-transform " + (opened ? "" : "-rotate-90")} />}
        </div>
        {opened && (
          <div data-card-body>
            {/* Сначала папки-подкатегории, потом услуги — как в проводнике. */}
            {root?.children.map(sub)}
            {(direct.get(key) ?? []).map(row)}
            {!all.length && <p className="border-t border-line/70 px-4 py-3 text-[13px] text-ink-dim">Пока пусто — «⋯» → «Новая услуга здесь».</p>}
          </div>
        )}
      </section>
    );
  };

  const selIds = [...sel];

  return (
    <div className="space-y-5">
      <Link to="/settings" className="text-[13.5px] font-semibold text-ink-muted hover:text-ink">
        ‹ Настройки
      </Link>

      <PageHeader eyebrow="Настройки" title="Услуги" subtitle="Прайс мастерской. Из него подставляются названия и цены при наборе выполненных работ." />

      {/* Перебор с кнопками стоит показать сразу: в карточке заказа лишние
          всё равно не поместятся, и человек будет думать, что не сохранилось. */}
      {pinned > PINNED_LIMIT && (
        <Banner tone="warning">
          Кнопками отмечено {pinned} услуг, а в карточке заказа помещается {PINNED_LIMIT}. Остальные останутся в подсказках и в панели «+».
        </Banner>
      )}

      <Card className="p-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput
            placeholder="Название услуги или категории"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="min-w-0 flex-1 basis-[260px]"
            data-services-search
          />
          {canEdit && (
            <>
              <Button variant="secondary" icon={<IconFolder />} onClick={() => setCatDialog({ kind: "create", parentId: null })} data-service-category-new>
                Категория
              </Button>
              <Button icon={<IconPlus />} onClick={() => setEditing({ service: null, categoryId: null })} data-service-new>
                Услуга
              </Button>
            </>
          )}
        </div>
      </Card>

      {sel.size > 0 && (
        <div className="sticky top-2 z-20 flex flex-wrap items-center gap-2 rounded-panel border border-brand/40 bg-surface-raised px-3 py-2 shadow-raised" data-services-selection>
          <span className="px-1 text-[13.5px] font-semibold">Отмечено: {sel.size}</span>
          {canEdit && (
            <>
              <Button
                variant="secondary"
                className="min-h-[34px] px-3 text-[13px]"
                icon={<IconFolder />}
                onClick={(e) => fromButton(e.currentTarget, (x, y, sheet) => setMenu({ at: { x, y, sheet, title: `Переместить ${sel.size}` }, entries: [{ node: movePicker(selIds, undefined, sheet)(() => setMenu(null)) }] }))}
                data-services-move
              >
                Переместить в…
              </Button>
              <Button variant="danger" className="min-h-[34px] px-3 text-[13px]" icon={<IconDelete />} onClick={() => setConfirmDelete(selIds)} data-services-delete>
                Удалить
              </Button>
            </>
          )}
          <button type="button" onClick={() => setSel(new Set())} className="ml-auto flex h-8 items-center gap-1 rounded-[9px] px-2 text-[13px] text-ink-muted hover:bg-surface-input hover:text-ink [&>svg]:h-4 [&>svg]:w-4">
            <IconClose /> Снять
          </button>
        </div>
      )}

      {notice && <Banner tone={notice.tone}>{notice.text}</Banner>}

      {!rows ? (
        <Spinner />
      ) : rows.length === 0 && !roots.length ? (
        <EmptyState icon={<IconServices />} title="Прайс пока пуст">
          Заведите то, что делаете чаще всего, — диагностику, чистку, установку системы. Дальше эти названия будут подставляться в заказ сами.
        </EmptyState>
      ) : filtering && !visible.length ? (
        <EmptyState icon={<IconServices />} title="Ничего не нашлось">
          Попробуйте другое название.
        </EmptyState>
      ) : (
        <div className="space-y-2.5" data-service-cards>
          {roots.map((r) => card(r))}
          {cardKeys.includes(NONE) && card(null)}
        </div>
      )}

      {rows && rows.length > 0 && (
        <p className="text-[12.5px] text-ink-dim">
          {plural(rows.length, "услуга", "услуги", "услуг")} в прайсе{roots.length ? `, ${plural(flatTree(roots).length, "категория", "категории", "категорий")}` : ""}. Щелчок по услуге —
          изменить, Ctrl или Shift — отметить, правая кнопка — меню.
        </p>
      )}

      {menu && <ContextMenu at={menu.at} entries={menu.entries} onClose={() => setMenu(null)} />}

      {catDialog && (
        <CategoryDialog
          dialog={catDialog}
          roots={roots}
          api={servicesApi}
          unit="услуг"
          example="Пайка"
          onClose={() => setCatDialog(null)}
          onDone={(id) => {
            const d = catDialog;
            setCatDialog(null);
            void load().then(() => {
              if (d.kind === "create" && id) {
                // Новую верхнюю — раскрыть; новую подкатегорию — раскрыть все папки над ней.
                if (d.parentId) reveal(d.parentId);
                else if (!isOpen(id)) toggleOpen(id);
              }
            });
          }}
        />
      )}

      {confirmDelete && (
        <Modal title={confirmDelete.length === 1 ? "Удалить услугу?" : `Удалить ${plural(confirmDelete.length, "услугу", "услуги", "услуг")}?`} onClose={() => setConfirmDelete(null)}>
          <div className="space-y-4" data-services-confirm>
            <p className="text-[14px] leading-relaxed text-ink-soft">
              {confirmDelete.length === 1 ? `«${rows?.find((s) => s.id === confirmDelete[0])?.name ?? ""}» исчезнет` : "Они исчезнут"} из прайса и из подсказок. Работы,
              уже записанные в заказы, останутся на месте вместе со своими ценами.
            </p>
            <div className="flex flex-col gap-2 sm:flex-row-reverse">
              <Button
                variant="danger"
                className="sm:flex-1"
                onClick={() => {
                  const ids = confirmDelete;
                  setConfirmDelete(null);
                  servicesApi
                    .bulk({ action: "delete", ids })
                    .then((r) => (setNotice({ text: `Удалено: ${plural(r.changed, "услуга", "услуги", "услуг")}` }), setSel(new Set()), load()))
                    .catch((err) => fail(err, "Не удалось удалить"));
                }}
                data-services-confirm-delete
              >
                Удалить
              </Button>
              <Button variant="secondary" className="sm:flex-1" onClick={() => setConfirmDelete(null)}>
                Не удалять
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {editing && (
        <ServiceModal
          service={editing.service}
          copyOf={editing.copyOf}
          categoryId={editing.categoryId}
          roots={roots}
          onClose={() => setEditing(null)}
          onDone={(text) => {
            const target = editing.service ? null : editing.categoryId;
            setEditing(null);
            if (text) setNotice({ text });
            if (target) reveal(target);
            void load();
          }}
        />
      )}
    </div>
  );
}

const blank = { name: "", price: "", note: "", isPinned: false, categoryId: "" };
type Form = typeof blank;

function ServiceModal({
  service,
  copyOf,
  categoryId,
  roots,
  onClose,
  onDone,
}: {
  service: Service | null;
  copyOf?: Service;
  categoryId: string | null;
  roots: TreeNode[];
  onClose: () => void;
  onDone: (notice?: string) => void;
}) {
  const from = service ?? copyOf ?? null;
  const [form, setForm] = useState<Form>(
    from
      ? {
          name: copyOf ? `${copyOf.name} (копия)` : from.name,
          price: String(from.price),
          note: from.note ?? "",
          isPinned: copyOf ? false : from.isPinned,
          categoryId: categoryId ?? "",
        }
      : { ...blank, categoryId: categoryId ?? "" }
  );
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const flat = flatTree(roots);

  const set = (k: "name" | "price" | "note") => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = {
        name: form.name,
        price: form.price.trim() === "" ? 0 : Number(form.price.replace(",", ".")),
        note: form.note,
        isPinned: form.isPinned,
        categoryId: form.categoryId || null,
      };
      if (service) await servicesApi.update(service.id, body);
      else await servicesApi.create(body);
      onDone(service ? undefined : `«${form.name.trim()}» в прайсе`);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "Сервер недоступен"));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!service) return;
    setBusy(true);
    setError(null);
    try {
      await servicesApi.remove(service.id);
      onDone(`«${service.name}» удалена`);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "Сервер недоступен"));
      setConfirmDelete(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={service ? service.name : copyOf ? "Копия услуги" : "Новая услуга"} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4" data-service-form>
        {error && <Banner tone="error">{error.message}</Banner>}

        <Field label="Название" error={error?.field("name")} hint="Это название попадёт в заказ и в квитанцию клиенту">
          <Input value={form.name} onChange={set("name")} invalid={!!error?.field("name")} autoFocus={!service} />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Цена, ₽" error={error?.field("price")} hint="Можно оставить нулевой и ставить руками в заказе">
            <Input inputMode="decimal" value={form.price} onChange={set("price")} invalid={!!error?.field("price")} />
          </Field>
          <Field label="Категория">
            <Select value={form.categoryId} onChange={(e) => setForm((f) => ({ ...f, categoryId: e.target.value }))} data-service-category>
              <option value="">Без категории</option>
              {flat.map((n) => (
                <option key={n.id} value={n.id}>
                  {indent(n)}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field label="Уточнение" error={error?.field("note")} hint="Что входит в работу, а что нет. Видно только сотрудникам.">
          <Input value={form.note} onChange={set("note")} placeholder="Без стоимости запчастей" />
        </Field>

        <Checkbox label="Вынести кнопкой в карточку заказа" checked={form.isPinned} onChange={(v) => setForm((f) => ({ ...f, isPinned: v }))} />

        <div className="flex flex-col gap-2 pt-2 sm:flex-row-reverse">
          <Button type="submit" disabled={busy} className="sm:flex-1">
            {busy ? "Сохраняем…" : service ? "Сохранить" : "Добавить"}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose} className="sm:flex-1">
            Отмена
          </Button>
        </div>

        {service && (
          <div className="border-t border-line pt-4">
            {confirmDelete ? (
              <div className="space-y-3">
                <Banner tone="warning">
                  Услуга исчезнет из прайса и из подсказок. Работы, уже записанные в заказы, останутся на месте вместе со своими ценами.
                </Banner>
                <div className="flex flex-col gap-2 sm:flex-row-reverse">
                  <Button type="button" variant="danger" disabled={busy} onClick={() => void remove()} className="sm:flex-1">
                    {busy ? "Удаляем…" : "Удалить услугу"}
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => setConfirmDelete(false)} className="sm:flex-1">
                    Не удалять
                  </Button>
                </div>
              </div>
            ) : (
              <Button type="button" variant="danger" onClick={() => setConfirmDelete(true)} className="w-full">
                Удалить услугу
              </Button>
            )}
          </div>
        )}
      </form>
    </Modal>
  );
}
