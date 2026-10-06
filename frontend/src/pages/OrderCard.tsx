import { useCallback, useEffect, useRef, useState } from "react";
import { copyable } from "../components/CopyMenu";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { PrintDialog } from "../components/PrintDialog";
import { LabelDialog } from "../components/LabelDialog";
import { OrderSms, SmsModal } from "../components/OrderSms";
import type { ReadyHint } from "../lib/sms";
import { printingApi } from "../lib/printing";
import { IconCamera, IconFolder, IconPlus, IconSearch } from "../components/icons";
import { useOrderFolder } from "../components/OrderFolder";
import { PartsSearch, type PickedOffer } from "../components/PartsSearch";
import { PhotoShooter } from "../components/PhotoShooter";
import { PhotoViewer } from "../components/PhotoViewer";
import { Photo } from "../components/OrderPhoto";
import { DeviceHistory } from "../components/DeviceHistory";
import { OrderChat } from "../components/OrderChat";
import { OrderEditModal } from "../components/OrderEditModal";
import { Modal } from "../components/Modal";
import { ROUTER_BASE } from "../lib/basePath";
import {
  Banner,
  Button,
  Card,
  Field,
  Input,
  SectionLabel,
  Select,
  Spinner,
  StatusPill,
  DebtBadge,
  Textarea,
  GrowText,
} from "../components/ui";
import { ApiError } from "../lib/api";
import { PayDebtButton } from "../components/DebtPanel";
import { useAuth } from "../lib/auth";
import { formatDate, formatDateTime } from "../lib/format";
import { customerColor, nameStyle } from "../lib/customerColor";
import {
  masterLabel,
  money,
  ORDER_KIND_LABEL,
  ordersApi,
  PART_SOURCE_LABEL,
  statusPill,
  type Order,
  type OrderPart,
  type OrderWork,
  type Reference,
} from "../lib/orders";
import { matchServices, PINNED_LIMIT, type Service } from "../lib/services";
import { IssueDialog } from "../components/IssueDialog";
import { PAYMENT_LABEL } from "../lib/debt";

function Rows({ items }: { items: Array<{ label: string; value: React.ReactNode }> }) {
  return (
    <dl className="space-y-2 text-[14px]">
      {items.map((r) => (
        <div key={r.label} className="flex gap-3">
          <dt className="w-[150px] shrink-0 text-ink-muted">{r.label}</dt>
          <dd className="min-w-0 flex-1">{r.value ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

function Checklist({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <p className="text-[13px] font-semibold text-ink-muted">{title}</p>
      {items.length === 0 ? (
        <p className="mt-1 text-[13.5px] text-ink-dim">ничего не отмечено</p>
      ) : (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {items.map((label) => (
            <span key={label} className="rounded-pill bg-surface-raised px-2.5 py-1 text-[12.5px] text-ink-soft">
              {label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Редактор строк работ или запчастей: одна и та же таблица с разным набором колонок. */
/**
 * Поле названия с подсказками из прайса.
 *
 * Подсказка не обязывает: мастер волен дописать что угодно своими словами,
 * список просто избавляет от набора одного и того же по двадцать раз в
 * неделю. Выбор подставляет и цену — иначе половина смысла прайса теряется.
 */
function ServiceNameInput({
  value,
  onChange,
  onPick,
  services,
}: {
  value: string;
  onChange: (name: string) => void;
  onPick: (service: Service) => void;
  services: Service[];
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);

  const hits = matchServices(services, value);
  const show = open && hits.length > 0;

  function pick(service: Service) {
    onPick(service);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape") return setOpen(false);
    if (!show) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => (h + 1) % hits.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => (h - 1 + hits.length) % hits.length);
    } else if (e.key === "Enter") {
      // Перехватываем Enter только когда список открыт: иначе отберём
      // у формы обычное подтверждение.
      e.preventDefault();
      pick(hits[highlight] ?? hits[0]);
    }
  }

  return (
    <div className="relative">
      <GrowText
        value={value}
        placeholder="Наименование"
        autoComplete="off"
        aria-label="Наименование"
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setHighlight(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {show && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 overflow-hidden rounded-field border border-line bg-surface-raised shadow-modal">
          {hits.map((s, i) => (
            <button
              key={s.id}
              type="button"
              // onMouseDown вместо onClick: клик по подсказке иначе сначала
              // снимает фокус с поля, список закрывается, и выбор не доходит.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(s);
              }}
              onMouseEnter={() => setHighlight(i)}
              className={
                "flex w-full items-center gap-3 border-b border-line px-3 py-2 text-left text-[13.5px] last:border-b-0 " +
                (i === highlight ? "bg-surface-hover text-ink" : "text-ink-soft")
              }
            >
              <span className="min-w-0 flex-1 truncate">{s.name}</span>
              <span className="shrink-0 font-semibold text-ink-muted">{money(s.price)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function LineEditor<T extends OrderWork>({
  title,
  rows,
  setRows,
  empty,
  extraColumn,
  services,
  actions,
}: {
  title: string;
  rows: T[];
  setRows: (next: T[]) => void;
  empty: T;
  extraColumn?: (row: T, update: (patch: Partial<T>) => void) => React.ReactNode;
  /** Кнопки рядом с «Добавить строку» (у запчастей — поиск у поставщиков). */
  actions?: React.ReactNode;
  /** Прайс для подсказок. Не передан — поле обычное, как было. */
  services?: Service[];
}) {
  const update = (i: number, patch: Partial<T>) =>
    setRows(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const addService = (s: Service) =>
    setRows([...rows, { ...empty, name: s.name, qty: 1, price: s.price }]);

  const pinned = (services ?? []).filter((s) => s.isPinned).slice(0, PINNED_LIMIT);

  const total = rows.reduce((acc, r) => acc + (Number(r.qty) || 0) * (Number(r.price) || 0), 0);

  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <SectionLabel>{title}</SectionLabel>
        <span className="text-[13px] font-semibold text-ink-soft">{money(total)}</span>
      </div>

      <div className="mt-4 space-y-2">
        {rows.map((row, i) => (
          // items-start: длинное название растёт вниз, количество и цена остаются у первой строки.
          <div key={i} data-line className="grid gap-2 sm:grid-cols-[1fr_78px_110px_auto] sm:items-start">
            {services ? (
              <ServiceNameInput
                value={row.name}
                services={services}
                onChange={(name) => update(i, { name } as Partial<T>)}
                onPick={(s) => update(i, { name: s.name, price: s.price } as Partial<T>)}
              />
            ) : (
              <GrowText
                value={row.name}
                placeholder="Наименование"
                aria-label="Наименование"
                onChange={(e) => update(i, { name: e.target.value } as Partial<T>)}
              />
            )}
            <Input
              inputMode="decimal"
              aria-label="Количество"
              value={String(row.qty)}
              onChange={(e) => update(i, { qty: Number(e.target.value.replace(",", ".")) || 0 } as Partial<T>)}
            />
            <Input
              inputMode="decimal"
              aria-label="Цена"
              value={String(row.price)}
              onChange={(e) => update(i, { price: Number(e.target.value.replace(",", ".")) || 0 } as Partial<T>)}
            />
            <div className="flex items-center gap-2">
              {extraColumn?.(row, (patch) => update(i, patch))}
              <Button
                type="button"
                variant="ghost"
                className="min-h-[42px] px-3"
                onClick={() => setRows(rows.filter((_, idx) => idx !== i))}
              >
                Убрать
              </Button>
            </div>
          </div>
        ))}
        {rows.length === 0 && <p className="text-[13.5px] text-ink-dim">Пока ничего не добавлено.</p>}
      </div>

      {/* Частое — рядом с «Добавить строку»: это тот же жест, только сразу
          с названием и ценой. Список задаётся в настройках, в разделе услуг. */}
      {pinned.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[12.5px] text-ink-dim">Частое:</span>
          {pinned.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => addService(s)}
              title={`Добавить: ${s.name} — ${money(s.price)}`}
              className="rounded-pill border border-line bg-surface-raised px-3 py-1.5 text-[13px] font-semibold text-ink-soft transition-colors duration-150 hover:border-line-strong hover:text-ink"
            >
              {s.name}
              <span className="ml-1.5 font-normal text-ink-dim">{money(s.price)}</span>
            </button>
          ))}
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <Button type="button" variant="secondary" icon={<IconPlus />} onClick={() => setRows([...rows, { ...empty }])}>
          Добавить строку
        </Button>
        {actions}
      </div>
    </Card>
  );
}

type Finish = { diagnosis: string; masterComment: string; recommendation: string; warrantyDays: string };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Пустая строка, которую добавили и не заполнили, — не ошибка, её просто не сохраняем. */
const filled = <T extends OrderWork>(rows: T[]) => rows.filter((r) => r.name.trim() || Number(r.price) > 0);

export default function OrderCard() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { can, me } = useAuth();
  const [order, setOrder] = useState<Order | null>(null);
  const [ref, setRef] = useState<Reference | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [works, setWorks] = useState<OrderWork[]>([]);
  const [parts, setParts] = useState<OrderPart[]>([]);
  /** Окно поиска у поставщиков: что искать и какую строку заполнить найденным (-1 — новая). */
  const [suppliers, setSuppliers] = useState<{ q: string; row: number } | null>(null);
  const folder = useOrderFolder();
  const [finish, setFinish] = useState<Finish>({ diagnosis: "", masterComment: "", recommendation: "", warrantyDays: "" });
  const [returnReason, setReturnReason] = useState<string | null>(null);
  const [issuing, setIssuing] = useState(false);
  /** null — блок удаления свёрнут, строка — набранная причина. */
  const [deleteReason, setDeleteReason] = useState<string | null>(null);
  const [shooting, setShooting] = useState(false);
  /** Какой снимок открыт в просмотре: номер в общем списке. */
  const [viewing, setViewing] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  /** Предупреждение после действия (например, «Готов» без диагноза). */
  const [warn, setWarn] = useState<string | null>(null);
  // Пришли из поиска по заказам — в адресе номер найденной записи истории.
  const [params] = useSearchParams();
  const found = params.get("found");

  /**
   * Что сейчас записано на сервере — от этого считается «есть несохранённое».
   * Перечитали заказ (сменили статус, добавили фото) — правки, которые человек
   * ещё не сохранил, остаются на месте; подтягивается только то, что он не трогал.
   */
  const base = useRef<{ works: OrderWork[]; parts: OrderPart[]; finish: Finish } | null>(null);
  const adopt = useRef(false);
  const load = useCallback(async () => {
    try {
      const o = await ordersApi.get(id);
      setOrder(o);
      const next = {
        works: o.works.map((w) => ({ name: w.name, qty: w.qty, price: w.price, masterId: w.masterId ?? null })),
        parts: o.parts.map((p) => ({ name: p.name, qty: p.qty, price: p.price, source: p.source })),
        finish: {
          diagnosis: o.diagnosis ?? "",
          masterComment: o.masterComment ?? "",
          recommendation: o.recommendation ?? "",
          warrantyDays: o.warrantyDays ? String(o.warrantyDays) : "",
        },
      };
      // Только что сохранили — берём то, что записал сервер (он подрезает пробелы и т. п.).
      const prev = adopt.current ? null : base.current;
      adopt.current = false;
      base.current = next;
      setWorks((cur) => (!prev || same(cur, prev.works) ? next.works : cur));
      setParts((cur) => (!prev || same(cur, prev.parts) ? next.parts : cur));
      setFinish((cur) => (!prev || same(cur, prev.finish) ? next.finish : cur));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось загрузить заказ");
    }
  }, [id]);

  useEffect(() => {
    void load();
    ordersApi.reference().then(setRef).catch(() => undefined);
  }, [load]);

  // Из оповещения «Сообщение в истории ремонта» — сразу к ленте.
  const loaded = !!order;
  useEffect(() => {
    if (!loaded || window.location.hash !== "#history") return;
    const t = setTimeout(() => document.getElementById("history")?.scrollIntoView({ behavior: "smooth" }), 300);
    return () => clearTimeout(t);
  }, [loaded]);

  // Печать бланка: окно «на принтер / открыть для печати».
  const [printing, setPrinting] = useState<{ doc: "intake" | "act"; afterIntake?: boolean; auto?: boolean } | null>(null);
  // Наклейки: окно сейчас и окно «после квитанции» — после приёма они идут друг за другом.
  const [labelling, setLabelling] = useState<{ afterIntake?: boolean; auto?: boolean } | null>(null);
  const labelsNext = useRef<{ afterIntake: boolean; auto: boolean } | null>(null);

  // Только что приняли — предложить квитанцию (или сразу напечатать, как
  // настроил сотрудник в «Периферии»). Метка в истории браузера снимается,
  // чтобы обновление страницы не предлагало печать второй раз.
  const location = useLocation();
  const justAccepted = !!(location.state as { printOffer?: boolean } | null)?.printOffer;
  useEffect(() => {
    if (!justAccepted) return;
    navigate(location.pathname + location.search, { replace: true, state: null });
    printingApi
      .overview()
      .then((p) => {
        const labels = p.labels?.intake && p.labels.intake !== "off" ? { afterIntake: true, auto: p.labels.intake === "auto" } : null;
        if (p.intake === "off") {
          if (labels) setLabelling(labels);
          return;
        }
        labelsNext.current = labels;
        setPrinting({ doc: "intake", afterIntake: true, auto: p.intake === "auto" });
      })
      .catch(() => setPrinting({ doc: "intake", afterIntake: true }));
  }, [justAccepted]); // eslint-disable-line react-hooks/exhaustive-deps

  // SMS клиенту: окно-предложение после «Готов к выдаче» и номер версии
  // карточки «SMS клиенту», чтобы она перечитала список после отправки.
  const [smsOffer, setSmsOffer] = useState(false);
  const [smsVersion, setSmsVersion] = useState(0);

  async function run(action: () => Promise<unknown>, message: string) {
    setSaving(true);
    setError(null);
    try {
      const result = await action();
      await load();
      // «Готов» без диагноза: сервер не мешает, но предупреждает.
      const warning = (result as { warn?: string } | undefined)?.warn;
      if (warning) {
        setWarn(warning);
        setTimeout(() => setWarn(null), 9000);
      }
      // Заказ стал «Готов к выдаче»: сервер подсказывает, что делать с SMS клиенту.
      const sms = (result as { sms?: ReadyHint } | undefined)?.sms;
      if (sms && "offer" in sms) setSmsOffer(true);
      if (sms && "auto" in sms) {
        message += " · SMS клиенту отправляется";
        setTimeout(() => setSmsVersion((v) => v + 1), 2500);
      }
      setNotice(message);
      setTimeout(() => setNotice(null), 4000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не получилось");
    } finally {
      setSaving(false);
    }
  }

  // ---------------------------------------------------------------- одна кнопка «Сохранить»

  const b = base.current;
  const dirtyWorks = !!b && !same(filled(works), b.works);
  const dirtyParts = !!b && !same(filled(parts), b.parts);
  const dirtyFinish = !!b && !same(finish, b.finish);
  const dirty = dirtyWorks || dirtyParts || dirtyFinish;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  /** Записать всё изменённое: работы, запчасти, итог ремонта. Ошибка — правки остаются на экране. */
  async function saveDirty() {
    if (!order) return;
    if (dirtyWorks) await ordersApi.saveWorks(order.id, filled(works));
    if (dirtyParts) await ordersApi.saveParts(order.id, filled(parts));
    if (dirtyFinish) {
      const days = finish.warrantyDays.trim() ? Number(finish.warrantyDays.replace(",", ".")) : null;
      if (days !== null && (!Number.isInteger(days) || days < 0)) throw new ApiError(400, "Гарантия — целое число дней");
      await ordersApi.saveFinish(order.id, {
        diagnosis: finish.diagnosis,
        masterComment: finish.masterComment,
        recommendation: finish.recommendation,
        warrantyDays: days,
      });
    }
    adopt.current = true;
  }
  const saveAll = () => run(saveDirty, "Изменения сохранены");
  const revert = () => {
    if (!b) return;
    setWorks(b.works);
    setParts(b.parts);
    setFinish(b.finish);
  };

  // Ушли со страницы с несохранённым — браузер переспросит (закрыть вкладку, обновить).
  useEffect(() => {
    const warnLeave = (e: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warnLeave);
    return () => window.removeEventListener("beforeunload", warnLeave);
  }, []);

  // Переход по ссылке внутри программы с несохранённым — своё окно: сохранить, не сохранять, остаться.
  const [leaveTo, setLeaveTo] = useState<string | null>(null);
  useEffect(() => {
    const click = (e: MouseEvent) => {
      if (!dirtyRef.current || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || a.origin !== window.location.origin || a.hasAttribute("download")) return;
      if (a.pathname === window.location.pathname) return;
      e.preventDefault();
      e.stopPropagation();
      setLeaveTo(a.pathname + a.search + a.hash);
    };
    document.addEventListener("click", click, true);
    return () => document.removeEventListener("click", click, true);
  }, []);
  const go = (to: string) => {
    // Ссылки внутри программы уже с базовым путём — убираем его для navigate.
    const root = ROUTER_BASE === "/" ? "" : ROUTER_BASE;
    navigate(root && to.startsWith(root) ? to.slice(root.length) || "/" : to);
  };

  if (error && !order) return <Banner tone="error">{error}</Banner>;
  if (!order) return <Spinner label="Открываем заказ" />;

  const myId = me?.kind === "tenant" ? me.user.id : null;
  const isMyOrder = !!myId && order.assignedMaster?.id === myId;
  const canEditWork = can("orders.edit") || isMyOrder;
  const canIssue = can("orders.issue") && !order.issuedAt;
  const canChangeStatus = can("orders.status") || (can("orders.status.own") && isMyOrder);
  const seesMoney = order.total !== undefined;
  const intake = order.attachments.filter((a) => a.kind === "INTAKE");
  const completion = order.attachments.filter((a) => a.kind === "COMPLETION");
  /** Все снимки подряд — для листания: сначала при приёме, потом после ремонта. */
  const photos = [...intake, ...completion];

  return (
    // Пока видна плавающая «Сохранить» — запас снизу, чтобы она не закрывала последние поля.
    <div className={"space-y-5 " + (canEditWork && dirty ? "pb-24" : "")}>
      <button onClick={() => (dirty ? setLeaveTo("/orders") : navigate("/orders"))} className="text-[13.5px] font-semibold text-ink-muted hover:text-ink">
        ‹ К списку заказов
      </button>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="font-mono text-[26px] font-extrabold tracking-tight" {...copyable("order", order.number)}>{order.number}</h1>
            <StatusPill tone={statusPill(order).tone} className="text-[13px]">
              {statusPill(order).label}
            </StatusPill>
            {order.inDebt && <DebtBadge amount={order.debt} className="text-[13px]" />}
            {order.inDebt && can("finance.payment", "finance.manage") && (
              <PayDebtButton orderId={order.id} onPaid={() => void load()} className="min-h-[34px] px-3 text-[13px]" />
            )}
            {order.isUrgent && (
              <span className="tag tag-urgent px-3 py-1 text-[12.5px]">срочный</span>
            )}
            {order.kind !== "REPAIR" && (
              <span className={"tag px-3 py-1 text-[12.5px] " + (order.kind === "WARRANTY" ? "tag-warranty" : "tag-neutral")}>
                {ORDER_KIND_LABEL[order.kind]}
              </span>
            )}
          </div>
          <p className="mt-2 text-[15px] text-ink-muted">
            {[order.device?.kind, order.device?.brand, order.device?.model].filter(Boolean).join(" ")}
            {order.device?.serial && (
              <>
                {" · s/n "}
                <span {...copyable("serial", order.device.serial)}>{order.device.serial}</span>
              </>
            )}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {canChangeStatus && ref && (
            <Select
              aria-label="Статус"
              className="min-w-[190px]"
              value={order.status.id}
              onChange={(e) => {
                const to = e.target.value;
                // Сначала — несохранённое (диагноз, работы): «Готов» должен уйти уже с ними.
                void run(async () => {
                  await saveDirty();
                  return ordersApi.setStatus(order.id, to);
                }, dirty ? "Изменения сохранены, статус изменён" : "Статус изменён");
              }}
            >
              {ref.statuses.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          )}
          {can("orders.edit") && ref && (
            <Button variant="secondary" onClick={() => setEditing(true)}>
              Изменить
            </Button>
          )}
          {/* Печать рядом со сменой статуса: квитанцию распечатывают сразу
              после приёма, акт — при выдаче, оба раза отсюда. */}
          <Button variant="secondary" onClick={() => setPrinting({ doc: "intake" })}>
            Квитанция
          </Button>
          <Button variant="secondary" onClick={() => setLabelling({})}>
            Наклейки
          </Button>
          {/* Только в программе FineCRM: в браузере и на телефоне папок на компьютере нет. */}
          {folder.available && (
            <Button variant="secondary" icon={<IconFolder />} onClick={() => folder.open(order)} disabled={folder.busy}>
              Папка заказа
            </Button>
          )}
          {order.completedAt && (
            <Button variant="secondary" onClick={() => setPrinting({ doc: "act" })}>
              Акт работ
            </Button>
          )}
          {canIssue &&
            (order.completedAt ? (
              <Button onClick={() => setIssuing(true)} disabled={saving}>
                Выдать клиенту
              </Button>
            ) : (
              <Button variant="secondary" onClick={() => setReturnReason(returnReason === null ? "" : null)}>
                Вернуть без ремонта
              </Button>
            ))}
        </div>
      </div>

      {/* Отдать технику до окончания ремонта можно, но причина обязательна —
          иначе заказ закроется молча и разбираться будет не по чему. */}
      {returnReason !== null && (
        <Card>
          <SectionLabel>Выдача без ремонта</SectionLabel>
          <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <Field label="Причина" hint="Например: клиент отказался от ремонта, неисправность не подтвердилась">
              <Input
                value={returnReason}
                autoFocus
                onChange={(e) => setReturnReason(e.target.value)}
                placeholder="Клиент забрал технику без ремонта"
              />
            </Field>
            <Button
              disabled={saving || returnReason.trim().length < 3}
              onClick={() =>
                void run(async () => {
                  await ordersApi.issue(order.id, { reason: returnReason.trim() });
                  setReturnReason(null);
                }, "Техника возвращена клиенту без ремонта")
              }
            >
              Подтвердить
            </Button>
          </div>
        </Card>
      )}

      {/* Выдача — единственное место, где заказ превращается в деньги, и
          спрашивать про них надо здесь, а не оставлять кассу на потом: «потом»
          не наступает, и выручка расходится с заказами. */}
      {issuing && (
        <IssueDialog
          orderId={order.id}
          onClose={() => setIssuing(false)}
          onIssue={async (payment) => {
            await ordersApi.issue(order.id, { payment });
            setIssuing(false);
            await run(async () => {}, "Заказ выдан клиенту");
          }}
        />
      )}

      {notice && <Banner>{notice}</Banner>}
      {warn && <Banner tone="warning">{warn}</Banner>}
      {error && <Banner tone="error">{error}</Banner>}

      {order.previousRepair && (
        <Card className="border-state-waiting/30 bg-state-waiting/[0.07]">
          <SectionLabel>Гарантийный возврат — что делали в прошлый раз</SectionLabel>
          <div className="mt-3">
            <Rows
              items={[
                { label: "Прошлый заказ", value: <span className="font-mono" {...copyable("order", order.previousRepair.number)}>{order.previousRepair.number}</span> },
                { label: "Мастер", value: order.previousRepair.master },
                { label: "Закрыт", value: formatDate(order.previousRepair.issuedAt ?? order.previousRepair.completedAt) },
                { label: "Гарантия до", value: formatDate(order.previousRepair.warrantyUntil) },
                { label: "Диагноз", value: order.previousRepair.diagnosis },
                {
                  label: "Работы",
                  value: order.previousRepair.works.map((w) => w.name).join(", ") || "—",
                },
                {
                  label: "Запчасти",
                  value: order.previousRepair.parts.map((p) => p.name).join(", ") || "—",
                },
                { label: "Комментарий", value: order.previousRepair.masterComment },
              ]}
            />
          </div>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-[1.55fr_1fr]">
        <div className="space-y-4">
          <Card>
            <SectionLabel>Со слов клиента</SectionLabel>
            <p className="mt-3 whitespace-pre-wrap text-[15px] leading-relaxed">{order.complaint}</p>
            {order.receptionNote && (
              <>
                <p className="mt-5 text-[13px] font-semibold text-ink-muted">Примечания приёмщика</p>
                <p className="mt-1.5 whitespace-pre-wrap text-[14px] leading-relaxed text-ink-soft">
                  {order.receptionNote}
                </p>
              </>
            )}

            <div className="mt-5 grid gap-5 border-t border-line pt-5 sm:grid-cols-2">
              <Checklist title="Комплектность" items={order.completeness ?? []} />
              <div className="space-y-3">
                <Checklist title="Внешнее состояние" items={order.appearance ?? []} />
                {/* Следы вскрытия и влаги сервер уже вписал в список выше —
                    и у новых заказов, и у старых, где они стояли флагом.
                    Примечание осталось только у заказов, принятых до кнопок. */}
                {order.appearanceNote && <p className="text-[13px] text-ink-muted">{order.appearanceNote}</p>}
              </div>
            </div>
          </Card>

          {/* Прошлые ремонты той же вещи — сразу под жалобой: мастер смотрит их до того, как браться. */}
          <DeviceHistory orderId={order.id} />

          <Card>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <SectionLabel>Фотографии</SectionLabel>
              {canEditWork && (
                <Button
                  type="button"
                  variant="secondary"
                  icon={<IconCamera />}
                  className="px-4 text-[13px]"
                  onClick={() => setShooting(true)}
                >
                  Добавить фото
                </Button>
              )}
            </div>

            <div className="mt-4 space-y-4">
              <div>
                <p className="mb-2 text-[13px] font-semibold text-ink-muted">При приёме</p>
                {intake.length === 0 ? (
                  <p className="text-[13.5px] text-ink-dim">Фотографий нет</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {intake.map((a, i) => (
                      <Photo key={a.id} orderId={order.id} attachmentId={a.id} name={a.fileName} onOpen={() => setViewing(i)} />
                    ))}
                  </div>
                )}
              </div>
              {completion.length > 0 && (
                <div>
                  <p className="mb-2 text-[13px] font-semibold text-ink-muted">После ремонта</p>
                  <div className="flex flex-wrap gap-2">
                    {completion.map((a, i) => (
                      <Photo
                        key={a.id}
                        orderId={order.id}
                        attachmentId={a.id}
                        name={a.fileName}
                        onOpen={() => setViewing(intake.length + i)}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          </Card>

          <OrderChat orderId={order.id} myId={myId} canModerate={can("orders.edit")} found={found} />
        </div>

        <div className="space-y-4">
          <Card>
            <SectionLabel>Заказ</SectionLabel>
            <div className="mt-3">
              <Rows
                items={[
                  { label: "Принят", value: formatDateTime(order.acceptedAt) },
                  { label: "Приёмщик", value: order.acceptedBy?.fullName },
                  { label: "Срок готовности", value: formatDate(order.dueAt) },
                  // Когда закончили и когда отдали — разные дни, и путать их
                  // нельзя: гарантия и претензии клиента считаются от выдачи.
                  ...(order.completedAt ? [{ label: "Готов", value: formatDateTime(order.completedAt) }] : []),
                  ...(order.issuedAt ? [{ label: "Выдан", value: formatDateTime(order.issuedAt) }] : []),
                  {
                    label: "Мастер",
                    // Мастера меняет тот, кто вправе править заказ: «взялся
                    // сам владелец» или «передали коллеге» — прямо здесь, без
                    // пересоздания заказа.
                    value:
                      can("orders.edit") && ref ? (
                        <Select
                          aria-label="Мастер"
                          value={order.assignedMaster?.id ?? ""}
                          disabled={saving}
                          onChange={(e) =>
                            void run(
                              () => ordersApi.assignMaster(order.id, e.target.value || null),
                              e.target.value ? "Мастер назначен" : "Мастер снят с заказа"
                            )
                          }
                        >
                          <option value="">Не назначен</option>
                          {/* Назначенный раньше мог сменить роль или уволиться —
                              он всё равно должен быть виден в поле. */}
                          {order.assignedMaster && !ref.masters.some((m) => m.id === order.assignedMaster?.id) && (
                            <option value={order.assignedMaster.id}>{order.assignedMaster.fullName}</option>
                          )}
                          {ref.masters.map((m) => (
                            <option key={m.id} value={m.id}>
                              {masterLabel(m)}
                            </option>
                          ))}
                        </Select>
                      ) : (
                        (order.assignedMaster?.fullName ?? "не назначен")
                      ),
                  },
                  { label: "Место хранения", value: order.storageLocation },
                  { label: "Пароль устройства", value: order.devicePasscode },
                  {
                    label: "Согласовано до",
                    value: order.approvedLimit ? money(order.approvedLimit) : "не ограничено",
                  },
                ]}
              />
            </div>
          </Card>

          {order.customer.name ? (
            <Card>
              <SectionLabel>Клиент</SectionLabel>
              <div className="mt-3">
                <Rows
                  items={[
                    {
                      label: "Имя",
                      // Цветная метка клиента — та же, что в списках: приёмщик
                      // узнаёт человека до того, как назовёт срок и цену.
                      // Имя — ссылка на карточку клиента: там все его ремонты
                      // и сколько он заплатил за всё время.
                      value: order.customer.name ? (
                        can("customers.view") ? (
                          <Link
                            to={`/clients/${order.customer.id}`}
                            {...copyable("name", order.customer.name)}
                            className="font-semibold underline decoration-dotted underline-offset-4 hover:decoration-solid"
                            style={nameStyle(order.customer.color)}
                            title={`${customerColor(order.customer.color)?.label ?? "Клиент"} — открыть карточку`}
                          >
                            {order.customer.name}
                          </Link>
                        ) : (
                          <span
                            className="font-semibold"
                            {...copyable("name", order.customer.name)}
                            style={nameStyle(order.customer.color)}
                            title={customerColor(order.customer.color)?.label}
                          >
                            {order.customer.name}
                          </span>
                        )
                      ) : null,
                    },
                    {
                      label: "Телефон",
                      value: order.customer.phone ? (
                        <a href={`tel:${order.customer.phone}`} {...copyable("phone", order.customer.phone)} className="font-semibold text-brand">
                          {order.customer.phone}
                        </a>
                      ) : null,
                    },
                    {
                      label: "Ещё телефон",
                      value: order.customer.phone2 ? (
                        <span {...copyable("phone", order.customer.phone2)}>{order.customer.phone2}</span>
                      ) : null,
                    },
                    { label: "Email", value: order.customer.email },
                    { label: "Адрес", value: order.customer.address },
                  ]}
                />
              </div>
            </Card>
          ) : (
            <Card>
              <SectionLabel>Клиент</SectionLabel>
              <p className="mt-3 text-[13.5px] leading-relaxed text-ink-dim">
                Контакты клиента скрыты: для ремонта они не нужны. Если понадобится связаться —
                через приёмщика.
              </p>
            </Card>
          )}

          <OrderSms orderId={order.id} version={smsVersion} onSent={() => setSmsVersion((v) => v + 1)} />

          {seesMoney && (
            <Card>
              <SectionLabel>Деньги</SectionLabel>
              <div className="mt-3">
                <Rows
                  items={[
                    { label: "Предварительно", value: money(order.estimatedCost) },
                    { label: "Работы", value: money(order.totalWork) },
                    // Скидку показываем отдельной строкой, а не вычтенной из
                    // работ: клиент должен видеть, что она у него есть.
                    ...(order.workDiscount
                      ? [
                          {
                            label: `Скидка на работы, ${order.workDiscountPercent}%`,
                            value: (
                              <span className="text-state-done">−{money(order.workDiscount)}</span>
                            ),
                          },
                        ]
                      : []),
                    { label: "Запчасти", value: money(order.totalParts) },
                    ...(order.discount
                      ? [
                          {
                            label: "Скидка при выдаче",
                            value: <span className="text-state-done">−{money(order.discount)}</span>,
                          },
                        ]
                      : []),
                    { label: "Предоплата", value: money(order.prepayment) },
                    {
                      label: "Итого",
                      value: <span className="text-[17px] font-bold">{money(order.total)}</span>,
                    },
                    // Чем расплатились — видно только у выданных: до выдачи
                    // строка «Тип оплаты: —» обещает поле, которого ещё нет.
                    ...(order.paymentMethod
                      ? [
                          {
                            label: "Тип оплаты",
                            value:
                              order.paymentMethod === "DEBT" ? (
                                <span className="font-semibold text-state-waiting">
                                  {PAYMENT_LABEL.DEBT}
                                  {order.debtDueAt ? ` до ${formatDate(order.debtDueAt)}` : ""}
                                </span>
                              ) : (
                                PAYMENT_LABEL[order.paymentMethod]
                              ),
                          },
                        ]
                      : []),
                  ]}
                />
              </div>
            </Card>
          )}
        </div>
      </div>

      {canEditWork && (
        <>
          <LineEditor
            title="Выполненные работы"
            rows={works}
            setRows={setWorks}
            empty={{ name: "", qty: 1, price: 0, masterId: null }}
            services={ref?.services ?? []}
            // Чья работа — для зарплаты: два мастера на заказе делят деньги по
            // строкам. Выбирает тот, кто правит любой заказ; мастер пишет на себя.
            extraColumn={
              can("orders.edit") && ref
                ? (row, update) => (
                    <Select
                      className="min-h-[42px] w-[150px]"
                      title="Чья работа — для зарплаты"
                      value={row.masterId ?? ""}
                      onChange={(e) => update({ masterId: e.target.value || null })}
                    >
                      <option value="">Мастер заказа</option>
                      {ref.masters.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.fullName}
                        </option>
                      ))}
                      {row.masterId && !ref.masters.some((m) => m.id === row.masterId) && (
                        <option value={row.masterId}>другой сотрудник</option>
                      )}
                    </Select>
                  )
                : undefined
            }
          />

          <LineEditor
            title="Запчасти"
            rows={parts}
            setRows={setParts}
            empty={{ name: "", qty: 1, price: 0, source: "STOCK" }}
            actions={
              <Button
                type="button"
                variant="secondary"
                icon={<IconSearch />}
                onClick={() => {
                  // Набрали название, а цены нет — ищем его и найденным заполним эту же строку.
                  const i = parts.map((p, k) => (p.name.trim() && !Number(p.price) ? k : -1)).filter((k) => k >= 0).pop() ?? -1;
                  setSuppliers({ q: i >= 0 ? parts[i].name.trim() : "", row: i });
                }}
              >
                Найти у поставщиков
              </Button>
            }

            extraColumn={(row, update) => (
              <Select
                className="min-h-[42px] w-[142px]"
                value={row.source}
                onChange={(e) => update({ source: e.target.value as OrderPart["source"] })}
              >
                {Object.entries(PART_SOURCE_LABEL).map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </Select>
            )}
          />

          {folder.element}
          {suppliers && (
            <PartsSearch
              initialQuery={suppliers.q}
              onClose={() => setSuppliers(null)}
              onPick={(o: PickedOffer) => {
                // Цена — магазина: наценку мастер поправит в строке. Деталь куплена, а не со склада.
                const row: OrderPart = { name: o.name, qty: 1, price: o.price ?? 0, source: "PURCHASED" };
                setParts((cur) =>
                  suppliers.row >= 0 && suppliers.row < cur.length
                    ? cur.map((r, i) => (i === suppliers.row ? { ...row, qty: r.qty || 1 } : r))
                    : [...cur, row]
                );
                setSuppliers(null);
              }}
            />
          )}

          <Card>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <SectionLabel>Итог ремонта</SectionLabel>
              <span className="text-[12.5px] text-ink-dim">
                Рекомендации и гарантия — в акт работ, диагноз — в историю техники. «Готов» — сменой статуса.
              </span>
            </div>
            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <Field label="Что оказалось не так" hint="Диагноз, а не пересказ жалобы">
                <Textarea value={finish.diagnosis} onChange={(e) => setFinish({ ...finish, diagnosis: e.target.value })} />
              </Field>
              <Field label="Комментарий для приёмщика и клиента">
                <Textarea
                  value={finish.masterComment}
                  onChange={(e) => setFinish({ ...finish, masterComment: e.target.value })}
                />
              </Field>
            </div>
            <div className="mt-4 grid gap-4 sm:grid-cols-[1fr_200px]">
              <Field label="Рекомендации клиенту">
                <Input
                  value={finish.recommendation}
                  onChange={(e) => setFinish({ ...finish, recommendation: e.target.value })}
                />
              </Field>
              <Field label="Гарантия, дней">
                <Input
                  inputMode="numeric"
                  value={finish.warrantyDays}
                  onChange={(e) => setFinish({ ...finish, warrantyDays: e.target.value })}
                />
              </Field>
            </div>
          </Card>
        </>
      )}

      {/* Удаление внизу и в два шага: это не то действие, которое должно
          случаться от промаха по соседней кнопке. */}
      {can("orders.delete") && (
        <Card className="border-state-off/25">
          <SectionLabel>Удаление заказа</SectionLabel>
          {deleteReason === null ? (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <p className="text-[13.5px] text-ink-muted">
                Заказ уйдёт из списков и с доски. Списанные запчасти и движения по кассе останутся
                на месте — их поправляют в своих разделах.
              </p>
              <Button variant="danger" onClick={() => setDeleteReason("")}>
                Удалить заказ
              </Button>
            </div>
          ) : (
            <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
              <Field
                label="Причина"
                hint="Останется в журнале — через полгода это будет единственное объяснение"
              >
                <Input
                  value={deleteReason}
                  autoFocus
                  onChange={(e) => setDeleteReason(e.target.value)}
                  placeholder="Завели по ошибке, дубль заказа Р-2026-00041"
                />
              </Field>
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => setDeleteReason(null)}>
                  Отмена
                </Button>
                <Button
                  variant="danger"
                  disabled={saving || deleteReason.trim().length < 3}
                  onClick={() =>
                    void (async () => {
                      setSaving(true);
                      setError(null);
                      try {
                        await ordersApi.remove(order.id, deleteReason.trim());
                        navigate("/orders");
                      } catch (err) {
                        setError(err instanceof ApiError ? err.message : "Не удалось удалить заказ");
                        setSaving(false);
                      }
                    })()
                  }
                >
                  Удалить
                </Button>
              </div>
            </div>
          )}
        </Card>
      )}

      {/* Одна кнопка на всю карточку — всегда в правом нижнем углу, листать
          в поисках «Сохранить» не нужно. Видна, только пока есть что сохранять. */}
      {canEditWork && dirty && (
        <div
          data-save-bar
          className="fixed bottom-[calc(var(--bottom-nav,0px)+16px)] right-4 z-[55] flex items-center gap-2 rounded-pill border border-line bg-surface-raised p-1.5 pl-4 shadow-modal sm:right-6"
        >
          <span className="hidden text-[13px] text-ink-muted sm:inline">Есть несохранённые изменения</span>
          <Button type="button" variant="ghost" onClick={revert} disabled={saving} className="min-h-[40px] px-3 text-[13.5px]">
            Отменить
          </Button>
          <Button type="button" onClick={() => void saveAll()} disabled={saving} className="min-h-[40px] rounded-pill px-5">
            {saving ? "Сохраняем…" : "Сохранить"}
          </Button>
        </div>
      )}

      {leaveTo !== null && (
        <Modal title="Сохранить изменения?" onClose={() => setLeaveTo(null)}>
          <p className="text-[14px] text-ink-muted">В заказе есть несохранённые изменения: работы, запчасти или итог ремонта.</p>
          <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="secondary" onClick={() => setLeaveTo(null)}>
              Остаться
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                const to = leaveTo;
                dirtyRef.current = false;
                setLeaveTo(null);
                go(to);
              }}
            >
              Не сохранять
            </Button>
            <Button
              type="button"
              disabled={saving}
              onClick={() => {
                const to = leaveTo;
                setLeaveTo(null);
                void (async () => {
                  setSaving(true);
                  setError(null);
                  try {
                    await saveDirty();
                    dirtyRef.current = false;
                    go(to);
                  } catch (err) {
                    setError(err instanceof ApiError ? err.message : "Не удалось сохранить");
                  } finally {
                    setSaving(false);
                  }
                })();
              }}
            >
              Сохранить и перейти
            </Button>
          </div>
        </Modal>
      )}

      {editing && ref && (
        <OrderEditModal
          order={order}
          reference={ref}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void run(async () => {}, "Заказ изменён");
          }}
        />
      )}

      {shooting && (
        <PhotoShooter
          orderId={order.id}
          defaultKind={order.completedAt ? "COMPLETION" : "INTAKE"}
          onClose={() => setShooting(false)}
          onDone={(count) => {
            setShooting(false);
            void run(async () => undefined, count === 1 ? "Снимок загружен" : `Загружено снимков: ${count}`);
          }}
        />
      )}

      {smsOffer && (
        <SmsModal
          orderId={order.id}
          kind="ready"
          onClose={() => setSmsOffer(false)}
          onSent={() => {
            setSmsOffer(false);
            setSmsVersion((v) => v + 1);
            setNotice("SMS клиенту отправлена");
            setTimeout(() => setNotice(null), 4000);
          }}
        />
      )}

      {printing && (
        <PrintDialog
          orderId={order.id}
          number={order.number}
          doc={printing.doc}
          afterIntake={printing.afterIntake}
          auto={printing.auto}
          onClose={() => {
            setPrinting(null);
            const next = labelsNext.current;
            labelsNext.current = null;
            if (next) setLabelling(next);
          }}
        />
      )}

      {labelling && (
        <LabelDialog order={order} afterIntake={labelling.afterIntake} auto={labelling.auto} onClose={() => setLabelling(null)} />
      )}

      {viewing !== null && photos.length > 0 && (
        <PhotoViewer
          orderId={order.id}
          photos={photos}
          start={Math.min(viewing, photos.length - 1)}
          canDelete={canEditWork}
          onClose={() => setViewing(null)}
          onDeleted={() => {
            // Последний снимок удалён — смотреть больше нечего.
            if (photos.length <= 1) setViewing(null);
            void run(async () => undefined, "Снимок удалён");
          }}
        />
      )}
    </div>
  );
}
