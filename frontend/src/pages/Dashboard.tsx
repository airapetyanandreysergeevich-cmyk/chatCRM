import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { IconOrders } from "../components/icons";
import { Badge, Banner, EmptyState, Spinner } from "../components/ui";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { dueLabel, formatDateShort, plural, shortName } from "../lib/format";
import { money } from "../lib/orders";
import { STAGES, type Stage } from "../lib/stages";
import {
  summaryApi,
  type BoardCard,
  type OverdueDebt,
  type StageColumn,
  type Summary,
} from "../lib/workshop";

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

/**
 * Просроченные долги.
 *
 * Показываем заказ, клиента и телефон: действие здесь одно — позвонить, и оно
 * должно начинаться в этой же строке, а не в карточке клиента через два
 * перехода. Номер — ссылка, на телефоне она сразу набирает.
 */
function OverduePanel({ rows, total }: { rows: OverdueDebt[]; total: number }) {
  return (
    <section className="rounded-panel border border-state-off/45 bg-state-off/[0.06] p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-[15px] font-bold uppercase tracking-wide text-state-off">
          Просрочка задолженности
        </h2>
        <p className="text-[19px] font-extrabold leading-none tracking-tight">{money(total)}</p>
      </div>

      <ul className="mt-3 space-y-1.5">
        {rows.map((r) => (
          <li
            key={r.orderId}
            className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-field bg-surface/70 px-3 py-2"
          >
            <Link to={`/orders/${r.orderId}`} className="font-mono text-[13px] font-bold hover:underline">
              {r.number}
            </Link>
            <span className="min-w-0 flex-1 truncate text-[14px]">
              {r.customer?.name ?? "Клиент не указан"}
            </span>
            {r.customer?.phone && (
              <a
                href={`tel:${r.customer.phone}`}
                className="whitespace-nowrap text-[13px] font-semibold text-brand-ink hover:underline"
              >
                {r.customer.phone}
              </a>
            )}
            <span className="whitespace-nowrap text-[12.5px] text-ink-muted">
              обещали {formatDateShort(r.debtDueAt)}
            </span>
            <span className="whitespace-nowrap text-[14px] font-bold text-state-off">{money(r.due)}</span>
          </li>
        ))}
      </ul>
    </section>
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
      className="block rounded-card border border-line bg-surface-raised p-3 transition-all duration-150 hover:-translate-y-[1px] hover:border-line-strong hover:shadow-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
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
        {/* Срок не обрезаем никогда: в узкой колонке уступает имя мастера —
            «просрочен 5 дн.» важнее, чем чья это работа. */}
        <span
          className={
            "shrink-0 whitespace-nowrap " +
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
          <span className="min-w-0 truncate text-right text-ink-dim">
            {shortName(card.master.fullName)}
          </span>
        )}
      </div>
    </Link>
  );
}

function StageColumnPanel({
  stage,
  column,
  fit,
}: {
  stage: Stage;
  column: StageColumn;
  /** Сколько карточек помещается на экран. Одно число на все колонки. */
  fit: number;
}) {
  const shown = column.items.slice(0, fit);
  const hidden = column.total - shown.length;

  return (
    <section className="relative rounded-panel border border-line bg-surface p-3 sm:p-3.5">
      {/* Цвет стадии — тонкая светящаяся полоса по верхней грани. Отдельным
          элементом, а не рамкой: рамка читается как контур, а нужна
          подсветка. Чуть отступает от углов, чтобы не спорить со скруглением. */}
      <span aria-hidden className={"absolute inset-x-3.5 -top-px h-[2px] rounded-pill " + stage.glow} />

      {/* Заголовок — ссылка в список заказов с тем же фильтром. Сама панель
          ссылкой быть не может: внутри неё уже лежат ссылки на заказы. */}
      <Link
        to={`/orders?group=${stage.key}`}
        title={`Все заказы: ${stage.label.toLowerCase()}`}
        className="flex items-center justify-between gap-2 rounded-field px-0.5 pb-3 transition-opacity duration-150 hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
      >
        <h2 className="flex items-center gap-2 text-[13px] font-bold uppercase tracking-[0.1em] text-ink-soft">
          <span aria-hidden className={"h-[7px] w-[7px] shrink-0 rounded-full " + stage.dot} />
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

      {shown.length === 0 ? (
        <p className="px-0.5 pb-2 text-[13px] text-ink-dim">Пусто</p>
      ) : (
        <div className="space-y-2" data-cards>
          {shown.map((card) => (
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

/**
 * Сколько карточек помещается на видимую часть экрана.
 *
 * Доска — рабочее место, а не список: на неё смотрят, а не листают её. Пока
 * в колонку падало всё подряд, главная растягивалась на три экрана, и по
 * высоте столбцов, ради которой доска и сделана, ничего сравнить было
 * нельзя — второй колонки просто не видно, когда первая уехала вниз.
 *
 * Высоту карточки не задаём числом, а меряем: шрифт зависит от темы и от
 * настроек человека, а «86 пикселей» в коде расходятся с правдой в первый
 * же день. Меряем первую отрисованную карточку и от неё считаем остальные.
 *
 * Число одно на все четыре колонки. Считать каждой своё значило бы, что на
 * узком экране, где колонки идут одна под другой, нижние получают по одной
 * карточке — они и правда начинаются ниже края экрана, но выглядит это как
 * поломка, а не как забота.
 */
function useFit(ready: boolean): [number, (el: HTMLDivElement | null) => void] {
  const board = useRef<HTMLDivElement | null>(null);
  // Шесть — столько, чтобы было что померить, и не столько, чтобы экран
  // дёрнулся, если поместится меньше.
  const [fit, setFit] = useState(6);

  const measure = useCallback(() => {
    const el = board.current;
    if (!el) return;

    // Узкий экран: колонки идут одна под другой, и «влезает» теряет смысл —
    // ниже первой не видно ничего. Показываем немного и одинаково.
    if (!window.matchMedia("(min-width: 768px)").matches) return setFit(4);

    const cards = el.querySelector<HTMLElement>("[data-cards]");
    const card = cards?.firstElementChild?.getBoundingClientRect().height ?? 86;
    const top = (cards ?? el).getBoundingClientRect().top;
    const gap = 8;
    // Запас под строку «ещё N заказов» и воздух под доской: без него
    // последняя карточка в колонке всегда оказывается наполовину срезанной.
    const reserve = 64;

    const n = Math.floor((window.innerHeight - top - reserve + gap) / (card + gap));
    setFit(Math.max(1, Math.min(n, 60)));
  }, []);

  useEffect(() => {
    if (!ready) return;
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [ready, measure]);

  return [
    fit,
    (el) => {
      board.current = el;
    },
  ];
}

export default function Dashboard() {
  const { me } = useAuth();
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fit, boardRef] = useFit(data !== null);

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
  const overdue = data.overdue ?? [];
  const empty = data.stages.every((s) => s.total === 0);

  return (
    <div className="space-y-6">
      {header}

      {/* Просрочка стоит выше доски: это единственное на главной, что не
          решится само и требует звонка сегодня. Панели нет, пока нет
          просроченных, — постоянная панель с нулём перестаёт замечаться, а
          вместе с ней перестаёт замечаться и непустая. */}
      {overdue.length > 0 && <OverduePanel rows={overdue} total={data.overdueTotal} />}

      {empty ? (
        <EmptyState icon={<IconOrders />} title="Заказов в работе нет">
          Доска показывает то, что сейчас в мастерской. Примите первый заказ — он появится в
          «Диагностике».
        </EmptyState>
      ) : (
        // items-start: колонки не тянутся до высоты самой длинной, а растут
        // каждая на свою высоту — по ней и видно, где скопилась работа.
        <div ref={boardRef} className="grid items-start gap-3 sm:gap-4 md:grid-cols-2 xl:grid-cols-4">
          {STAGES.map((stage) => (
            <StageColumnPanel
              key={stage.key}
              stage={stage}
              column={byKey.get(stage.key) ?? { key: stage.key, total: 0, items: [] }}
              fit={fit}
            />
          ))}
        </div>
      )}
    </div>
  );
}
