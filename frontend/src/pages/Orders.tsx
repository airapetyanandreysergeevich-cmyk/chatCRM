import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { IconOrders, IconPlus } from "../components/icons";
import { Banner, Button, Card, EmptyState, PageHeader, SearchInput, Spinner, StatusChip } from "../components/ui";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatDate, formatDateTime } from "../lib/format";
import {
  money,
  ORDER_KIND_LABEL,
  ordersApi,
  statusTone,
  type Order,
  type Reference,
} from "../lib/orders";

const GROUPS = [
  { value: "", label: "Все" },
  { value: "NEW", label: "Новые" },
  { value: "IN_PROGRESS", label: "В работе" },
  { value: "WAITING", label: "Ожидают" },
  { value: "DONE", label: "Готовы" },
  { value: "CLOSED", label: "Выданы" },
] as const;

export default function Orders() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [rows, setRows] = useState<Order[] | null>(null);
  const [reference, setReference] = useState<Reference | null>(null);
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
    ordersApi.reference().then(setReference).catch(() => undefined);
  }, []);

  useEffect(() => {
    // Небольшая задержка, чтобы не дёргать сервер на каждую букву в поиске.
    const t = setTimeout(() => void load(), search ? 350 : 0);
    return () => clearTimeout(t);
  }, [load, search]);

  if (error) return <Banner tone="error">{error}</Banner>;

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
        <div className="grid gap-3 xl:grid-cols-2">
          {rows.map((o) => (
            <Link key={o.id} to={`/orders/${o.id}`} className="block">
              <Card interactive className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[15px] font-bold">{o.number}</span>
                      {o.isUrgent && (
                        <span className="rounded-pill bg-[#2D1A1D] px-2 py-0.5 text-[11.5px] font-bold text-[#EE9494]">
                          срочный
                        </span>
                      )}
                      {o.kind !== "REPAIR" && (
                        <span className="rounded-pill bg-surface-raised px-2 py-0.5 text-[11.5px] font-semibold text-ink-muted">
                          {ORDER_KIND_LABEL[o.kind]}
                        </span>
                      )}
                    </div>
                    <p className="mt-1.5 truncate text-[15px] font-semibold">
                      {[o.device?.kind, o.device?.brand, o.device?.model].filter(Boolean).join(" ") ||
                        "Техника не указана"}
                    </p>
                    <p className="mt-1 line-clamp-2 text-[13.5px] text-ink-muted">{o.complaint}</p>
                  </div>
                  <StatusChip tone={statusTone(o.status.group)}>{o.status.name}</StatusChip>
                </div>

                <div className="mt-3.5 flex flex-wrap items-center gap-x-5 gap-y-1.5 border-t border-line pt-3 text-[12.5px] text-ink-dim">
                  <span>Принят {formatDate(o.acceptedAt)}</span>
                  {o.dueAt && <span>Срок {formatDate(o.dueAt)}</span>}
                  {o.assignedMaster && <span>Мастер: {o.assignedMaster.fullName}</span>}
                  {o.customer.name && <span>{o.customer.name}</span>}
                  {o.total !== undefined && o.total !== null && o.total > 0 && (
                    <span className="ml-auto font-semibold text-ink-soft">{money(o.total)}</span>
                  )}
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}

      {rows && rows.length > 0 && reference && (
        <p className="text-[12.5px] text-ink-dim">
          Показано {rows.length}. Последнее обновление {formatDateTime(new Date())}.
        </p>
      )}
    </div>
  );
}
