import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { copyable } from "../components/CopyMenu";
import { fixLayoutEnabled } from "../lib/searchPrefs";
import { SearchFixedHint } from "../components/SearchFixedHint";
import { useSearchParams } from "react-router-dom";
import { Modal } from "../components/Modal";
import { IconChevronDown, IconClose, IconDownload, IconEdit, IconFilter, IconPlus, IconSearch, IconStock, IconUpload } from "../components/icons";
import { PartsSearch } from "../components/PartsSearch";
import { SuggestInput } from "../components/SuggestInput";
import { buildTree, flatTree, indent, StockTree } from "../components/StockTree";
import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  List,
  ListRow,
  PageHeader,
  SearchInput,
  Select,
  Spinner,
  StatusGlyph,
} from "../components/ui";
import { ApiError } from "../lib/api";
import { Pager } from "../components/Pager";
import { useAuth } from "../lib/auth";
import { formatDateTime, plural } from "../lib/format";
import { money } from "../lib/orders";
import { stockApi, type StockCatalog, type StockItem, type StockList, type StockMovement } from "../lib/workshop";

/**
 * Склад.
 *
 * Слева каталог деревом (components/StockTree.tsx), справа позиции выбранной
 * категории вместе с подкатегориями. Наличие, поставщик, место и порядок — за
 * одной кнопкой «Фильтры» с красным кружком, как у заказов; выбор помнится на
 * устройстве. На телефоне вместо дерева — кнопка «Категория: …».
 */

const AVAIL = [
  { value: "all", label: "Все" },
  { value: "in", label: "В наличии" },
  { value: "low", label: "Ниже минимума" },
  { value: "zero", label: "Закончились" },
] as const;

const SORTS = [
  { value: "name", label: "По названию" },
  { value: "low", label: "Сначала заканчивающиеся" },
  { value: "qty", label: "Больше всего на складе" },
  { value: "price", label: "По цене продажи" },
  { value: "updated", label: "Недавно изменённые" },
  { value: "recent", label: "Недавние движения" },
  { value: "category", label: "По категории" },
  { value: "sku", label: "По артикулу" },
] as const;

interface StockFilters {
  cat: string;
  filter: string;
  supplier: string;
  location: string;
  sort: string;
}
const NO_FILTERS: StockFilters = { cat: "", filter: "all", supplier: "", location: "", sort: "name" };
const FILTER_KEYS = ["cat", "filter", "supplier", "location", "sort"] as const;
/** Красный кружок на «Фильтрах»: наличие, поставщик, место (порядок и категория — не фильтры). */
const filterCount = (f: StockFilters) => Number(f.filter !== "all") + Number(!!f.supplier) + Number(!!f.location);

function recall(key: string): StockFilters | null {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? "null");
    return raw && typeof raw === "object" ? { ...NO_FILTERS, ...raw } : null;
  } catch {
    return null;
  }
}
function remember(key: string, f: StockFilters) {
  try {
    localStorage.setItem(key, JSON.stringify(f));
  } catch {
    /* не запомнили — не беда */
  }
}

export default function Stock() {
  const { can, me } = useAuth();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<StockList | null>(null);
  const [catalog, setCatalog] = useState<StockCatalog | null>(null);
  const [hints, setHints] = useState<{ suppliers: string[]; locations: string[] }>({ suppliers: [], locations: [] });
  const [search, setSearch] = useState("");
  // «Искать как набрано» — отказ от исправления раскладки для этого запроса.
  const [exact, setExact] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<StockItem | "new" | null>(null);
  const [moving, setMoving] = useState<{ item: StockItem; type: MoveType } | null>(null);
  const [history, setHistory] = useState<StockItem | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [catsOpen, setCatsOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // Поиск у поставщиков: с тем, что набрано в поиске склада, — чего нет у себя, ищут у них.
  const [suppliers, setSuppliers] = useState<string | null>(null);

  const f: StockFilters = {
    cat: params.get("cat") ?? "",
    filter: params.get("filter") ?? "all",
    supplier: params.get("supplier") ?? "",
    location: params.get("location") ?? "",
    sort: params.get("sort") ?? "name",
  };
  const memoryKey = `finecrm.stock.filters.${me?.kind === "tenant" ? me.user.id : "platform"}`;
  const canMove = can("stock.move");
  const canCount = can("stock.inventory");
  const seesCost = can("orders.cost", "finance.view", "stock.move");

  const apply = useCallback(
    (next: StockFilters, opts: { save?: boolean } = {}) => {
      const p = new URLSearchParams(params);
      for (const k of FILTER_KEYS) {
        const v = next[k];
        if (v && v !== NO_FILTERS[k]) p.set(k, v);
        else p.delete(k);
      }
      p.delete("page");
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
    const saved = recall(memoryKey);
    if (saved) apply(saved, { save: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const page = Math.max(1, Number(params.get("page") ?? 1) || 1);
  const setPage = (next: number) => {
    const p = new URLSearchParams(params);
    if (next > 1) p.set("page", String(next));
    else p.delete("page");
    setParams(p, { replace: true });
    window.scrollTo({ top: 0 });
  };

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
      setData(
        await stockApi.list({
          search: search.trim(),
          filter: f.filter,
          page,
          ...(f.sort !== "name" ? { sort: f.sort } : {}),
          ...(f.cat ? { category: f.cat } : {}),
          ...(f.supplier ? { supplier: f.supplier } : {}),
          ...(f.location ? { location: f.location } : {}),
          ...(search.trim() && !exact && fixLayoutEnabled() ? { layout: "1" } : {}),
        })
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось загрузить склад");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, f.filter, f.sort, f.cat, f.supplier, f.location, page, exact]);

  useEffect(() => {
    const t = setTimeout(() => void load(), search ? 350 : 0);
    return () => clearTimeout(t);
  }, [load, search]);

  const reloadAll = () => {
    void load();
    void loadCatalog();
  };
  const flash = (text: string) => {
    setNotice(text);
    setTimeout(() => setNotice((n) => (n === text ? null : n)), 4000);
  };

  const roots = useMemo(() => buildTree(catalog?.items ?? []), [catalog]);
  const catName =
    f.cat === "none" ? "Без категории" : f.cat ? (catalog?.items.find((c) => c.id === f.cat)?.name ?? "Категория") : "Все позиции";

  /** Позицию перетащили на категорию в дереве. */
  async function moveToCategory(itemId: string, categoryId: string | null) {
    try {
      await stockApi.updateItem(itemId, { categoryId });
      const name = categoryId ? (catalog?.items.find((c) => c.id === categoryId)?.name ?? "") : "Без категории";
      flash(`Перенесено в «${name}»`);
      reloadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось перенести");
    }
  }

  if (error) return <Banner tone="error">{error}</Banner>;

  const count = filterCount(f);
  const chips: Array<{ label: string; clear: () => void }> = [
    ...(f.filter !== "all" ? [{ label: AVAIL.find((a) => a.value === f.filter)?.label ?? f.filter, clear: () => apply({ ...f, filter: "all" }) }] : []),
    ...(f.supplier ? [{ label: `Поставщик: ${f.supplier}`, clear: () => apply({ ...f, supplier: "" }) }] : []),
    ...(f.location ? [{ label: `Место: ${f.location}`, clear: () => apply({ ...f, location: "" }) }] : []),
  ];

  const tree = catalog && (
    <StockTree
      catalog={catalog}
      selected={f.cat}
      onSelect={(cat) => {
        apply({ ...f, cat });
        setCatsOpen(false);
      }}
      canEdit={canMove}
      onChanged={reloadAll}
      onDropItem={canMove ? (id, cat) => void moveToCategory(id, cat) : undefined}
    />
  );

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Мастерская"
        title="Склад"
        subtitle="Остатки запчастей и расходников. Любое изменение остатка — движение с автором и причиной."
        actions={
          <>
            <Button variant="secondary" icon={<IconSearch />} onClick={() => setSuppliers(search.trim())}>
              Найти у поставщиков
            </Button>
            {canMove && (
              <Button icon={<IconPlus />} onClick={() => setEditing("new")}>
                Новая позиция
              </Button>
            )}
          </>
        }
      />
      {suppliers !== null && <PartsSearch initialQuery={suppliers} onClose={() => setSuppliers(null)} />}

      <div className="grid gap-5 lg:grid-cols-[270px_minmax(0,1fr)]">
        {/* Каталог: на компьютере — слева всегда, на телефоне — по кнопке. */}
        <aside className="hidden lg:block">
          <Card className="sticky top-4 max-h-[calc(100vh-32px)] overflow-y-auto p-2.5">
            <p className="px-2 pb-2 pt-1 text-[12px] font-bold uppercase tracking-[0.06em] text-ink-dim">Каталог</p>
            {tree ?? <Spinner />}
          </Card>
        </aside>

        <div className="min-w-0 space-y-4">
          <Card className="p-3.5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <button
                type="button"
                onClick={() => setCatsOpen(true)}
                className="flex min-h-[44px] items-center justify-between gap-2 rounded-field border border-line bg-surface-raised px-3.5 text-left text-[14px] font-semibold lg:hidden"
                data-cat-button
              >
                <span className="min-w-0 truncate">
                  <span className="font-normal text-ink-muted">Категория: </span>
                  {catName}
                </span>
                <IconChevronDown className="h-4 w-4 shrink-0 text-ink-dim" />
              </button>
              <div className="flex min-w-0 flex-1 items-center gap-2">
              <SearchInput
                placeholder="Название, артикул, место или поставщик"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setExact(false);
                  if (page > 1) setPage(1);
                }}
                className="min-w-0 flex-1"
              />
              <Button variant="secondary" icon={<IconFilter />} onClick={() => setFiltersOpen(true)} className="relative shrink-0" aria-label="Фильтры">
                <span className="hidden sm:inline">Фильтры</span>
                {count > 0 && (
                  <span data-filter-count className="absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-state-off px-1 text-[11px] font-bold text-white">
                    {count}
                  </span>
                )}
              </Button>
              </div>
            </div>
            {(chips.length > 0 || f.sort !== "name") && (
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
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
          </Card>

          <SearchFixedHint fixed={data?.searchFixed} onExact={() => setExact(true)} />
          {notice && <Banner>{notice}</Banner>}

          {!data ? (
            <Spinner />
          ) : (
            <>
              {data.totals.low > 0 && f.filter !== "low" && (
                <Banner tone="warning">
                  {plural(data.totals.low, "позиция", "позиции", "позиций")} ниже минимального остатка.{" "}
                  <button onClick={() => apply({ ...f, filter: "low" })} className="font-bold underline underline-offset-2">
                    Показать
                  </button>
                </Banner>
              )}

              {data.items.length === 0 ? (
                <EmptyState
                  icon={<IconStock />}
                  title={search || count || f.cat ? "Ничего не нашлось" : "На складе пусто"}
                  action={
                    canMove && !search && !count && !f.cat ? (
                      <Button icon={<IconPlus />} onClick={() => setEditing("new")}>
                        Завести первую позицию
                      </Button>
                    ) : search.trim().length >= 2 ? (
                      <Button variant="secondary" icon={<IconSearch />} onClick={() => setSuppliers(search.trim())}>
                        Найти «{search.trim()}» у поставщиков
                      </Button>
                    ) : canMove && f.cat ? (
                      <Button icon={<IconPlus />} onClick={() => setEditing("new")}>
                        Новая позиция в «{catName}»
                      </Button>
                    ) : undefined
                  }
                >
                  {search || count || f.cat
                    ? "Попробуйте изменить запрос, снять фильтр или выбрать другую категорию."
                    : "Заведите позицию и оприходуйте её — дальше запчасти в заказах будут уменьшать остаток сами."}
                </EmptyState>
              ) : (
                <List>
                  {data.items.map((i) => (
                    <div
                      key={i.id}
                      data-stock-item={i.id}
                      draggable={canMove}
                      onDragStart={(e) => {
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/x-stock-item", i.id);
                      }}
                      className={canMove ? "lg:cursor-grab" : ""}
                    >
                      <ListRow
                        glyph={
                          <StatusGlyph
                            tone={i.qty <= 0 ? "cancelled" : i.low ? "waiting" : "done"}
                            title={i.qty <= 0 ? "Закончилось" : i.low ? "Ниже минимума" : "В наличии"}
                            icon={<IconStock />}
                          />
                        }
                        title={
                          <>
                            {canMove ? (
                              <button
                                type="button"
                                onClick={() => setEditing(i)}
                                title="Открыть карточку позиции"
                                className="min-w-0 truncate text-left underline decoration-dotted decoration-ink-dim underline-offset-4 hover:decoration-solid"
                              >
                                {i.name}
                              </button>
                            ) : (
                              <span className="truncate">{i.name}</span>
                            )}
                            {i.sku && <span className="font-mono text-[12.5px] text-ink-dim">{i.sku}</span>}
                            {i.low && i.qty > 0 && <Badge tone="warning">мало</Badge>}
                            {i.qty <= 0 && <Badge tone="danger">нет</Badge>}
                          </>
                        }
                        subtitle={
                          <>
                            {i.categoryPath ?? i.category ?? "без категории"}
                            {i.location && <span className="text-ink-dim">{` · место: ${i.location}`}</span>}
                            {i.supplier && <span className="text-ink-dim">{` · ${i.supplier}`}</span>}
                            {i.places.length > 1 && (
                              <span className="text-ink-dim">
                                {" · "}
                                {i.places.map((p) => `${p.warehouse}: ${p.qty}`).join(", ")}
                              </span>
                            )}
                            {i.minQty > 0 && <span className="text-ink-dim">{` · минимум ${i.minQty}`}</span>}
                          </>
                        }
                        meta={
                          <>
                            <span
                              className={
                                "whitespace-nowrap font-bold lg:w-[84px] lg:text-right " +
                                (i.qty <= 0 ? "text-state-off" : i.low ? "text-state-waiting" : "text-ink")
                              }
                            >
                              {i.qty} {i.unit}
                            </span>
                            <span className="whitespace-nowrap font-semibold text-ink-soft lg:w-[92px] lg:text-right" title="Цена продажи">
                              {i.salePrice ? money(i.salePrice) : "—"}
                            </span>
                          </>
                        }
                        actions={
                          <div className="flex flex-wrap gap-1.5 sm:justify-end">
                            {canMove && (
                              <Button
                                variant="secondary"
                                className="min-h-[34px] px-2.5 text-[13px]"
                                icon={<IconEdit />}
                                onClick={() => setEditing(i)}
                                aria-label="Изменить"
                                title="Изменить позицию"
                              />
                            )}
                            {canMove && (
                              <Button
                                variant="secondary"
                                className="min-h-[34px] px-3 text-[13px]"
                                icon={<IconDownload />}
                                onClick={() => setMoving({ item: i, type: "IN" })}
                                title="Приход на склад"
                                aria-label="Приход"
                              >
                                <span className="lg:hidden">Приход</span>
                              </Button>
                            )}
                            {(canMove || canCount) && (
                              <Button
                                variant="secondary"
                                className="min-h-[34px] px-3 text-[13px]"
                                icon={<IconUpload />}
                                onClick={() => setMoving({ item: i, type: "WRITE_OFF" })}
                                title="Списание со склада"
                                aria-label="Списать"
                              >
                                <span className="lg:hidden">Списать</span>
                              </Button>
                            )}
                            <Button variant="ghost" className="min-h-[34px] px-2.5 text-[13px]" onClick={() => setHistory(i)} title="История движений">
                              История
                            </Button>
                          </div>
                        }
                      />
                    </div>
                  ))}
                </List>
              )}

              <Pager page={data.page} pages={data.pages} total={data.total} pageSize={data.pageSize} onPage={setPage} />

              <p className="text-[12.5px] text-ink-dim">
                {plural(data.totals.positions, "позиция", "позиции", "позиций")} в номенклатуре
                {data.totals.value !== undefined && ` · склад на ${money(Math.round(data.totals.value))}`}.
                {canMove && " Позицию можно перетащить мышью на категорию слева."}
              </p>
            </>
          )}
        </div>
      </div>

      {catsOpen && (
        <Modal title="Категория" onClose={() => setCatsOpen(false)}>
          {tree ?? <Spinner />}
        </Modal>
      )}

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
          item={editing === "new" ? null : editing}
          defaultCategory={editing === "new" && f.cat && f.cat !== "none" ? f.cat : null}
          roots={roots}
          hints={hints}
          seesCost={seesCost}
          onClose={() => setEditing(null)}
          onDone={(text) => {
            setEditing(null);
            flash(text);
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
    </div>
  );
}

// ------------------------------------------------------------------ окна

function Pills<T extends string>({ value, options, onChange, label }: { value: T; options: ReadonlyArray<{ value: T; label: string }>; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={
            "rounded-pill px-3.5 py-1.5 text-[13px] font-semibold transition-colors duration-150 " +
            (value === o.value ? "bg-brand text-white" : "border border-line bg-surface-raised text-ink-muted hover:text-ink")
          }
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

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
        <div>
          <p className="mb-2 text-[13px] font-semibold text-ink-soft">Наличие</p>
          <Pills label="Наличие" value={d.filter as (typeof AVAIL)[number]["value"]} options={AVAIL} onChange={(filter) => setD({ ...d, filter })} />
        </div>
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
          <Button type="button" variant="secondary" onClick={() => setD({ ...NO_FILTERS, cat: d.cat })} className="sm:flex-1">
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
  defaultCategory,
  roots,
  hints,
  seesCost,
  onClose,
  onDone,
}: {
  item: StockItem | null;
  defaultCategory: string | null;
  roots: ReturnType<typeof buildTree>;
  hints: { suppliers: string[]; locations: string[] };
  seesCost: boolean;
  onClose: () => void;
  onDone: (text: string) => void;
}) {
  const flat = flatTree(roots);
  const str = (n: number | null | undefined) => (n === null || n === undefined ? "" : String(n));
  const [form, setForm] = useState({
    name: item?.name ?? "",
    sku: item?.sku ?? "",
    categoryId: item ? (item.categoryId ?? "") : (defaultCategory ?? ""),
    unit: item?.unit ?? "шт",
    minQty: str(item?.minQty ?? 0),
    location: item?.location ?? "",
    supplier: item?.supplier ?? "",
    purchasePrice: str(item?.purchasePrice),
    salePrice: str(item?.salePrice),
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
    <Modal title={item ? item.name : "Новая позиция"} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4" data-stock-item-form>
        {error && <Banner tone="error">{error.message}</Banner>}
        <Field label="Название" error={error?.field("name")} hint="Так, как вы её ищете: «Блок питания 19V 65W»">
          <Input value={form.name} onChange={set("name")} invalid={!!error?.field("name")} autoFocus={!item} />
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
          <Field label="Место хранения" hint="Шкаф, полка, ячейка">
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
