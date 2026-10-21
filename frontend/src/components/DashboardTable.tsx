import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { copyable, copyRow, deviceText } from "./CopyMenu";
import { orderCopyItems, type MenuOrder, type useOrderMenu } from "./OrderMenu";
import { StatusPicker } from "./StatusPicker";
import { IconOrders, IconPlus, IconUrgent } from "./icons";
import { Button, EmptyState, SearchInput } from "./ui";
import { useAuth } from "../lib/auth";
import { nameStyle } from "../lib/customerColor";
import { dueLabel, formatDate, plural, shortName } from "../lib/format";
import { money, type OrderStatus } from "../lib/orders";
import { STAGES } from "../lib/stages";
import { TABLE_OFF, type DashboardPrefs, type TableCol, type TableRow, type TablePrefs, type TableSort } from "../lib/workshop";

/**
 * Главная таблицей — вариант «А» (Андрей, 21.10.2026, по образцу HelloClient).
 *
 * Строка на заказ, сверху — быстрые фильтры по тому, что требует внимания
 * («Статус дольше нормы», «Просрочены по сроку», «Без мастера»…), под ними —
 * статусы с числами. Статус меняется щелчком по таблетке, любое поле —
 * копируется правой кнопкой (там же «всё строкой» и «Меню заказа…»), по
 * свободному месту строки — обычное меню заказа.
 *
 * Сервер присылает все заказы в работе разом (и выданные с долгом — тому, кто
 * видит деньги), а фильтрует, ищет и сортирует уже браузер: щелчок по фильтру
 * не должен ждать ответа. Фильтр и поиск — в адресе страницы: вернулись из
 * заказа — таблица та же.
 *
 * На телефоне строки становятся карточками: таблица в девять столбцов на
 * узком экране не читается, а прокручивать её вбок неудобно.
 */

type Om = ReturnType<typeof useOrderMenu>;

/** Сколько дней в статусе — уже «дольше нормы». Готовые — отдельным фильтром. */
const NORM_DAYS: Partial<Record<OrderStatus["group"], number>> = { NEW: 2, WAITING: 3, IN_PROGRESS: 5 };
/** «Готовы, не забрали» — лежат готовыми дольше этого. */
const READY_DAYS = 3;
const DAY = 86_400_000;
const PAGE = 50;

const days = (iso: string | null | undefined) => (iso ? Math.floor((Date.now() - new Date(iso).getTime()) / DAY) : 0);
const isActive = (r: TableRow) => !r.issuedAt;
const isStale = (r: TableRow) => {
  const norm = NORM_DAYS[r.status.group];
  return isActive(r) && norm !== undefined && days(r.statusSince) >= norm;
};
const isOverdue = (r: TableRow) => isActive(r) && r.status.group !== "DONE" && !!r.dueAt && new Date(r.dueAt).getTime() < Date.now();
const waitsParts = (r: TableRow) => isActive(r) && /запчаст|детал/i.test(r.status.name);
const readyIdle = (r: TableRow) => isActive(r) && r.status.group === "DONE" && days(r.completedAt ?? r.statusSince) >= READY_DAYS;

type QuickKey = "all" | "stale" | "overdue" | "nomaster" | "debt" | "parts" | "ready";

const QUICK: Array<{ key: QuickKey; label: string; hint: string; test: (r: TableRow) => boolean; money?: boolean }> = [
  { key: "all", label: "Все в работе", hint: "Все заказы, которые ещё не выданы", test: isActive },
  {
    key: "stale",
    label: "Статус дольше нормы",
    hint: `Диагностика дольше ${NORM_DAYS.NEW} дн., согласование — ${NORM_DAYS.WAITING} дн., ремонт — ${NORM_DAYS.IN_PROGRESS} дн.`,
    test: isStale,
  },
  { key: "overdue", label: "Просрочены по сроку", hint: "Срок прошёл, а заказ ещё не готов", test: isOverdue },
  { key: "nomaster", label: "Без мастера", hint: "Не назначен мастер", test: (r) => isActive(r) && !r.master && r.status.group !== "DONE" },
  { key: "debt", label: "С долгом", hint: "Выданы, но оплачены не полностью", test: (r) => !!r.issuedAt && (r.debt ?? 0) > 0, money: true },
  { key: "parts", label: "Ждут запчасть", hint: "Статус со словом «запчасть» или «деталь»", test: waitsParts },
  { key: "ready", label: "Готовы, не забрали", hint: `Готовы больше ${READY_DAYS} дн. назад, а клиент не пришёл`, test: readyIdle },
];

interface ColDef {
  key: TableCol;
  label: string;
  /** Чем сортировать по щелчку на заголовке. */
  sort?: "created" | "number" | "due" | "total" | "since";
  /** Классы ячейки: ширина, выравнивание. */
  cls: string;
  /**
   * Ширина: постоянная в пикселях или доля оставшегося места. Таблица с
   * постоянной раскладкой (table-fixed): иначе длинная жалоба или имя
   * растягивали свой столбец, и «Срок» с «Суммой» уезжали за край.
   */
  w?: number;
  money?: boolean;
}

const COLS: ColDef[] = [
  { key: "number", label: "Номер", sort: "number", cls: "whitespace-nowrap", w: 118 },
  { key: "created", label: "Создан", sort: "created", cls: "whitespace-nowrap", w: 84 },
  { key: "device", label: "Устройство", cls: "" },
  { key: "serial", label: "Серийный №", cls: "", w: 130 },
  { key: "status", label: "Статус", cls: "", w: 152 },
  { key: "since", label: "В статусе", sort: "since", cls: "whitespace-nowrap", w: 92 },
  { key: "customer", label: "Клиент", cls: "" },
  { key: "complaint", label: "Неисправность", cls: "" },
  { key: "note", label: "Примечание", cls: "" },
  { key: "master", label: "Мастер", cls: "truncate whitespace-nowrap", w: 100 },
  { key: "due", label: "Срок", sort: "due", cls: "truncate whitespace-nowrap", w: 128 },
  { key: "total", label: "Сумма", sort: "total", cls: "whitespace-nowrap text-right", w: 98, money: true },
];

/** Меньше этого таблица не сжимается — дальше прокрутка внутри неё, а не каша. */
const minTable = (cols: TableCol[]) =>
  cols.reduce((n, c) => n + (COLS.find((x) => x.key === c)?.w ?? 110), 16);

export function visibleCols(t: TablePrefs | undefined, seesMoney: boolean): TableCol[] {
  return COLS.filter((c) => {
    if (c.money && !seesMoney) return false;
    if (TABLE_OFF.includes(c.key)) return !!t?.shown?.includes(c.key);
    return !t?.hidden?.includes(c.key);
  }).map((c) => c.key);
}

const menuOf = (r: TableRow): MenuOrder => ({
  id: r.id,
  number: r.number,
  status: r.status,
  masterId: r.master?.id ?? null,
  isUrgent: r.isUrgent,
  completed: !!r.completedAt,
  issued: !!r.issuedAt,
  phone: r.customer.phone ?? null,
  copy: orderCopyItems({ number: r.number, customer: r.customer, device: r.device, serial: r.device?.serial }),
});

const deviceLine = (r: TableRow) => [r.device?.kind, r.device?.brand, r.device?.model].filter(Boolean).join(" ") || "Техника не указана";
const digits = (s: string) => s.replace(/\D+/g, "");

/** Подходит ли заказ под слова поиска: номер, клиент, телефон, техника, серийник, жалоба, мастер. */
function matches(r: TableRow, words: string[]) {
  const hay = [r.number, r.customer.name, r.customer.phone, deviceLine(r), r.device?.serial, r.complaint, r.master?.fullName, r.receptionNote, ...r.completeness]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase("ru-RU");
  const phone = digits(r.customer.phone ?? "");
  // Телефон — по цифрам: «9021739851» находит «+7 902 173-98-51».
  return words.every((w) => {
    const dw = digits(w);
    return hay.includes(w) || (dw.length >= 3 && dw.length === w.replace(/[\s()+-]/g, "").length && phone.includes(dw));
  });
}

function sorter(sort: TableSort): (a: TableRow, b: TableRow) => number {
  const dir = sort.startsWith("-") ? -1 : 1;
  const key = sort.replace(/^-/, "");
  const t = (v: string | null | undefined) => (v ? new Date(v).getTime() : Number.POSITIVE_INFINITY);
  const val = (r: TableRow): number => {
    switch (key) {
      case "number":
        return Number(r.number.replace(/\D+/g, "")) || 0;
      case "due":
        return t(r.dueAt);
      case "total":
        return r.total ?? 0;
      case "since":
        return new Date(r.statusSince).getTime();
      default:
        return new Date(r.acceptedAt).getTime();
    }
  };
  // Срочные — всегда сверху: так же, как на доске.
  return (a, b) => Number(b.isUrgent) - Number(a.isUrgent) || dir * (val(a) - val(b)) || b.acceptedAt.localeCompare(a.acceptedAt);
}

const withTable = (prefs: DashboardPrefs, patch: Partial<TablePrefs>): DashboardPrefs => {
  const t: TablePrefs = { ...(prefs.table ?? {}), ...patch };
  const clean: TablePrefs = {};
  if (t.hidden?.length) clean.hidden = t.hidden;
  if (t.shown?.length) clean.shown = t.shown;
  if (t.dense) clean.dense = true;
  if (t.sort && t.sort !== "-created") clean.sort = t.sort;
  const next = { ...prefs };
  if (Object.keys(clean).length) next.table = clean;
  else delete next.table;
  return next;
};

export function DashboardTable({
  rows,
  prefs,
  seesMoney,
  om,
  onPrefs,
}: {
  rows: TableRow[];
  prefs: DashboardPrefs;
  /** Видит ли человек деньги клиентов: столбец «Сумма» и фильтр «С долгом». */
  seesMoney: boolean;
  om: Om;
  onPrefs: (next: DashboardPrefs) => void;
}) {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const [shown, setShown] = useState(PAGE);
  const [colsOpen, setColsOpen] = useState(false);

  const quick = (QUICK.find((x) => x.key === params.get("f"))?.key ?? "all") as QuickKey;
  const statusId = params.get("st");
  const table = prefs.table;
  const dense = !!table?.dense;
  const sort: TableSort = table?.sort ?? "-created";
  const cols = visibleCols(table, seesMoney);
  const quickList = QUICK.filter((x) => !x.money || seesMoney);

  // Несколько ключей — одним переходом: два setParams подряд читают один и
  // тот же старый адрес, и второй затирал первый.
  const setParam = (key: string, value: string | null, also: Record<string, string | null> = {}) =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        for (const [k, v] of Object.entries({ [key]: value, ...also })) {
          if (v) p.set(k, v);
          else p.delete(k);
        }
        return p;
      },
      { replace: true }
    );

  // Поиск — в адрес с задержкой: на каждую букву историю не переписываем.
  useEffect(() => {
    const t = setTimeout(() => {
      if ((params.get("q") ?? "") !== q.trim()) setParam("q", q.trim() || null);
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  useEffect(() => setShown(PAGE), [quick, statusId, q]);

  const words = useMemo(
    () =>
      q
        .toLocaleLowerCase("ru-RU")
        .split(/\s+/)
        .filter(Boolean),
    [q]
  );
  const searched = useMemo(() => (words.length ? rows.filter((r) => matches(r, words)) : rows), [rows, words]);
  const counts = useMemo(() => new Map(quickList.map((x) => [x.key, searched.filter(x.test).length])), [searched, quickList]);
  const byQuick = useMemo(() => searched.filter(QUICK.find((x) => x.key === quick)!.test), [searched, quick]);

  // Статусы с числами — в порядке статусов мастерской, только непустые.
  const statusChips = useMemo(() => {
    const n = new Map<string, number>();
    for (const r of byQuick) n.set(r.status.id, (n.get(r.status.id) ?? 0) + 1);
    const order = om.reference?.statuses ?? [];
    const known = order.filter((s) => n.has(s.id));
    const rest = [...new Map(byQuick.filter((r) => !order.some((s) => s.id === r.status.id)).map((r) => [r.status.id, r.status])).values()];
    return [...known, ...rest].map((s) => ({ status: s, count: n.get(s.id) ?? 0 }));
  }, [byQuick, om.reference]);

  const filtered = useMemo(() => {
    const list = statusId ? byQuick.filter((r) => r.status.id === statusId) : byQuick;
    return [...list].sort(sorter(sort));
  }, [byQuick, statusId, sort]);
  const page = filtered.slice(0, shown);

  const sortBy = (key: NonNullable<ColDef["sort"]>) => {
    // Первый щелчок: даты и суммы — сначала большие, номер — сначала новые.
    const next: TableSort = sort === `-${key}` ? (key as TableSort) : (`-${key}` as TableSort);
    onPrefs(withTable(prefs, { sort: next }));
  };

  const pick = (r: TableRow, s: OrderStatus) => void om.changeStatus(menuOf(r), s);

  const open = (e: React.MouseEvent, r: TableRow) => {
    // Выделяли текст, чтобы скопировать, — это не щелчок по строке.
    if (window.getSelection()?.toString()) return;
    if ((e.target as Element).closest("a,button,input,[role=menu]")) return;
    if (e.ctrlKey || e.metaKey) window.open(`/orders/${r.id}`, "_blank");
    else navigate(`/orders/${r.id}`);
  };

  const pad = dense ? "py-1.5" : "py-2.5";

  const cell = (c: TableCol, r: TableRow) => {
    switch (c) {
      case "number":
        return (
          <Link to={`/orders/${r.id}`} className="font-mono text-[13px] font-bold hover:underline" {...copyable("order", r.number)}>
            {r.number}
            {r.isUrgent && (
              <span title="Срочный" className="ml-1 inline-block align-[-2px] text-state-off">
                <IconUrgent className="h-3.5 w-3.5" />
              </span>
            )}
          </Link>
        );
      case "created":
        return (
          <span className="text-ink-muted" {...copyable("text", formatDate(r.acceptedAt), "дату приёма")}>
            {shortDate(r.acceptedAt)}
          </span>
        );
      case "device":
        return (
          <span className="line-clamp-2 font-semibold [overflow-wrap:anywhere]" title={deviceLine(r)} {...copyable("device", deviceText(r.device) || deviceLine(r))}>
            {deviceLine(r)}
          </span>
        );
      case "serial":
        return r.device?.serial ? (
          <span className="block truncate font-mono text-[12.5px] text-ink-soft" {...copyable("serial", r.device.serial)}>
            {r.device.serial}
          </span>
        ) : (
          <span className="text-ink-dim">—</span>
        );
      case "status":
        return (
          <StatusPicker order={r} statuses={om.reference?.statuses} canChange={om.canStatus(menuOf(r))} onPick={(s) => pick(r, s)} className="max-w-full" />
        );
      case "since": {
        const d = days(r.statusSince);
        return (
          <span className={isStale(r) ? "font-semibold text-state-off" : "text-ink-muted"} title={`В статусе с ${formatDate(r.statusSince)}`}>
            {d === 0 ? "сегодня" : `${d} дн.`}
          </span>
        );
      }
      case "customer":
        return (
          <span className="block min-w-0">
            {r.customer.name ? (
              <span className="block truncate" style={nameStyle(r.customer.color)} title={r.customer.name} {...copyable("name", r.customer.name)}>
                {r.customer.name}
              </span>
            ) : (
              <span className="text-ink-dim">—</span>
            )}
            {r.customer.phone && (
              <a
                href={`tel:${r.customer.phone}`}
                className="block truncate text-[12.5px] text-brand-ink hover:underline"
                {...copyable("phone", r.customer.phone)}
              >
                {r.customer.phone}
              </a>
            )}
          </span>
        );
      case "complaint":
        return (
          <span className="block min-w-0">
            <span className="line-clamp-2 [overflow-wrap:anywhere]" title={r.complaint} {...copyable("text", r.complaint, "неисправность")}>
              {r.complaint || <span className="text-ink-dim">—</span>}
            </span>
            {r.completeness.length > 0 && (
              <span className="block truncate text-[12px] text-ink-dim" {...copyable("text", r.completeness.join(", "), "комплектность")}>
                {r.completeness.join(", ")}
              </span>
            )}
          </span>
        );
      case "note":
        return r.receptionNote ? (
          <span className="block truncate text-ink-soft" title={r.receptionNote} {...copyable("text", r.receptionNote, "примечание")}>
            {r.receptionNote}
          </span>
        ) : (
          <span className="text-ink-dim">—</span>
        );
      case "master":
        return r.master ? (
          <span title={r.master.fullName} {...copyable("text", r.master.fullName, "мастера")}>
            {shortName(r.master.fullName)}
          </span>
        ) : (
          <span className="text-ink-dim">—</span>
        );
      case "due":
        return <DueCell r={r} />;
      case "total":
        return (
          <span className="block">
            {r.total ? (
              <span className="font-semibold tabular-nums" {...copyable("text", money(r.total), "сумму")}>
                {money(r.total)}
              </span>
            ) : (
              <span className="text-ink-dim">—</span>
            )}
            {(r.debt ?? 0) > 0 && (
              <span className="tag tag-debt mt-0.5 block w-fit px-2 py-[1px] text-[11px] sm:ml-auto" {...copyable("text", money(r.debt), "долг")}>
                долг {money(r.debt)}
              </span>
            )}
          </span>
        );
    }
  };

  const nothing = rows.length === 0;

  return (
    <div className="space-y-3" data-dashboard-table>
      <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
        <SearchInput
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Номер, клиент, телефон, техника…"
          aria-label="Найти заказ в таблице"
          className="min-w-0 flex-1 basis-full sm:basis-auto"
          data-table-search
        />
        <div className="relative hidden md:block">
          <Button variant="secondary" onClick={() => setColsOpen((v) => !v)} aria-expanded={colsOpen} data-table-columns className="whitespace-nowrap">
            <ColumnsIcon />
            Столбцы
          </Button>
          {colsOpen && <ColumnsMenu prefs={prefs} seesMoney={seesMoney} onPrefs={onPrefs} onClose={() => setColsOpen(false)} />}
        </div>
        {can("orders.create") && (
          <Button icon={<IconPlus />} onClick={() => navigate("/orders/new")} className="hidden whitespace-nowrap sm:inline-flex">
            Принять технику
          </Button>
        )}
      </div>

      {/* Быстрые фильтры: на телефоне — лентой вбок, на компьютере — переносом. */}
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-0.5 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0" data-quick-filters>
        {quickList.map((x) => {
          const n = counts.get(x.key) ?? 0;
          const on = quick === x.key;
          return (
            <button
              key={x.key}
              type="button"
              title={x.hint}
              data-quick={x.key}
              aria-pressed={on}
              onClick={() => setParam("f", x.key === "all" ? null : x.key, { st: null })}
              className={
                "inline-flex min-h-[36px] shrink-0 items-center gap-2 whitespace-nowrap rounded-pill border px-3.5 text-[13px] font-semibold transition-colors duration-150 " +
                (on ? "border-brand bg-brand-tint text-brand-ink" : "border-line bg-surface hover:border-line-strong")
              }
            >
              {x.label}
              <span
                className={
                  "rounded-pill px-1.5 py-[1px] font-mono text-[11.5px] " +
                  (x.key !== "all" && n > 0 ? "bg-state-off/15 text-state-off" : "bg-surface-raised text-ink-muted")
                }
              >
                {n}
              </span>
            </button>
          );
        })}
      </div>

      {statusChips.length > 0 && (
        <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0" data-status-chips>
          <StageChip on={!statusId} onClick={() => setParam("st", null)} label="Все статусы" count={byQuick.length} />
          {statusChips.map(({ status, count }) => (
            <StageChip
              key={status.id}
              on={statusId === status.id}
              onClick={() => setParam("st", statusId === status.id ? null : status.id)}
              label={status.name}
              count={count}
              dot={STAGES.find((s) => s.key === status.group)?.dot ?? "bg-ink-dim"}
            />
          ))}
        </div>
      )}

      {nothing ? (
        <EmptyState icon={<IconOrders />} title="Заказов в работе нет">
          Примите первый заказ — он появится здесь строкой.
        </EmptyState>
      ) : filtered.length === 0 ? (
        <p className="rounded-card border border-dashed border-line px-4 py-8 text-center text-[13.5px] text-ink-muted" data-table-empty>
          {words.length ? "Ничего не нашлось." : "Таких заказов сейчас нет."}
        </p>
      ) : (
        <>
          {/* Компьютер: таблица. */}
          <div className="hidden overflow-hidden rounded-panel border border-line bg-surface md:block">
            <div className="overflow-x-auto">
              <table
                className={"w-full table-fixed border-collapse " + (dense ? "text-[13px]" : "text-[13.5px]")}
                style={{ minWidth: minTable(cols) }}
                data-table
              >
                <colgroup>
                  {cols.map((c) => {
                    const def = COLS.find((x) => x.key === c)!;
                    return <col key={c} style={def.w ? { width: def.w + (c === cols[0] || c === cols[cols.length - 1] ? 8 : 0) } : undefined} />;
                  })}
                </colgroup>
                <thead>
                  <tr className="border-b border-line text-left text-[11px] font-bold uppercase tracking-[0.07em] text-ink-dim">
                    {cols.map((c) => {
                      const def = COLS.find((x) => x.key === c)!;
                      const active = def.sort && sort.replace(/^-/, "") === def.sort;
                      return (
                        <th key={c} className={"truncate px-2 py-2.5 font-bold first:pl-4 last:pr-4 " + def.cls}>
                          {def.sort ? (
                            <button
                              type="button"
                              onClick={() => sortBy(def.sort!)}
                              className={"inline-flex items-center gap-1 uppercase tracking-[0.07em] hover:text-ink " + (active ? "text-ink" : "")}
                              data-sort={def.sort}
                            >
                              {def.label}
                              {active && <span aria-hidden>{sort.startsWith("-") ? "↓" : "↑"}</span>}
                            </button>
                          ) : (
                            def.label
                          )}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {page.map((r) => {
                    const m = menuOf(r);
                    return (
                      <tr
                        key={r.id}
                        data-table-row={r.number}
                        {...om.bind(m)}
                        {...copyRow(m.copy ?? [])}
                        onClick={(e) => open(e, r)}
                        className={
                          "cursor-pointer border-b border-line align-middle transition-colors duration-100 last:border-b-0 hover:bg-surface-raised/60 " +
                          (r.isUrgent ? "shadow-[inset_3px_0_0_0_rgb(var(--state-off))]" : "")
                        }
                      >
                        {cols.map((c) => {
                          const def = COLS.find((x) => x.key === c)!;
                          return (
                            <td key={c} className={`overflow-hidden px-2 ${pad} first:pl-4 last:pr-4 ` + def.cls} data-col={c}>
                              {cell(c, r)}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-2.5 text-[12.5px] text-ink-muted">
              <span data-table-count>
                Показано {page.length} из {filtered.length}
                {filtered.length > page.length && (
                  <>
                    {" · "}
                    <button type="button" className="font-semibold text-brand-ink hover:underline" onClick={() => setShown((n) => n + PAGE)}>
                      показать ещё
                    </button>
                  </>
                )}
              </span>
              <span className="flex items-center gap-1.5">
                Строки:
                <button
                  type="button"
                  onClick={() => dense && onPrefs(withTable(prefs, { dense: false }))}
                  className={dense ? "hover:text-ink" : "font-bold text-ink"}
                  data-density="normal"
                >
                  обычные
                </button>
                ·
                <button
                  type="button"
                  onClick={() => !dense && onPrefs(withTable(prefs, { dense: true }))}
                  className={dense ? "font-bold text-ink" : "hover:text-ink"}
                  data-density="dense"
                >
                  плотные
                </button>
              </span>
            </div>
          </div>

          {/* Телефон: карточки. */}
          <div className="space-y-2 md:hidden" data-table-cards>
            {page.map((r) => {
              const m = menuOf(r);
              return (
                <div
                  key={r.id}
                  data-table-card={r.number}
                  {...om.bind(m)}
                  onClick={(e) => open(e, r)}
                  className={
                    "cursor-pointer rounded-card border border-line bg-surface p-3.5 " +
                    (r.isUrgent ? "shadow-[inset_3px_0_0_0_rgb(var(--state-off))]" : "")
                  }
                >
                  <div className="flex items-center justify-between gap-3">
                    <Link to={`/orders/${r.id}`} className="font-mono text-[14px] font-bold">
                      {r.number}
                      {r.isUrgent && (
              <span title="Срочный" className="ml-1 inline-block align-[-2px] text-state-off">
                <IconUrgent className="h-3.5 w-3.5" />
              </span>
            )}
                    </Link>
                    <StatusPicker order={r} statuses={om.reference?.statuses} canChange={om.canStatus(m)} onPick={(s) => pick(r, s)} />
                  </div>
                  <p className="mt-1.5 text-[15px] font-bold leading-snug [overflow-wrap:anywhere]">{deviceLine(r)}</p>
                  {r.customer.name && (
                    <p className="mt-1 text-[14px]" style={nameStyle(r.customer.color)}>
                      {r.customer.name}
                    </p>
                  )}
                  {r.customer.phone && (
                    <a href={`tel:${r.customer.phone}`} className="text-[13.5px] text-brand-ink">
                      {r.customer.phone}
                    </a>
                  )}
                  {r.complaint && <p className="mt-1 line-clamp-2 text-[13.5px] text-ink-soft">{r.complaint}</p>}
                  {r.completeness.length > 0 && <p className="text-[12.5px] text-ink-dim">{r.completeness.join(", ")}</p>}
                  <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[13px]">
                    {r.dueAt || r.issuedAt || r.status.group === "DONE" ? <DueCell r={r} /> : <span />}
                    <span className="flex items-center gap-2">
                      {r.master && <span className="text-ink-dim">{shortName(r.master.fullName)}</span>}
                      {seesMoney && r.total ? <b className="tabular-nums">{money(r.total)}</b> : null}
                      {(r.debt ?? 0) > 0 && <span className="tag tag-debt px-2 py-[1px] text-[11px]">долг {money(r.debt)}</span>}
                    </span>
                  </div>
                </div>
              );
            })}
            <p className="px-1 text-[12.5px] text-ink-muted">
              Показано {page.length} из {filtered.length}
              {filtered.length > page.length && (
                <>
                  {" · "}
                  <button type="button" className="font-semibold text-brand-ink" onClick={() => setShown((n) => n + PAGE)}>
                    показать ещё
                  </button>
                </>
              )}
            </p>
          </div>
        </>
      )}
    </div>
  );
}

const shortDate = (iso: string) => new Date(iso).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit" });

function DueCell({ r }: { r: TableRow }) {
  if (r.issuedAt) {
    return (
      <span className="text-ink-muted" {...copyable("text", formatDate(r.issuedAt), "дату выдачи")}>
        выдан {shortDate(r.issuedAt)}
      </span>
    );
  }
  if (r.status.group === "DONE") {
    const idle = readyIdle(r);
    return (
      <span className={idle ? "font-semibold text-state-waiting" : "text-ink-muted"} {...copyable("text", formatDate(r.completedAt ?? r.statusSince), "дату готовности")}>
        готов {shortDate(r.completedAt ?? r.statusSince)}
      </span>
    );
  }
  const due = dueLabel(r.dueAt);
  if (!due) return <span className="text-ink-dim">—</span>;
  return (
    <span
      className={due.overdue ? "font-semibold text-state-off" : due.soon ? "font-semibold text-state-waiting" : "text-ink-muted"}
      {...copyable("text", formatDate(r.dueAt), "срок")}
    >
      {due.text}
    </span>
  );
}

function StageChip({ on, onClick, label, count, dot }: { on: boolean; onClick: () => void; label: string; count: number; dot?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      data-status-chip={label}
      className={
        "inline-flex min-h-[32px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-field px-2.5 text-[12.5px] font-semibold transition-colors duration-150 " +
        (on ? "bg-surface-raised text-ink ring-1 ring-line-strong" : "text-ink-muted hover:bg-surface-raised/60 hover:text-ink")
      }
    >
      {dot && <span aria-hidden className={"h-[7px] w-[7px] rounded-full " + dot} />}
      {label}
      <span className="font-mono text-[11.5px] text-ink">{count}</span>
    </button>
  );
}

function ColumnsIcon() {
  return (
    <svg aria-hidden viewBox="0 0 20 20" className="h-[17px] w-[17px]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
      <rect x="3" y="4" width="14" height="12" rx="2" />
      <path d="M8 4v12M12.5 4v12" />
    </svg>
  );
}

/** «Столбцы»: что показывать в таблице. Номер и статус — всегда. */
function ColumnsMenu({
  prefs,
  seesMoney,
  onPrefs,
  onClose,
}: {
  prefs: DashboardPrefs;
  seesMoney: boolean;
  onPrefs: (p: DashboardPrefs) => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (box.current?.contains(e.target as Node)) return;
      if ((e.target as Element).closest?.("[data-table-columns]")) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [onClose]);

  const t = prefs.table ?? {};
  const visible = visibleCols(t, seesMoney);
  const toggle = (c: TableCol) => {
    const on = visible.includes(c);
    if (TABLE_OFF.includes(c)) {
      const shown = on ? (t.shown ?? []).filter((x) => x !== c) : [...(t.shown ?? []), c];
      onPrefs(withTable(prefs, { shown }));
    } else {
      const hidden = on ? [...(t.hidden ?? []), c] : (t.hidden ?? []).filter((x) => x !== c);
      onPrefs(withTable(prefs, { hidden }));
    }
  };

  return (
    <div
      ref={box}
      className="absolute right-0 top-[calc(100%+6px)] z-40 w-[250px] rounded-field border border-line bg-surface-raised p-2 shadow-raised"
      data-columns-menu
    >
      <p className="px-2 pb-1 pt-0.5 text-[11px] font-bold uppercase tracking-[0.08em] text-ink-dim">Столбцы</p>
      {COLS.filter((c) => !c.money || seesMoney).map((c) => {
        const fixed = c.key === "number" || c.key === "status";
        const on = visible.includes(c.key);
        return (
          <label
            key={c.key}
            className={"flex min-h-[34px] items-center gap-2.5 rounded-[8px] px-2 text-[13.5px] " + (fixed ? "opacity-55" : "cursor-pointer hover:bg-surface-input")}
          >
            <input type="checkbox" checked={on} disabled={fixed} onChange={() => toggle(c.key)} className="h-4 w-4 accent-[rgb(var(--brand))]" data-col-toggle={c.key} />
            {c.label}
          </label>
        );
      })}
      <div className="mt-1 border-t border-line px-2 pt-2 text-[12.5px] text-ink-dim">
        Строки:{" "}
        <button type="button" className={prefs.table?.dense ? "hover:text-ink" : "font-bold text-ink"} onClick={() => onPrefs(withTable(prefs, { dense: false }))}>
          обычные
        </button>
        {" · "}
        <button type="button" className={prefs.table?.dense ? "font-bold text-ink" : "hover:text-ink"} onClick={() => onPrefs(withTable(prefs, { dense: true }))}>
          плотные
        </button>
      </div>
    </div>
  );
}
