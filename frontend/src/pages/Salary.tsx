import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { IconChevronLeft, IconChevronRight, IconDelete } from "../components/icons";
import { Banner, Button, Card, Field, Input, PageHeader, SectionLabel, Spinner } from "../components/ui";
import { ApiError } from "../lib/api";
import { formatDate, formatDateTime } from "../lib/format";
import { money } from "../lib/orders";
import {
  monthTitle,
  salaryApi,
  shiftMonth,
  type SalaryDetail,
  type SalaryMonth,
  type SalaryRecords,
  type SalaryRow,
} from "../lib/salaryApi";

/**
 * Зарплата.
 *
 * Та же таблица, что мастерская вела в Excel: на начало — начислено —
 * получено — итого, по строке на сотрудника, и раскрывающаяся карточка с
 * расчётом. Процент мастера считается сам — с работ (итог минус запчасти)
 * по заказам, выданным и оплаченным полностью в этом месяце. Руками —
 * оклад, премия, штраф и выплаты.
 */

const errorText = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

/** Сумма со знаком: минус — выдано вперёд, плюс — мастерская должна. */
function Signed({ v, strong }: { v: number; strong?: boolean }) {
  const cls = v < 0 ? "text-state-off" : v > 0 ? "text-ink" : "text-ink-dim";
  return <span className={`tabular-nums ${cls} ${strong ? "font-bold" : ""}`}>{money(v)}</span>;
}

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="rounded-field border border-line bg-surface-raised px-3 py-2.5">
      <div className="text-[12px] text-ink-dim">{label}</div>
      <div className="text-[16px] font-bold tabular-nums">{value}</div>
      {hint && <div className="text-[11.5px] text-ink-dim">{hint}</div>}
    </div>
  );
}

const today = () => new Date().toISOString().slice(0, 10);

/** Ячейка строки ведомости: на телефоне — с подписью, на широком экране подпись в шапке. */
function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="flex items-baseline justify-between gap-2 sm:block sm:text-right">
      <span className="text-[12px] text-ink-dim sm:hidden">{label}</span>
      {children}
    </span>
  );
}

/** Карточка сотрудника за месяц: расчёт, начисления руками, выплаты. */
function Detail({
  data,
  row,
  detail,
  onChanged,
}: {
  data: SalaryMonth;
  row: SalaryRow;
  detail: SalaryDetail;
  onChanged: () => void;
}) {
  const [records, setRecords] = useState<SalaryRecords | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showOrders, setShowOrders] = useState(false);
  const [bonus, setBonus] = useState({ amount: "", comment: "" });
  const [payout, setPayout] = useState({ amount: "", date: today(), comment: "" });
  const [opening, setOpening] = useState<string>(row.startSet ? String(row.start) : "");

  const open = !data.closed;
  const manage = data.canManage && open;
  const mine = row.userId === data.me;
  const canPay = open && (data.canManage || mine);
  const money_ = detail.orders.some((o) => o.total !== undefined);

  const loadRecords = useCallback(() => {
    salaryApi
      .records(data.month, row.userId)
      .then(setRecords)
      .catch((err) => setError(errorText(err, "Не удалось загрузить записи")));
  }, [data.month, row.userId]);

  useEffect(() => {
    loadRecords();
  }, [loadRecords]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      loadRecords();
      onChanged();
    } catch (err) {
      setError(errorText(err, "Не получилось"));
    } finally {
      setBusy(false);
    }
  }

  const num = (s: string) => Number(s.replace(/\s/g, "").replace(",", "."));

  function addBonus(e: FormEvent) {
    e.preventDefault();
    const amount = num(bonus.amount);
    if (!amount) return setError("Впишите сумму: премия — плюсом, штраф — с минусом");
    void run(async () => {
      await salaryApi.addEntry(row.userId, data.month, amount, bonus.comment);
      setBonus({ amount: "", comment: "" });
    });
  }

  function addPayout(e: FormEvent) {
    e.preventDefault();
    const amount = num(payout.amount);
    if (!(amount > 0)) return setError("Впишите сумму выплаты");
    // Полдень выбранного дня — чтобы выплата не уехала в соседний день из-за часового пояса.
    const paidAt = payout.date && payout.date !== today() ? new Date(`${payout.date}T12:00:00`).toISOString() : undefined;
    void run(async () => {
      await salaryApi.addPayout(row.userId, amount, paidAt, payout.comment);
      setPayout({ amount: "", date: today(), comment: "" });
    });
  }

  const bonuses = records?.entries.filter((e) => e.kind === "BONUS") ?? [];

  return (
    <div className="space-y-4 border-t border-line bg-surface px-4 py-4 sm:px-5">
      {error && <Banner tone="error">{error}</Banner>}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Готово за месяц" value={money(detail.ready)} hint="справочно, итог − запчасти" />
        <Stat label="Выдано за месяц" value={money(detail.issued)} hint="в том числе готовые раньше" />
        <Stat label="Оплачено за месяц" value={money(detail.earned)} hint="выданы и оплачены полностью" />
        <Stat
          label="К начислению"
          value={money(row.accrued)}
          hint={row.percent ? `${row.percent}% с работ` : "процент не задан в «Сотрудниках»"}
        />
      </div>

      <div className="grid gap-2 sm:grid-cols-4">
        <Stat label="На начало месяца" value={<Signed v={row.start} />} hint={row.startSet ? "введено руками" : "перенос с прошлого месяца"} />
        <Stat label="Начислено" value={money(row.accrued + row.bonus)} hint={row.bonus ? `в том числе оклад/премия ${money(row.bonus)}` : undefined} />
        <Stat label="Получено" value={money(row.paid)} />
        <Stat label="Итого" value={<Signed v={row.end} strong />} hint={row.end < 0 ? "выдано вперёд" : row.end > 0 ? "к выплате" : "в расчёте"} />
      </div>

      {/* Заказы месяца */}
      <div>
        <button
          type="button"
          onClick={() => setShowOrders((v) => !v)}
          className="text-[13.5px] font-semibold text-brand-ink underline-offset-2 hover:underline"
        >
          {showOrders ? "Скрыть заказы" : `Заказы месяца: ${detail.orders.length}`}
        </button>
        {showOrders && detail.orders.length > 0 && (
          <div className="mt-2 max-h-[320px] overflow-auto rounded-card border border-line">
            <table className="w-full text-[13px]">
              <thead className="sticky top-0 bg-surface-raised text-left text-ink-dim">
                <tr>
                  <th className="px-3 py-1.5 font-medium">Заказ</th>
                  <th className="px-3 py-1.5 font-medium">Оплачен</th>
                  {money_ && <th className="px-3 py-1.5 text-right font-medium">Итог</th>}
                  {money_ && <th className="px-3 py-1.5 text-right font-medium">Запчасти</th>}
                  <th className="px-3 py-1.5 text-right font-medium">С работ</th>
                  <th className="px-3 py-1.5 text-right font-medium">Доля</th>
                  <th className="px-3 py-1.5 text-right font-medium">Начислено</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {detail.orders.map((o) => (
                  <tr key={o.orderId}>
                    <td className="px-3 py-1.5 font-mono">
                      <Link to={`/orders/${o.orderId}`} className="text-brand-ink hover:underline">
                        {o.number}
                      </Link>
                    </td>
                    <td className="px-3 py-1.5 text-ink-soft">{formatDate(o.at)}</td>
                    {money_ && <td className="px-3 py-1.5 text-right tabular-nums">{money(o.total)}</td>}
                    {money_ && <td className="px-3 py-1.5 text-right tabular-nums text-ink-dim">{money(o.parts)}</td>}
                    <td className="px-3 py-1.5 text-right tabular-nums">{money(o.base)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-ink-dim">
                      {o.share === 1 ? "весь" : `${Math.round(o.share * 100)}%`}
                    </td>
                    <td className="px-3 py-1.5 text-right font-semibold tabular-nums">{money(o.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Оклад, премия, штраф */}
        <div>
          <p className="text-[13.5px] font-semibold">Оклад, премия, штраф</p>
          <ul className="mt-2 space-y-1">
            {bonuses.map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-2 rounded-field bg-surface-raised px-3 py-1.5 text-[13px]">
                <span>
                  <Signed v={e.amount} /> <span className="text-ink-soft">{e.comment}</span>
                  <span className="ml-1 text-ink-dim">· {e.by ?? "—"}</span>
                </span>
                {manage && (
                  <button
                    type="button"
                    title="Удалить запись"
                    disabled={busy}
                    onClick={() => void run(() => salaryApi.removeEntry(e.id))}
                    className="text-ink-dim hover:text-state-off"
                  >
                    <IconDelete className="h-4 w-4" />
                  </button>
                )}
              </li>
            ))}
            {records && bonuses.length === 0 && <li className="text-[13px] text-ink-dim">Записей нет.</li>}
          </ul>
          {manage && (
            <form onSubmit={addBonus} className="mt-2 flex flex-wrap items-end gap-2">
              <div className="w-[140px]">
                <Input
                  inputMode="decimal"
                  placeholder="10000 или −500"
                  value={bonus.amount}
                  onChange={(e) => setBonus({ ...bonus, amount: e.target.value })}
                />
              </div>
              <div className="min-w-[160px] flex-1">
                <Input
                  placeholder="Оклад, премия, штраф…"
                  value={bonus.comment}
                  onChange={(e) => setBonus({ ...bonus, comment: e.target.value })}
                />
              </div>
              <Button type="submit" variant="secondary" disabled={busy}>
                Начислить
              </Button>
            </form>
          )}
        </div>

        {/* Выплаты */}
        <div>
          <p className="text-[13.5px] font-semibold">Выплаты</p>
          <ul className="mt-2 space-y-1">
            {records?.payouts.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-2 rounded-field bg-surface-raised px-3 py-1.5 text-[13px]">
                <span>
                  <span className="font-semibold tabular-nums">{money(p.amount)}</span>{" "}
                  <span className="text-ink-soft">{formatDate(p.paidAt)}</span>
                  {p.comment && <span className="text-ink-soft"> · {p.comment}</span>}
                  <span className="ml-1 text-ink-dim" title="Кто записал">· записал {p.by ?? "—"}</span>
                </span>
                {manage && (
                  <button
                    type="button"
                    title="Удалить выплату"
                    disabled={busy}
                    onClick={() => void run(() => salaryApi.removePayout(p.id))}
                    className="text-ink-dim hover:text-state-off"
                  >
                    <IconDelete className="h-4 w-4" />
                  </button>
                )}
              </li>
            ))}
            {records && records.payouts.length === 0 && <li className="text-[13px] text-ink-dim">Выплат не было.</li>}
          </ul>
          {canPay && (
            <form onSubmit={addPayout} className="mt-2 flex flex-wrap items-end gap-2">
              <div className="w-[120px]">
                <Input
                  inputMode="decimal"
                  placeholder="Сумма"
                  value={payout.amount}
                  onChange={(e) => setPayout({ ...payout, amount: e.target.value })}
                />
              </div>
              <div className="w-[160px]">
                <Input
                  type="date"
                  value={payout.date}
                  max={today()}
                  onChange={(e) => setPayout({ ...payout, date: e.target.value })}
                />
              </div>
              <div className="min-w-[140px] flex-1">
                <Input
                  placeholder="Комментарий"
                  value={payout.comment}
                  onChange={(e) => setPayout({ ...payout, comment: e.target.value })}
                />
              </div>
              <Button type="submit" variant="secondary" disabled={busy}>
                {mine && !data.canManage ? "Я получил" : "Выплатить"}
              </Button>
            </form>
          )}
        </div>
      </div>

      {/* Начальный остаток — один раз, в первом месяце учёта. */}
      {manage && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const v = opening.trim() === "" ? null : num(opening);
            if (v !== null && Number.isNaN(v)) return setError("Остаток — число, можно с минусом");
            void run(() => salaryApi.setOpening(row.userId, data.month, v));
          }}
          className="flex flex-wrap items-end gap-2 border-t border-line pt-3"
        >
          <Field label="Остаток на начало месяца — если ведёте учёт в программе с этого месяца">
            <div className="w-[160px]">
              <Input
                inputMode="decimal"
                placeholder={row.startSet ? "" : String(row.start)}
                value={opening}
                onChange={(e) => setOpening(e.target.value)}
              />
            </div>
          </Field>
          <Button type="submit" variant="secondary" disabled={busy}>
            {opening.trim() === "" && row.startSet ? "Убрать" : "Сохранить"}
          </Button>
          <p className="basis-full text-[12px] text-ink-dim">
            Плюс — мастерская должна сотруднику, минус — выдано вперёд. Дальше остаток переносится сам.
          </p>
        </form>
      )}
    </div>
  );
}

export default function Salary() {
  const [month, setMonth] = useState<string | undefined>(undefined);
  const [data, setData] = useState<SalaryMonth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await salaryApi.month(month);
      setData(d);
      setError(null);
      if (!d.seesAll && d.rows[0]) setOpenRow(d.rows[0].userId);
    } catch (err) {
      setError(errorText(err, "Не удалось загрузить зарплату"));
    }
  }, [month]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !data) return <Banner tone="error">{error}</Banner>;
  if (!data) return <Spinner label="Считаем зарплату" />;

  const current = new Date().toISOString().slice(0, 7);
  const go = (delta: number) => {
    setOpenRow(data.seesAll ? null : openRow);
    setMonth(shiftMonth(data.month, delta));
  };

  async function toggleClose() {
    if (!data) return;
    setBusy(true);
    setError(null);
    try {
      if (data.closed) await salaryApi.reopen(data.month);
      else await salaryApi.close(data.month);
      await load();
    } catch (err) {
      setError(errorText(err, "Не получилось"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Мастерская"
        title="Зарплата"
        subtitle="Процент мастера — с работ (итог минус запчасти) по заказам, выданным и оплаченным полностью в этом месяце."
      />

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Button variant="secondary" className="px-3" onClick={() => go(-1)} title="Предыдущий месяц">
              <IconChevronLeft className="h-4 w-4" />
            </Button>
            <span className="min-w-[150px] text-center text-[17px] font-bold">{monthTitle(data.month)}</span>
            <Button variant="secondary" className="px-3" onClick={() => go(1)} title="Следующий месяц">
              <IconChevronRight className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            {data.closed ? (
              <span className="rounded-pill bg-state-done/15 px-3 py-1 font-semibold text-state-done">
                Закрыт {formatDateTime(data.closed.at)}
                {data.closed.by ? ` · ${data.closed.by}` : ""}
              </span>
            ) : (
              <span className="text-ink-dim">
                {data.month < data.since
                  ? `Учёт ведётся с месяца «${monthTitle(data.since)}» — здесь только справка`
                  : "Месяц открыт — цифры меняются вместе с заказами"}
              </span>
            )}
            {data.canManage && data.month < current && data.month >= data.since && (
              <Button variant="secondary" disabled={busy} onClick={() => void toggleClose()}>
                {data.closed ? "Открыть снова" : "Закрыть месяц"}
              </Button>
            )}
          </div>
        </div>
        {error && <div className="mt-3"><Banner tone="error">{error}</Banner></div>}
      </Card>

      {data.rows.length === 0 ? (
        <Card>
          <SectionLabel>Пусто</SectionLabel>
          <p className="mt-2 text-[13.5px] text-ink-muted">
            В этом месяце нет ни начислений, ни выплат. Мастер появится здесь, как только у него будет
            процент с работ (раздел «Сотрудники») или запись за месяц.
          </p>
        </Card>
      ) : !data.seesAll ? (
        // Своя карточка — сразу раскрытой: смотреть больше не на кого.
        <div className="overflow-hidden rounded-panel border border-line bg-surface shadow-card">
          <div className="px-4 pt-4 sm:px-5">
            <p className="text-[16px] font-bold">{data.rows[0].name}</p>
            <p className="text-[12.5px] text-ink-dim">{data.rows[0].percent ? `${data.rows[0].percent}% с работ` : "процент не задан"}</p>
          </div>
          <Detail data={data} row={data.rows[0]} detail={data.details[data.rows[0].userId]} onChanged={() => void load()} />
        </div>
      ) : (
        <div className="overflow-hidden rounded-panel border border-line bg-surface shadow-card">
          {/* Не таблица, а строки: на телефоне колонки складываются в плитки,
              и раскрытая карточка не уезжает вбок вместе с широкой таблицей. */}
          <div className="hidden grid-cols-[minmax(0,1fr)_repeat(4,130px)] gap-2 bg-surface-raised px-4 py-2.5 text-[12.5px] text-ink-dim sm:grid">
            <span>Сотрудник</span>
            <span className="text-right">На начало</span>
            <span className="text-right">Начислено</span>
            <span className="text-right">Получено</span>
            <span className="text-right">Итого</span>
          </div>
          {data.rows.map((r) => {
            const opened = openRow === r.userId;
            return (
              <div key={r.userId} className="border-t border-line first:border-t-0 sm:first:border-t">
                <button
                  type="button"
                  onClick={() => setOpenRow(opened ? null : r.userId)}
                  className={
                    "grid w-full grid-cols-2 gap-x-3 gap-y-1 px-4 py-3 text-left text-[14px] transition-colors duration-150 hover:bg-surface-raised sm:grid-cols-[minmax(0,1fr)_repeat(4,130px)] sm:items-center sm:gap-2 " +
                    (opened ? "bg-surface-raised" : "")
                  }
                >
                  <span className="col-span-2 sm:col-span-1">
                    <span className="block font-semibold">
                      {r.name}
                      {!r.isActive && <span className="ml-2 text-[12px] font-normal text-ink-dim">выключен</span>}
                    </span>
                    <span className="block text-[12px] text-ink-dim">
                      {[r.role, r.percent ? `${r.percent}% с работ` : null, r.orders ? `заказов ${r.orders}` : null]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                  <Cell label="На начало"><Signed v={r.start} /></Cell>
                  <Cell label="Начислено"><span className="tabular-nums">{money(r.accrued + r.bonus)}</span></Cell>
                  <Cell label="Получено"><span className="tabular-nums">{money(r.paid)}</span></Cell>
                  <Cell label="Итого"><Signed v={r.end} strong /></Cell>
                </button>
                {opened && <Detail data={data} row={r} detail={data.details[r.userId]} onChanged={() => void load()} />}
              </div>
            );
          })}
          {data.totals && data.rows.length > 1 && (
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 border-t-2 border-line bg-surface-raised px-4 py-2.5 text-[13.5px] font-semibold sm:grid-cols-[minmax(0,1fr)_repeat(4,130px)] sm:gap-2">
              <span className="col-span-2 sm:col-span-1">Всего</span>
              <Cell label="На начало"><Signed v={data.totals.start} /></Cell>
              <Cell label="Начислено"><span className="tabular-nums">{money(data.totals.accrued)}</span></Cell>
              <Cell label="Получено"><span className="tabular-nums">{money(data.totals.paid)}</span></Cell>
              <Cell label="Итого"><Signed v={data.totals.end} strong /></Cell>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
