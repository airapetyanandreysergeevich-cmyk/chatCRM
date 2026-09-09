import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
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
} from "../components/ui";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { dueLabel, formatDateShort, plural, shortName } from "../lib/format";
import {
  money,
  ORDER_KIND_LABEL,
  ordersApi,
  statusGlyphTone,
  statusTextClass,
  type Order,
} from "../lib/orders";

const GROUPS = [
  { value: "", label: "Все" },
  { value: "NEW", label: "Новые" },
  { value: "IN_PROGRESS", label: "В работе" },
  { value: "WAITING", label: "Ожидают" },
  { value: "DONE", label: "Готовы" },
  { value: "CLOSED", label: "Выданы" },
] as const;

const deviceTitle = (o: Order) =>
  [o.device?.kind, o.device?.brand, o.device?.model].filter(Boolean).join(" ") || "Техника не указана";

export default function Orders() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [rows, setRows] = useState<Order[] | null>(null);
  const [group, setGroup] = useState("");
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);

  const canCreate = can("orders.create");
  const onlyAssigned = !can("orders.view.all") && can("orders.view.assigned");

  const load = useCallback(async () => {
    setRows(null);
    try {
      const params: Record<string, string> = {};
      if (group) params.group = group;
      if (search.trim()) params.search = search.trim();
      setRows(await ordersApi.list(params));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось загрузить заказы");
    }
  }, [group, search]);

  useEffect(() => {
    // Небольшая задержка, чтобы не дёргать сервер на каждую букву в поиске.
    const t = setTimeout(() => void load(), search ? 350 : 0);
    return () => clearTimeout(t);
  }, [load, search]);

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

      <Card className="p-3.5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <SearchInput
            placeholder="Номер, неисправность, модель или серийный номер"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="lg:max-w-[380px]"
          />
          <div className="flex flex-wrap gap-1.5">
            {GROUPS.map((g) => (
              <button
                key={g.value}
                onClick={() => setGroup(g.value)}
                className={
                  "rounded-pill px-3.5 py-1.5 text-[13px] font-semibold transition-colors duration-150 " +
                  (group === g.value
                    ? "bg-brand text-white"
                    : "border border-line bg-surface-raised text-ink-muted hover:text-ink")
                }
              >
                {g.label}
              </button>
            ))}
          </div>
        </div>
      </Card>

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
          title={search || group ? "Ничего не нашлось" : "Заказов пока нет"}
          action={
            canCreate && !search && !group ? (
              <Button icon={<IconPlus />} onClick={() => navigate("/orders/new")}>
                Принять первую технику
              </Button>
            ) : undefined
          }
        >
          {search || group
            ? "Попробуйте изменить запрос или снять фильтр."
            : "Заведите первый заказ — заполните бланк приёма, и он появится здесь."}
        </EmptyState>
      ) : (
        <List>
          {rows.map((o) => {
            const due = o.status.group === "CLOSED" ? null : dueLabel(o.dueAt);
            return (
              <Link key={o.id} to={`/orders/${o.id}`} className="block">
                <ListRow
                  glyph={<StatusGlyph tone={statusGlyphTone(o.status.group)} title={o.status.name} />}
                  title={
                    <>
                      <span className="font-mono text-[14px] text-ink-soft">{o.number}</span>
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
                    </>
                  }
                  subtitle={
                    <>
                      {o.customer.name && <span className="text-ink-soft">{o.customer.name}</span>}
                      {o.customer.name && " · "}
                      {o.complaint || "без описания"}
                    </>
                  }
                  meta={
                    <>
                      {/* Пустые ячейки на широком экране остаются на месте:
                          без этого колонки съезжают у заказов без мастера
                          или без суммы, и список перестаёт читаться сверху вниз. */}
                      <span
                        className={
                          "empty:hidden lg:empty:block whitespace-nowrap lg:w-[146px] lg:text-right font-semibold " +
                          statusTextClass(o.status.group)
                        }
                      >
                        {o.status.name}
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

      {rows && rows.length > 0 && (
        <p className="text-[12.5px] text-ink-dim">
          {plural(rows.length, "заказ", "заказа", "заказов")} в списке.
        </p>
      )}
    </div>
  );
}
