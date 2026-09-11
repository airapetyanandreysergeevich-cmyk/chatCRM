import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  IconOrders,
  IconPurchases,
  IconStatusDone,
  IconStatusProgress,
  IconStatusWaiting,
  IconStock,
  IconUrgent,
} from "../components/icons";
import {
  Banner,
  Card,
  EmptyState,
  List,
  ListRow,
  PageHeader,
  SectionLabel,
  Spinner,
  StatusGlyph,
} from "../components/ui";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { dueLabel, formatDateShort, plural, shortName } from "../lib/format";
import { money, statusGlyphTone, statusTextClass } from "../lib/orders";
import { summaryApi, type Summary } from "../lib/workshop";

/**
 * Сводка мастерской.
 *
 * Каждая цифра здесь — ответ на вопрос «что мне делать прямо сейчас», а не
 * украшение. Поэтому плитки кликаются: увидел «3 просрочено» — нажал и
 * попал в список этих трёх. Показатель, на который нельзя нажать и ничего
 * с ним сделать, на главной не нужен.
 */

function Tile({
  to,
  value,
  label,
  hint,
  icon,
  tone,
}: {
  to: string;
  value: number;
  label: string;
  hint?: string;
  icon: ReactNode;
  tone?: "danger" | "warning" | "done" | "progress";
}) {
  const valueTone =
    tone === "danger"
      ? "text-state-off"
      : tone === "warning"
        ? "text-state-waiting"
        : tone === "done"
          ? "text-state-done"
          : tone === "progress"
            ? "text-state-progress"
            : "text-ink";
  return (
    <Link to={to} className="block">
      <Card interactive className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className={"text-[32px] font-extrabold leading-none tracking-tight " + (value ? valueTone : "text-ink-dim")}>
              {value}
            </p>
            <p className="mt-2.5 text-[14px] font-semibold">{label}</p>
            {hint && <p className="mt-0.5 truncate text-[12.5px] text-ink-dim">{hint}</p>}
          </div>
          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-card bg-surface-raised text-ink-muted [&>svg]:h-[18px] [&>svg]:w-[18px]">
            {icon}
          </span>
        </div>
      </Card>
    </Link>
  );
}

function MoneyRow({ revenue }: { revenue: NonNullable<Summary["revenue"]> }) {
  const cells = [
    ["Сегодня", revenue.today],
    ["За неделю", revenue.week],
    ["За месяц", revenue.month],
  ] as const;
  return (
    <Card>
      <SectionLabel>Выдано клиентам</SectionLabel>
      <div className="mt-3 grid gap-4 sm:grid-cols-3">
        {cells.map(([label, value]) => (
          <div key={label}>
            <p className="text-[22px] font-extrabold leading-none tracking-tight">{money(value)}</p>
            <p className="mt-1.5 text-[12.5px] text-ink-dim">{label}</p>
          </div>
        ))}
      </div>
      {/* Оговорка не для красоты: это сумма закрытых заказов, а не касса.
          Путать их — верный способ однажды не сойтись с бухгалтерией. */}
      <p className="mt-3 border-t border-line pt-3 text-[12px] text-ink-dim">
        Сумма выданных заказов за период. Живые деньги — в разделе «Касса».
      </p>
    </Card>
  );
}

export default function Dashboard() {
  const { me, can } = useAuth();
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const name = me?.kind === "tenant" ? me.user.fullName.split(" ")[0] : "";

  useEffect(() => {
    summaryApi
      .get()
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Не удалось загрузить сводку"));
  }, []);

  if (error) return <Banner tone="error">{error}</Banner>;
  if (!data) return <Spinner label="Считаем" />;

  const g = data.groups;
  const nothingYet =
    Object.values(g).every((n) => n === 0) && data.recent.length === 0;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Мастерская"
        title={name ? `Здравствуйте, ${name}` : "Сводка"}
        subtitle={
          data.scope === "mine"
            ? "Ваши ремонты: что в работе, что ждёт, что горит."
            : "Что в работе, что готово, что тормозит."
        }
      />

      {nothingYet ? (
        <EmptyState icon={<IconOrders />} title="Заказов пока нет">
          Сводка считается по настоящим заказам. Заведите первый — и цифры появятся здесь сами.
        </EmptyState>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Tile
              to="/orders?group=IN_PROGRESS"
              value={g.IN_PROGRESS}
              label="В работе"
              hint="мастер занят ими сейчас"
              icon={<IconStatusProgress />}
              tone="progress"
            />
            <Tile
              to="/orders?group=DONE"
              value={g.DONE}
              label="Ждут выдачи"
              hint="готовы, но не забраны"
              icon={<IconStatusDone />}
              tone="done"
            />
            <Tile
              to="/orders?group=WAITING"
              value={g.WAITING}
              label="Ожидают"
              hint="остановлены до запчасти"
              icon={<IconStatusWaiting />}
              tone="warning"
            />
            <Tile
              to="/orders"
              value={data.overdue}
              label="Просрочено"
              hint="срок готовности прошёл"
              icon={<IconUrgent />}
              tone="danger"
            />
          </div>

          <div className="flex flex-wrap gap-x-6 gap-y-1.5 px-1 text-[13px] text-ink-muted">
            <span>
              Сегодня принято <span className="font-bold text-ink">{data.acceptedToday}</span>
            </span>
            <span>
              Выдано <span className="font-bold text-ink">{data.issuedToday}</span>
            </span>
            <span>
              Новых <span className="font-bold text-ink">{g.NEW}</span>
            </span>
          </div>

          {(!!data.lowStock || !!data.purchasesPending) && (
            <div className="grid gap-3 sm:grid-cols-2">
              {!!data.lowStock && (
                <Link to="/stock?filter=low" className="block">
                  <Banner tone="warning">
                    <span className="inline-flex items-center gap-2">
                      <IconStock className="h-4 w-4" />
                      {plural(data.lowStock, "позиция", "позиции", "позиций")} на складе ниже минимума —
                      посмотреть
                    </span>
                  </Banner>
                </Link>
              )}
              {!!data.purchasesPending && (
                <Link to="/purchases?status=PENDING" className="block">
                  <Banner>
                    <span className="inline-flex items-center gap-2">
                      <IconPurchases className="h-4 w-4" />
                      {plural(data.purchasesPending, "заявка ждёт", "заявки ждут", "заявок ждут")}
                      {" "}согласования — открыть
                    </span>
                  </Banner>
                </Link>
              )}
            </div>
          )}

          {data.revenue && <MoneyRow revenue={data.revenue} />}

          <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
            <div className="space-y-2.5">
              <div className="flex items-center justify-between px-1">
                <SectionLabel>Последние заказы</SectionLabel>
                <Link to="/orders" className="text-[12.5px] font-semibold text-brand-ink hover:underline">
                  все заказы
                </Link>
              </div>
              <List>
                {data.recent.map((o) => {
                  const due = o.status.group === "CLOSED" ? null : dueLabel(o.dueAt);
                  return (
                    <Link key={o.id} to={`/orders/${o.id}`} className="block">
                      <ListRow
                        glyph={<StatusGlyph tone={statusGlyphTone(o.status.group)} title={o.status.name} />}
                        title={
                          <>
                            <span className="font-mono text-[14px] text-ink-soft">{o.number}</span>
                            <span className="truncate">
                              {[o.device?.kind, o.device?.brand, o.device?.model].filter(Boolean).join(" ") ||
                                "Техника не указана"}
                            </span>
                          </>
                        }
                        subtitle={o.customer.name ?? o.complaint}
                        meta={
                          <>
                            <span
                              className={
                                "whitespace-nowrap font-semibold " +
                                statusTextClass(o.status.group)
                              }
                            >
                              {o.status.name}
                            </span>
                            <span
                              className={
                                "whitespace-nowrap " +
                                (due?.overdue ? "font-semibold text-state-off" : "")
                              }
                            >
                              {due ? due.text : formatDateShort(o.acceptedAt)}
                            </span>
                          </>
                        }
                      />
                    </Link>
                  );
                })}
              </List>
            </div>

            {data.masters && (
              <div className="space-y-2.5">
                <SectionLabel>Загрузка мастеров</SectionLabel>
                {data.masters.length === 0 ? (
                  <Card className="p-4 text-[13.5px] text-ink-dim">
                    Ни на кого сейчас не назначено ни одного заказа.
                  </Card>
                ) : (
                  <List>
                    {data.masters.map((m) => (
                      <ListRow
                        key={m.id}
                        title={<span className="truncate">{shortName(m.fullName)}</span>}
                        meta={
                          <span className="whitespace-nowrap font-semibold text-ink-soft">
                            {plural(m.active, "заказ", "заказа", "заказов")}
                          </span>
                        }
                      />
                    ))}
                  </List>
                )}
                {can("staff.manage") && (
                  <Link
                    to="/staff"
                    className="block px-1 text-[12.5px] font-semibold text-brand-ink hover:underline"
                  >
                    все сотрудники
                  </Link>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
