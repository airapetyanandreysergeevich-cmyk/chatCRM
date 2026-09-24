import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { copyable } from "../components/CopyMenu";
import { Link, useNavigate, useParams } from "react-router-dom";
import { IconChevronLeft, IconCompany, IconEdit, IconOrders, IconPerson, IconUrgent, IconWarranty } from "../components/icons";
import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  List,
  ListRow,
  SectionLabel,
  Spinner,
  StatusGlyph,
} from "../components/ui";
import { DebtPanel } from "../components/DebtPanel";
import { ApiError, api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { customerColor, nameStyle } from "../lib/customerColor";
import { formatDateShort, plural } from "../lib/format";
import { money, ORDER_KIND_LABEL, statusGlyphTone, statusTextClass, type Order } from "../lib/orders";
import { ClientModal, type Client } from "./Clients";

/**
 * Карточка клиента: кто он, сколько раз приходил и сколько заплатил.
 *
 * Отдельная страница, а не окно: из неё уходят в заказы и возвращаются
 * кнопкой «назад», на неё ведёт имя клиента из карточки заказа. Окно такого
 * не переживает — закрылось, и человек снова в начале списка.
 *
 * «Оплачено» и «средний чек» сервер присылает только тем, кому положено видеть
 * деньги; остальные видят те же плитки без сумм.
 */

interface Detail {
  customer: Omit<Client, "orderCount" | "deviceCount"> & { inn: string | null };
  stats: {
    orders: number;
    active: number;
    firstVisit: string | null;
    lastVisit: string | null;
    paid?: number;
    average?: number | null;
  };
  debt: { total: number };
  devices: unknown[];
  orders: Array<{
    id: string;
    number: string;
    kind: Order["kind"];
    isUrgent: boolean;
    complaint: string | null;
    acceptedAt: string;
    issuedAt: string | null;
    status: { name: string; group: Order["status"]["group"] };
    device: { kind: string | null; brand: string | null; model: string | null } | null;
    total?: number;
  }>;
}

const deviceTitle = (d: Detail["orders"][number]["device"]) =>
  [d?.kind, d?.brand, d?.model].filter(Boolean).join(" ") || "Техника не указана";

export default function ClientCard() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  /** Карточка уже показывалась: её пропажа значит «удалили», а не «нет такой». */
  const shown = useRef(false);

  const load = useCallback(async () => {
    try {
      setData(await api.get<Detail>(`/customers/${id}`));
      shown.current = true;
    } catch (err) {
      // Карточку только что удалили из окна правки — уходим в список, а не
      // показываем «клиент не найден» про того, кого сами же удалили.
      if (err instanceof ApiError && err.status === 404 && shown.current) {
        navigate("/clients", { replace: true });
        return;
      }
      setError(err instanceof ApiError ? err.message : "Не удалось загрузить клиента");
    }
  }, [id, navigate]);

  useEffect(() => {
    setData(null);
    shown.current = false;
    void load();
  }, [load]);

  const back = () => {
    // Пришли из списка — возвращаемся в него на то же место; открыли ссылкой
    // — в список клиентов.
    if (window.history.length > 1) navigate(-1);
    else navigate("/clients");
  };

  if (error)
    return (
      <div className="space-y-4">
        <BackLink onClick={back} />
        <Banner tone="error">{error}</Banner>
      </div>
    );
  if (!data) return <Spinner />;

  const c = data.customer;
  const s = data.stats;
  const seesMoney = s.paid !== undefined;
  const color = customerColor(c.color);

  return (
    <div className="space-y-5">
      <BackLink onClick={back} />

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3.5">
            <StatusGlyph
              tone="neutral"
              title={c.type === "COMPANY" ? "Организация" : "Частное лицо"}
              icon={c.type === "COMPANY" ? <IconCompany /> : <IconPerson />}
            />
            <div className="min-w-0">
              <SectionLabel>Клиент №{c.number}</SectionLabel>
              <h1 className="mt-1.5 flex flex-wrap items-center gap-2 text-[26px] font-extrabold leading-tight tracking-tight">
                {color && (
                  <span
                    title={color.label}
                    className="h-[14px] w-[14px] shrink-0 rounded-full"
                    style={{ backgroundColor: color.dot }}
                  />
                )}
                <span style={nameStyle(c.color)} {...copyable("name", c.name)}>{c.name}</span>
                {c.type === "COMPANY" && <Badge>организация</Badge>}
                {c.discountPercent > 0 && <Badge tone="brand">скидка {c.discountPercent}%</Badge>}
              </h1>
              <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[14px] text-ink-muted">
                {c.phone ? (
                  <a href={`tel:${c.phone}`} {...copyable("phone", c.phone)} className="font-semibold text-brand-ink hover:underline">
                    {c.phone}
                  </a>
                ) : (
                  <span className="text-ink-dim">телефон не указан</span>
                )}
                {c.phone2 && (
                  <a href={`tel:${c.phone2}`} {...copyable("phone", c.phone2)} className="hover:underline">
                    {c.phone2}
                  </a>
                )}
                {c.email && <span>{c.email}</span>}
                {c.address && <span>{c.address}</span>}
              </p>
              {c.note && <p className="mt-2 text-[13.5px] text-ink-soft">{c.note}</p>}
            </div>
          </div>
          {can("customers.edit") && (
            <Button variant="secondary" icon={<IconEdit />} onClick={() => setEditing(true)}>
              Изменить
            </Button>
          )}
        </div>
      </Card>

      {/* Долг — первое, что нужно знать о человеке у стойки. Панель сама
          прячется, когда долга нет. */}
      <DebtPanel customerId={c.id} onPaid={() => void load()} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Tile
          label="Заказов"
          value={String(s.orders)}
          hint={s.active > 0 ? `сейчас в работе: ${s.active}` : s.orders > 0 ? "все завершены" : "пока не было"}
        />
        {seesMoney && <Tile label="Оплачено" value={money(s.paid ?? 0)} hint="по кассе, за всё время" />}
        {seesMoney && (
          <Tile
            label="Средний чек"
            value={s.average ? money(s.average) : "—"}
            hint={s.average ? "по выданным заказам" : "выданных ещё нет"}
          />
        )}
        <Tile label="Первый визит" value={s.firstVisit ? formatDateShort(s.firstVisit) : "—"} />
        <Tile label="Последний визит" value={s.lastVisit ? formatDateShort(s.lastVisit) : "—"} />
      </div>

      <div className="space-y-2.5">
        <SectionLabel>
          {s.orders > 0 ? plural(s.orders, "заказ", "заказа", "заказов") : "Заказы"}
          {s.orders > data.orders.length ? ` · показаны последние ${data.orders.length}` : ""}
        </SectionLabel>

        {data.orders.length === 0 ? (
          <EmptyState icon={<IconOrders />} title="Заказов пока нет">
            Клиент заведён заранее — первый заказ появится здесь, как только примут его технику.
          </EmptyState>
        ) : (
          <List>
            {data.orders.map((o) => (
              <Link key={o.id} to={`/orders/${o.id}`} className="block">
                <ListRow
                  glyph={<StatusGlyph tone={statusGlyphTone(o.status.group)} title={o.status.name} />}
                  title={
                    <>
                      <span className="font-mono text-[14px] text-ink-soft" {...copyable("order", o.number)}>{o.number}</span>
                      <span className="truncate">{deviceTitle(o.device)}</span>
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
                      {o.kind !== "REPAIR" && o.kind !== "WARRANTY" && <Badge>{ORDER_KIND_LABEL[o.kind]}</Badge>}
                    </>
                  }
                  subtitle={o.complaint || "без описания"}
                  meta={
                    <>
                      <span
                        className={
                          "whitespace-nowrap font-semibold lg:w-[146px] lg:text-right " + statusTextClass(o.status.group)
                        }
                      >
                        {o.status.name}
                      </span>
                      <span className="whitespace-nowrap lg:w-[96px] lg:text-right">{formatDateShort(o.acceptedAt)}</span>
                      {seesMoney && (
                        <span className="whitespace-nowrap font-semibold text-ink-soft lg:w-[88px] lg:text-right">
                          {o.total && o.total > 0 ? money(o.total) : "—"}
                        </span>
                      )}
                    </>
                  }
                />
              </Link>
            ))}
          </List>
        )}
      </div>

      {editing && (
        <ClientModal
          client={{ ...c, orderCount: s.orders, deviceCount: data.devices.length }}
          onClose={() => setEditing(false)}
          onDone={() => {
            setEditing(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

function BackLink({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 text-[14px] font-semibold text-ink-muted transition-colors hover:text-ink [&>svg]:h-[18px] [&>svg]:w-[18px]"
    >
      <IconChevronLeft />
      Назад
    </button>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: ReactNode }) {
  return (
    <div className="rounded-card border border-line bg-surface p-4 shadow-card">
      <SectionLabel>{label}</SectionLabel>
      <p className="mt-2 text-[22px] font-extrabold leading-none tracking-tight">{value}</p>
      {hint && <p className="mt-1.5 text-[12.5px] text-ink-dim">{hint}</p>}
    </div>
  );
}
