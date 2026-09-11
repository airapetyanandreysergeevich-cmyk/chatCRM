import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { IconOrders } from "../components/icons";
import { Badge, Banner, EmptyState, Spinner } from "../components/ui";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { dueLabel, plural, shortName } from "../lib/format";
import { STAGES, type Stage } from "../lib/stages";
import { summaryApi, type BoardCard, type StageColumn, type Summary } from "../lib/workshop";

/**
 * Главный экран мастерской.
 *
 * Это доска, а не сводка: четыре стадии — четыре колонки, в колонках лежат
 * заказы, карточка открывает заказ. Колонки одинаковой ширины и растут вниз
 * сами по себе, поэтому по высоте столбца сразу видно, где затор.
 *
 * Цифры без заказов за ними отсюда убраны намеренно. Показатель, по которому
 * нельзя ткнуть и попасть в работу, на рабочем экране только занимает место.
 */

/** Часы обновляются раз в секунду — иначе это не часы, а надпись со временем. */
function Clock() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const time = now.toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const date = now.toLocaleDateString("ru-RU", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });

  return (
    <div className="shrink-0 text-right">
      {/* tabular-nums: без него строка дёргается каждую секунду. */}
      <p className="font-mono text-[24px] font-bold leading-none tracking-tight tabular-nums sm:text-[34px] lg:text-[40px]">
        {time}
      </p>
      <p className="mt-1.5 text-[12px] text-ink-muted first-letter:uppercase sm:text-[13px]">{date}</p>
    </div>
  );
}

function OrderCardTile({ card }: { card: BoardCard }) {
  const due = dueLabel(card.dueAt);
  const device =
    [card.device?.kind, card.device?.brand, card.device?.model].filter(Boolean).join(" ") ||
    "Техника не указана";

  return (
    <Link
      to={`/orders/${card.id}`}
      className="block rounded-card border border-line bg-surface p-3 transition-all duration-150 hover:-translate-y-[1px] hover:border-line-strong hover:shadow-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
    >
      <div className="flex items-center gap-2">
        <span className="font-mono text-[13px] font-semibold text-ink-soft">{card.number}</span>
        {card.isUrgent && <Badge tone="danger">срочный</Badge>}
      </div>

      <p className="mt-1.5 truncate text-[14px] font-semibold">{device}</p>

      {/* Ни клиента, ни названия статуса здесь нет: доска отвечает на вопрос
          «что чинить дальше», а колонка уже сказала, на какой это стадии.
          Всё остальное — на карточке заказа, в одном нажатии отсюда. */}
      <div className="mt-2 flex items-center justify-between gap-2 text-[12px]">
        <span
          className={
            "truncate " +
            (due?.overdue
              ? "font-semibold text-state-off"
              : due?.soon
                ? "font-semibold text-state-waiting"
                : "text-ink-dim")
          }
        >
          {due ? due.text : ""}
        </span>
        {card.master && (
          <span className="shrink-0 truncate text-ink-dim">{shortName(card.master.fullName)}</span>
        )}
      </div>
    </Link>
  );
}

function StageColumnPanel({ stage, column }: { stage: Stage; column: StageColumn }) {
  const hidden = column.total - column.items.length;

  return (
    <section className={"rounded-panel border p-3 sm:p-3.5 " + stage.panel}>
      {/* Заголовок — ссылка в список заказов с тем же фильтром. Сама панель
          ссылкой быть не может: внутри неё уже лежат ссылки на заказы. */}
      <Link
        to={`/orders?group=${stage.key}`}
        title={`Все заказы: ${stage.label.toLowerCase()}`}
        className="flex items-center justify-between gap-2 rounded-field px-0.5 pb-3 transition-opacity duration-150 hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
      >
        <h2 className={"text-[13px] font-bold uppercase tracking-[0.1em] " + stage.text}>
          {stage.label}
        </h2>
        <span
          className={
            "inline-flex h-6 min-w-[24px] items-center justify-center rounded-pill px-2 text-[12px] font-bold " +
            stage.chip
          }
        >
          {column.total}
        </span>
      </Link>

      {column.items.length === 0 ? (
        <p className="px-0.5 pb-2 text-[13px] text-ink-dim">Пусто</p>
      ) : (
        <div className="space-y-2">
          {column.items.map((card) => (
            <OrderCardTile key={card.id} card={card} />
          ))}
        </div>
      )}

      {hidden > 0 && (
        <Link
          to={`/orders?group=${stage.key}`}
          className="mt-2 block px-0.5 text-[12.5px] font-semibold text-brand-ink hover:underline"
        >
          ещё {plural(hidden, "заказ", "заказа", "заказов")}
        </Link>
      )}
    </section>
  );
}

export default function Dashboard() {
  const { me } = useAuth();
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    summaryApi
      .get()
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Не удалось загрузить доску"));
  }, []);

  const workshop =
    me?.kind === "tenant"
      ? (me.tenant?.name ?? "Мастерская")
      : me?.kind === "platform"
        ? (me.impersonating?.name ?? "Мастерская")
        : "Мастерская";

  const header = (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-ink-dim">
          {data?.scope === "mine" ? "Мои заказы" : "Мастерская"}
        </p>
        {/* Название не обрезаем: длинное имя мастерской лучше перенести
            на вторую строку, чем показать «Сервис на …». */}
        <h1 className="mt-1.5 text-[24px] font-extrabold leading-tight tracking-tight [overflow-wrap:anywhere] sm:text-[32px] lg:text-[38px]">
          {workshop}
        </h1>
      </div>
      <Clock />
    </div>
  );

  if (error) {
    return (
      <div className="space-y-6">
        {header}
        <Banner tone="error">{error}</Banner>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="space-y-6">
        {header}
        <Spinner label="Собираем доску" />
      </div>
    );
  }

  const byKey = new Map(data.stages.map((s) => [s.key, s]));
  const empty = data.stages.every((s) => s.total === 0);

  return (
    <div className="space-y-6">
      {header}

      {empty ? (
        <EmptyState icon={<IconOrders />} title="Заказов в работе нет">
          Доска показывает то, что сейчас в мастерской. Примите первый заказ — он появится в
          «Диагностике».
        </EmptyState>
      ) : (
        // items-start: колонки не тянутся до высоты самой длинной, а растут
        // каждая на свою высоту — по ней и видно, где скопилась работа.
        <div className="grid items-start gap-3 sm:gap-4 md:grid-cols-2 xl:grid-cols-4">
          {STAGES.map((stage) => (
            <StageColumnPanel
              key={stage.key}
              stage={stage}
              column={byKey.get(stage.key) ?? { key: stage.key, total: 0, items: [] }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
