import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { C, ChartCard, ColumnChart, DataTable, Donut, HBars, Heatmap, Legend, Sparkline, hideTip, useHideTipOnUnmount } from "../components/charts";
import { Banner, PageHeader, Spinner } from "../components/ui";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatDate } from "../lib/format";
import {
  DOW_NAMES,
  DOW_SHORT,
  PERIODS,
  axisRub,
  bucketLabels,
  bucketRange,
  dayLabel,
  days,
  isoDay,
  monthLabel,
  num,
  pct,
  periodRange,
  rub,
  rubShort,
  statsApi,
  type Access,
  type DrillItem,
  type Gran,
  type MasterCard as MasterCardData,
  type MasterRow,
  type MastersStats,
  type OrdersStats,
  type Overview,
  type PeriodId,
  type Range,
  type Tiles,
} from "../lib/stats";

/**
 * «Статистика»: заказы, деньги и мастера за период — со сравнением с тем же
 * периодом год назад.
 *
 * Кто что видит, решает сервер (stats.routes.ts): с правом «Статистика» —
 * всё, суммы — если ещё видна касса; мастер без права — только свою
 * карточку. Здесь лишь не показываем то, чего сервер не прислал.
 */

/** Только слово, без числа: «заказ», «заказа», «заказов». */
const word = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};

const PERIOD_KEY = "finecrm.stats.period";
const CUSTOM_KEY = "finecrm.stats.custom";
const TAB_KEY = "finecrm.stats.tab";

type Tab = "overview" | "orders" | "masters";
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "overview", label: "Обзор" },
  { id: "orders", label: "Заказы" },
  { id: "masters", label: "Мастера" },
];

const read = <T,>(key: string, ok: (v: unknown) => v is T, d: T): T => {
  try {
    const raw = localStorage.getItem(key);
    const v = raw ? JSON.parse(raw) : null;
    return ok(v) ? v : d;
  } catch {
    return d;
  }
};
const write = (key: string, v: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* не запомнится — не беда */
  }
};

/** Загрузка с защитой от гонки: ответ на прежний период, пришедший позже нового, не показываем. */
function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const seq = useRef(0);
  useEffect(() => {
    const my = ++seq.current;
    setBusy(true);
    setError(null);
    load()
      .then((d) => {
        if (my === seq.current) setData(d);
      })
      .catch((err) => {
        if (my === seq.current) setError(err instanceof ApiError ? err.message : "Не удалось загрузить статистику");
      })
      .finally(() => {
        if (my === seq.current) setBusy(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error, busy };
}

function Pills<T extends string>({
  items,
  value,
  onChange,
  label,
}: {
  items: ReadonlyArray<{ id: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
      {items.map((p) => (
        <button
          key={p.id}
          type="button"
          role="radio"
          aria-checked={value === p.id}
          onClick={() => onChange(p.id)}
          className={
            "rounded-pill px-3.5 py-1.5 text-[13px] font-semibold transition-colors duration-150 " +
            (value === p.id ? "bg-brand text-white" : "border border-line bg-surface-raised text-ink-muted hover:text-ink")
          }
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}

// ================================================================ страница

export default function StatsPage() {
  useHideTipOnUnmount();
  const { can } = useAuth();
  const isMaster = can("orders.view.assigned", "orders.status.own");
  const [access, setAccess] = useState<Access | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriodState] = useState<PeriodId>(() =>
    read(PERIOD_KEY, (v): v is PeriodId => PERIODS.some((p) => p.id === v), "year")
  );
  const [custom, setCustomState] = useState<Range | null>(() =>
    read(CUSTOM_KEY, (v): v is Range => !!v && typeof (v as Range).from === "string" && typeof (v as Range).to === "string", null)
  );
  const [tab, setTabState] = useState<Tab>(() => read(TAB_KEY, (v): v is Tab => TABS.some((t) => t.id === v), "overview"));

  useEffect(() => {
    statsApi
      .access()
      .then(setAccess)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Не удалось открыть статистику"));
  }, []);

  const setPeriod = (p: PeriodId) => {
    setPeriodState(p);
    write(PERIOD_KEY, p);
    if (p === "custom" && !custom) {
      const to = new Date();
      const from = new Date(to.getFullYear(), to.getMonth() - 2, 1);
      const c = { from: isoDay(from), to: isoDay(to) };
      setCustomState(c);
      write(CUSTOM_KEY, c);
    }
  };
  const setCustom = (c: Range) => {
    setCustomState(c);
    write(CUSTOM_KEY, c);
  };
  const setTab = (t: Tab) => {
    hideTip();
    setTabState(t);
    write(TAB_KEY, t);
  };

  if (error) return <Banner tone="error">{error}</Banner>;
  if (!access) return <Spinner />;

  const { range, name } = periodRange(period, custom, access.firstDay);
  const bad = period === "custom" && custom && custom.from > custom.to;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Мастерская"
        title={access.full || !isMaster ? "Статистика" : "Моя статистика"}
        subtitle={
          access.full || !isMaster
            ? "Заказы, деньги и работа мастеров за период — и сравнение с тем же периодом год назад."
            : "Ваши заказы за период и сравнение со средним по мастерской."
        }
      />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
        <Pills items={PERIODS} value={period} onChange={setPeriod} label="Период" />
        {period === "custom" && custom && (
          <div className="flex flex-wrap items-center gap-2 text-[13px] text-ink-muted">
            <label htmlFor="stats-from">с</label>
            <input
              id="stats-from"
              type="date"
              value={custom.from}
              max={custom.to}
              onChange={(e) => e.target.value && setCustom({ ...custom, from: e.target.value })}
              className="rounded-field border border-line bg-surface-input px-2 py-1.5 text-ink"
            />
            <label htmlFor="stats-to">по</label>
            <input
              id="stats-to"
              type="date"
              value={custom.to}
              min={custom.from}
              onChange={(e) => e.target.value && setCustom({ ...custom, to: e.target.value })}
              className="rounded-field border border-line bg-surface-input px-2 py-1.5 text-ink"
            />
          </div>
        )}
        <span className="text-[13px] text-ink-dim">Показано: {name}</span>
      </div>
      {bad && <Banner tone="warning">Начало периода позже конца — поменяйте даты местами.</Banner>}

      {access.full ? (
        <>
          <div role="tablist" className="-mb-1 flex gap-1 overflow-x-auto border-b border-line">
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                className={
                  "-mb-px whitespace-nowrap border-b-2 px-3.5 py-2.5 text-[14px] font-bold transition-colors " +
                  (tab === t.id ? "border-brand text-ink" : "border-transparent text-ink-muted hover:text-ink")
                }
              >
                {t.label}
              </button>
            ))}
          </div>
          {tab === "overview" && <OverviewTab range={range} name={name} />}
          {tab === "orders" && <OrdersTab range={range} />}
          {tab === "masters" && <MastersTab range={range} />}
        </>
      ) : access.me && isMaster ? (
        <MasterCard id={access.me} range={range} />
      ) : (
        <Banner>Статистика мастерской открывается по праву «Статистика» — его выдаёт владелец.</Banner>
      )}
    </div>
  );
}

// ================================================================ общие куски

const Grid = ({ children }: { children: ReactNode }) => <div className="grid grid-cols-12 gap-3.5">{children}</div>;

function Delta({ cur, prev, kind, goodUp = true }: { cur: number | null; prev: number | null | undefined; kind: "rel" | "pp"; goodUp?: boolean }) {
  if (cur === null || prev === null || prev === undefined) return null;
  const d = kind === "rel" ? (prev ? (cur - prev) / prev : null) : cur - prev;
  if (d === null || !isFinite(d)) return null;
  const flat = Math.abs(d) < 0.005;
  const up = d > 0;
  const good = flat ? null : up === goodUp;
  const val = kind === "rel" ? pct(Math.abs(d)) : `${String(Math.round(Math.abs(d) * 1000) / 10).replace(".", ",")} п.п.`;
  return (
    <span className={"text-[12.5px] font-bold " + (good === null ? "text-ink-dim" : good ? "text-state-done" : "text-state-off")}>
      {flat ? "● " : up ? "▲ +" : "▼ −"}
      {val}
      <span className="font-medium text-ink-dim"> к прошлому году</span>
    </span>
  );
}

function Tile({
  label,
  value,
  delta,
  spark,
  sub,
  hero = false,
  className,
}: {
  label: string;
  value: string;
  delta?: ReactNode;
  spark?: number[] | null;
  sub?: string;
  hero?: boolean;
  className: string;
}) {
  // Число и мини-график — в одну строку, сравнение — отдельной строкой во всю
  // ширину: в узкой плитке «к прошлому году» не рвётся по слову на строку.
  return (
    <section className={`flex min-w-0 flex-col rounded-panel border border-line bg-surface p-4 shadow-card sm:p-5 ${className}`}>
      <span className="text-[13px] font-semibold text-ink-muted">{label}</span>
      <div className="mt-1 flex flex-wrap items-end justify-between gap-x-3 gap-y-1">
        <span className={"font-extrabold leading-tight tracking-tight " + (hero ? "text-[40px]" : "text-[28px]")}>{value}</span>
        {spark && <span className="mb-1"><Sparkline values={spark} /></span>}
      </div>
      {sub && <span className="mt-1 text-[12.5px] text-ink-dim">{sub}</span>}
      {delta && <div className="mt-auto pt-2">{delta}</div>}
    </section>
  );
}

const OUTCOME: Record<DrillItem["outcome"], { label: string; color: string }> = {
  ok: { label: "Отремонтирован", color: C.good },
  no: { label: "Без ремонта", color: C.bad },
  work: { label: "В работе", color: C.brand },
};

/** Заказы за выбранный столбик — под графиком. */
function DrillList({ range, title, master, onClose }: { range: Range; title: string; master?: string; onClose: () => void }) {
  const { data, error, busy } = useLoad(() => statsApi.drill(range, master), [range.from, range.to, master]);
  return (
    <div className="mt-4 border-t border-line pt-3">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[13.5px] font-bold">
          {title}
          {data && ` — ${num(data.total)} ${word(data.total, "заказ", "заказа", "заказов")}`}
        </h3>
        <button type="button" onClick={onClose} className="text-[12.5px] font-semibold text-brand-ink hover:underline">
          Закрыть
        </button>
      </div>
      {error && <Banner tone="error">{error}</Banner>}
      {busy && !data && <Spinner />}
      {data && (
        <div className="max-h-[360px] overflow-auto">
          <DataTable
            cols={["Заказ", "Принят", "Техника", "Мастер", "Итог", ...(data.items.some((i) => i.total !== null) ? ["Сумма"] : [])]}
            rows={data.items.map((o) => [
              <Link key="n" to={`/orders/${o.id}`} className="font-semibold text-brand-ink hover:underline">
                {o.number}
              </Link>,
              formatDate(o.acceptedAt),
              <span key="d" className="block max-w-[260px] truncate text-left">
                {o.device}
              </span>,
              <span key="m" className="block text-left">
                {o.master ?? "—"}
              </span>,
              <span key="o" className="inline-flex items-center gap-1.5">
                <i className="inline-block h-2 w-2 rounded-full" style={{ background: o.outcome === "ok" && !o.issued ? "rgb(var(--state-waiting))" : OUTCOME[o.outcome].color }} />
                {o.outcome === "ok" && !o.issued ? "Готов" : o.outcome === "ok" ? "Выдан" : OUTCOME[o.outcome].label}
              </span>,
              ...(o.total !== null ? [o.total ? rub(o.total) : "—"] : []),
            ])}
          />
          {data.total > data.items.length && (
            <p className="mt-2 text-[12.5px] text-ink-dim">Показаны последние {data.items.length} — остальные в разделе «Заказы».</p>
          )}
        </div>
      )}
    </div>
  );
}

function Loading({ busy, children }: { busy: boolean; children: ReactNode }) {
  // Пока грузится новый период, прежние цифры остаются видны, чуть бледнее: без скачка и мигания.
  return <div className={"transition-opacity duration-150 " + (busy ? "opacity-60" : "")}>{children}</div>;
}

// ================================================================ Обзор

function OverviewTab({ range, name }: { range: Range; name: string }) {
  const { data, error, busy } = useLoad(() => statsApi.overview(range), [range.from, range.to]);
  const [drill, setDrill] = useState<number | null>(null);
  useEffect(() => setDrill(null), [range.from, range.to]);
  if (error) return <Banner tone="error">{error}</Banner>;
  if (!data) return <Spinner />;
  const d = data;
  const cur = d.tiles.cur, prev = d.tiles.prev;
  const labels = bucketLabels(d.keys, d.gran, d.range);
  const stepName = d.gran === "day" ? "по дням" : d.gran === "week" ? "по неделям" : "по месяцам";
  const f = d.facts;
  const t = (k: keyof Tiles) => prev?.[k] ?? null;

  return (
    <Loading busy={busy}>
      <Grid>
        {d.money ? (
          <>
            <Tile className="col-span-12 xl:col-span-6" hero label="Выручка" value={rubShort(cur.revenue ?? 0)}
              delta={<Delta cur={cur.revenue} prev={t("revenue")} kind="rel" />} spark={d.spark.revenue} />
            <Tile className="col-span-12 sm:col-span-6 xl:col-span-3" label="Принято заказов" value={num(cur.accepted)}
              delta={<Delta cur={cur.accepted} prev={t("accepted")} kind="rel" />} spark={d.spark.accepted} />
            <Tile className="col-span-12 sm:col-span-6 xl:col-span-3" label="Выдано" value={num(cur.issued)}
              delta={<Delta cur={cur.issued} prev={t("issued")} kind="rel" />} spark={d.spark.issued} />
            <Tile className="col-span-12 sm:col-span-6 xl:col-span-3" label="Средний чек" value={rub(cur.check ?? 0)}
              delta={<Delta cur={cur.check} prev={t("check")} kind="rel" />} spark={d.spark.check} />
          </>
        ) : (
          <>
            <Tile className="col-span-12 sm:col-span-6 xl:col-span-4" label="Принято заказов" value={num(cur.accepted)}
              delta={<Delta cur={cur.accepted} prev={t("accepted")} kind="rel" />} spark={d.spark.accepted} />
            <Tile className="col-span-12 sm:col-span-6 xl:col-span-4" label="Выдано" value={num(cur.issued)}
              delta={<Delta cur={cur.issued} prev={t("issued")} kind="rel" />} spark={d.spark.issued} />
          </>
        )}
        <Tile className={`col-span-12 sm:col-span-6 ${d.money ? "xl:col-span-3" : "xl:col-span-4"}`} label="Отремонтировано" value={pct(cur.fixRate)}
          sub="из завершённых заказов" delta={<Delta cur={cur.fixRate} prev={t("fixRate")} kind="pp" />} spark={d.spark.fixRate} />
        <Tile className={`col-span-12 sm:col-span-6 ${d.money ? "xl:col-span-3" : "xl:col-span-6"}`} label="Ремонт в среднем" value={days(cur.readyMedian)}
          sub="медиана: от приёма до готовности" delta={<Delta cur={cur.readyMedian} prev={t("readyMedian")} kind="rel" goodUp={false} />} spark={d.spark.readyMedian} />
        <Tile className={`col-span-12 sm:col-span-6 ${d.money ? "xl:col-span-3" : "xl:col-span-6"}`} label="Гарантийные возвраты" value={pct(cur.warrantyRate)}
          sub="из отремонтированных за период" delta={<Delta cur={cur.warrantyRate} prev={t("warrantyRate")} kind="pp" goodUp={false} />} spark={d.spark.warrantyRate} />

        <ChartCard
          className="col-span-12 xl:col-span-8"
          title="Принято заказов"
          hint={`${stepName}. Нажмите на столбик — ниже откроется список заказов`}
          table={() => ({
            cols: ["Период", "Принято", ...(d.series.acceptedPrev ? ["Год назад"] : [])],
            rows: d.keys.map((_, i) => [labels[i].full, num(d.series.accepted[i]), ...(d.series.acceptedPrev ? [num(d.series.acceptedPrev[i] ?? 0)] : [])]),
          })}
        >
          <Legend items={[[name, C.brand], ...(d.series.acceptedPrev ? ([["год назад", C.ghost, true]] as Array<[string, string, boolean]>) : [])]} />
          <ColumnChart
            title="Принято заказов"
            labels={labels.map((l) => l.short)}
            full={labels.map((l) => l.full)}
            series={[
              { name, values: d.series.accepted, color: C.brand, kind: "bar" },
              ...(d.series.acceptedPrev ? [{ name: "год назад", values: d.series.acceptedPrev, color: C.ghost, kind: "ghost" as const }] : []),
            ]}
            onClick={(i) => setDrill(i)}
            selected={drill}
          />
          {drill !== null && d.keys[drill] && (
            <DrillList
              range={bucketRange(d.keys[drill], d.gran, d.range)}
              title={`Принятые: ${labels[drill].full}`}
              onClose={() => setDrill(null)}
            />
          )}
        </ChartCard>

        <ChartCard
          className="col-span-12 xl:col-span-4"
          title="Чем закончились"
          hint="заказы, принятые за период"
          table={() => ({
            cols: ["Итог", "Заказов"],
            rows: [["Отремонтировано", num(d.outcomes.ok)], ["Без ремонта", num(d.outcomes.no)], ["Ещё в работе", num(d.outcomes.work)]],
          })}
        >
          <Donut
            center={pct(cur.fixRate)}
            caption="из завершённых"
            parts={[
              { label: "Отремонтировано", n: d.outcomes.ok, color: C.good },
              { label: "Без ремонта", n: d.outcomes.no, color: C.bad },
              { label: "Ещё в работе", n: d.outcomes.work, color: C.brand },
            ]}
          />
        </ChartCard>

        {d.money && d.series.revenue && (
          <ChartCard
            className="col-span-12"
            title="Выручка"
            hint="деньги по заказам в кассе: оплаты минус возвраты, по дню оплаты"
            table={() => ({
              cols: ["Период", "Выручка", ...(d.series.revenuePrev ? ["Год назад"] : [])],
              rows: d.keys.map((_, i) => [labels[i].full, rub(d.series.revenue![i]), ...(d.series.revenuePrev ? [rub(d.series.revenuePrev[i] ?? 0)] : [])]),
            })}
          >
            {d.series.revenuePrev && <Legend items={[[name, C.teal, true], ["год назад", C.ghost, true]]} />}
            <ColumnChart
              title="Выручка"
              height={210}
              fmt={rub}
              axisFmt={axisRub}
              labels={labels.map((l) => l.short)}
              full={labels.map((l) => l.full)}
              series={[
                { name, values: d.series.revenue, color: C.teal, kind: "area" },
                ...(d.series.revenuePrev ? [{ name: "год назад", values: d.series.revenuePrev, color: C.ghost, kind: "ghost" as const }] : []),
              ]}
            />
          </ChartCard>
        )}

        <section className="col-span-12 rounded-panel border border-line bg-surface p-4 shadow-card sm:p-5">
          <h2 className="text-[15px] font-bold">Интересное за период</h2>
          <p className="mt-0.5 text-[12.5px] text-ink-dim">Считается само из заказов</p>
          <div className="mt-3 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            <Fact label="Самый загруженный день" value={f.busyDow ? `${DOW_NAMES[f.busyDow - 1]}, спокойнее всего — ${DOW_NAMES[(f.calmDow ?? 1) - 1]}` : "—"} />
            <Fact label="Пик приёма" value={f.peakHour !== null ? `${f.peakHour}:00–${f.peakHour + 1}:00` : "—"} />
            <Fact label="Чаще всего несут" value={f.topDevice ? `${[f.topDevice.kind.toLowerCase(), f.topDevice.brand].filter(Boolean).join(" ")} — ${num(f.topDevice.n)}` : "—"} />
            <Fact
              label={d.gran === "month" ? "Рекордный месяц" : d.gran === "week" ? "Рекордная неделя" : "Рекордный день"}
              value={f.best ? `${d.gran === "month" ? monthLabel(f.best.key) : d.gran === "week" ? `с ${dayLabel(f.best.key)}` : dayLabel(f.best.key)} — ${num(f.best.n)}` : "—"}
            />
            <Fact label="Лежало готовым дольше 2 недель" value={`${num(f.idleLong)} ${word(f.idleLong, "заказ", "заказа", "заказов")}`} />
            <Fact label="От постоянных клиентов" value={f.returning.of ? `${pct(f.returning.n / f.returning.of)} заказов` : "—"} />
          </div>
        </section>
      </Grid>
    </Loading>
  );
}

const Fact = ({ label, value }: { label: string; value: string }) => (
  <div className="rounded-field bg-surface-raised px-3 py-2.5">
    <p className="text-[12.5px] text-ink-muted">{label}</p>
    <p className="mt-0.5 text-[15px] font-bold">{value}</p>
  </div>
);

// ================================================================ Заказы

const GRANS: Array<{ id: Gran; label: string }> = [
  { id: "day", label: "Дни" },
  { id: "week", label: "Недели" },
  { id: "month", label: "Месяцы" },
];

function OrdersTab({ range }: { range: Range }) {
  const [gran, setGran] = useState<Gran | null>(null);
  useEffect(() => setGran(null), [range.from, range.to]);
  const { data, error, busy } = useLoad(() => statsApi.orders(range, gran ?? undefined), [range.from, range.to, gran]);
  const [drill, setDrill] = useState<number | null>(null);
  useEffect(() => setDrill(null), [range.from, range.to, gran]);
  if (error) return <Banner tone="error">{error}</Banner>;
  if (!data) return <Spinner />;
  const d: OrdersStats = data;
  const labels = bucketLabels(d.keys, d.gran, d.range);
  const spanDays = Math.round((new Date(d.range.to).getTime() - new Date(d.range.from).getTime()) / 86_400_000) + 1;
  const grans = GRANS.filter((g) => (g.id === "day" ? spanDays <= 120 : g.id === "month" ? spanDays >= 40 : spanDays >= 8));

  // Часы — только рабочие: от первого до последнего часа, когда вообще принимали.
  const hoursWithData = d.heat[0].map((_, h) => d.heat.some((row) => row[h] > 0));
  let h0 = hoursWithData.indexOf(true), h1 = hoursWithData.lastIndexOf(true);
  if (h0 < 0) { h0 = 9; h1 = 20; }
  h0 = Math.min(h0, 9); h1 = Math.max(h1, 19);
  const hours = Array.from({ length: h1 - h0 + 1 }, (_, i) => h0 + i);
  const grid = d.heat.map((row) => hours.map((h) => row[h]));

  const binRows = (edges: number[], bins: number[], unit: (a: number, b: number | null) => string) =>
    bins.map((n, i) => ({ label: unit(edges[i], i + 1 < edges.length ? edges[i + 1] : null), n }));
  const readyRows = binRows(d.ready.edges, d.ready.bins, (a, b) => (b === null ? `больше ${a} дней` : a === 0 ? `до ${b} дня` : `${a}–${b} ${word(b, "день", "дня", "дней")}`));
  const waitRows = binRows(d.wait.edges, d.wait.bins, (a, b) =>
    b === null ? "больше 2 недель" : a === 0 ? "в тот же день" : b === 7 ? "3–7 дней" : b === 14 ? "1–2 недели" : `${a}–${b} ${word(b, "день", "дня", "дней")}`
  );
  const c = d.counts;

  return (
    <Loading busy={busy}>
      <Grid>
        <ChartCard
          className="col-span-12"
          title="Динамика заказов"
          hint="по дате приёма, разбито по итогу. Нажмите на столбик — откроется список"
          actions={grans.length > 1 ? <Pills items={grans} value={d.gran} onChange={(g) => setGran(g)} label="Шаг графика" /> : undefined}
          table={() => ({
            cols: ["Период", "Принято", "Отремонтировано", "Без ремонта", "В работе"],
            rows: d.keys.map((_, i) => [labels[i].full, num(d.series.ok[i] + d.series.no[i] + d.series.work[i]), num(d.series.ok[i]), num(d.series.no[i]), num(d.series.work[i])]),
          })}
        >
          <Legend items={[["Отремонтировано", C.good], ["Без ремонта", C.bad], ["В работе", C.brand]]} />
          <ColumnChart
            title="Динамика заказов"
            stacked
            height={250}
            labels={labels.map((l) => l.short)}
            full={labels.map((l) => l.full)}
            series={[
              { name: "Отремонтировано", values: d.series.ok, color: C.good, kind: "bar" },
              { name: "Без ремонта", values: d.series.no, color: C.bad, kind: "bar" },
              { name: "В работе", values: d.series.work, color: C.brand, kind: "bar" },
            ]}
            onClick={(i) => setDrill(i)}
            selected={drill}
          />
          {drill !== null && d.keys[drill] && (
            <DrillList range={bucketRange(d.keys[drill], d.gran, d.range)} title={`Принятые: ${labels[drill].full}`} onClose={() => setDrill(null)} />
          )}
        </ChartCard>

        <ChartCard
          className="col-span-12 xl:col-span-7"
          title="Когда несут технику"
          hint="день недели × час приёма. Темнее — больше заказов"
          table={() => ({ cols: ["День", ...hours.map((h) => `${h}:00`)], rows: grid.map((row, i) => [DOW_SHORT[i], ...row.map(num)]) })}
        >
          <Heatmap
            title="Когда несут технику"
            grid={grid}
            rows={DOW_SHORT}
            cols={hours}
            cellTitle={(i, j) => `${DOW_NAMES[i]}, ${hours[j]}:00–${hours[j] + 1}:00`}
          />
          <div className="mt-2 flex items-center gap-2 text-[12px] text-ink-dim">
            меньше
            <span
              className="inline-block h-2 w-28 rounded-full"
              style={{ background: "linear-gradient(90deg, color-mix(in oklab, rgb(var(--brand)) 8%, rgb(var(--surface))), rgb(var(--brand)))" }}
            />
            больше
          </div>
        </ChartCard>

        <ChartCard className="col-span-12 xl:col-span-5" title="Какая техника" hint="доля заказов по типам"
          table={() => ({ cols: ["Тип", "Заказов"], rows: d.kinds.map((k) => [k.label, num(k.n)]) })}>
          <HBars rows={d.kinds.map((k) => ({ label: k.label, n: k.n }))} />
        </ChartCard>

        <ChartCard className="col-span-12 lg:col-span-4" title="Топ марок" hint="восемь самых частых"
          table={() => ({ cols: ["Марка", "Заказов"], rows: d.brands.map((k) => [k.label, num(k.n)]) })}>
          <HBars rows={d.brands.map((k) => ({ label: k.label, n: k.n }))} share={false} />
        </ChartCard>

        <ChartCard className="col-span-12 sm:col-span-6 lg:col-span-4" title="Сколько длится ремонт"
          hint={`от приёма до готовности · медиана ${days(d.ready.median)}`}
          table={() => ({ cols: ["Срок", "Заказов"], rows: readyRows.map((r) => [r.label, num(r.n)]) })}>
          <HBars rows={readyRows} color={C.teal} />
        </ChartCard>

        <ChartCard className="col-span-12 sm:col-span-6 lg:col-span-4" title="Сколько лежит готовым"
          hint={`от готовности до выдачи · медиана ${days(d.wait.median)}`}
          table={() => ({ cols: ["Срок", "Заказов"], rows: waitRows.map((r) => [r.label, num(r.n)]) })}>
          <HBars rows={waitRows} color={C.amber} />
        </ChartCard>

        <ChartCard className="col-span-12 lg:col-span-6" title="Почему без ремонта" hint="причина из выдачи без ремонта или из возврата"
          table={() => ({ cols: ["Причина", "Заказов"], rows: d.reasons.map((r) => [r.label, num(r.n)]) })}>
          <HBars rows={d.reasons.map((r) => ({ label: r.label, n: r.n }))} color={C.bad} />
        </ChartCard>

        <section className="col-span-12 rounded-panel border border-line bg-surface p-4 shadow-card sm:p-5 lg:col-span-6">
          <h2 className="text-[15px] font-bold">Сроки и повторы</h2>
          <p className="mt-0.5 text-[12.5px] text-ink-dim">за период</p>
          <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
            <Fact label="Готово позже обещанного" value={`${num(c.late)} · ${pct(c.lateOf ? c.late / c.lateOf : null)}`} />
            <Fact label="Вернулись по гарантии" value={`${num(c.warranty)} · ${pct(c.completed ? c.warranty / c.completed : null)}`} />
            <Fact label="Срочных заказов" value={`${num(c.urgent)} · ${pct(c.accepted ? c.urgent / c.accepted : null)}`} />
            <Fact label="От постоянных клиентов" value={`${num(c.returning)} · ${pct(c.accepted ? c.returning / c.accepted : null)}`} />
          </div>
        </section>
      </Grid>
    </Loading>
  );
}

// ================================================================ Мастера

type SortKey = "accepted" | "ok" | "no" | "work" | "fixRate" | "warrantyRate" | "readyMedian" | "works" | "check";
const ASC: SortKey[] = ["warrantyRate", "readyMedian"];

function MastersTab({ range }: { range: Range }) {
  const { data, error, busy } = useLoad(() => statsApi.masters(range), [range.from, range.to]);
  const [sort, setSort] = useState<SortKey>("accepted");
  const [picked, setPicked] = useState<string | null>(null);
  const rows = useMemo(() => {
    if (!data) return [] as MasterRow[];
    const v = (r: MasterRow) => (r[sort] ?? (ASC.includes(sort) ? Infinity : -Infinity)) as number;
    return [...data.rows].sort((a, b) => (ASC.includes(sort) ? v(a) - v(b) : v(b) - v(a)));
  }, [data, sort]);
  const current = picked && rows.some((r) => r.id === picked) ? picked : rows[0]?.id ?? null;
  const pick = useCallback((id: string) => setPicked(id), []);
  if (error) return <Banner tone="error">{error}</Banner>;
  if (!data) return <Spinner />;
  const d: MastersStats = data;
  const maxAcc = Math.max(1, ...rows.map((r) => r.accepted));
  const cols: Array<[string, SortKey | null]> = [
    ["Мастер", null], ["Взял", "accepted"], ["Отремонтировал", "ok"], ["Без ремонта", "no"], ["В работе", "work"],
    ["Успешно", "fixRate"], ["Гарант. возвраты", "warrantyRate"], ["Срок, медиана", "readyMedian"],
    ...(d.money ? ([["Выручка работ", "works"], ["Средний чек", "check"]] as Array<[string, SortKey]>) : []),
  ];
  const shopWarranty = (() => {
    const done = rows.reduce((a, r) => a + r.ok, 0);
    return done ? rows.reduce((a, r) => a + (r.warrantyRate ?? 0) * r.ok, 0) / done : null;
  })();

  return (
    <Loading busy={busy}>
      <div className="space-y-3.5">
        <section className="rounded-panel border border-line bg-surface p-4 shadow-card sm:p-5">
          <h2 className="text-[15px] font-bold">Мастера</h2>
          <p className="mt-0.5 text-[12.5px] text-ink-dim">
            Нажмите на мастера — ниже откроется его карточка. Нажмите на заголовок столбца — таблица отсортируется. Красным —
            гарантийные возвраты заметно выше среднего по мастерской.
          </p>
          {rows.length === 0 ? (
            <p className="mt-3 text-[13px] text-ink-dim">За период заказов с назначенным мастером нет.</p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full border-collapse text-[13px] tabular-nums">
                <thead>
                  <tr>
                    {cols.map(([h, k], i) => (
                      <th
                        key={h}
                        className={
                          "whitespace-nowrap border-b border-line px-2 py-1.5 text-[12px] font-semibold " +
                          (i ? "text-right " : "text-left ") +
                          (k ? "cursor-pointer hover:text-ink " : "") +
                          (k === sort ? "text-ink" : "text-ink-dim")
                        }
                        onClick={k ? () => setSort(k) : undefined}
                        aria-sort={k === sort ? (ASC.includes(k) ? "ascending" : "descending") : undefined}
                      >
                        {h}
                        {k === sort ? (ASC.includes(k) ? " ↑" : " ↓") : ""}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const high = r.warrantyRate !== null && shopWarranty !== null && r.ok >= 10 && r.warrantyRate > shopWarranty * 1.5 && r.warrantyRate > 0.03;
                    return (
                      <tr
                        key={r.id}
                        tabIndex={0}
                        onClick={() => pick(r.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            pick(r.id);
                          }
                        }}
                        className={"cursor-pointer " + (r.id === current ? "bg-brand-tint" : "hover:bg-surface-raised")}
                      >
                        <td className="whitespace-nowrap border-b border-line px-2 py-2">
                          <span className="flex items-center gap-2">
                            <Avatar name={r.name} />
                            <span className="font-semibold">{r.name}</span>
                            {!r.active && <span className="rounded-pill bg-surface-raised px-2 py-0.5 text-[11px] font-bold text-ink-muted">не работает</span>}
                          </span>
                        </td>
                        <td className="whitespace-nowrap border-b border-line px-2 py-2 text-right">
                          {num(r.accepted)}
                          <span className="ml-2 inline-block h-1.5 rounded-full bg-brand align-middle" style={{ width: Math.round((40 * r.accepted) / maxAcc) }} />
                        </td>
                        <td className="border-b border-line px-2 py-2 text-right">{num(r.ok)}</td>
                        <td className="border-b border-line px-2 py-2 text-right">{num(r.no)}</td>
                        <td className="border-b border-line px-2 py-2 text-right">{num(r.work)}</td>
                        <td className="border-b border-line px-2 py-2 text-right">{pct(r.fixRate)}</td>
                        <td className={"border-b border-line px-2 py-2 text-right " + (high ? "font-bold text-state-off" : "")}>{pct(r.warrantyRate)}</td>
                        <td className="whitespace-nowrap border-b border-line px-2 py-2 text-right">{days(r.readyMedian)}</td>
                        {d.money && <td className="whitespace-nowrap border-b border-line px-2 py-2 text-right">{rub(r.works ?? 0)}</td>}
                        {d.money && <td className="whitespace-nowrap border-b border-line px-2 py-2 text-right">{rub(r.check ?? 0)}</td>}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {current && <MasterCard id={current} range={range} key={current} />}

        {d.receivers.length > 0 && (
          <section className="rounded-panel border border-line bg-surface p-4 shadow-card sm:p-5">
            <h2 className="text-[15px] font-bold">Приёмщики</h2>
            <p className="mt-0.5 text-[12.5px] text-ink-dim">кто сколько принял и выдал за период</p>
            <div className="mt-3 overflow-x-auto">
              <DataTable
                cols={["Сотрудник", "Принял", "Выдал"]}
                rows={d.receivers.map((r) => [r.name, num(r.accepted), num(r.issued)])}
              />
            </div>
          </section>
        )}
      </div>
    </Loading>
  );
}

const Avatar = ({ name, big = false }: { name: string; big?: boolean }) => (
  <span
    className={
      "grid shrink-0 place-items-center rounded-full bg-surface-raised font-extrabold text-ink-soft " +
      (big ? "h-10 w-10 text-[14px]" : "h-[26px] w-[26px] text-[11px]")
    }
  >
    {name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((x) => x[0])
      .join("")}
  </span>
);

/** Карточка мастера: и в разделе «Мастера», и сама по себе — у мастера без права на всю статистику. */
function MasterCard({ id, range }: { id: string; range: Range }) {
  const { data, error, busy } = useLoad(() => statsApi.master(id, range), [id, range.from, range.to]);
  const [drill, setDrill] = useState<number | null>(null);
  useEffect(() => setDrill(null), [range.from, range.to]);
  if (error) return <Banner tone="error">{error}</Banner>;
  if (!data) return <Spinner />;
  const d: MasterCardData = data;
  const labels = bucketLabels(d.keys, d.gran, d.range);
  const t = d.tiles;
  return (
    <Loading busy={busy}>
      <div className="space-y-3.5">
        <div className="flex items-center gap-3 pt-2">
          <Avatar name={d.name} big />
          <div>
            <h2 className="text-[18px] font-extrabold leading-tight">{d.name}</h2>
            {t.share !== null && <p className="text-[12.5px] text-ink-dim">{pct(t.share)} всех заказов мастерской за период</p>}
          </div>
        </div>
        <Grid>
          <Tile className="col-span-12 sm:col-span-6 xl:col-span-3" label="Взял заказов" value={num(t.accepted)} sub={`отремонтировано ${num(t.ok)}, без ремонта ${num(t.no)}, в работе ${num(t.work)}`} />
          <Tile className="col-span-12 sm:col-span-6 xl:col-span-3" label="Отремонтировано" value={pct(t.fixRate)} sub={`в среднем по мастерской ${pct(d.shop.fixRate)}`} />
          <Tile className="col-span-12 sm:col-span-6 xl:col-span-3" label="Гарантийные возвраты" value={pct(t.warrantyRate)} sub={`в среднем ${pct(d.shop.warrantyRate)}`} />
          <Tile className="col-span-12 sm:col-span-6 xl:col-span-3" label="Срок ремонта" value={days(t.readyMedian)} sub={`медиана; в среднем ${days(d.shop.readyMedian)}`} />

          <ChartCard
            className="col-span-12 xl:col-span-8"
            title="Заказы мастера"
            hint="по дате приёма. Нажмите на столбик — откроется список"
            table={() => ({
              cols: ["Период", "Отремонтировано", "Без ремонта", "В работе"],
              rows: d.keys.map((_, i) => [labels[i].full, num(d.series.ok[i]), num(d.series.no[i]), num(d.series.work[i])]),
            })}
          >
            <Legend items={[["Отремонтировано", C.good], ["Без ремонта", C.bad], ["В работе", C.brand]]} />
            <ColumnChart
              title="Заказы мастера"
              stacked
              height={220}
              labels={labels.map((l) => l.short)}
              full={labels.map((l) => l.full)}
              series={[
                { name: "Отремонтировано", values: d.series.ok, color: C.good, kind: "bar" },
                { name: "Без ремонта", values: d.series.no, color: C.bad, kind: "bar" },
                { name: "В работе", values: d.series.work, color: C.brand, kind: "bar" },
              ]}
              onClick={(i) => setDrill(i)}
              selected={drill}
            />
            {drill !== null && d.keys[drill] && (
              <DrillList range={bucketRange(d.keys[drill], d.gran, d.range)} master={d.id} title={`${d.name}: ${labels[drill].full}`} onClose={() => setDrill(null)} />
            )}
          </ChartCard>
          <ChartCard className="col-span-12 xl:col-span-4" title="С какой техникой работает"
            table={() => ({ cols: ["Тип", "Заказов"], rows: d.kinds.map((k) => [k.label, num(k.n)]) })}>
            <HBars rows={d.kinds.map((k) => ({ label: k.label, n: k.n }))} />
          </ChartCard>
          {d.money && d.series.works && (
            <ChartCard
              className="col-span-12"
              title="Выручка по работам мастера"
              hint="по дате выдачи, без запчастей — от неё считается процент в зарплате"
              table={() => ({ cols: ["Период", "Работы"], rows: d.keys.map((_, i) => [labels[i].full, rub(d.series.works![i])]) })}
            >
              <ColumnChart
                title="Выручка по работам"
                height={190}
                fmt={rub}
                axisFmt={axisRub}
                labels={labels.map((l) => l.short)}
                full={labels.map((l) => l.full)}
                series={[{ name: "Работы", values: d.series.works, color: C.teal, kind: "area" }]}
              />
            </ChartCard>
          )}
        </Grid>
      </div>
    </Loading>
  );
}
