import { useCallback, useEffect, useState } from "react";
import { copyable } from "../components/CopyMenu";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { IconOrders, IconPlus, IconUrgent, IconWarranty } from "../components/icons";
import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  List,
  ListRow,
  PageHeader,
  SearchInput,
  Spinner,
  StatusGlyph,
  StatusPill,
  DebtBadge,
} from "../components/ui";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Pager } from "../components/Pager";
import { customerColor, nameStyle } from "../lib/customerColor";
import { dueLabel, formatDateShort, plural, shortName } from "../lib/format";
import {
  money,
  ORDER_KIND_LABEL,
  ordersApi,
  statusGlyphTone,
  statusPill,
  type Order,
} from "../lib/orders";
import { STAGES } from "../lib/stages";
import { menuFromOrder, useOrderMenu } from "../components/OrderMenu";
import { fixLayoutEnabled } from "../lib/searchPrefs";
import { SearchFixedHint } from "../components/SearchFixedHint";
import { listPref, remember } from "../lib/listPrefs";
import { COLOR_FILTER_VALUES, type ColorFilterValue } from "../components/ListControls";
import {
  ActiveFilters,
  FilterButton,
  OrderFiltersModal,
  filterCount,
  useDeviceKinds,
  useOutsourceClients,
  type OrderFilterState,
} from "../components/OrderFilters";

const SORTS = [
  { value: "default", label: "Срочные, потом новые" },
  { value: "new", label: "Сначала новые" },
  { value: "old", label: "Сначала старые" },
  { value: "due", label: "Сначала горящие" },
  { value: "number", label: "По номеру" },
  { value: "color", label: "По цвету метки клиента" },
  { value: "total", label: "По сумме", money: true },
] as const;
type Sort = (typeof SORTS)[number]["value"];

/**
 * Фильтры повторяют колонки на главной: человек нажал панель «Ремонт» и
 * попал сюда с тем же набором заказов. Разные названия для одного и того
 * же на двух экранах — верный способ запутать приёмщика.
 */
const STAGE_TAG: Record<string, string> = { NEW: "tag-new", WAITING: "tag-waiting", IN_PROGRESS: "tag-progress", DONE: "tag-done" };

const FILTERS: Array<{ value: string; label: string; pill: string | null }> = [
  { value: "", label: "Все", pill: null },
  ...STAGES.map((s) => ({ value: s.key, label: s.label, pill: `tag ${STAGE_TAG[s.key]} border-transparent` })),
  // Выданные — уже не стадия работы, поэтому на главной их нет, а здесь
  // есть: найти, что и когда отдали. Сюда же попадает выданное без ремонта —
  // техника ушла к клиенту так же. Отменённые (клиент так и не сдал) — нет.
  { value: "CLOSED", label: "Выдан", pill: "tag tag-issued border-transparent" },
  // Должники: выданы, а оплачены не полностью. Не группа статуса, а свой
  // признак — уходит на сервер как debt=1.
  { value: "DEBT", label: "Задолженность", pill: "tag tag-debt border-transparent" },
];

const deviceTitle = (o: Order) =>
  [o.device?.kind, o.device?.brand, o.device?.model].filter(Boolean).join(" ") || "Техника не указана";

export default function Orders() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [rows, setRows] = useState<Order[] | null>(null);
  const [pageInfo, setPageInfo] = useState({ page: 1, pages: 1, total: 0, pageSize: 50 });
  // Группа берётся из адреса: со сводки сюда приходят по ссылке
  // «3 просрочено», и фильтр должен уже стоять, а не сбрасываться.
  const [params, setParams] = useSearchParams();
  const group = params.get("group") ?? "";
  // ?search= — со сканера наклейки (Layout): несколько заказов с такими цифрами или ни одного.
  const [search, setSearch] = useState(() => params.get("search") ?? "");
  const urlSearch = params.get("search");
  useEffect(() => {
    if (urlSearch !== null) setSearch(urlSearch);
  }, [urlSearch]);
  // «Искать как набрано» — отказ от исправления раскладки для этого запроса.
  const [exact, setExact] = useState(false);
  const [searchFixed, setSearchFixed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Сколько всего должны по найденному — только с фильтром «Задолженность» и тем, кто видит деньги. */
  const [debtTotal, setDebtTotal] = useState<number | null>(null);

  // Деньги видит не каждый — и сортировку по ним тоже.
  const seesMoney = can("orders.cost", "orders.view.all");
  const sorts = SORTS.filter((s) => !("money" in s) || seesMoney);
  const [sort] = listPref<Sort>(params, setParams, {
    key: "sort",
    storageKey: "finecrm.orders.sort",
    fallback: "default",
    allowed: sorts.map((s) => s.value),
  });
  const [color] = listPref<ColorFilterValue>(params, setParams, {
    key: "color",
    storageKey: "finecrm.orders.color",
    fallback: "",
    allowed: COLOR_FILTER_VALUES,
  });

  // Типы техники — в адресе через запятую, как и остальные фильтры.
  const kindsParam = params.get("kind") ?? "";
  const kinds = kindsParam ? kindsParam.split(",").filter(Boolean) : [];
  const deviceKinds = useDeviceKinds();
  const kindLabel = (key: string) => deviceKinds?.find((k) => k.key === key)?.label ?? key.charAt(0).toUpperCase() + key.slice(1);
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Аутсорс: «1» — все такие клиенты, иначе id одного (в адресе, как остальные фильтры).
  const outsource = params.get("outsource") ?? "";
  const outsourceClients = useOutsourceClients();
  const filters: OrderFilterState = { group, kinds, color, sort, outsource };

  /** Всё выбранное в окне — одним переходом: по отдельности сеттеры затирали бы друг друга. */
  const applyFilters = (next: OrderFilterState) => {
    const p = new URLSearchParams(params);
    const put = (key: string, v: string) => (v ? p.set(key, v) : p.delete(key));
    put("group", next.group);
    put("kind", next.kinds.join(","));
    put("color", next.color);
    put("outsource", next.outsource);
    put("sort", next.sort === "default" ? "" : next.sort);
    p.delete("page");
    setParams(p, { replace: true });
    remember("finecrm.orders.sort", next.sort === "default" ? "" : next.sort);
    remember("finecrm.orders.color", next.color);
    setFiltersOpen(false);
  };

  const canCreate = can("orders.create");
  const onlyAssigned = !can("orders.view.all") && can("orders.view.assigned");

  // Страница живёт в адресе вместе с фильтром: вернувшись из заказа
  // «назад», человек должен попасть туда же, откуда ушёл, а не на первую.
  const page = Math.max(1, Number(params.get("page") ?? 1) || 1);
  const setPage = (next: number) => {
    const p = new URLSearchParams(params);
    if (next > 1) p.set("page", String(next));
    else p.delete("page");
    setParams(p, { replace: true });
    window.scrollTo({ top: 0 });
  };

  // quiet — перечитать после действия из меню заказа, не мигая списком.
  const load = useCallback(async (quiet = false) => {
    if (!quiet) setRows(null);
    try {
      const query: Record<string, string> = { page: String(page) };
      if (group === "DEBT") query.debt = "1";
      else if (group) query.group = group;
      if (search.trim()) query.search = search.trim();
      if (sort !== "default") query.sort = sort;
      if (search.trim() && !exact && fixLayoutEnabled()) query.layout = "1";
      if (color) query.color = color;
      if (kindsParam) query.kind = kindsParam;
      if (outsource) query.outsource = outsource;
      const data = await ordersApi.list(query);
      setRows(data.rows);
      setDebtTotal(data.debtTotal ?? null);
      setSearchFixed(data.searchFixed ?? null);
      setPageInfo({ page: data.page, pages: data.pages, total: data.total, pageSize: data.pageSize });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось загрузить заказы");
    }
  }, [group, search, page, sort, color, exact, kindsParam, outsource]);

  useEffect(() => {
    // Небольшая задержка, чтобы не дёргать сервер на каждую букву в поиске.
    const t = setTimeout(() => void load(), search ? 350 : 0);
    return () => clearTimeout(t);
  }, [load, search]);

  const om = useOrderMenu({ onChanged: () => load(true) });

  if (error) return <Banner tone="error">{error}</Banner>;

  const overdue = rows?.filter((o) => dueLabel(o.dueAt)?.overdue && o.status.group !== "CLOSED").length ?? 0;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Мастерская"
        title={onlyAssigned ? "Мои ремонты" : "Заказы"}
        subtitle={
          onlyAssigned
            ? "Заказы, назначенные вам. Открывайте по номеру или сканируйте ярлык."
            : "Приём техники, работа мастера, выдача клиенту."
        }
        actions={
          canCreate && (
            <Button icon={<IconPlus />} onClick={() => navigate("/orders/new")}>
              Принять технику
            </Button>
          )
        }
      />

      <Card className="space-y-3 p-3.5">
        <div className="flex items-center gap-2.5">
          <SearchInput
            placeholder={
              filterCount(filters)
                ? "Искать среди выбранного…"
                : "Любые слова: ноутбук xiaomi, номер, клиент, неисправность, запись в истории"
            }
            value={search}
            data-scan="1"
            onChange={(e) => {
              setSearch(e.target.value);
              setExact(false);
              if (page > 1) setPage(1);
            }}
            className="min-w-0 flex-1 lg:max-w-[520px]"
          />
          <div className="lg:ml-auto">
            <FilterButton count={filterCount(filters)} onClick={() => setFiltersOpen(true)} />
          </div>
        </div>
        <ActiveFilters value={filters} stages={FILTERS} sorts={sorts} kindLabel={kindLabel} outsource={outsourceClients} onChange={applyFilters} />
      </Card>

      {filtersOpen && (
        <OrderFiltersModal
          value={filters}
          stages={FILTERS}
          sorts={sorts}
          kinds={deviceKinds}
          outsource={outsourceClients}
          onApply={applyFilters}
          onClose={() => setFiltersOpen(false)}
        />
      )}

      <SearchFixedHint fixed={searchFixed} onExact={() => setExact(true)} />

      {group === "DEBT" && rows && rows.length > 0 && (
        <p className="flex flex-wrap items-center gap-2 text-[14px] text-ink-muted">
          {plural(pageInfo.total, "заказ", "заказа", "заказов")} с задолженностью
          {debtTotal !== null && <DebtBadge amount={debtTotal} short />}
          <span className="text-[13px] text-ink-dim">· сначала просроченные, потом по сумме долга</span>
        </p>
      )}

      {overdue > 0 && (
        <Banner tone="warning">
          {plural(overdue, "заказ просрочен", "заказа просрочены", "заказов просрочено")} — они помечены в списке
          красным сроком.
        </Banner>
      )}

      {!rows ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<IconOrders />}
          title={search || filterCount(filters) ? "Ничего не нашлось" : "Заказов пока нет"}
          action={
            canCreate && !search && !filterCount(filters) ? (
              <Button icon={<IconPlus />} onClick={() => navigate("/orders/new")}>
                Принять первую технику
              </Button>
            ) : undefined
          }
        >
          {search || filterCount(filters)
            ? "Попробуйте изменить запрос или снять фильтр."
            : "Заведите первый заказ — заполните бланк приёма, и он появится здесь."}
        </EmptyState>
      ) : (
        <List>
          {rows.map((o) => {
            const due = o.status.group === "CLOSED" ? null : dueLabel(o.dueAt);
            return (
              <Link
                key={o.id}
                // Нашлось в истории — открываем заказ сразу на ленте и с
                // запросом: карточка подсветит ту самую запись.
                to={o.foundMessage ? `/orders/${o.id}?found=${o.foundMessage.id}#history` : `/orders/${o.id}`}
                className="block"
                data-order-row={o.id}
                {...om.bind(menuFromOrder(o))}
              >
                <ListRow
                  glyph={<StatusGlyph tone={statusGlyphTone(o.status.group)} title={o.status.name} />}
                  title={
                    <>
                      <span className="font-mono text-[14px] text-ink-soft" {...copyable("order", o.number)}>{o.number}</span>
                      <span className="truncate">{deviceTitle(o)}</span>
                      {o.isUrgent && (
                        <Badge tone="danger" icon={<IconUrgent />}>
                          срочный
                        </Badge>
                      )}
                      {o.kind === "WARRANTY" && (
                        <Badge tone="warning" icon={<IconWarranty />}>
                          гарантия
                        </Badge>
                      )}
                      {o.kind !== "REPAIR" && o.kind !== "WARRANTY" && (
                        <Badge>{ORDER_KIND_LABEL[o.kind]}</Badge>
                      )}
                      {o.inDebt && <DebtBadge amount={o.debt} />}
                    </>
                  }
                  subtitle={
                    <>
                      {o.customer.name && (
                        <span
                          className="text-ink-soft"
                          {...copyable("name", o.customer.name)}
                          style={nameStyle(o.customer.color)}
                          title={customerColor(o.customer.color)?.label}
                        >
                          {o.customer.name}
                        </span>
                      )}
                      {o.customer.name && " · "}
                      {o.complaint || "без описания"}
                      {/* Нашлось в истории ремонта: показываем саму запись —
                          иначе непонятно, почему заказ оказался в выдаче. */}
                      {o.foundMessage && (
                        <span className="mt-1 block truncate text-[12.5px] text-ink-dim">
                          <span className="text-ink-muted">в истории ремонта:</span> «{o.foundMessage.text}»
                          {o.foundMessage.author ? ` — ${o.foundMessage.author}` : ""}
                        </span>
                      )}
                    </>
                  }
                  meta={
                    <>
                      {/* Пустые ячейки на широком экране остаются на месте:
                          без этого колонки съезжают у заказов без мастера
                          или без суммы, и список перестаёт читаться сверху вниз. */}
                      <span className="whitespace-nowrap lg:flex lg:w-[156px] lg:justify-end">
                        <StatusPill tone={statusPill(o).tone}>{statusPill(o).label}</StatusPill>
                      </span>
                      <span
                        className="empty:hidden lg:empty:block whitespace-nowrap lg:w-[104px] lg:text-right"
                        title={o.assignedMaster?.fullName}
                      >
                        {o.assignedMaster ? shortName(o.assignedMaster.fullName) : ""}
                      </span>
                      <span
                        className={
                          "empty:hidden lg:empty:block whitespace-nowrap lg:w-[126px] lg:text-right " +
                          (due?.overdue ? "font-semibold text-state-off" : due?.soon ? "text-state-waiting" : "")
                        }
                      >
                        {due ? due.text : formatDateShort(o.acceptedAt)}
                      </span>
                      <span className="empty:hidden lg:empty:block whitespace-nowrap lg:w-[88px] lg:text-right font-semibold text-ink-soft">
                        {o.total !== undefined && o.total !== null && o.total > 0 ? money(o.total) : ""}
                      </span>
                    </>
                  }
                />
              </Link>
            );
          })}
        </List>
      )}

      {rows && <Pager {...pageInfo} onPage={setPage} />}
      {om.element}
    </div>
  );
}
