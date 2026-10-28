import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { backState } from "../lib/listState";
import { looksLikePhone, phoneMatches } from "../lib/phone";
import { copyable, copyRow, deviceText } from "./CopyMenu";
import { orderCopyItems, type MenuOrder, type useOrderMenu } from "./OrderMenu";
import { StatusPicker } from "./StatusPicker";
import { MasterPicker } from "./MasterPicker";
import { OrderLabels, canLabel } from "./OrderLabels";
import { TableConfigurator } from "./TableConfigurator";
import { OutsourceFilter, type OutsourceOption } from "./OutsourceFilter";
import { KindBadge } from "./KindBadge";
import { IconDownload, IconOrders, IconPlus, IconUrgent } from "./icons";
import { Button, EmptyState, SearchInput } from "./ui";
import { useAuth } from "../lib/auth";
import { nameStyle } from "../lib/customerColor";
import { dueLabel, formatDate, plural, shortName } from "../lib/format";
import { LabelDot } from "../lib/labelIcons";
import { isWarrantyKind, kindBadge, money, type OrderStatus } from "../lib/orders";
import { STAGES } from "../lib/stages";
import { COL, DEFAULT_VIEW, MAX_PX, MIN_PX, colFlex, colPx, deviceLine, layoutCols, moneyText, type ColSpec } from "../lib/tableCols";
import { withPanel } from "../lib/dashboard";
import { ISSUED_DAYS, ISSUED_DAYS_DEFAULT, summaryApi, type DashboardPrefs, type TablePrefs, type TableRow, type TableViewPrefs } from "../lib/workshop";

/**
 * Главная таблицей — вариант «А» (Андрей, 21.10.2026, по образцу HelloClient),
 * с 22.10.2026 — с конфигуратором.
 *
 * Строка на заказ, сверху — вкладки видов (у каждого свои столбцы), быстрые
 * фильтры по тому, что требует внимания, и статусы с числами. Статус и мастер
 * меняются щелчком, ярлыки — щелчком по кружкам, любое поле копируется правой
 * кнопкой (там же «всё строкой» и «Меню заказа…»), по свободному месту строки —
 * обычное меню заказа.
 *
 * Сервер присылает все заказы в работе разом (и выданные с долгом — тому, кто
 * видит деньги), а фильтрует, ищет и сортирует уже браузер: щелчок по фильтру
 * не должен ждать ответа. Фильтр, поиск и вид — в адресе страницы: вернулись
 * из заказа — таблица та же.
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

interface Quick {
  key: string;
  label: string;
  hint: string;
  test: (r: TableRow) => boolean;
  money?: boolean;
  dot?: { icon: string; color: string };
  /** Число не тревожное — серым, а не красным («Выданы»). */
  calm?: boolean;
}

const QUICK: Quick[] = [
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
  labels: r.labels?.map((l) => l.id) ?? [],
});

/** Подходит ли заказ под слова поиска: номер, клиент, телефон, техника, серийник, жалоба, мастер. */
function matches(r: TableRow, words: string[]) {
  const hay = [
    r.number,
    r.customer.name,
    r.customer.phone,
    r.customer.phone2,
    deviceLine(r),
    r.device?.serial,
    r.complaint,
    r.master?.fullName,
    r.receptionNote,
    r.outsource,
    r.storage,
    ...r.completeness,
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase("ru-RU");
  // Телефон — по последним 10 цифрам: «89021739851» находит «+7 902 173-98-51».
  return words.every((w) => hay.includes(w) || (looksLikePhone(w) && phoneMatches(w, r.customer.phone, r.customer.phone2)));
}

function sorter(sort: string): (a: TableRow, b: TableRow) => number {
  const dir = sort.startsWith("-") ? -1 : 1;
  const spec = COL.get(sort.replace(/^-/, "")) ?? COL.get("created")!;
  const val = spec.sort ?? (() => 0);
  // Строки сравниваем «как люди»: ПР121847 раньше ПР121902, 1192-9 раньше 1192-10.
  const cmp = (x: number | string, y: number | string) =>
    typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "ru", { numeric: true, sensitivity: "base" });
  // Пустое (нет номера аутсорса) — внизу при любом направлении.
  const empty = (v: number | string | null) => v === null || v === "";
  // Срочные — всегда сверху: так же, как на доске.
  return (a, b) => {
    const x = val(a);
    const y = val(b);
    return (
      Number(b.isUrgent) - Number(a.isUrgent) ||
      Number(empty(x)) - Number(empty(y)) ||
      (empty(x) || empty(y) ? 0 : dir * cmp(x!, y!)) ||
      b.acceptedAt.localeCompare(a.acceptedAt)
    );
  };
}

/** Виды таблицы, где изменён один: остальные — как были. */
const replaceView = (table: TablePrefs, view: TableViewPrefs): TablePrefs => ({
  ...table,
  views: table.views.map((v) => (v.id === view.id ? view : v)),
});

const shortDate = (iso: string) => new Date(iso).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit" });

export function DashboardTable({
  rows,
  prefs,
  views,
  seesMoney,
  contacts,
  om,
  onPrefs,
  onShared,
  onReload,
}: {
  rows: TableRow[];
  prefs: DashboardPrefs;
  /** Действующие виды: свои → мастерской → стандартный (сервер, tableViews). */
  views: TablePrefs;
  /** Видит ли человек деньги заказов: суммы и фильтр «С долгом». */
  seesMoney: boolean;
  /** Видит ли контакты клиентов. */
  contacts: boolean;
  om: Om;
  onPrefs: (next: DashboardPrefs) => void;
  /** «Сделать так у всех» прошло — перечитать. */
  onShared: () => void;
  /** Перечитать строки (после ярлыка). */
  onReload: () => unknown;
}) {
  const navigate = useNavigate();
  // Заказ, открытый из таблицы, ведёт «‹ К сводке» — с теми же фильтрами и видом.
  const location = useLocation();
  const back = backState(location.pathname, location.search);
  const { can, me } = useAuth();
  const myId = me?.kind === "tenant" ? me.user.id : null;
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const [shown, setShown] = useState(PAGE);
  const [config, setConfig] = useState(false);
  const [exporting, setExporting] = useState(false);
  // Ширина места под таблицу — столбцы подстраиваются под окно.
  const [wrapEl, setWrapEl] = useState<HTMLDivElement | null>(null);
  const [avail, setAvail] = useState(0);
  // Столбец, который сейчас тянут за край заголовка.
  const [live, setLive] = useState<{ k: string; px: number } | null>(null);
  const scaleRef = useRef(1);

  useEffect(() => {
    if (!wrapEl) return;
    const measure = () => setAvail(wrapEl.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrapEl);
    return () => ro.disconnect();
  }, [wrapEl]);

  // Свои виды — из настроек, что уже на экране (правка видна сразу, до
  // ответа сервера); нет своих — мастерской или стандартный.
  const eff = prefs.table ?? views;
  const list = eff.views.length ? eff.views : [DEFAULT_VIEW];
  const activeId = params.get("v") ?? eff.active ?? list[0].id;
  const view = list.find((v) => v.id === activeId) ?? list[0];
  const dense = !!view.dense;
  const sort = view.sort ?? "-created";
  const labelDefs = om.reference?.labels ?? [];

  const allowed = (c: ColSpec | undefined) => !!c && (!c.money || seesMoney) && (!c.contacts || contacts);
  const cols = view.cols.filter((c) => allowed(COL.get(c.k)));

  // «Выданы» (28.10.2026) — срок общий с панелью «Выдано» на доске.
  const issuedDays = prefs.panels.ISSUED?.days ?? ISSUED_DAYS_DEFAULT;
  const daysText = (d: number) => (d === 1 ? "сутки" : `${d} дн.`);
  const quickList: Quick[] = [
    ...QUICK.filter((x) => !x.money || seesMoney),
    {
      key: "issued",
      label: `Выданы · ${daysText(issuedDays)}`,
      hint: "Отданы клиенту за выбранный срок",
      test: (r: TableRow) => !!r.issuedAt && Date.now() - new Date(r.issuedAt).getTime() <= issuedDays * 86_400_000,
      calm: true,
    },
    // Ярлыки с галочкой «кнопкой в быстрых фильтрах» — рядом с остальными.
    ...labelDefs
      .filter((l) => l.quickFilter)
      .map((l) => ({
        key: `label:${l.id}`,
        label: l.name,
        hint: `С ярлыком «${l.name}»`,
        test: (r: TableRow) => isActive(r) && !!r.labels?.some((m) => m.id === l.id),
        dot: { icon: l.icon, color: l.color },
      })),
  ];
  const quick = quickList.find((x) => x.key === params.get("f"))?.key ?? "all";
  const statusId = params.get("st");

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

  useEffect(() => setShown(PAGE), [quick, statusId, q, view.id]);

  const words = useMemo(
    () =>
      q
        .toLocaleLowerCase("ru-RU")
        .split(/\s+/)
        .filter(Boolean),
    [q]
  );
  const found = useMemo(() => (words.length ? rows.filter((r) => matches(r, words)) : rows), [rows, words]);

  // «Аутсорс ▾»: компании — из заказов в работе; числа — с учётом поиска.
  const outOptions = useMemo<OutsourceOption[]>(() => {
    const live = found.filter(isActive);
    const by = new Map<string, OutsourceOption>();
    let named = 0;
    for (const r of live) {
      if (!r.outsourcer) continue;
      const o = by.get(r.outsourcer.id) ?? { key: r.outsourcer.id, label: r.outsourcer.name ?? "", count: 0 };
      o.count += 1;
      if (r.outsourcer.name) named += 1;
      by.set(r.outsourcer.id, o);
    }
    const any = [...by.values()].reduce((n, o) => n + o.count, 0);
    // Без права видеть клиентов имён нет — тогда только «аутсорс / без».
    const companies = named ? [...by.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "ru")) : [];
    return [
      { key: "", label: "Все заказы", count: live.length },
      { key: "any", label: "Только аутсорс", count: any },
      ...companies,
      { key: "none", label: "Без аутсорса", count: live.length - any },
    ];
  }, [found]);
  const out = view.out && outOptions.some((o) => o.key === view.out) ? view.out : "";
  const hasOutsource = (outOptions[1]?.count ?? 0) > 0 || !!out;
  // «Тип заказа ▾»: платные / гарантийные (27.10.2026) — показываем, когда
  // гарантийные вообще бывают или фильтр уже выбран.
  const okind = view.okind === "paid" || view.okind === "warranty" ? view.okind : "";
  const kindOptions = useMemo<OutsourceOption[]>(() => {
    const live = found.filter(isActive);
    const warranty = live.filter((r) => isWarrantyKind(r.kind)).length;
    return [
      { key: "", label: "Все заказы", count: live.length },
      { key: "paid", label: "Платные", count: live.length - warranty },
      { key: "warranty", label: "Гарантийные", count: warranty },
    ];
  }, [found]);
  const hasKinds = kindOptions[2].count > 0 || !!okind;
  const searched = useMemo(
    () =>
      found.filter(
        (r) =>
          (!out || (out === "any" ? !!r.outsourcer : out === "none" ? !r.outsourcer : r.outsourcer?.id === out)) &&
          (!okind || (okind === "warranty") === isWarrantyKind(r.kind))
      ),
    [found, out, okind]
  );
  const counts = new Map(quickList.map((x) => [x.key, searched.filter(x.test).length]));
  const quickTest = quickList.find((x) => x.key === quick)!.test;
  const byQuick = useMemo(() => searched.filter(quickTest), [searched, quickTest]);

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
    const l = statusId ? byQuick.filter((r) => r.status.id === statusId) : byQuick;
    return [...l].sort(sorter(sort));
  }, [byQuick, statusId, sort]);
  const page = filtered.slice(0, shown);

  /** Изменить вид и сохранить. Свои виды заводятся с первой правки. */
  const saveView = (next: TableViewPrefs, extra: Partial<TablePrefs> = {}) =>
    onPrefs({ ...prefs, table: { ...replaceView({ views: list, active: eff.active }, next), ...extra } });

  const sortBy = (key: string) => {
    // Первый щелчок — по убыванию (новые, большие сверху), второй — наоборот.
    saveView({ ...view, sort: sort === `-${key}` ? key : `-${key}` });
  };

  const switchView = (id: string) => {
    setParam("v", id === list[0].id ? null : id);
    onPrefs({ ...prefs, table: { views: list, active: id } });
  };

  const addView = () => {
    const id = `v${Date.now().toString(36).slice(-6)}`;
    const copy: TableViewPrefs = { ...view, id, name: `Вид ${list.length + 1}`, cols: view.cols.map((c) => ({ ...c })) };
    onPrefs({ ...prefs, table: { views: [...list, copy], active: id } });
    setParam("v", id);
    setConfig(true);
  };

  const pick = (r: TableRow, s: OrderStatus) => void om.changeStatus(menuOf(r), s);

  const open = (e: React.MouseEvent, r: TableRow) => {
    // Выделяли текст, чтобы скопировать, — это не щелчок по строке.
    if (window.getSelection()?.toString()) return;
    if ((e.target as Element).closest("a,button,input,[role=menu]")) return;
    if (e.ctrlKey || e.metaKey) window.open(`/orders/${r.id}`, "_blank");
    else navigate(`/orders/${r.id}`, { state: back });
  };

  const pad = dense ? "py-1.5" : "py-2.5";

  /** Ячейка. Особый вид — у части столбцов; остальное — текстом с «Копировать». */
  const cell = (k: string, r: TableRow, wrap: boolean) => {
    const clamp = wrap ? "line-clamp-2 [overflow-wrap:anywhere]" : "block truncate";
    switch (k) {
      case "number": {
        // Гарантийный заказ — подписью под номером (27.10.2026): видно сразу,
        // даже если столбца «Тип обращения» в виде нет.
        const kb = isWarrantyKind(r.kind) ? kindBadge(r.kind, r.device?.brand) : null;
        return (
          <>
            <Link to={`/orders/${r.id}`} state={back} className="whitespace-nowrap font-mono text-[13px] font-bold hover:underline" {...copyable("order", r.number)}>
              {r.number}
              {r.isUrgent && (
                <span title="Срочный" className="ml-1 inline-block align-[-2px] text-state-off">
                  <IconUrgent className="h-3.5 w-3.5" />
                </span>
              )}
            </Link>
            {kb && (
              <span
                title={kb.title}
                data-row-kind={r.kind}
                className={"block truncate text-[11.5px] font-semibold " + (kb.tone === "factory" ? "text-[rgb(var(--tag-factory))]" : "text-[rgb(var(--tag-warranty))]")}
              >
                {kb.label}
              </span>
            )}
          </>
        );
      }
      case "created":
        return (
          <span className="whitespace-nowrap text-ink-muted" {...copyable("text", formatDate(r.acceptedAt), "дату приёма")}>
            {shortDate(r.acceptedAt)}
          </span>
        );
      case "urgent":
        return r.isUrgent ? <span className="tag tag-urgent px-2 py-[1px] text-[11px]">срочный</span> : null;
      case "device":
        return (
          <span className="line-clamp-2 font-semibold [overflow-wrap:anywhere]" title={deviceLine(r)} {...copyable("device", deviceText(r.device) || deviceLine(r))}>
            {deviceLine(r)}
          </span>
        );
      case "serial":
      case "passcode": {
        const v = k === "serial" ? r.device?.serial : r.passcode;
        return v ? (
          <span className="block truncate font-mono text-[12.5px] text-ink-soft" {...copyable(k === "serial" ? "serial" : "text", v, k === "serial" ? undefined : "пароль")}>
            {v}
          </span>
        ) : (
          <Dash />
        );
      }
      case "status":
        return (
          <StatusPicker order={r} statuses={om.reference?.statuses} canChange={om.canStatus(menuOf(r))} onPick={(s) => pick(r, s)} className="max-w-full" />
        );
      case "since": {
        if (!isActive(r)) return <Dash />;
        const d = days(r.statusSince);
        return (
          <span className={isStale(r) ? "font-semibold text-state-off" : "text-ink-muted"} title={`В статусе с ${formatDate(r.statusSince)}`}>
            {d === 0 ? "сегодня" : `${d} дн.`}
          </span>
        );
      }
      case "age":
        return <span className="text-ink-muted">{plural(days(r.acceptedAt), "день", "дня", "дней")}</span>;
      case "labels":
        return (
          <OrderLabels
            order={r}
            defs={labelDefs}
            canEdit={isActive(r) && canLabel(can, myId, r.master?.id)}
            onChanged={onReload}
          />
        );
      case "customer":
        return (
          <span className="block min-w-0">
            {r.customer.name ? (
              <span className={clamp} style={nameStyle(r.customer.color)} title={r.customer.name} {...copyable("name", r.customer.name)}>
                {r.customer.name}
              </span>
            ) : (
              <Dash />
            )}
            {r.customer.phone && (
              <a href={`tel:${r.customer.phone}`} className="block truncate text-[12.5px] text-brand-ink hover:underline" {...copyable("phone", r.customer.phone)}>
                {r.customer.phone}
              </a>
            )}
          </span>
        );
      case "cname":
        return r.customer.name ? (
          <span className={clamp} style={nameStyle(r.customer.color)} title={r.customer.name} {...copyable("name", r.customer.name)}>
            {r.customer.name}
          </span>
        ) : (
          <Dash />
        );
      case "phone":
      case "phone2": {
        const v = k === "phone" ? r.customer.phone : r.customer.phone2;
        return v ? (
          <a href={`tel:${v}`} className="block truncate text-brand-ink hover:underline" {...copyable("phone", v)}>
            {v}
          </a>
        ) : (
          <Dash />
        );
      }
      case "complaint":
        return (
          <span className="block min-w-0">
            <span className={wrap ? clamp : "line-clamp-2 [overflow-wrap:anywhere]"} title={r.complaint} {...copyable("text", r.complaint, "неисправность")}>
              {r.complaint || <Dash />}
            </span>
            {r.completeness.length > 0 && !view.cols.some((c) => c.k === "completeness") && (
              <span className="block truncate text-[12px] text-ink-dim" {...copyable("text", r.completeness.join(", "), "комплектность")}>
                {r.completeness.join(", ")}
              </span>
            )}
          </span>
        );
      case "master":
        return om.canAssign && isActive(r) ? (
          <MasterPicker
            number={r.number}
            master={r.master}
            masters={om.reference?.masters}
            canChange
            onPick={(m) => void om.changeMaster(menuOf(r), m, r.master)}
          />
        ) : r.master ? (
          <span className="block truncate" title={r.master.fullName} {...copyable("text", r.master.fullName, "мастера")}>
            {shortName(r.master.fullName)}
          </span>
        ) : (
          <Dash />
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
              <Dash />
            )}
            {(r.debt ?? 0) > 0 && (
              <span className="tag tag-debt ml-auto mt-0.5 block w-fit px-2 py-[1px] text-[11px]" {...copyable("text", money(r.debt), "долг")}>
                долг {money(r.debt)}
              </span>
            )}
          </span>
        );
    }
    const spec = COL.get(k);
    if (!spec) return null;
    const v = spec.text(r);
    if (v === null || v === "") return <Dash />;
    const shownText = spec.group === "Деньги" && typeof v === "number" ? money(v) : String(v);
    return (
      <span className={clamp + (spec.group === "Деньги" ? " tabular-nums" : "")} title={shownText} {...copyable("text", shownText, spec.what ?? spec.label.toLowerCase())}>
        {shownText}
      </span>
    );
  };

  async function exportExcel() {
    setExporting(true);
    try {
      await summaryApi.exportTable({
        name: view.name,
        columns: cols
          .filter((c) => c.k !== "labels")
          .map((c) => ({ title: COL.get(c.k)!.label, width: Math.round((c.px ?? (colFlex(c.k, c.w) ? 240 : colPx(c.k, c.w))) / 7) })),
        rows: filtered.slice(0, 5000).map((r) =>
          cols
            .filter((c) => c.k !== "labels")
            .map((c) => {
              const v = COL.get(c.k)!.text(r);
              return v === null || v === undefined ? null : v;
            })
        ),
      });
    } catch {
      /* подсказка о сбое — внизу */
      om.say({ text: "Не удалось выгрузить таблицу", tone: "error" });
    } finally {
      setExporting(false);
    }
  }

  const totals = view.totals
    ? new Map(
        cols
          .filter((c) => COL.get(c.k)?.sum)
          .map((c) => [c.k, filtered.reduce((n, r) => n + (Number(COL.get(c.k)!.text(r)) || 0), 0)])
      )
    : null;

  const nothing = rows.length === 0;
  const layout = layoutCols(cols, avail, live);
  scaleRef.current = layout.scale;

  /** Потянули за край заголовка — своя ширина столбца. */
  function startResize(e: React.PointerEvent<HTMLSpanElement>, k: string, edge: number) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget;
    const th = handle.parentElement as HTMLElement;
    const start = th.getBoundingClientRect().width - edge;
    const x0 = e.clientX;
    let px = Math.round(start);
    let moved = false;
    handle.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      px = Math.round(Math.min(MAX_PX, Math.max(MIN_PX, start + ev.clientX - x0)));
      moved = moved || Math.abs(ev.clientX - x0) > 2;
      if (moved) setLive({ k, px });
    };
    const done = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", done);
      handle.removeEventListener("pointercancel", done);
      if (moved) {
        // Окно узкое и столбцы сжаты — запоминаем ширину «без сжатия», чтобы
        // на этом экране она осталась такой, как дотянули.
        const want = Math.round(Math.min(MAX_PX, Math.max(MIN_PX, px / (scaleRef.current < 1 ? scaleRef.current : 1))));
        saveView({ ...view, cols: view.cols.map((c) => (c.k === k ? { ...c, px: want } : c)) });
      }
      setLive(null);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", done);
    handle.addEventListener("pointercancel", done);
  }

  /** Двойной щелчок по краю — ширина как была (узкий/средний/широкий). */
  const resetWidth = (k: string) =>
    saveView({ ...view, cols: view.cols.map((c) => (c.k === k ? { k: c.k, ...(c.w ? { w: c.w } : {}), ...(c.wrap ? { wrap: true } : {}) } : c)) });

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
        <Button variant="secondary" onClick={() => setConfig(true)} data-table-columns className="hidden whitespace-nowrap md:inline-flex">
          <ColumnsIcon />
          Настроить
        </Button>
        {can("orders.create") && (
          <Button icon={<IconPlus />} onClick={() => navigate("/orders/new")} className="hidden whitespace-nowrap sm:inline-flex">
            Принять технику
          </Button>
        )}
      </div>

      {/* Виды — вкладками: у каждого свои столбцы, порядок и «Итого». */}
      {(
        <div className="-mx-4 flex items-center gap-1.5 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0" data-table-views>
          {list.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => switchView(v.id)}
              onDoubleClick={() => setConfig(true)}
              aria-pressed={v.id === view.id}
              data-table-view={v.name}
              className={
                "inline-flex min-h-[34px] shrink-0 items-center whitespace-nowrap rounded-field border px-3.5 text-[13.5px] font-semibold transition-colors duration-150 " +
                (v.id === view.id ? "border-line bg-surface text-ink" : "border-transparent text-ink-muted hover:text-ink")
              }
            >
              {v.name}
            </button>
          ))}
          <button
            type="button"
            onClick={addView}
            data-table-view-add
            className="hidden min-h-[34px] shrink-0 items-center whitespace-nowrap rounded-field px-3 text-[13px] font-semibold text-brand-ink hover:underline md:inline-flex"
            disabled={list.length >= 8}
          >
            + Новый вид
          </button>
        </div>
      )}

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
                (x.dot ? "pl-1.5 " : "") +
                (on ? "border-brand bg-brand-tint text-brand-ink" : "border-line bg-surface hover:border-line-strong")
              }
            >
              {x.dot && <LabelDot icon={x.dot.icon} color={x.dot.color} />}
              {x.label}
              <span
                className={
                  "rounded-pill px-1.5 py-[1px] font-mono text-[11.5px] " +
                  (x.key !== "all" && !x.calm && n > 0 ? "bg-state-off/15 text-state-off" : "bg-surface-raised text-ink-muted")
                }
              >
                {n}
              </span>
            </button>
          );
        })}
        {quick === "issued" && (
          <span className="inline-flex shrink-0 items-center gap-0.5 rounded-pill border border-line bg-surface p-0.5" data-issued-days role="radiogroup" aria-label="За какой срок">
            {ISSUED_DAYS.map((d) => (
              <button
                key={d}
                type="button"
                role="radio"
                aria-checked={issuedDays === d}
                data-days={d}
                onClick={() => onPrefs(withPanel(prefs, "ISSUED", { ...prefs.panels.ISSUED, days: d === ISSUED_DAYS_DEFAULT ? undefined : d }))}
                className={
                  "min-h-[30px] rounded-pill px-2.5 text-[12.5px] font-semibold transition-colors " +
                  (issuedDays === d ? "bg-brand-tint text-brand-ink" : "text-ink-muted hover:text-ink")
                }
              >
                {d === 1 ? "Сутки" : `${d} дней`}
              </button>
            ))}
          </span>
        )}
      </div>

      {(statusChips.length > 0 || hasOutsource || hasKinds) && (
        <div className="-mx-4 flex items-center gap-1.5 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0" data-status-chips>
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
          {(hasOutsource || hasKinds) && (
            <span className="ml-auto flex gap-1.5 pl-2">
              {hasKinds && (
                <OutsourceFilter id="okind" title="Тип" value={okind} options={kindOptions} onChange={(key) => saveView({ ...view, okind: key === "paid" || key === "warranty" ? key : undefined })} />
              )}
              {hasOutsource && (
                <OutsourceFilter value={out} options={outOptions} onChange={(key) => saveView({ ...view, out: key || undefined })} />
              )}
            </span>
          )}
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
            <div className="overflow-x-auto" ref={setWrapEl}>
              <table
                className={"table-fixed border-collapse " + (layout.table ? "" : "w-full ") + (dense ? "text-[13px]" : "text-[13.5px]") + (live ? " select-none" : "")}
                style={layout.table ? { width: layout.table } : undefined}
                data-table
              >
                <colgroup>
                  {cols.map((c, i) => (
                    <col key={c.k} style={layout.widths[i] === null ? undefined : { width: layout.widths[i]! }} />
                  ))}
                </colgroup>
                <thead>
                  <tr className="group/head border-b border-line text-left text-[11px] font-bold uppercase tracking-[0.07em] text-ink-dim">
                    {cols.map((c, i) => {
                      const spec = COL.get(c.k)!;
                      const active = sort.replace(/^-/, "") === c.k;
                      const edge = i === cols.length - 1 ? 8 : 0;
                      return (
                        <th key={c.k} className={"relative truncate px-2 py-2.5 font-bold first:pl-4 last:pr-4 " + (spec.right ? "text-right" : "")} title={spec.label} data-th={c.k}>
                          {spec.sort ? (
                            <button
                              type="button"
                              onClick={() => sortBy(c.k)}
                              className={"inline-flex max-w-full items-center gap-1 uppercase tracking-[0.07em] hover:text-ink " + (active ? "text-ink" : "")}
                              data-sort={c.k}
                            >
                              <span className="truncate">{spec.head ?? spec.label}</span>
                              {active && <span aria-hidden>{sort.startsWith("-") ? "↓" : "↑"}</span>}
                            </button>
                          ) : (
                            spec.head ?? spec.label
                          )}
                          <span
                            role="separator"
                            aria-orientation="vertical"
                            aria-label={`Ширина столбца «${spec.label}»`}
                            title="Потяните, чтобы изменить ширину. Двойной щелчок — как было"
                            onPointerDown={(e) => startResize(e, c.k, edge + (i === 0 ? 8 : 0))}
                            onDoubleClick={() => resetWidth(c.k)}
                            onClick={(e) => e.stopPropagation()}
                            data-col-resize={c.k}
                            className={
                              "absolute right-0 top-0 z-[1] h-full w-2.5 cursor-col-resize touch-none select-none after:absolute after:right-[4px] after:top-1/4 after:h-1/2 after:w-[2px] after:rounded-full after:transition-colors " +
                              (live?.k === c.k ? "after:bg-brand" : "after:bg-transparent group-hover/head:after:bg-line-strong hover:after:!bg-brand")
                            }
                          />
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
                          "group cursor-pointer border-b border-line align-middle transition-colors duration-100 last:border-b-0 hover:bg-surface-raised/60 " +
                          (r.isUrgent ? "shadow-[inset_3px_0_0_0_rgb(var(--state-off))]" : "")
                        }
                      >
                        {cols.map((c) => (
                          <td
                            key={c.k}
                            className={`overflow-hidden px-2 ${pad} first:pl-4 last:pr-4 ` + (COL.get(c.k)!.right ? "text-right" : "")}
                            data-col={c.k}
                          >
                            {cell(c.k, r, !!c.wrap)}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
                {totals && (
                  <tfoot>
                    <tr className="border-t-2 border-line bg-surface-raised/40 font-semibold" data-table-totals>
                      {cols.map((c, i) => (
                        <td key={c.k} className={"px-2 py-2.5 first:pl-4 last:pr-4 " + (COL.get(c.k)!.right ? "text-right tabular-nums" : "")}>
                          {i === 0 ? `Итого: ${filtered.length}` : totals.has(c.k) ? moneyText(totals.get(c.k)) : ""}
                        </td>
                      ))}
                    </tr>
                  </tfoot>
                )}
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
              <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <button
                  type="button"
                  onClick={() => void exportExcel()}
                  disabled={exporting}
                  className="inline-flex items-center gap-1.5 font-semibold text-brand-ink hover:underline disabled:opacity-50 [&>svg]:h-4 [&>svg]:w-4"
                  data-table-export
                >
                  <IconDownload />
                  {exporting ? "Выгружаем…" : "В Excel"}
                </button>
                <span className="flex items-center gap-1.5">
                  Строки:
                  <button type="button" onClick={() => dense && saveView({ ...view, dense: false })} className={dense ? "hover:text-ink" : "font-bold text-ink"} data-density="normal">
                    обычные
                  </button>
                  ·
                  <button type="button" onClick={() => !dense && saveView({ ...view, dense: true })} className={dense ? "font-bold text-ink" : "hover:text-ink"} data-density="dense">
                    плотные
                  </button>
                </span>
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
                  className={"cursor-pointer rounded-card border border-line bg-surface p-3.5 " + (r.isUrgent ? "shadow-[inset_3px_0_0_0_rgb(var(--state-off))]" : "")}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="flex min-w-0 items-center gap-2">
                      <Link to={`/orders/${r.id}`} state={back} className="font-mono text-[14px] font-bold">
                        {r.number}
                        {r.isUrgent && (
                          <span title="Срочный" className="ml-1 inline-block align-[-2px] text-state-off">
                            <IconUrgent className="h-3.5 w-3.5" />
                          </span>
                        )}
                      </Link>
                      <OrderLabels order={r} defs={labelDefs} canEdit={false} />
                      <KindBadge kind={r.kind} brand={r.device?.brand} />
                    </span>
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

      {config && (
        <TableConfigurator
          view={view}
          views={list}
          seesMoney={seesMoney}
          contacts={contacts}
          canShare={can("settings.manage")}
          onChange={(v) => saveView(v)}
          onDelete={() => {
            const rest = list.filter((v) => v.id !== view.id);
            onPrefs({ ...prefs, table: { views: rest, active: rest[0].id } });
            setParam("v", null);
            setConfig(false);
          }}
          onShare={async () => {
            await summaryApi.shareTable({ views: list, active: view.id });
            onShared();
          }}
          onClose={() => setConfig(false)}
        />
      )}
    </div>
  );
}

function Dash() {
  return <span className="text-ink-dim">—</span>;
}

function DueCell({ r }: { r: TableRow }) {
  if (r.issuedAt) {
    return (
      <span className="whitespace-nowrap text-ink-muted" {...copyable("text", formatDate(r.issuedAt), "дату выдачи")}>
        выдан {shortDate(r.issuedAt)}
      </span>
    );
  }
  if (r.status.group === "DONE") {
    const idle = readyIdle(r);
    return (
      <span
        className={"whitespace-nowrap " + (idle ? "font-semibold text-state-waiting" : "text-ink-muted")}
        {...copyable("text", formatDate(r.completedAt ?? r.statusSince), "дату готовности")}
      >
        готов {shortDate(r.completedAt ?? r.statusSince)}
      </span>
    );
  }
  const due = dueLabel(r.dueAt);
  if (!due) return <Dash />;
  return (
    <span
      className={"whitespace-nowrap " + (due.overdue ? "font-semibold text-state-off" : due.soon ? "font-semibold text-state-waiting" : "text-ink-muted")}
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

export function ColumnsIcon() {
  return (
    <svg aria-hidden viewBox="0 0 20 20" className="h-[17px] w-[17px]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
      <rect x="3" y="4" width="14" height="12" rx="2" />
      <path d="M8 4v12M12.5 4v12" />
    </svg>
  );
}
