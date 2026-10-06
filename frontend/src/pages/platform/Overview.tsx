import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { C, ChartCard, ColumnChart, Donut, HBars, Legend, useHideTipOnUnmount } from "../../components/charts";
import { CategoryChip, KindMark, PayText, Seen, UsageBar } from "../../components/platform/ClientBits";
import { Banner, SectionLabel, Spinner } from "../../components/ui";
import { ApiError } from "../../lib/api";
import { customerColor } from "../../lib/customerColor";
import { plural } from "../../lib/format";
import {
  ACTIVITY_LABEL,
  bytes,
  monthFull,
  monthShort,
  platformApi,
  rub,
  type Overview as Data,
} from "../../lib/platformApi";

/**
 * Обзор облака для собственника: кто с нами, кто сейчас работает, кто
 * должен заплатить и сколько ресурсов уходит. В том же виде, что и
 * статистика мастерской, — плитки сверху, графики ниже.
 *
 * Содержимого мастерских — заказов, денег, клиентов — здесь нет: только
 * то, что касается облака.
 */

const CLOUD = C.brand;
const ACT_SHORT = { online: "В сети", day: "Сегодня", week: "Неделя", month: "Месяц", long: "Давно", never: "Никогда" } as const;
const LOCAL = C.teal;

export default function Overview() {
  useHideTipOnUnmount();
  const navigate = useNavigate();
  const [d, setD] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setD(await platformApi.overview());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось загрузить обзор");
    }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  if (error) return <Banner tone="error">{error}</Banner>;
  if (!d) return <Spinner />;

  const total = d.counts.cloud + d.counts.local;
  const onlineNow = d.counts.onlineCloud + d.counts.onlineLocal;
  const short = d.months.map(monthShort);
  const full = d.months.map(monthFull);
  const catColor = (key: string) => customerColor(key)?.dot ?? C.ghost;
  const catBy = new Map(d.categories.map((c) => [c.id, c]));
  const open = (kind: "cloud" | "local") => navigate(kind === "cloud" ? "/platform/tenants" : "/platform/boxes");
  const disk = d.storage.disk;

  return (
    <div className="space-y-5">
      <div>
        <SectionLabel>Платформа</SectionLabel>
        <h1 className="mt-1 text-2xl font-extrabold tracking-tight">Обзор</h1>
        <p className="mt-1 text-sm text-ink-muted">Клиенты, оплата и ресурсы облака. Обновляется раз в минуту.</p>
      </div>

      <div className="grid grid-cols-12 gap-3.5">
        <Tile
          className="col-span-12 sm:col-span-6 xl:col-span-3"
          label="Клиентов"
          value={String(total)}
          sub={`${d.counts.cloud} облачных · ${d.counts.local} локальных`}
          hero
        />
        <Tile
          className="col-span-12 sm:col-span-6 xl:col-span-3"
          label="Сейчас в сети"
          value={String(onlineNow)}
          sub={`${d.counts.onlineCloud} облачных · ${d.counts.onlineLocal} локальных`}
          tone={onlineNow ? "good" : undefined}
        />
        <Tile
          className="col-span-12 sm:col-span-6 xl:col-span-3"
          label="В месяц по ценам"
          value={rub(d.money.monthly)}
          sub="Сумма цен всех, у кого облако или доступ платные"
        />
        <Tile
          className="col-span-12 sm:col-span-6 xl:col-span-3"
          label="Получено в этом месяце"
          value={rub(d.money.thisMonth)}
          sub={
            d.pay.overdue || d.pay.soon
              ? `Просрочено: ${d.pay.overdue} · скоро: ${d.pay.soon}`
              : "Просроченных нет"
          }
          subTone={d.pay.overdue ? "bad" : undefined}
        />

        <ChartCard
          className="col-span-12 xl:col-span-7"
          title="Новые клиенты"
          hint="По месяцам подключения, за год"
          table={() => ({
            cols: ["Месяц", "Облачные", "Локальные"],
            rows: d.months.map((m, i) => [monthFull(m), String(d.growth.cloud[i]), String(d.growth.local[i])]),
          })}
        >
          <Legend items={[["Облачные", CLOUD], ["Локальные", LOCAL]]} />
          <ColumnChart
            title="Новые клиенты"
            stacked
            height={220}
            labels={short}
            full={full}
            series={[
              { name: "Облачные", values: d.growth.cloud, color: CLOUD, kind: "bar" },
              { name: "Локальные", values: d.growth.local, color: LOCAL, kind: "bar" },
            ]}
          />
        </ChartCard>

        <ChartCard
          className="col-span-12 xl:col-span-5"
          title="Поступления"
          hint="Отмеченные оплаты по месяцам"
          table={() => ({ cols: ["Месяц", "Получено"], rows: d.months.map((m, i) => [monthFull(m), rub(d.money.income[i])]) })}
        >
          <ColumnChart
            title="Поступления"
            height={232}
            fmt={rub}
            axisFmt={(v) => (v >= 1000 ? `${Math.round(v / 1000)}к` : String(v))}
            labels={short}
            full={full}
            series={[{ name: "Получено", values: d.money.income, color: C.good, kind: "bar" }]}
          />
        </ChartCard>

        <ChartCard className="col-span-12 md:col-span-6 xl:col-span-4" title="По категориям">
          <Donut
            unit="Клиентов"
            center={String(total)}
            caption="клиентов"
            parts={d.categories.map((c) => ({ label: c.name, n: c.cloud + c.local, color: catColor(c.color) }))}
          />
        </ChartCard>

        <ChartCard className="col-span-12 md:col-span-6 xl:col-span-4" title="Оплата" hint="Бесплатным срок не нужен">
          <Donut
            unit="Клиентов"
            center={String(d.pay.overdue)}
            caption="просрочено"
            parts={[
              { label: "Оплачено", n: d.pay.paid, color: C.good },
              { label: "Меньше недели", n: d.pay.soon, color: C.amber },
              { label: "Просрочено", n: d.pay.overdue, color: C.bad },
              { label: "Срок не задан", n: d.pay.none, color: C.ghost },
              { label: "Бесплатно", n: d.pay.free, color: C.teal },
            ]}
          />
        </ChartCard>

        <ChartCard className="col-span-12 xl:col-span-4" title="Активность" hint="Когда последний раз работали">
          <Legend items={[["Облачные", CLOUD], ["Локальные", LOCAL]]} />
          <ColumnChart
            title="Активность"
            stacked
            height={232}
            labels={d.activity.map((a) => ACT_SHORT[a.id])}
            full={d.activity.map((a) => ACTIVITY_LABEL[a.id])}
            series={[
              { name: "Облачные", values: d.activity.map((a) => a.cloud), color: CLOUD, kind: "bar" },
              { name: "Локальные", values: d.activity.map((a) => a.local), color: LOCAL, kind: "bar" },
            ]}
          />
        </ChartCard>

        <ChartCard className="col-span-12 lg:col-span-6" title="Место" hint="Фотографии облачных мастерских и диск сервера">
          <div className="space-y-4">
            {disk && (
              <div>
                <p className="mb-1.5 text-[13px] font-semibold text-ink-soft">Диск сервера</p>
                <UsageBar used={disk.totalBytes - disk.freeBytes} limit={disk.totalBytes} label={`занято ${bytes(disk.totalBytes - disk.freeBytes)}, свободно ${bytes(disk.freeBytes)}`} />
              </div>
            )}
            <div>
              <p className="mb-1.5 text-[13px] font-semibold text-ink-soft">Фотографии мастерских</p>
              <UsageBar used={d.storage.usedBytes} limit={d.storage.limitBytes} label={`${bytes(d.storage.usedBytes)} из выделенных`} />
            </div>
            {d.storage.top.some((t) => t.bytes > 0) && (
              <div>
                <p className="mb-2 text-[13px] font-semibold text-ink-soft">Больше всех занимают</p>
                <HBars
                  unit="Занято"
                  share={false}
                  fmt={bytes}
                  rows={d.storage.top.filter((t) => t.bytes > 0).map((t) => ({ label: t.name, n: t.bytes }))}
                />
              </div>
            )}
          </div>
        </ChartCard>

        <ChartCard className="col-span-12 lg:col-span-6" title="Расход за месяц" hint={monthFull(d.usage.month)}>
          <dl className="grid grid-cols-2 gap-4">
            <Stat label="Снимков шильдиков" value={String(d.usage.plateOcr)} sub="распознано в облачных мастерских" />
            <Stat label="Трафик доступа из интернета" value={bytes(d.usage.relayBytes)} sub={`${plural(d.usage.relayRequests, "запрос", "запроса", "запросов")} к локальным`} />
            <Stat label="Сотрудников в облаке" value={String(d.counts.users)} sub="во всех облачных мастерских" />
            <Stat label="Локальных с доступом" value={`${d.counts.localActive} из ${d.counts.local}`} sub="у остальных доступ выключен" />
          </dl>
        </ChartCard>

        <ChartCard className="col-span-12 lg:col-span-6" title="Пора платить" hint="Просрочено, меньше недели или срок не задан">
          {d.due.length === 0 ? (
            <p className="text-[13px] text-ink-dim">Все платные клиенты оплатили вперёд.</p>
          ) : (
            <ul className="-mx-1 divide-y divide-line">
              {d.due.map((c) => (
                <Row key={c.kind + c.id} onClick={() => open(c.kind)}>
                  <KindMark kind={c.kind} size="sm" />
                  <Name name={c.name} sub={c.sub} />
                  <span className="hidden sm:inline-flex">
                    <CategoryChip category={c.categoryId ? catBy.get(c.categoryId) : null} />
                  </span>
                  <PayText pay={c.pay} paidUntil={c.paidUntil} price={c.price} />
                </Row>
              ))}
            </ul>
          )}
        </ChartCard>

        <ChartCard className="col-span-12 lg:col-span-6" title="Кто работает" hint="Сейчас в сети и заходившие недавно">
          {d.recent.length === 0 ? (
            <p className="text-[13px] text-ink-dim">Пока никто не заходил.</p>
          ) : (
            <ul className="-mx-1 divide-y divide-line">
              {d.recent.map((c) => (
                <Row key={c.kind + c.id} onClick={() => open(c.kind)}>
                  <KindMark kind={c.kind} size="sm" online={c.online} />
                  <Name name={c.name} sub={c.sub} />
                  <span className="hidden sm:inline-flex">
                    <CategoryChip category={c.categoryId ? catBy.get(c.categoryId) : null} />
                  </span>
                  <Seen online={c.online} at={c.lastSeenAt} />
                </Row>
              ))}
            </ul>
          )}
        </ChartCard>
      </div>
    </div>
  );
}

function Tile({
  label,
  value,
  sub,
  hero = false,
  tone,
  subTone,
  className,
}: {
  label: string;
  value: string;
  sub?: string;
  hero?: boolean;
  tone?: "good" | "bad";
  subTone?: "bad";
  className: string;
}) {
  return (
    <section className={`flex min-w-0 flex-col rounded-panel border border-line bg-surface p-4 shadow-card sm:p-5 ${className}`}>
      <span className="text-[13px] font-semibold text-ink-muted">{label}</span>
      <span
        className={
          "mt-1 font-extrabold leading-tight tracking-tight " +
          (hero ? "text-[40px] " : "text-[28px] ") +
          (tone === "good" ? "text-state-done" : tone === "bad" ? "text-state-off" : "")
        }
      >
        {value}
      </span>
      {sub && <span className={"mt-1 text-[12.5px] " + (subTone === "bad" ? "font-semibold text-state-off" : "text-ink-dim")}>{sub}</span>}
    </section>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12.5px] font-semibold text-ink-muted">{label}</dt>
      <dd className="mt-0.5 text-[24px] font-extrabold leading-tight tracking-tight">{value}</dd>
      <dd className="text-[12px] text-ink-dim">{sub}</dd>
    </div>
  );
}

function Row({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <li>
      <button type="button" onClick={onClick} className="flex w-full items-center gap-2.5 rounded-field px-1 py-2 text-left hover:bg-surface-raised">
        {children}
      </button>
    </li>
  );
}

function Name({ name, sub }: { name: string; sub: string }) {
  return (
    <span className="min-w-0 flex-1">
      <span className="block truncate text-[13.5px] font-semibold">{name}</span>
      <span className="block truncate text-[12px] text-ink-dim">{sub}</span>
    </span>
  );
}
