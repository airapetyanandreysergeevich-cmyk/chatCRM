import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { copyable, copyText } from "../components/CopyMenu";
import { fixLayoutEnabled } from "../lib/searchPrefs";
import { SearchFixedHint } from "../components/SearchFixedHint";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useUrlSearch } from "../lib/listState";
import { SaleDialog } from "../components/SaleDialog";
import { SalesJournal } from "../components/SalesJournal";
import { Modal } from "../components/Modal";
import {
  IconChevronDown,
  IconClose,
  IconDelete,
  IconDownload,
  IconEdit,
  IconFilter,
  IconFolder,
  IconMore,
  IconPlus,
  IconSearch,
  IconStock,
  IconUpload,
  IconCart,
  IconJournal,
  IconGlobe,
} from "../components/icons";
import { openSearch } from "../components/WebSearch";
import { PartsSearch } from "../components/PartsSearch";
import { SuggestInput } from "../components/SuggestInput";
import { buildTree, CategoryDialog, flatTree, indent, rootColor, STOCK_PALETTE, type CategoryDialogKind, type TreeNode } from "../components/StockTree";
import { CategoryPicker, Check, ContextMenu, MenuItem, tidy, useMenuTrigger, type MenuAt, type MenuEntry } from "../components/StockMenu";
import { Badge, Banner, Button, EmptyState, Field, GrowText, Input, List, ListRow, PageHeader, SearchInput, Select, Spinner } from "../components/ui";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatDateTime, plural } from "../lib/format";
import { money } from "../lib/orders";
import { stockApi, type StockCatalog, type StockItem, type StockList, type StockMovement } from "../lib/workshop";

/**
 * Склад.
 *
 * Категории верхнего уровня — карточки своего цвета, раскрываются щелчком;
 * подкатегории — кнопками внутри карточки. Позиции — плотными строками:
 * галочка, название и артикул, место, остаток кнопками −/+, цена. Щелчок по
 * строке открывает справа карточку позиции (на узком экране — окном).
 *
 * Меню правой кнопкой (на телефоне — долгим нажатием) — у позиции и у
 * категории. Выбранное (галочки, Shift+щелчок — подряд, Ctrl+A — вся
 * категория) переносится, получает наценку, место или удаляется разом —
 * панелью внизу; позиции можно перетащить мышью на категорию.
 */

const SORTS = [
  { value: "name", label: "По названию" },
  { value: "low", label: "Сначала заканчивающиеся" },
  { value: "qty", label: "Больше всего на складе" },
  { value: "price", label: "По цене продажи" },
  { value: "updated", label: "Недавно изменённые" },
  { value: "recent", label: "Недавние движения" },
  { value: "sku", label: "По артикулу" },
] as const;

interface StockFilters {
  filter: string;
  supplier: string;
  location: string;
  sort: string;
}
const NO_FILTERS: StockFilters = { filter: "all", supplier: "", location: "", sort: "name" };
const FILTER_KEYS = ["filter", "supplier", "location", "sort"] as const;
/** Красный кружок на «Фильтрах»: поставщик и место (наличие — переключателем рядом, порядок — не фильтр). */
const filterCount = (f: StockFilters) => Number(!!f.supplier) + Number(!!f.location);

function recall<T>(key: string, fallback: T): T {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? "null");
    return raw ?? fallback;
  } catch {
    return fallback;
  }
}
function remember(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* не запомнили — не беда */
  }
}

/** Раскрытые карточки категорий — помнятся на устройстве. «none» — «Без категории». */
const OPEN_KEY = "finecrm.stock.cards";
const NONE = "none";
const NONE_COLOR = "#8A93A6";

interface Toast {
  text: string;
  tone?: "error";
  undo?: () => void;
}

type MenuState = { at: MenuAt; entries: MenuEntry[] } | null;

export default function Stock() {
  const { can, me } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<StockList | null>(null);
  const [catalog, setCatalog] = useState<StockCatalog | null>(null);
  const [hints, setHints] = useState<{ suppliers: string[]; locations: string[] }>({ suppliers: [], locations: [] });
  // Набранное — в адресе: вернулись на склад — тот же поиск.
  const [search, setSearch] = useUrlSearch("q");
  // «Искать как набрано» — отказ от исправления раскладки для этого запроса.
  const [exact, setExact] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ item: StockItem | null; categoryId: string | null; copy?: StockItem } | null>(null);
  const [moving, setMoving] = useState<{ item: StockItem; type: MoveType } | null>(null);
  const [history, setHistory] = useState<StockItem | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Поиск у поставщиков: с тем, что набрано в поиске склада, — чего нет у себя, ищут у них.
  const [suppliers, setSuppliers] = useState<string | null>(null);
  /** Окно продажи: что уже в чеке при открытии. */
  const [selling, setSelling] = useState<StockItem[] | null>(null);
  const [salesOpen, setSalesOpen] = useState(false);
  const [catDialog, setCatDialog] = useState<{ d: CategoryDialogKind; then?: (id?: string) => void } | null>(null);
  const [locationFor, setLocationFor] = useState<string[] | null>(null);
  const [deleteFor, setDeleteFor] = useState<string[] | null>(null);
  const [menu, setMenu] = useState<MenuState>(null);
  const [toast, setToast] = useState<Toast | null>(null);

  const [open, setOpen] = useState<Set<string>>(() => new Set(recall<string[]>(OPEN_KEY, [])));
  /** Выбранная кнопка подкатегории в карточке: id карточки → id категории. */
  const [chip, setChip] = useState<Record<string, string>>({});
  const [sel, setSel] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  /** Позиция в карточке справа (на узком экране — окном). */
  const [active, setActive] = useState<string | null>(null);
  const [detailModal, setDetailModal] = useState(false);
  const trigger = useMenuTrigger();

  const f: StockFilters = {
    filter: params.get("filter") ?? "all",
    supplier: params.get("supplier") ?? "",
    location: params.get("location") ?? "",
    sort: params.get("sort") ?? "name",
  };
  const memoryKey = `finecrm.stock.filters.${me?.kind === "tenant" ? me.user.id : "platform"}`;
  const canMove = can("stock.move");
  const canCount = can("stock.inventory");
  // Продажа со склада без ремонта (окно-чек, components/SaleDialog.tsx).
  const canSell = can("stock.sell");
  const canSeeSales = canSell || can("finance.view");
  const seesCost = can("orders.cost", "finance.view", "stock.move");

  const apply = useCallback(
    (next: StockFilters, opts: { save?: boolean } = {}) => {
      const p = new URLSearchParams(params);
      for (const k of FILTER_KEYS) {
        const v = next[k];
        if (v && v !== NO_FILTERS[k]) p.set(k, v);
        else p.delete(k);
      }
      for (const old of ["cat", "page"]) p.delete(old);
      setParams(p, { replace: true });
      if (opts.save !== false) remember(memoryKey, next);
    },
    [params, setParams, memoryKey]
  );

  // Фильтры помнятся на устройстве; адрес с фильтрами главнее памяти.
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    if (restored) return;
    setRestored(true);
    if (FILTER_KEYS.some((k) => params.has(k))) return;
    const saved = recall<StockFilters | null>(memoryKey, null);
    if (saved && typeof saved === "object") apply({ ...NO_FILTERS, ...saved, filter: saved.filter === "in" ? "all" : (saved.filter ?? "all") }, { save: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadCatalog = useCallback(async () => {
    try {
      setCatalog(await stockApi.catalog());
    } catch {
      setCatalog({ items: [], uncategorized: 0, total: 0 });
    }
    stockApi.hints().then(setHints).catch(() => undefined);
  }, []);
  useEffect(() => void loadCatalog(), [loadCatalog]);

  const load = useCallback(async () => {
    try {
      const next = await stockApi.list({
        search: search.trim(),
        filter: f.filter,
        all: "1",
        ...(f.sort !== "name" ? { sort: f.sort } : {}),
        ...(f.supplier ? { supplier: f.supplier } : {}),
        ...(f.location ? { location: f.location } : {}),
        ...(search.trim() && !exact && fixLayoutEnabled() ? { layout: "1" } : {}),
      });
      setData(next);
      // Выбор — только среди того, что видно: исчезнувшее из списка снимается.
      const ids = new Set(next.items.map((i) => i.id));
      setSel((cur) => (cur.size && [...cur].some((id) => !ids.has(id)) ? new Set([...cur].filter((id) => ids.has(id))) : cur));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось загрузить склад");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, f.filter, f.sort, f.supplier, f.location, exact]);

  useEffect(() => {
    const t = setTimeout(() => void load(), search ? 350 : 0);
    return () => clearTimeout(t);
  }, [load, search]);

  const reloadAll = useCallback(() => {
    void load();
    void loadCatalog();
  }, [load, loadCatalog]);

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const say = useCallback((t: Toast) => {
    setToast(t);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), t.undo ? 8000 : 4500);
  }, []);
  useEffect(() => () => void (toastTimer.current && clearTimeout(toastTimer.current)), []);
  const fail = useCallback((err: unknown, fallback: string) => say({ text: err instanceof ApiError ? err.message : fallback, tone: "error" }), [say]);

  // ------------------------------------------------------------ каталог и группы

  const roots = useMemo(() => buildTree(catalog?.items ?? []), [catalog]);
  /** Для каждой категории: её карточка (корень) и цвет карточки. */
  const { rootOf, colorOf, nodeById } = useMemo(() => {
    const rootOf = new Map<string, string>();
    const colorOf = new Map<string, string>();
    const nodeById = new Map<string, TreeNode>();
    roots.forEach((r) => {
      const c = rootColor(r);
      const walk = (n: TreeNode) => {
        rootOf.set(n.id, r.id);
        colorOf.set(n.id, c);
        nodeById.set(n.id, n);
        n.children.forEach(walk);
      };
      walk(r);
    });
    return { rootOf, colorOf, nodeById };
  }, [roots]);

  const items = useMemo(() => data?.items ?? [], [data]);
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  /** Позиции по карточкам в порядке списка с сервера. */
  const byRoot = useMemo(() => {
    const m = new Map<string, StockItem[]>();
    for (const i of items) {
      const r = (i.categoryId && rootOf.get(i.categoryId)) || NONE;
      const list = m.get(r);
      if (list) list.push(i);
      else m.set(r, [i]);
    }
    return m;
  }, [items, rootOf]);

  const filtering = !!search.trim() || f.filter !== "all" || !!f.supplier || !!f.location;
  const isOpen = (key: string) => filtering || open.has(key);
  const toggleOpen = (key: string) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      remember(OPEN_KEY, [...next]);
      return next;
    });

  /** Позиции категории вместе с подкатегориями (среди отобранного). */
  const itemsOfNode = useCallback(
    (node: TreeNode | null): StockItem[] => {
      if (!node) return byRoot.get(NONE) ?? [];
      const inside = new Set<string>();
      const go = (n: TreeNode) => (inside.add(n.id), n.children.forEach(go));
      go(node);
      return (byRoot.get(rootOf.get(node.id) ?? node.id) ?? []).filter((i) => i.categoryId && inside.has(i.categoryId));
    },
    [byRoot, rootOf]
  );

  /** Что сейчас показано в карточке: выбранная подкатегория или вся карточка. */
  const shownNode = (root: TreeNode): TreeNode => {
    const id = chip[root.id];
    return (id && nodeById.get(id) && rootOf.get(id) === root.id && nodeById.get(id)) || root;
  };

  const visibleRoots = roots.filter((r) => !filtering || (byRoot.get(r.id)?.length ?? 0) > 0);
  const noneItems = byRoot.get(NONE) ?? [];
  /** Порядок видимых строк — для Shift+щелчка. */
  const visibleOrder = useMemo(() => {
    const out: string[] = [];
    for (const r of visibleRoots) if (isOpen(r.id)) out.push(...itemsOfNode(shownNode(r)).map((i) => i.id));
    if (noneItems.length && isOpen(NONE)) out.push(...noneItems.map((i) => i.id));
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleRoots, noneItems, open, chip, filtering, itemsOfNode]);

  const pathOf = (id: string | null | undefined) => {
    if (!id) return "Без категории";
    const parts: string[] = [];
    let n = nodeById.get(id);
    while (n) {
      parts.unshift(n.name);
      n = n.parentId ? nodeById.get(n.parentId) : undefined;
    }
    return parts.join(" › ") || "Без категории";
  };

  // ------------------------------------------------------------------ выбор

  const toggle = (id: string, e?: { shiftKey?: boolean }) => {
    if (e?.shiftKey && anchor.current && anchor.current !== id) {
      const a = visibleOrder.indexOf(anchor.current), b = visibleOrder.indexOf(id);
      if (a >= 0 && b >= 0) {
        const [from, to] = a < b ? [a, b] : [b, a];
        setSel((cur) => new Set([...cur, ...visibleOrder.slice(from, to + 1)]));
        return;
      }
    }
    anchor.current = id;
    setSel((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const selectMany = (ids: string[], on: boolean) =>
    setSel((cur) => {
      const next = new Set(cur);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  const openItem = (id: string) => {
    setActive(id);
    anchor.current = id;
    // Карточка справа есть только на широком экране; на узком — окном.
    if (!window.matchMedia("(min-width: 1280px)").matches) setDetailModal(true);
  };

  // Клавиши: Esc — снять выбор, Ctrl+A — вся категория, Delete — удалить выбранное, «/» — к поиску.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input,textarea,select,[contenteditable=true]") || document.querySelector("[role=dialog],[data-stock-menu]")) return;
      if (e.key === "Escape" && sel.size) {
        setSel(new Set());
      } else if (e.key === "Escape" && active) {
        setActive(null);
      } else if ((e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "ф")) {
        e.preventDefault();
        const item = active ? byId.get(active) : null;
        const root = item?.categoryId ? nodeById.get(rootOf.get(item.categoryId) ?? "") : null;
        selectMany(item ? itemsOfNode(root ? shownNode(root) : null).map((i) => i.id) : visibleOrder, true);
      } else if (e.key === "Delete" && sel.size && canMove) {
        setDeleteFor([...sel]);
      } else if (e.key === "/") {
        e.preventDefault();
        document.getElementById("stock-search")?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  // ------------------------------------------------------------- действия

  const nameList = (ids: string[]) => (ids.length === 1 ? `«${byId.get(ids[0])?.name ?? "позиция"}»` : plural(ids.length, "позиция", "позиции", "позиций"));

  async function moveItems(ids: string[], categoryId: string | null) {
    const before = new Map<string | null, string[]>();
    for (const id of ids) {
      const prev = byId.get(id)?.categoryId ?? null;
      if (prev === categoryId) continue;
      before.set(prev, [...(before.get(prev) ?? []), id]);
    }
    const moved = [...before.values()].flat();
    if (!moved.length) return say({ text: `Уже в «${pathOf(categoryId)}»` });
    try {
      await stockApi.bulk({ action: "move", ids: moved, categoryId });
      setSel(new Set());
      reloadAll();
      say({
        text: `${nameList(moved)} → ${pathOf(categoryId)}`,
        undo: () => {
          setToast(null);
          Promise.all([...before.entries()].map(([cat, list]) => stockApi.bulk({ action: "move", ids: list, categoryId: cat })))
            .then(() => (reloadAll(), say({ text: "Вернули на место" })))
            .catch((err) => fail(err, "Не удалось вернуть"));
        },
      });
    } catch (err) {
      fail(err, "Не удалось перенести");
    }
  }

  async function markup(ids: string[], pct: number) {
    const before = ids.map((id) => ({ id, salePrice: byId.get(id)?.salePrice ?? null }));
    try {
      const r = await stockApi.bulk({ action: "markup", ids, pct });
      void load();
      const skipped = r.skipped.length ? ` · без закупочной цены не тронули: ${r.skipped.length}` : "";
      say({
        text: r.changed ? `Цена продажи +${pct}% от закупки: ${plural(r.changed, "позиция", "позиции", "позиций")}${skipped}` : "Ни у одной из выбранных нет закупочной цены — наценку считать не от чего",
        tone: r.changed ? undefined : "error",
        undo: r.changed
          ? () => {
              setToast(null);
              Promise.all(before.map((b) => stockApi.updateItem(b.id, { salePrice: b.salePrice })))
                .then(() => (void load(), say({ text: "Цены вернули как были" })))
                .catch((err) => fail(err, "Не удалось вернуть цены"));
            }
          : undefined,
      });
    } catch (err) {
      fail(err, "Не удалось поставить наценку");
    }
  }

  async function setLocation(ids: string[], location: string) {
    const before = new Map<string, string[]>();
    for (const id of ids) {
      const prev = byId.get(id)?.location ?? "";
      before.set(prev, [...(before.get(prev) ?? []), id]);
    }
    try {
      await stockApi.bulk({ action: "location", ids, location });
      setLocationFor(null);
      void load();
      stockApi.hints().then(setHints).catch(() => undefined);
      say({
        text: location ? `Место «${location}»: ${nameList(ids)}` : `Место снято: ${nameList(ids)}`,
        undo: () => {
          setToast(null);
          Promise.all([...before.entries()].map(([loc, list]) => stockApi.bulk({ action: "location", ids: list, location: loc })))
            .then(() => (void load(), say({ text: "Места вернули как были" })))
            .catch((err) => fail(err, "Не удалось вернуть"));
        },
      });
    } catch (err) {
      throw err;
    }
  }

  async function exportItems(ids: string[], name: string) {
    try {
      await stockApi.exportItems(ids, name);
    } catch (err) {
      fail(err, "Не удалось выгрузить");
    }
  }

  async function setMarkupOne(item: StockItem, pct: number) {
    if (!item.purchasePrice) return say({ text: "Сначала укажите закупочную цену — наценка считается от неё", tone: "error" });
    await markup([item.id], pct);
  }

  // Остаток кнопками −/+: щелчки копятся и уходят одним движением «Ручная правка».
  const pending = useRef(new Map<string, { delta: number; from: number; timer: ReturnType<typeof setTimeout> }>());
  const adjust = (item: StockItem, d: number) => {
    if (item.qty + d < 0) return;
    const p = pending.current.get(item.id) ?? { delta: 0, from: item.qty, timer: setTimeout(() => undefined, 0) };
    clearTimeout(p.timer);
    p.delta += d;
    p.timer = setTimeout(() => void commitAdjust(item.id), 700);
    pending.current.set(item.id, p);
    setData((cur) =>
      cur
        ? {
            ...cur,
            items: cur.items.map((i) => (i.id === item.id ? { ...i, qty: i.qty + d, low: i.minQty > 0 && i.qty + d < i.minQty } : i)),
          }
        : cur
    );
  };
  async function commitAdjust(id: string) {
    const p = pending.current.get(id);
    pending.current.delete(id);
    if (!p || p.delta === 0) return;
    const item = byIdRef.current.get(id);
    const move = (delta: number, comment: string) =>
      stockApi.move({ stockItemId: id, type: delta > 0 ? "IN" : "WRITE_OFF", qty: Math.abs(delta), comment });
    try {
      await move(p.delta, "Ручная правка");
      say({
        text: `«${item?.name ?? "Позиция"}»: ${p.from} → ${p.from + p.delta} ${item?.unit ?? ""}`,
        undo: () => {
          setToast(null);
          move(-p.delta, "Отмена ручной правки")
            .then(() => (void load(), say({ text: `Остаток снова ${p.from}` })))
            .catch((err) => fail(err, "Не удалось вернуть"));
        },
      });
    } catch (err) {
      fail(err, "Не удалось изменить остаток");
      void load();
    }
  }
  const byIdRef = useRef(byId);
  byIdRef.current = byId;
  // Уходим со страницы — несохранённые щелчки −/+ отправляем сразу.
  useEffect(
    () => () => {
      for (const [id, p] of pending.current) {
        clearTimeout(p.timer);
        if (p.delta) void stockApi.move({ stockItemId: id, type: p.delta > 0 ? "IN" : "WRITE_OFF", qty: Math.abs(p.delta), comment: "Ручная правка" }).catch(() => undefined);
      }
    },
    []
  );

  // ------------------------------------------------------------------ меню

  const sheetNow = () => window.matchMedia("(max-width: 767px)").matches;

  const movePicker = (ids: string[], current: string | null | undefined, big: boolean) => (close: () => void) => (
    <CategoryPicker
      roots={roots}
      colors={colorOf}
      current={current}
      none="Без категории"
      big={big}
      onPick={(id) => {
        close();
        void moveItems(ids, id);
      }}
      onNew={() => {
        close();
        setCatDialog({ d: { kind: "create", parentId: null }, then: (id) => id && void moveItems(ids, id) });
      }}
    />
  );
  const markupPanel = (ids: string[], big: boolean) => (close: () => void) => (
    <div>
      {[20, 30, 50, 100].map((p) => (
        <MenuItem key={p} big={big} onClick={() => (close(), void markup(ids, p))} hint="от закупки">
          +{p}%
        </MenuItem>
      ))}
      <p className="px-3 pb-1.5 pt-1 text-[11.5px] leading-snug text-ink-dim">Цена продажи = закупка + наценка, вверх до 10 ₽.</p>
    </div>
  );

  function itemMenu(item: StockItem, x: number, y: number, sheet: boolean) {
    // Щёлкнули правой по невыбранной — меню про неё одну, и выбор переходит на неё.
    const ids = sel.has(item.id) ? [...sel] : [item.id];
    if (!sel.has(item.id)) {
      setSel(new Set([item.id]));
      anchor.current = item.id;
    }
    const one = ids.length === 1;
    const ico = "h-[17px] w-[17px]";
    const entries: MenuEntry[] = [
      ...(one ? [{ label: "Открыть карточку", icon: <IconStock className={ico} />, onClick: () => openItem(item.id) }] : []),
      ...(canSell
        ? [{
            label: one ? "Продать…" : "Продать выбранное…",
            icon: <IconCart className={ico} />,
            disabled: one ? item.qty <= 0 : false,
            hint: one && item.qty <= 0 ? "нет на складе" : undefined,
            onClick: () => setSelling(one ? [item] : (data?.items ?? []).filter((i) => ids.includes(i.id))),
          }]
        : []),
      ...(one && canMove ? [{ label: "Изменить…", icon: <IconEdit className={ico} />, hint: sheet ? undefined : "2× щелчок", onClick: () => setEditing({ item, categoryId: null }) }] : []),
      ...(one && canMove ? [{ label: "Приход…", icon: <IconDownload className={ico} />, onClick: () => setMoving({ item, type: "IN" }) }] : []),
      ...(one && (canMove || canCount) ? [{ label: "Списать…", icon: <IconUpload className={ico} />, onClick: () => setMoving({ item, type: "WRITE_OFF" }) }] : []),
      ...(canMove
        ? ([
            { sep: true },
            { label: "Переместить в", icon: <IconFolder className={ico} />, sub: movePicker(ids, one ? item.categoryId ?? null : undefined, sheet) },
            ...(seesCost ? [{ label: "Наценка", icon: <span className="text-[13px] font-bold">%</span>, sub: markupPanel(ids, sheet) }] : []),
            { label: "Место хранения…", icon: <PinIcon />, onClick: () => setLocationFor(ids) },
            ...(one ? [{ label: "Завести в другом месте…", icon: <IconPlus className={ico} />, onClick: () => setEditing({ item: null, categoryId: item.categoryId ?? null, copy: item }) }] : []),
          ] as MenuEntry[])
        : []),
      { sep: true },
      ...(one && item.sku
        ? [{ label: "Копировать артикул", icon: <CopyIcon />, onClick: () => void copyText(item.sku!).then((ok) => say({ text: ok ? `Скопировано: ${item.sku}` : "Не удалось скопировать", tone: ok ? undefined : "error" })) }]
        : []),
      // Поиск по названию (Андрей, 28.10.2026): в Google — в браузере (в
      // программе — во внешнем); у поставщиков — окно поиска по нашим магазинам.
      ...(one ? [{ label: "Искать в Google", icon: <IconGlobe className={ico} />, hint: sheet ? undefined : "в браузере", onClick: () => openSearch("google", item.name) }] : []),
      ...(one ? [{ label: "Искать у поставщиков", icon: <IconSearch className={ico} />, hint: sheet ? undefined : "наши магазины", onClick: () => setSuppliers(item.name) }] : []),
      ...(one ? [{ label: "История движений", icon: <ClockIcon />, onClick: () => setHistory(item) }] : []),
      ...(canMove ? [{ label: "Выгрузить в Excel", icon: <IconDownload className={ico} />, onClick: () => void exportItems(ids, one ? item.name : "Склад — выбранное") }] : []),
      ...(canMove ? ([{ sep: true }, { label: "Удалить…", icon: <IconDelete className={ico} />, danger: true, hint: sheet ? undefined : "Del", onClick: () => setDeleteFor(ids) }] as MenuEntry[]) : []),
    ];
    setMenu({ at: { x, y, sheet, title: one ? item.name : `Выбрано: ${ids.length}` }, entries: tidy(entries) });
  }

  function categoryMenu(node: TreeNode | null, x: number, y: number, sheet: boolean) {
    const list = itemsOfNode(node);
    const ids = list.map((i) => i.id);
    const allOn = ids.length > 0 && ids.every((id) => sel.has(id));
    const key = node ? (rootOf.get(node.id) ?? node.id) : NONE;
    const isRoot = !node || !node.parentId;
    const ico = "h-[17px] w-[17px]";
    const inside = new Set<string>();
    if (node) {
      const go = (n: TreeNode) => (inside.add(n.id), n.children.forEach(go));
      go(node);
    }
    const entries: MenuEntry[] = [
      { label: allOn ? "Снять выбор" : "Выбрать все позиции", icon: <MiniCheck on={allOn} />, hint: String(ids.length), disabled: !ids.length, onClick: () => selectMany(ids, !allOn) },
      ...(isRoot && !filtering ? [{ label: isOpen(key) ? "Свернуть" : "Развернуть", icon: <IconChevronDown className={ico} />, onClick: () => toggleOpen(key) }] : []),
      ...(node && canMove
        ? ([
            { sep: true },
            { label: "Подкатегория…", icon: <IconPlus className={ico} />, onClick: () => setCatDialog({ d: { kind: "create", parentId: node.id }, then: (id) => id && (setChip((c) => ({ ...c, [key]: id })), setOpen((o) => new Set(o).add(key))) }) },
            { label: "Переименовать…", icon: <IconEdit className={ico} />, onClick: () => setCatDialog({ d: { kind: "edit", node } }) },
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
                    stockApi
                      .updateCategory(node.id, { parentId })
                      .then(() => (reloadAll(), say({ text: `«${node.name}» → ${parentId ? pathOf(parentId) : "верхний уровень"}` })))
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
                                stockApi
                                  .updateCategory(node.id, { color: c })
                                  .then(loadCatalog)
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
          ] as MenuEntry[])
        : []),
      ...(canMove ? ([{ sep: true }, { label: "Выгрузить в Excel", icon: <IconDownload className={ico} />, hint: String(ids.length), disabled: !ids.length, onClick: () => void exportItems(ids, node ? pathOf(node.id).replace(/ › /g, " - ") : "Без категории") }] as MenuEntry[]) : []),
      ...(node && canMove ? [{ label: "Удалить категорию…", icon: <IconDelete className={ico} />, danger: true, onClick: () => setCatDialog({ d: { kind: "delete", node } }) }] : []),
    ];
    setMenu({ at: { x, y, sheet, title: node ? node.name : "Без категории" }, entries: tidy(entries) });
  }

  /** Меню у кнопки (панель выбранного, «⋯» карточки): под ней, а на телефоне — листом. */
  const fromButton = (el: HTMLElement, open: (x: number, y: number, sheet: boolean) => void) => {
    const r = el.getBoundingClientRect();
    open(r.left, r.bottom, sheetNow());
  };

  // ------------------------------------------------------------- перетаскивание

  const [dropOn, setDropOn] = useState<string | null>(null);
  const dropTarget = (key: string, categoryId: string | null) =>
    canMove
      ? {
          onDragOver: (e: React.DragEvent) => {
            if (!e.dataTransfer.types.includes("text/x-stock-items")) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            if (dropOn !== key) setDropOn(key);
          },
          onDragLeave: (e: React.DragEvent) => {
            if (!(e.currentTarget as Node).contains(e.relatedTarget as Node)) setDropOn((o) => (o === key ? null : o));
          },
          onDrop: (e: React.DragEvent) => {
            e.preventDefault();
            e.stopPropagation();
            setDropOn(null);
            try {
              const ids = JSON.parse(e.dataTransfer.getData("text/x-stock-items")) as string[];
              if (ids.length) void moveItems(ids, categoryId);
            } catch {
              /* перетащили что-то чужое */
            }
          },
        }
      : {};

  if (error) return <Banner tone="error">{error}</Banner>;

  const count = filterCount(f);
  const chips: Array<{ label: string; clear: () => void }> = [
    ...(f.supplier ? [{ label: `Поставщик: ${f.supplier}`, clear: () => apply({ ...f, supplier: "" }) }] : []),
    ...(f.location ? [{ label: `Место: ${f.location}`, clear: () => apply({ ...f, location: "" }) }] : []),
  ];
  const activeItem = active ? (byId.get(active) ?? null) : null;
  const totals = data?.totals;
  const empty = !!data && !items.length;
  const selIds = [...sel];

  // ------------------------------------------------------------------ строка

  const row = (i: StockItem) => {
    const on = sel.has(i.id);
    const isActive = active === i.id;
    const qtyTone = i.qty <= 0 ? "text-state-off" : i.low ? "text-state-waiting" : "text-ink";
    return (
      <div
        key={i.id}
        data-stock-item={i.id}
        draggable={canMove}
        onDragStart={(e) => {
          const ids = sel.has(i.id) ? [...sel] : [i.id];
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/x-stock-items", JSON.stringify(ids));
        }}
        onClick={(e) => {
          if ((e.target as Element).closest("button,input,a")) return;
          if (e.shiftKey || e.ctrlKey || e.metaKey) {
            e.preventDefault();
            return toggle(i.id, e);
          }
          openItem(i.id);
        }}
        onDoubleClick={(e) => {
          if (!canMove || (e.target as Element).closest("button,input,a")) return;
          setEditing({ item: i, categoryId: null });
        }}
        {...trigger((x, y, sheet) => itemMenu(i, x, y, sheet))}
        className={
          "group relative grid cursor-default select-none grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-x-3 border-b border-line/70 px-3 py-2 last:border-b-0 md:grid-cols-[22px_minmax(0,1fr)_minmax(0,150px)_112px_92px] md:py-0 md:min-h-[44px] " +
          (isActive ? "bg-surface-input shadow-[inset_3px_0_0_rgb(var(--brand))] " : on ? "bg-brand/10 " : "hover:bg-surface-raised/60 ")
        }
        style={{ WebkitTouchCallout: "none" }}
      >
        <Check on={on} label={`Выбрать: ${i.name}`} onClick={(e) => toggle(i.id, e)} />
        <div className="min-w-0 py-0.5">
          <p className="truncate text-[14px] font-medium leading-snug md:text-[13.5px]">
            {i.name}
            {i.sku && <span className="ml-2 hidden font-mono text-[11.5px] text-ink-dim md:inline">{i.sku}</span>}
            {i.note && (
              <span title={i.note} aria-label={`Примечание: ${i.note}`} data-note-mark className="ml-1.5 inline-flex translate-y-[2px] text-ink-dim">
                <NoteIcon />
              </span>
            )}
          </p>
          <p className="truncate text-[12.5px] text-ink-dim md:hidden">
            {[i.sku, i.location, i.salePrice ? money(i.salePrice) : null].filter(Boolean).join(" · ") || "—"}
          </p>
        </div>
        <span className="hidden truncate text-[12.5px] text-ink-muted md:block" title={i.location ?? undefined}>
          {i.location || <span className="text-ink-dim">—</span>}
        </span>
        <div className="flex items-center justify-end md:justify-center">
          {canMove ? (
            <span className="hidden items-center md:inline-flex" data-stepper>
              <button type="button" aria-label={`Меньше: ${i.name}`} disabled={i.qty <= 0} onClick={() => adjust(i, -1)} className="flex h-7 w-7 items-center justify-center rounded-[8px] text-[16px] text-ink-dim opacity-0 transition-opacity hover:bg-surface-input hover:text-ink disabled:opacity-0 group-hover:opacity-100 group-hover:disabled:opacity-30">
                −
              </button>
              <span className={"min-w-[40px] text-center text-[13.5px] font-bold tabular-nums " + qtyTone} data-qty>
                {fmtQty(i.qty)}
              </span>
              <button type="button" aria-label={`Больше: ${i.name}`} onClick={() => adjust(i, 1)} className="flex h-7 w-7 items-center justify-center rounded-[8px] text-[16px] text-ink-dim opacity-0 transition-opacity hover:bg-surface-input hover:text-ink group-hover:opacity-100">
                +
              </button>
            </span>
          ) : null}
          <span className={"whitespace-nowrap text-[14px] font-bold tabular-nums " + qtyTone + (canMove ? " md:hidden" : "")} data-qty={canMove ? undefined : true}>
            {fmtQty(i.qty)} <span className="text-[12px] font-medium text-ink-dim">{i.unit}</span>
          </span>
        </div>
        <span className="hidden whitespace-nowrap text-right text-[13.5px] font-semibold tabular-nums md:block">{i.salePrice ? money(i.salePrice) : <span className="text-ink-dim">—</span>}</span>
      </div>
    );
  };

  // ---------------------------------------------------------------- карточка

  const card = (root: TreeNode | null, index: number) => {
    const key = root?.id ?? NONE;
    const color = root ? (colorOf.get(root.id) ?? rootColor(root)) : NONE_COLOR;
    const all = root ? (byRoot.get(root.id) ?? []) : noneItems;
    const opened = isOpen(key);
    const shown = root ? shownNode(root) : null;
    const list = root ? itemsOfNode(shown) : noneItems;
    const n = all.filter((i) => sel.has(i.id)).length;
    const low = all.filter((i) => i.low && i.qty > 0).length;
    const zero = all.filter((i) => i.qty <= 0).length;
    const value = seesCost ? all.reduce((s, i) => s + (i.value ?? 0), 0) : null;
    const kids = root ? root.children.length : 0;
    // Ряды кнопок подкатегорий: от карточки вниз до выбранной.
    const chain: TreeNode[] = [];
    if (root && shown) {
      let c: TreeNode | undefined = shown;
      while (c) {
        chain.unshift(c);
        c = c.parentId ? nodeById.get(c.parentId) : undefined;
      }
    }
    const chipRows = chain.filter((c) => c.children.length > 0);
    const chipCount = (c: TreeNode) => itemsOfNode(c).length;
    const dropKey = (id: string) => `chip:${id}`;
    return (
      <section
        key={key}
        data-stock-card={root?.name ?? "Без категории"}
        className={"overflow-hidden rounded-card border bg-surface transition-colors " + (dropOn === key ? "ring-2 ring-brand " : "")}
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
          {...dropTarget(key, root?.id ?? null)}
          className="relative flex min-h-[60px] cursor-pointer select-none items-center gap-3 py-2.5 pl-3 pr-2 before:absolute before:bottom-2.5 before:left-0 before:top-2.5 before:w-[3px] before:rounded-r-[3px] before:bg-[var(--c)] sm:pr-3"
          style={{ WebkitTouchCallout: "none" }}
          data-card-head
        >
          <Check on={n > 0 && n === all.length} part={n > 0 && n < all.length} label={`Выбрать всё: ${root?.name ?? "Без категории"}`} disabled={!all.length} onClick={() => selectMany(all.map((i) => i.id), !(n > 0 && n === all.length))} />
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px]" style={{ background: `color-mix(in srgb, ${color} 18%, transparent)`, color }}>
            {root ? <IconStock className="h-[18px] w-[18px]" /> : <IconFolder className="h-[18px] w-[18px]" />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[15px] font-bold">{root?.name ?? "Без категории"}</span>
            <span className="block truncate text-[12.5px] text-ink-muted">
              {plural(all.length, "позиция", "позиции", "позиций")}
              {kids > 0 && <span className="hidden sm:inline">{` · ${plural(kids, "подкатегория", "подкатегории", "подкатегорий")}`}</span>}
              {value !== null && value > 0 && ` · на ${money(Math.round(value))}`}
            </span>
          </span>
          {zero > 0 && <span className="hidden sm:inline"><Badge tone="danger">{zero} нет</Badge></span>}
          {low > 0 && <Badge tone="warning">{low} мало</Badge>}
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
          <>
            {root &&
              (chipRows.length > 0 || canMove) &&
              (chipRows.length ? chipRows : [root]).map((parent) => (
                <div key={parent.id} className="no-scrollbar flex gap-1.5 overflow-x-auto px-3 pb-2.5 sm:flex-wrap sm:pl-[60px]" data-chips={parent.name}>
                  {parent.children.length > 0 && (
                    <ChipBtn color={color} on={shown?.id === parent.id} onClick={() => setChip((c) => ({ ...c, [key]: parent.id }))} count={chipCount(parent)} {...dropTarget(dropKey(parent.id), parent.id)} drop={dropOn === dropKey(parent.id)}>
                      {parent.id === root.id ? "Все" : `Все в «${parent.name}»`}
                    </ChipBtn>
                  )}
                  {parent.children.map((c) => (
                    <ChipBtn
                      key={c.id}
                      color={color}
                      on={chain.some((x) => x.id === c.id)}
                      count={chipCount(c)}
                      onClick={() => setChip((cur) => ({ ...cur, [key]: c.id }))}
                      menu={trigger((x, y, sheet) => categoryMenu(c, x, y, sheet))}
                      drop={dropOn === dropKey(c.id)}
                      {...dropTarget(dropKey(c.id), c.id)}
                    >
                      {c.name}
                    </ChipBtn>
                  ))}
                  {canMove && parent.id === (chipRows.length ? chipRows[chipRows.length - 1].id : root.id) && (
                    <button
                      type="button"
                      aria-label={`Подкатегория в «${parent.name}»`}
                      title="Подкатегория"
                      onClick={() => setCatDialog({ d: { kind: "create", parentId: parent.id }, then: (id) => id && setChip((cur) => ({ ...cur, [key]: id })) })}
                      className="flex h-7 shrink-0 items-center rounded-pill border border-dashed border-line px-2.5 text-ink-dim hover:border-line-strong hover:text-ink"
                    >
                      <IconPlus className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              ))}
            <div className="border-t border-line/70" data-card-rows>
              {list.length ? (
                list.map(row)
              ) : (
                <div className="flex flex-col items-start gap-2 px-4 py-4 text-[13.5px] text-ink-muted sm:flex-row sm:items-center sm:justify-between">
                  <span>{filtering ? "Ничего не подходит." : "Пусто. Перетащите сюда позиции или заведите новую."}</span>
                  {canMove && !filtering && (
                    <Button variant="secondary" className="min-h-[34px] px-3 text-[13px]" icon={<IconPlus />} onClick={() => setEditing({ item: null, categoryId: shown?.id ?? null })}>
                      Новая позиция здесь
                    </Button>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </section>
    );
  };

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Мастерская"
        title="Склад"
        subtitle="Остатки запчастей и расходников. Любое изменение остатка — движение с автором и причиной."
        actions={
          <>
            {canSeeSales && (
              <Button variant="secondary" icon={<IconJournal />} onClick={() => setSalesOpen(true)} data-sales-open>
                Продажи
              </Button>
            )}
            <Button variant="secondary" icon={<IconSearch />} onClick={() => setSuppliers(search.trim())}>
              Найти у поставщиков
            </Button>
            {canSell && (
              <Button icon={<IconCart />} onClick={() => setSelling([])} className="!bg-state-done !text-[#0E2A1C] hover:!brightness-105" data-sell>
                Продать
              </Button>
            )}
            {canMove && (
              <Button icon={<IconPlus />} onClick={() => setEditing({ item: null, categoryId: null })}>
                Новая позиция
              </Button>
            )}
          </>
        }
      />
      {suppliers !== null && <PartsSearch initialQuery={suppliers} onClose={() => setSuppliers(null)} />}
      {selling !== null && (
        <SaleDialog
          initial={selling}
          canPickCustomer={can("customers.view")}
          onClose={() => setSelling(null)}
          onSold={(sale, print) => {
            setSelling(null);
            setSel(new Set());
            reloadAll();
            say({ text: `Продано: ${sale.number} на ${money(sale.total)}${sale.items.length > 1 ? ` (${sale.items.length} поз.)` : ""}` });
            if (print) navigate(`/sales/${sale.id}/print?print=1`);
          }}
        />
      )}
      {salesOpen && <SalesJournal canReturn={canSell} onClose={() => setSalesOpen(false)} onChanged={reloadAll} />}

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput
              id="stock-search"
              placeholder="Название, артикул, место или поставщик"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setExact(false);
              }}
              className="min-w-0 flex-[1_1_300px]"
            />
            <div role="radiogroup" aria-label="Наличие" className="inline-flex shrink-0 rounded-field border border-line bg-surface-input p-[3px]" data-avail>
              {[
                { v: "all", label: "Все", n: null },
                { v: "low", label: "Мало", n: totals?.low ?? null },
                { v: "zero", label: "Нет", n: totals?.zero ?? null },
              ].map((o) => (
                <button
                  key={o.v}
                  type="button"
                  role="radio"
                  aria-checked={f.filter === o.v}
                  onClick={() => apply({ ...f, filter: o.v })}
                  className={"h-[34px] whitespace-nowrap rounded-[9px] px-3 text-[13px] font-semibold transition-colors " + (f.filter === o.v ? "bg-surface-raised text-ink shadow-card" : "text-ink-muted hover:text-ink")}
                >
                  {o.label}
                  {o.n ? <span className="ml-1 font-medium text-ink-dim">· {o.n}</span> : null}
                </button>
              ))}
            </div>
            <Button variant="secondary" icon={<IconFilter />} onClick={() => setFiltersOpen(true)} className="relative shrink-0" aria-label="Фильтры">
              <span className="hidden sm:inline">Фильтры</span>
              {count > 0 && (
                <span data-filter-count className="absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-state-off px-1 text-[11px] font-bold text-white">
                  {count}
                </span>
              )}
            </Button>
            {!filtering && roots.length + (noneItems.length ? 1 : 0) > 1 && (
              <Button
                variant="ghost"
                className="hidden shrink-0 px-3 lg:inline-flex"
                aria-label={[...roots.map((r) => r.id), ...(noneItems.length ? [NONE] : [])].every((k) => open.has(k)) ? "Свернуть всё" : "Развернуть всё"}
                title={[...roots.map((r) => r.id), ...(noneItems.length ? [NONE] : [])].every((k) => open.has(k)) ? "Свернуть всё" : "Развернуть всё"}
                onClick={() => {
                  const keys = [...roots.map((r) => r.id), ...(noneItems.length ? [NONE] : [])];
                  const next = keys.every((k) => open.has(k)) ? new Set<string>() : new Set(keys);
                  remember(OPEN_KEY, [...next]);
                  setOpen(next);
                }}
              >
                <ExpandIcon collapse={[...roots.map((r) => r.id), ...(noneItems.length ? [NONE] : [])].every((k) => open.has(k))} />
              </Button>
            )}
          </div>
          {(chips.length > 0 || f.sort !== "name") && (
            <div className="flex flex-wrap items-center gap-1.5">
              {chips.map((c) => (
                <span key={c.label} className="inline-flex items-center gap-1 rounded-pill bg-brand-tint py-1 pl-3 pr-1 text-[12.5px] font-semibold text-brand-ink">
                  {c.label}
                  <button type="button" aria-label={`Убрать: ${c.label}`} onClick={c.clear} className="flex h-5 w-5 items-center justify-center rounded-full hover:bg-brand/15">
                    <IconClose className="h-3 w-3" />
                  </button>
                </span>
              ))}
              {f.sort !== "name" && <span className="text-[12.5px] text-ink-dim">{SORTS.find((s) => s.value === f.sort)?.label}</span>}
            </div>
          )}

          <SearchFixedHint fixed={data?.searchFixed} onExact={() => setExact(true)} />

          {!data || !catalog ? (
            <Spinner />
          ) : empty && !roots.length ? (
            <EmptyState
              icon={<IconStock />}
              title={filtering ? "Ничего не нашлось" : "На складе пусто"}
              action={
                canMove && !filtering ? (
                  <Button icon={<IconPlus />} onClick={() => setEditing({ item: null, categoryId: null })}>
                    Завести первую позицию
                  </Button>
                ) : search.trim().length >= 2 ? (
                  <Button variant="secondary" icon={<IconSearch />} onClick={() => setSuppliers(search.trim())}>
                    Найти «{search.trim()}» у поставщиков
                  </Button>
                ) : undefined
              }
            >
              {filtering ? "Попробуйте изменить запрос или снять фильтр." : "Заведите позицию и оприходуйте её — дальше запчасти в заказах будут уменьшать остаток сами."}
            </EmptyState>
          ) : (
            <div className="space-y-2.5" data-stock-cards>
              {empty && filtering && (
                <EmptyState
                  icon={<IconStock />}
                  title="Ничего не нашлось"
                  action={
                    search.trim().length >= 2 ? (
                      <Button variant="secondary" icon={<IconSearch />} onClick={() => setSuppliers(search.trim())}>
                        Найти «{search.trim()}» у поставщиков
                      </Button>
                    ) : undefined
                  }
                >
                  Попробуйте изменить запрос или снять фильтр.
                </EmptyState>
              )}
              {visibleRoots.map((r) => card(r, roots.indexOf(r)))}
              {noneItems.length > 0 && card(null, 0)}
              {canMove && !filtering && (
                <button
                  type="button"
                  onClick={() => setCatDialog({ d: { kind: "create", parentId: null }, then: (id) => id && setOpen((o) => (remember(OPEN_KEY, [...o, id]), new Set(o).add(id))) })}
                  className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-card border border-dashed border-line text-[13.5px] font-semibold text-ink-muted hover:border-line-strong hover:text-ink"
                >
                  <IconPlus className="h-4 w-4" /> Категория
                </button>
              )}
            </div>
          )}

          {data && (
            <p className="text-[12.5px] text-ink-dim">
              {plural(data.totals.positions, "позиция", "позиции", "позиций")} в номенклатуре
              {data.totals.value !== undefined && ` · склад на ${money(Math.round(data.totals.value))}`}.
              <span className="hidden lg:inline">
                {" "}
                Правая кнопка — меню; Shift+щелчок — подряд; Ctrl+A — вся категория
                {canMove && "; позиции можно перетащить на категорию"}.
              </span>
            </p>
          )}

          {sel.size > 0 && (
            <div className="pointer-events-none sticky bottom-[calc(var(--bottom-nav,0px)+12px)] z-30 flex justify-center lg:bottom-4" data-bulk-bar>
              <div className="pointer-events-auto flex max-w-full items-center gap-0.5 overflow-x-auto rounded-[16px] bg-ink py-1.5 pl-4 pr-1.5 text-surface shadow-modal">
                <b className="mr-2 whitespace-nowrap text-[13.5px]">Выбрано: {sel.size}</b>
                {canSell && <BarBtn icon={<IconCart className="h-4 w-4" />} label="Продать" onClick={() => setSelling((data?.items ?? []).filter((i) => sel.has(i.id)))} />}
                {canMove && (
                  <>
                    <BarBtn icon={<IconFolder className="h-4 w-4" />} label="Переместить" onClick={(el) => fromButton(el, (x, y, sheet) => setMenu({ at: { x, y: y - 8, sheet, title: `Переместить ${plural(sel.size, "позицию", "позиции", "позиций")}` }, entries: [{ node: movePicker(selIds, undefined, sheet)(() => setMenu(null)) }] }))} />
                    {seesCost && <BarBtn icon={<span className="text-[13px] font-bold">%</span>} label="Наценка" onClick={(el) => fromButton(el, (x, y, sheet) => setMenu({ at: { x, y: y - 8, sheet, title: "Наценка от закупки" }, entries: [{ node: markupPanel(selIds, sheet)(() => setMenu(null)) }] }))} />}
                    <BarBtn icon={<PinIcon />} label="Место" onClick={() => setLocationFor(selIds)} />
                    <BarBtn icon={<IconDownload className="h-4 w-4" />} label="Выгрузить" onClick={() => void exportItems(selIds, "Склад — выбранное")} />
                    <span className="mx-1 h-5 w-px shrink-0 bg-surface/25" />
                    <BarBtn icon={<IconDelete className="h-4 w-4" />} label="Удалить" danger onClick={() => setDeleteFor(selIds)} />
                  </>
                )}
                <button type="button" aria-label="Снять выбор" title="Снять выбор (Esc)" onClick={() => setSel(new Set())} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] hover:bg-surface/15">
                  <IconClose className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}
        </div>

        <aside className="sticky top-4 hidden xl:block" data-stock-side>
          {activeItem ? (
            <StockDetail
              item={activeItem}
              path={pathOf(activeItem.categoryId)}
              color={(activeItem.categoryId && colorOf.get(activeItem.categoryId)) || NONE_COLOR}
              canMove={canMove}
              canCount={canCount}
              seesCost={seesCost}
              onClose={() => setActive(null)}
              onEdit={() => setEditing({ item: activeItem, categoryId: null })}
              onMove={(type) => setMoving({ item: activeItem, type })}
              onHistory={() => setHistory(activeItem)}
              onMarkup={(p) => void setMarkupOne(activeItem, p)}
              onAdjust={(d) => adjust(activeItem, d)}
            />
          ) : (
            <SidePanelHint data={data} canMove={canMove} />
          )}
        </aside>
      </div>

      {detailModal && activeItem && (
        <Modal title={activeItem.name} onClose={() => setDetailModal(false)}>
          <StockDetail
            item={activeItem}
            path={pathOf(activeItem.categoryId)}
            color={(activeItem.categoryId && colorOf.get(activeItem.categoryId)) || NONE_COLOR}
            canMove={canMove}
            canCount={canCount}
            seesCost={seesCost}
            bare
            onEdit={() => (setDetailModal(false), setEditing({ item: activeItem, categoryId: null }))}
            onMove={(type) => (setDetailModal(false), setMoving({ item: activeItem, type }))}
            onHistory={() => (setDetailModal(false), setHistory(activeItem))}
            onMarkup={(p) => void setMarkupOne(activeItem, p)}
            onAdjust={(d) => adjust(activeItem, d)}
          />
        </Modal>
      )}

      {menu && <ContextMenu at={menu.at} entries={menu.entries} onClose={() => setMenu(null)} />}

      {filtersOpen && (
        <FiltersModal
          value={f}
          hints={hints}
          onClose={() => setFiltersOpen(false)}
          onApply={(next) => {
            apply(next);
            setFiltersOpen(false);
          }}
        />
      )}

      {editing && (
        <ItemModal
          item={editing.item}
          copy={editing.copy}
          defaultCategory={editing.categoryId}
          roots={roots}
          hints={hints}
          seesCost={seesCost}
          onClose={() => setEditing(null)}
          onDone={(text) => {
            setEditing(null);
            say({ text });
            reloadAll();
          }}
        />
      )}

      {moving && (
        <MoveModal
          item={moving.item}
          initial={moving.type}
          canCount={canCount}
          canMove={canMove}
          onClose={() => setMoving(null)}
          onDone={() => {
            setMoving(null);
            void load();
          }}
        />
      )}

      {history && <HistoryModal item={history} onClose={() => setHistory(null)} />}

      {catDialog && (
        <CategoryDialog
          dialog={catDialog.d}
          roots={roots}
          onClose={() => setCatDialog(null)}
          onDone={(id) => {
            const then = catDialog.then;
            setCatDialog(null);
            reloadAll();
            then?.(id);
          }}
        />
      )}

      {locationFor && <LocationDialog ids={locationFor} hints={hints.locations} current={locationFor.length === 1 ? (byId.get(locationFor[0])?.location ?? "") : ""} label={nameList(locationFor)} onClose={() => setLocationFor(null)} onSave={(loc) => setLocation(locationFor, loc)} />}

      {deleteFor && (
        <DeleteDialog
          items={deleteFor.map((id) => byId.get(id)).filter((i): i is StockItem => !!i)}
          onClose={() => setDeleteFor(null)}
          onDeleted={(n) => {
            setDeleteFor(null);
            setSel(new Set());
            if (active && deleteFor.includes(active)) setActive(null);
            reloadAll();
            say({ text: `Удалено: ${plural(n, "позиция", "позиции", "позиций")}` });
          }}
        />
      )}

      {toast && (
        <div
          role="status"
          data-stock-toast
          className={
            "fixed left-1/2 z-[95] flex max-w-[94vw] -translate-x-1/2 items-center gap-3 rounded-[18px] px-4 py-2 text-[13.5px] font-semibold shadow-raised " +
            (sel.size ? "bottom-[calc(var(--bottom-nav,0px)+76px)] lg:bottom-[84px] " : "bottom-24 sm:bottom-6 ") +
            (toast.tone === "error" ? "bg-state-off text-white" : "bg-ink text-surface")
          }
        >
          <span className="line-clamp-2 min-w-0">{toast.text}</span>
          {toast.undo && (
            <button type="button" onClick={toast.undo} className="shrink-0 rounded-pill px-2 py-0.5 font-bold text-brand underline-offset-2 hover:underline">
              Отменить
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Убрать разделители в начале, в конце и подряд — пункты меню зависят от прав. */

const fmtQty = (n: number) => (Number.isInteger(n) ? String(n) : n.toLocaleString("ru-RU", { maximumFractionDigits: 3 }));

// ------------------------------------------------------------------ мелочи


function ChipBtn({
  children,
  on,
  count,
  color,
  onClick,
  menu,
  drop,
  ...dropProps
}: {
  children: ReactNode;
  on: boolean;
  count: number;
  color: string;
  onClick: () => void;
  menu?: ReturnType<ReturnType<typeof useMenuTrigger>>;
  drop?: boolean;
  onDragOver?: (e: React.DragEvent) => void;
  onDragLeave?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      {...menu}
      {...dropProps}
      className={
        "flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-pill border px-3 text-[12.5px] font-semibold transition-colors " +
        (drop ? "border-brand bg-brand-tint text-ink ring-2 ring-brand " : on ? "text-ink " : "border-line bg-surface-raised text-ink-soft hover:text-ink ")
      }
      style={on && !drop ? { background: `color-mix(in srgb, ${color} 22%, rgb(var(--surface)))`, borderColor: `color-mix(in srgb, ${color} 55%, transparent)` } : undefined}
    >
      {children}
      <span className="font-medium text-ink-dim">{count}</span>
    </button>
  );
}

function BarBtn({ icon, label, onClick, danger }: { icon: ReactNode; label: string; onClick: (el: HTMLElement) => void; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={(e) => onClick(e.currentTarget)}
      title={label}
      className={"flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[10px] px-2.5 text-[13.5px] font-semibold hover:bg-surface/15 " + (danger ? "text-state-off" : "")}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

const MiniCheck = ({ on }: { on: boolean }) => (
  <span className={"flex h-4 w-4 items-center justify-center rounded-[4px] border-[1.5px] " + (on ? "border-brand bg-brand text-white" : "border-line-strong")}>
    {on && (
      <svg viewBox="0 0 12 10" className="h-2 w-2" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M1 5l3.5 3.5L11 1.5" />
      </svg>
    )}
  </span>
);
const ExpandIcon = ({ collapse }: { collapse: boolean }) => (
  <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {collapse ? <path d="m7 4 5 5 5-5M7 20l5-5 5 5" /> : <path d="m7 9 5-5 5 5M7 15l5 5 5-5" />}
  </svg>
);
const NoteIcon = () => (
  <svg viewBox="0 0 24 24" className="h-[14px] w-[14px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 4h14v11l-5 5H5z" />
    <path d="M14 20v-5h5M8.5 9h7M8.5 12.5h4" />
  </svg>
);
const PinIcon = () => (
  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 21s-7-6.2-7-12a7 7 0 0 1 14 0c0 5.8-7 12-7 12z" />
    <circle cx="12" cy="9" r="2.5" />
  </svg>
);
const CopyIcon = () => (
  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h8" />
  </svg>
);
const ClockIcon = () => (
  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </svg>
);

// ------------------------------------------------------------ карточка справа

function SidePanelHint({ data, canMove }: { data: StockList | null; canMove: boolean }) {
  return (
    <div className="rounded-panel border border-line bg-surface p-5" data-stock-side-hint>
      <p className="text-[12px] font-bold uppercase tracking-[0.07em] text-ink-dim">Склад</p>
      {data && (
        <div className="mt-3 grid grid-cols-2 gap-2.5">
          <Stat label="Позиций" value={String(data.totals.positions)} />
          {data.totals.value !== undefined ? <Stat label="На сумму" value={money(Math.round(data.totals.value))} /> : <Stat label="Нет в наличии" value={String(data.totals.zero ?? 0)} />}
          <Stat label="Заканчиваются" value={String(data.totals.low)} tone={data.totals.low ? "text-state-waiting" : undefined} />
          {data.totals.value !== undefined && <Stat label="Нет в наличии" value={String(data.totals.zero ?? 0)} tone={data.totals.zero ? "text-state-off" : undefined} />}
        </div>
      )}
      <p className="mt-4 text-[13px] leading-relaxed text-ink-muted">
        Щёлкните позицию — здесь откроется её карточка: место, цены, наценка и последние движения.
        {canMove && " Правая кнопка — меню: переместить, наценка, место, удалить."}
      </p>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-field border border-line bg-surface-input px-3 py-2.5">
      <p className="text-[11.5px] text-ink-dim">{label}</p>
      <p className={"text-[16px] font-bold tabular-nums " + (tone ?? "")}>{value}</p>
    </div>
  );
}

function StockDetail({
  item,
  path,
  color,
  canMove,
  canCount,
  seesCost,
  bare,
  onClose,
  onEdit,
  onMove,
  onHistory,
  onMarkup,
  onAdjust,
}: {
  item: StockItem;
  path: string;
  color: string;
  canMove: boolean;
  canCount: boolean;
  seesCost: boolean;
  /** В окне на телефоне: без рамки и заголовка (заголовок — у окна). */
  bare?: boolean;
  onClose?: () => void;
  onEdit: () => void;
  onMove: (type: MoveType) => void;
  onHistory: () => void;
  onMarkup: (pct: number) => void;
  onAdjust: (d: number) => void;
}) {
  const [moves, setMoves] = useState<StockMovement[] | null>(null);
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      stockApi
        .movements({ stockItemId: item.id, limit: 4 })
        .then((m) => live && setMoves(m))
        .catch(() => live && setMoves([]));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [item.id, item.qty]);

  const purchase = item.purchasePrice ?? null;
  const current = purchase && item.salePrice ? [20, 30, 50, 100].find((p) => Math.ceil((purchase * (1 + p / 100)) / 10) * 10 === item.salePrice) : undefined;
  const margin = purchase && item.salePrice ? Math.round(((item.salePrice - purchase) / purchase) * 100) : null;
  const qtyTone = item.qty <= 0 ? "text-state-off" : item.low ? "text-state-waiting" : "";

  return (
    <div className={bare ? "space-y-4" : "space-y-4 rounded-panel border border-line bg-surface p-5"} data-stock-detail={item.id}>
      {!bare && (
        <div className="flex items-start gap-2">
          <h3 className="min-w-0 flex-1 text-[17px] font-bold leading-snug">{item.name}</h3>
          {onClose && (
            <button type="button" aria-label="Закрыть карточку" onClick={onClose} className="-mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] text-ink-dim hover:bg-surface-raised hover:text-ink">
              <IconClose className="h-4 w-4" />
            </button>
          )}
        </div>
      )}
      <p className={"flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] " + (bare ? "" : "-mt-2")}>
        {item.sku && (
          <span className="select-all font-mono text-ink-dim">{item.sku}</span>
        )}
        <span className="inline-flex items-center gap-1.5 font-semibold" style={{ color: `color-mix(in srgb, ${color} 72%, rgb(var(--ink)))` }}>
          <span className="h-2 w-2 rounded-[3px]" style={{ background: color }} />
          {path}
        </span>
      </p>

      <div className="grid grid-cols-2 gap-2.5">
        <div className="rounded-field border border-line bg-surface-input px-3 py-2.5">
          <p className="text-[11.5px] text-ink-dim">Остаток</p>
          <div className="flex items-center gap-1">
            {canMove && (
              <button type="button" aria-label="Меньше" disabled={item.qty <= 0} onClick={() => onAdjust(-1)} className="flex h-7 w-7 items-center justify-center rounded-[8px] text-[16px] text-ink-dim hover:bg-surface-raised hover:text-ink disabled:opacity-30">
                −
              </button>
            )}
            <p className={"text-[16px] font-bold tabular-nums " + qtyTone} data-detail-qty>
              {fmtQty(item.qty)} <span className="text-[12px] font-medium text-ink-dim">{item.unit}</span>
            </p>
            {canMove && (
              <button type="button" aria-label="Больше" onClick={() => onAdjust(1)} className="flex h-7 w-7 items-center justify-center rounded-[8px] text-[16px] text-ink-dim hover:bg-surface-raised hover:text-ink">
                +
              </button>
            )}
          </div>
          {item.minQty > 0 && <p className="text-[11.5px] text-ink-dim">минимум {fmtQty(item.minQty)}</p>}
        </div>
        <div className="min-w-0 rounded-field border border-line bg-surface-input px-3 py-2.5">
          <p className="text-[11.5px] text-ink-dim">Место</p>
          <p className="break-words text-[14px] font-semibold">{item.location || <span className="font-normal text-ink-dim">не указано</span>}</p>
        </div>
        {seesCost && (
          <div className="rounded-field border border-line bg-surface-input px-3 py-2.5">
            <p className="text-[11.5px] text-ink-dim">Закупка</p>
            <p className="text-[16px] font-bold tabular-nums">{purchase ? money(purchase) : <span className="text-[14px] font-normal text-ink-dim">—</span>}</p>
          </div>
        )}
        <div className={"rounded-field border border-line bg-surface-input px-3 py-2.5 " + (seesCost ? "" : "col-span-2")}>
          <p className="text-[11.5px] text-ink-dim">Продажа{margin !== null ? ` · +${margin}%` : ""}</p>
          <p className="text-[16px] font-bold tabular-nums">{item.salePrice ? money(item.salePrice) : <span className="text-[14px] font-normal text-ink-dim">—</span>}</p>
        </div>
      </div>

      {canMove && seesCost && (
        <div className="grid grid-cols-4 gap-1.5" data-detail-markups>
          {[20, 30, 50, 100].map((p) => (
            <button
              key={p}
              type="button"
              disabled={!purchase}
              title={purchase ? `Цена продажи: ${money(Math.ceil((purchase * (1 + p / 100)) / 10) * 10)}` : "Нет закупочной цены"}
              onClick={() => onMarkup(p)}
              className={
                "rounded-[9px] border py-1.5 text-[12.5px] font-semibold transition-colors disabled:opacity-40 " +
                (current === p ? "border-brand text-brand-ink" : "border-line bg-surface-input text-ink-soft hover:border-line-strong hover:text-ink")
              }
            >
              +{p}%
            </button>
          ))}
        </div>
      )}

      {item.supplier && (
        <div className="rounded-field border border-line bg-surface-input px-3 py-2.5">
          <p className="text-[11.5px] text-ink-dim">Поставщик</p>
          <p className="text-[14px] font-semibold">{item.supplier}</p>
        </div>
      )}

      {item.note && (
        <div className="rounded-field border border-line bg-surface-input px-3 py-2.5" data-detail-note>
          <p className="text-[11.5px] text-ink-dim">Примечание</p>
          <p className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed">{item.note}</p>
        </div>
      )}

      <div className="border-t border-line pt-3">
        {!moves ? (
          <p className="text-[13px] text-ink-dim">Движения…</p>
        ) : moves.length === 0 ? (
          <p className="text-[13px] text-ink-dim">Движений ещё не было.</p>
        ) : (
          <ul className="space-y-1.5 text-[13px]">
            {moves.map((m) => (
              <li key={m.id} className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate text-ink-soft">
                  <span className={m.qty < 0 ? "font-semibold text-state-off" : "font-semibold text-state-done"}>
                    {m.qty > 0 ? "+" : ""}
                    {fmtQty(m.qty)}
                  </span>{" "}
                  {m.typeLabel}
                  {m.order ? ` · ${m.order.number}` : m.comment ? ` · ${m.comment}` : ""}
                </span>
                <span className="shrink-0 text-[12px] text-ink-dim">{shortDate(m.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {canMove && (
          <Button variant="secondary" className="min-h-[34px] px-3 text-[13px]" icon={<IconEdit />} onClick={onEdit}>
            Изменить
          </Button>
        )}
        {canMove && (
          <Button variant="secondary" className="min-h-[34px] px-3 text-[13px]" icon={<IconDownload />} onClick={() => onMove("IN")}>
            Приход
          </Button>
        )}
        {(canMove || canCount) && (
          <Button variant="secondary" className="min-h-[34px] px-3 text-[13px]" icon={<IconUpload />} onClick={() => onMove("WRITE_OFF")}>
            Списать
          </Button>
        )}
        <Button variant="ghost" className="min-h-[34px] px-3 text-[13px]" onClick={onHistory}>
          История
        </Button>
      </div>
    </div>
  );
}

const shortDate = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return "сегодня";
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "вчера";
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" }).replace(".", "");
};

// ------------------------------------------------------------ место и удаление

function LocationDialog({
  ids,
  current,
  label,
  hints,
  onClose,
  onSave,
}: {
  ids: string[];
  current: string;
  label: string;
  hints: string[];
  onClose: () => void;
  onSave: (location: string) => Promise<void>;
}) {
  const [value, setValue] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const items = hints
    .filter((s) => !value.trim() || (s.toLowerCase().includes(value.trim().toLowerCase()) && s.toLowerCase() !== value.trim().toLowerCase()))
    .slice(0, 12)
    .map((s) => ({ id: s, value: s, fixed: true }));
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSave(value.trim());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось сохранить");
      setBusy(false);
    }
  }
  return (
    <Modal title="Место хранения" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4" data-location-dialog>
        <p className="text-[14px] text-ink-soft">{ids.length > 1 ? `Одно место для ${label}.` : label}</p>
        <Field label="Где лежит" hint="Шкаф, полка, ячейка. Пусто — место снимется">
          <SuggestInput value={value} onChange={setValue} items={items} placeholder="Шкаф 2, ячейка 14" />
        </Field>
        {error && <Banner tone="error">{error}</Banner>}
        <div className="flex flex-col gap-2 sm:flex-row-reverse">
          <Button type="submit" disabled={busy} className="sm:flex-1">
            {busy ? "Сохраняем…" : "Сохранить"}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose} className="sm:flex-1">
            Отмена
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function DeleteDialog({ items, onClose, onDeleted }: { items: StockItem[]; onClose: () => void; onDeleted: (n: number) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const left = items.filter((i) => i.qty > 0);
  async function go() {
    setBusy(true);
    setError(null);
    try {
      const r = await stockApi.bulk({ action: "delete", ids: items.map((i) => i.id) });
      onDeleted(r.changed);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось удалить");
      setBusy(false);
    }
  }
  return (
    <Modal title={items.length === 1 ? `Удалить «${items[0].name}»?` : `Удалить ${plural(items.length, "позицию", "позиции", "позиций")}?`} onClose={onClose}>
      <div className="space-y-4" data-delete-dialog>
        {left.length ? (
          <Banner tone="warning">
            На складе ещё есть {left.slice(0, 3).map((i) => `«${i.name}» — ${fmtQty(i.qty)} ${i.unit}`).join(", ")}
            {left.length > 3 ? ` и ещё ${left.length - 3}` : ""}. Сначала спишите остаток — штуки не должны исчезать без следа.
          </Banner>
        ) : (
          <p className="text-[14px] leading-relaxed text-ink-soft">
            Позиции пропадут со склада и из подсказок в заказах. История движений и заказы, где они были, останутся как есть.
          </p>
        )}
        {error && <Banner tone="error">{error}</Banner>}
        <div className="flex flex-col gap-2 sm:flex-row-reverse">
          <Button type="button" variant="danger" disabled={busy || left.length > 0} onClick={go} className="sm:flex-1">
            {busy ? "Удаляем…" : "Удалить"}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose} className="sm:flex-1">
            {left.length ? "Понятно" : "Отмена"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ окна

function FiltersModal({
  value,
  hints,
  onClose,
  onApply,
}: {
  value: StockFilters;
  hints: { suppliers: string[]; locations: string[] };
  onClose: () => void;
  onApply: (f: StockFilters) => void;
}) {
  const [d, setD] = useState<StockFilters>(value);
  const withCurrent = (list: string[], cur: string) => (cur && !list.includes(cur) ? [cur, ...list] : list);
  return (
    <Modal title="Фильтры и сортировка" onClose={onClose}>
      <div className="space-y-5" data-stock-filters>
        <Field label="Поставщик">
          <Select aria-label="Поставщик" value={d.supplier} onChange={(e) => setD({ ...d, supplier: e.target.value })}>
            <option value="">Все поставщики</option>
            {withCurrent(hints.suppliers, d.supplier).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Место хранения">
          <Select aria-label="Место хранения" value={d.location} onChange={(e) => setD({ ...d, location: e.target.value })}>
            <option value="">Любое</option>
            {withCurrent(hints.locations, d.location).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Сортировка">
          <Select aria-label="Сортировка" value={d.sort} onChange={(e) => setD({ ...d, sort: e.target.value })}>
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex flex-col gap-2 sm:flex-row-reverse">
          <Button type="button" onClick={() => onApply(d)} className="sm:flex-1">
            Показать
          </Button>
          <Button type="button" variant="secondary" onClick={() => setD({ ...NO_FILTERS, filter: d.filter })} className="sm:flex-1">
            Сбросить всё
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** Наценки рядом с ценой продажи: от закупки, с округлением вверх до 10 ₽. */
const MARKUPS = [20, 30, 50, 100];
const withMarkup = (purchase: number, pct: number) => Math.ceil((purchase * (1 + pct / 100)) / 10) * 10;
const parseMoney = (v: string) => {
  const s = v.replace(/\s/g, "").replace(",", ".");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
};

function ItemModal({
  item,
  copy,
  defaultCategory,
  roots,
  hints,
  seesCost,
  onClose,
  onDone,
}: {
  item: StockItem | null;
  /** «Завести в другом месте»: всё как у этой позиции, кроме места и остатка. */
  copy?: StockItem;
  defaultCategory: string | null;
  roots: ReturnType<typeof buildTree>;
  hints: { suppliers: string[]; locations: string[] };
  seesCost: boolean;
  onClose: () => void;
  onDone: (text: string) => void;
}) {
  const flat = flatTree(roots);
  const str = (n: number | null | undefined) => (n === null || n === undefined ? "" : String(n));
  const src = item ?? copy ?? null;
  const [form, setForm] = useState({
    name: src?.name ?? "",
    sku: src?.sku ?? "",
    categoryId: src ? (src.categoryId ?? "") : (defaultCategory ?? ""),
    unit: src?.unit ?? "шт",
    minQty: str(src?.minQty ?? 0),
    location: item?.location ?? "",
    supplier: src?.supplier ?? "",
    note: src?.note ?? "",
    purchasePrice: str(src?.purchasePrice),
    salePrice: str(src?.salePrice),
  });
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const purchase = parseMoney(form.purchasePrice);
  const sale = parseMoney(form.salePrice);
  const margin = purchase && sale && !Number.isNaN(purchase) && !Number.isNaN(sale) ? Math.round(((sale - purchase) / purchase) * 100) : null;

  const suggest = (list: string[], v: string) =>
    list
      .filter((s) => !v.trim() || (s.toLowerCase().includes(v.trim().toLowerCase()) && s.toLowerCase() !== v.trim().toLowerCase()))
      .slice(0, 12)
      .map((s) => ({ id: s, value: s, fixed: true }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (Number.isNaN(purchase) || Number.isNaN(sale)) {
      setError(new ApiError(400, "Цена — число, например 1500 или 1500,50"));
      return;
    }
    setBusy(true);
    setError(null);
    const body = {
      name: form.name,
      sku: form.sku,
      unit: form.unit,
      categoryId: form.categoryId || null,
      minQty: Number(form.minQty.replace(",", ".")) || 0,
      location: form.location,
      supplier: form.supplier,
      note: form.note,
      ...(seesCost ? { purchasePrice: purchase } : {}),
      salePrice: sale,
    };
    try {
      if (item) await stockApi.updateItem(item.id, body);
      else await stockApi.createItem({ ...body, sku: body.sku || undefined });
      onDone(item ? "Позиция сохранена" : `Позиция «${form.name.trim()}» заведена — оприходуйте её кнопкой «Приход»`);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "Сервер недоступен"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={item ? item.name : copy ? "Тот же товар в другом месте" : "Новая позиция"} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4" data-stock-item-form>
        {error && <Banner tone="error">{error.message}</Banner>}
        {copy && (
          <Banner>
            Отдельная позиция со своим остатком: укажите место, где лежит этот товар, и оприходуйте его. «{copy.name}» в «{copy.location || "без места"}» останется как есть.
          </Banner>
        )}
        <Field label="Название" error={error?.field("name")} hint="Так, как вы её ищете: «Блок питания 19V 65W»">
          <Input value={form.name} onChange={set("name")} invalid={!!error?.field("name")} autoFocus={!item && !copy} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Артикул" error={error?.field("sku")} hint="Необязательно">
            <Input value={form.sku} onChange={set("sku")} />
          </Field>
          <Field label="Категория">
            <Select aria-label="Категория" value={form.categoryId} onChange={set("categoryId")}>
              <option value="">Без категории</option>
              {flat.map((n) => (
                <option key={n.id} value={n.id}>
                  {indent(n)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Место хранения" hint="Шкаф, полка, ячейка. Тот же товар в другом месте — отдельная позиция">
            <SuggestInput
              value={form.location}
              onChange={(location) => setForm((f) => ({ ...f, location }))}
              items={suggest(hints.locations, form.location)}
              placeholder="Шкаф 2, ячейка 14"
            />
          </Field>
          <Field label="Поставщик" hint="Запоминается — в следующий раз выберете из списка">
            <SuggestInput
              value={form.supplier}
              onChange={(supplier) => setForm((f) => ({ ...f, supplier }))}
              items={suggest(hints.suppliers, form.supplier)}
              placeholder="Aitech, Vshop…"
            />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {seesCost && (
            <Field label="Стоимость закупки, ₽">
              <Input value={form.purchasePrice} onChange={set("purchasePrice")} inputMode="decimal" placeholder="0" />
            </Field>
          )}
          <Field label="Стоимость продажи, ₽" hint={margin !== null ? `Наценка ${margin}%` : "Её подставит заказ, когда запчасть берут со склада"}>
            <Input value={form.salePrice} onChange={set("salePrice")} inputMode="decimal" placeholder="0" />
          </Field>
        </div>
        {seesCost && item?.avgCost ? (
          <p className="-mt-2 text-[12.5px] text-ink-dim">
            Средняя себестоимость на складе — {money(Math.round(item.avgCost))} (по приходам)
          </p>
        ) : null}
        {seesCost && (
          <div className="flex flex-wrap items-center gap-1.5" data-markups>
            <span className="text-[12.5px] text-ink-muted">Наценка от закупки:</span>
            {MARKUPS.map((p) => (
              <button
                key={p}
                type="button"
                disabled={!purchase || Number.isNaN(purchase)}
                onClick={() => purchase && setForm((f) => ({ ...f, salePrice: String(withMarkup(purchase, p)) }))}
                className="rounded-pill border border-line bg-surface-raised px-3 py-1 text-[13px] font-semibold text-ink hover:border-brand hover:text-brand-ink disabled:opacity-40"
              >
                +{p}%
              </button>
            ))}
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Единица">
            <Input value={form.unit} onChange={set("unit")} />
          </Field>
          <Field label="Минимальный остаток" hint="Ниже этого — подсветим на складе">
            <Input value={form.minQty} onChange={set("minQty")} inputMode="decimal" />
          </Field>
        </div>
        <Field label="Примечание" hint="Видно в карточке позиции, ищется поиском склада">
          <GrowText value={form.note} onChange={set("note")} maxLength={2000} placeholder="Ревизия платы, совместимость, «под заказ»…" rows={2} aria-label="Примечание" />
        </Field>
        <div className="flex flex-col gap-2 pt-2 sm:flex-row-reverse">
          <Button type="submit" disabled={busy || !form.name.trim()} className="sm:flex-1">
            {busy ? "Сохраняем…" : item ? "Сохранить" : "Завести"}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose} className="sm:flex-1">
            Отмена
          </Button>
        </div>
      </form>
    </Modal>
  );
}

type MoveType = "IN" | "WRITE_OFF" | "RETURN" | "INVENTORY";

const MOVE_TITLE: Record<MoveType, string> = {
  IN: "Приход",
  WRITE_OFF: "Списание",
  RETURN: "Возврат на склад",
  INVENTORY: "Инвентаризация",
};

function MoveModal({
  item,
  initial,
  canMove,
  canCount,
  onClose,
  onDone,
}: {
  item: StockItem;
  initial: MoveType;
  canMove: boolean;
  canCount: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [type, setType] = useState<MoveType>(initial);
  const [qty, setQty] = useState("1");
  const [price, setPrice] = useState("");
  const [comment, setComment] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  const options: MoveType[] = [
    ...(canMove ? (["IN", "WRITE_OFF", "RETURN"] as MoveType[]) : (["WRITE_OFF"] as MoveType[])),
    ...(canCount ? (["INVENTORY"] as MoveType[]) : []),
  ];

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await stockApi.move({
        stockItemId: item.id,
        type,
        qty: Number(qty.replace(",", ".")) || 0,
        ...(price ? { price: Number(price.replace(",", ".")) } : {}),
        ...(comment ? { comment } : {}),
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "Сервер недоступен"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`${MOVE_TITLE[type]}: ${item.name}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Banner>
          Сейчас на складе <b>{item.qty} {item.unit}</b>.
          {type === "INVENTORY"
            ? " Укажите, сколько насчитали по факту — разница попадёт в журнал."
            : ""}
        </Banner>
        {error && <Banner tone="error">{error.message}</Banner>}

        {options.length > 1 && (
          <Field label="Что делаем">
            <Select value={type} onChange={(e) => setType(e.target.value as MoveType)}>
              {options.map((o) => (
                <option key={o} value={o}>
                  {MOVE_TITLE[o]}
                </option>
              ))}
            </Select>
          </Field>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label={type === "INVENTORY" ? `Насчитано, ${item.unit}` : `Количество, ${item.unit}`}
            error={error?.field("qty")}
          >
            <Input value={qty} onChange={(e) => setQty(e.target.value)} inputMode="decimal" autoFocus />
          </Field>
          {(type === "IN" || type === "RETURN") && (
            <Field label="Цена за единицу, ₽" hint="Пересчитает среднюю себестоимость">
              <Input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" />
            </Field>
          )}
        </div>

        <Field label="Примечание" hint="Останется в журнале движений навсегда">
          <Input
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder={type === "WRITE_OFF" ? "Брак, бой, пересорт" : "Поставщик, накладная"}
          />
        </Field>

        <div className="flex flex-col gap-2 pt-2 sm:flex-row-reverse">
          <Button type="submit" disabled={busy} className="sm:flex-1">
            {busy ? "Проводим…" : "Провести"}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose} className="sm:flex-1">
            Отмена
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function HistoryModal({ item, onClose }: { item: StockItem; onClose: () => void }) {
  const [rows, setRows] = useState<StockMovement[] | null>(null);

  useEffect(() => {
    stockApi
      .movements({ stockItemId: item.id, limit: 50 })
      .then(setRows)
      .catch(() => setRows([]));
  }, [item.id]);

  return (
    <Modal title={`История: ${item.name}`} onClose={onClose}>
      {!rows ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-ink-dim">Движений по этой позиции ещё не было.</p>
      ) : (
        <div className="max-h-[60vh] overflow-y-auto">
          <List>
            {rows.map((m) => (
              <ListRow
                key={m.id}
                title={
                  <>
                    <span className={m.qty < 0 ? "text-state-off" : "text-state-done"}>
                      {m.qty > 0 ? "+" : ""}
                      {m.qty} {m.item.unit}
                    </span>
                    <Badge>{m.typeLabel}</Badge>
                    {m.order && (
                      <span className="font-mono text-[12.5px] text-ink-dim" {...copyable("order", m.order.number)}>
                        {m.order.number}
                      </span>
                    )}
                  </>
                }
                subtitle={
                  <>
                    {m.user?.fullName ?? "система"}
                    {m.comment ? ` · ${m.comment}` : ""}
                  </>
                }
                meta={<span className="whitespace-nowrap">{formatDateTime(m.createdAt)}</span>}
              />
            ))}
          </List>
        </div>
      )}
    </Modal>
  );
}
