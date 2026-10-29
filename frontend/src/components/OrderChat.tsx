import { Fragment, useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ApiError } from "../lib/api";
import { dayLabel, messagesApi, timeLabel, type OrderMessage } from "../lib/messages";
import { compressPhoto } from "../lib/photos";
import { IconAttach, IconClose, IconPerson, IconPlus, IconSend, IconSettings } from "./icons";
import { useHistoryOrder, type HistoryDock } from "../lib/historyDock";
import { ordersApi, type OrderEventRow } from "../lib/orders";
import { LabelDot } from "../lib/labelIcons";
import { STAGES } from "../lib/stages";
import { PhotoViewer, type ViewerPhoto } from "./PhotoViewer";
import { Banner, Card, SectionLabel } from "./ui";
import { CallLine } from "./CallLine";
import { useAuth } from "../lib/auth";

/**
 * История ремонта — лента сообщений в карточке заказа, как в мессенджере.
 *
 * Свои сообщения справа, чужие слева; у каждого — кто и во сколько, дни
 * разделены подписью «Сегодня», «Вчера», «12 сентября». Снимки — превью под
 * текстом; по нажатию открываются целиком, их можно сохранить к себе или
 * скопировать в буфер обмена и вставить в мессенджер клиенту.
 *
 * Лента подтягивает новое сама раз в 15 секунд, пока вкладка на виду: мастер
 * и приёмщик часто смотрят на один заказ с разных компьютеров.
 */

const POLL_MS = 15_000;
const MAX_FILES = 10;

interface Draft {
  id: number;
  file: File;
  url: string;
}

export function OrderChat({
  orderId,
  myId,
  canModerate,
  found,
  refreshKey,
  dock,
}: {
  orderId: string;
  myId: string | null;
  canModerate: boolean;
  /**
   * Прикрепление панели (шестерёнка в шапке): где она сейчас (value), где
   * стоит на самом деле (docked: окно узкое — на своём месте) и смена места.
   */
  dock?: { value: HistoryDock; docked: HistoryDock; fits: boolean; set: (d: HistoryDock) => void };
  /** Сменился заказ (статус, мастер, ярлык) — перечитать служебные строки. */
  refreshKey?: unknown;
  /** Сообщение, найденное поиском по заказам: его надо показать и подсветить. */
  found?: string | null;
}) {
  const [messages, setMessages] = useState<OrderMessage[] | null>(null);
  const [text, setText] = useState("");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<{ photos: ViewerPhoto[]; start: number } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  /** Подсвеченное сообщение: гаснет через три секунды. */
  const [glow, setGlow] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const counter = useRef(0);
  const stick = useRef(true);
  // Новые снизу (как в переписке) или сверху — выбор сотрудника (29.10.2026).
  const [order, setOrder] = useHistoryOrder();
  const top = order === "top";

  const [events, setEvents] = useState<OrderEventRow[]>([]);
  // Звонок переносят в другой заказ те, кто правит заказы.
  const { can } = useAuth();
  const canMoveCalls = can("orders.edit");
  // «Всё» — и сообщения, и служебные строки; «только сообщения» — переписка.
  // Выбор помнится на этом устройстве.
  const [onlyMessages, setOnlyMessages] = useState(() => {
    try {
      return localStorage.getItem("finecrm.history.only-messages") === "1";
    } catch {
      return false;
    }
  });
  const switchMode = (v: boolean) => {
    setOnlyMessages(v);
    try {
      localStorage.setItem("finecrm.history.only-messages", v ? "1" : "0");
    } catch {
      /* не запомнили — не беда */
    }
  };

  const load = useCallback(async () => {
    try {
      const [m, e] = await Promise.all([messagesApi.list(orderId), ordersApi.events(orderId).catch(() => ({ items: [] }))]);
      setMessages(m);
      setEvents(e.items);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось загрузить историю");
    }
  }, [orderId]);

  useEffect(() => {
    if (refreshKey !== undefined) void load();
  }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void load();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  // Прокрутка вниз — к новому, но только если человек и так был внизу:
  // если он листает историю вверх, новое сообщение не должно его сдёргивать.
  useEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = top ? 0 : el.scrollHeight;
  }, [messages, top]);

  /**
   * Пришли из поиска по заказам: лента прокручивается к найденной записи и
   * подсвечивает её на три секунды. Без этого человек попадает в ленту из
   * сорока сообщений и ищет глазами то, что уже нашёл поиском.
   */
  useEffect(() => {
    if (!found || !messages) return;
    if (!messages.some((m) => m.id === found)) return;
    // Прокрутку к новому в этот раз не делаем: она увела бы вниз от находки.
    stick.current = false;
    setGlow(found);
    const el = document.getElementById(`message-${found}`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
    const t = setTimeout(() => setGlow(null), 3000);
    return () => clearTimeout(t);
  }, [found, messages]);

  // Превью черновых снимков — память браузера; освобождаем за собой.
  useEffect(() => () => drafts.forEach((d) => URL.revokeObjectURL(d.url)), []); // eslint-disable-line react-hooks/exhaustive-deps

  async function attach(files: FileList | null) {
    if (!files?.length) return;
    const room = MAX_FILES - drafts.length;
    if (room <= 0) {
      setError(`К одному сообщению — не больше ${MAX_FILES} снимков`);
      return;
    }
    setBusy("Сжимаем снимки…");
    try {
      const out: Draft[] = [];
      for (const f of Array.from(files).slice(0, room)) {
        if (!f.type.startsWith("image/")) continue;
        const file = await compressPhoto(f);
        counter.current += 1;
        out.push({ id: counter.current, file, url: URL.createObjectURL(file) });
      }
      setDrafts((d) => [...d, ...out]);
      if (files.length > room) setError(`К одному сообщению — не больше ${MAX_FILES} снимков, лишние не добавлены`);
    } finally {
      setBusy(null);
    }
  }

  function dropDraft(id: number) {
    setDrafts((d) => {
      const gone = d.find((x) => x.id === id);
      if (gone) URL.revokeObjectURL(gone.url);
      return d.filter((x) => x.id !== id);
    });
  }

  async function send() {
    const body = text.trim();
    if (!body && !drafts.length) return;
    setBusy(drafts.length ? "Отправляем снимки…" : "Отправляем…");
    setError(null);
    try {
      const created = await messagesApi.send(orderId, body, drafts.map((d) => d.file));
      drafts.forEach((d) => URL.revokeObjectURL(d.url));
      setDrafts([]);
      setText("");
      stick.current = true;
      setMessages((m) => [...(m ?? []), created]);
    } catch (err) {
      // Текст и снимки остаются в поле — отправить можно ещё раз.
      setError(err instanceof ApiError ? err.message : "Не удалось отправить — проверьте связь и повторите");
    } finally {
      setBusy(null);
    }
  }

  async function remove(id: string) {
    setError(null);
    try {
      await messagesApi.remove(orderId, id);
      setRemoving(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось удалить сообщение");
    }
  }

  // Ctrl+Enter (⌘+Enter) — отправить; просто Enter — новая строка: записи
  // мастеров бывают в несколько строк, и случайная отправка полуфразы хуже
  // лишнего нажатия.
  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void send();
    }
  }

  // Все снимки истории подряд — чтобы в просмотре листать между сообщениями.
  const allPhotos: ViewerPhoto[] = (messages ?? []).flatMap((m) =>
    m.attachments.map((a) => ({ id: a.id, fileName: a.fileName, kind: "MESSAGE" }))
  );
  const openPhoto = (id: string) => setViewing({ photos: allPhotos, start: Math.max(0, allPhotos.findIndex((p) => p.id === id)) });

  const count = messages?.filter((m) => !m.deleted).length ?? 0;

  type Item = { at: string; msg?: OrderMessage; ev?: OrderEventRow };
  const timeline: Item[] = messages
    ? [
        ...messages.map((m) => ({ at: m.createdAt, msg: m })),
        // Звонки клиента — это разговор, они видны и в «только сообщения».
        ...events.filter((ev) => !onlyMessages || ev.kind === "CALL").map((ev) => ({ at: ev.at, ev })),
      ].sort((a, b) => (top ? b.at.localeCompare(a.at) : a.at.localeCompare(b.at)))
    : [];

  const docked = dock?.docked ?? null;

  // Поле ввода — там, где новые: внизу или сверху.
  const composer = (
      <div className={(top ? "mb-1 " : "") + "mt-3 rounded-field border border-line bg-surface-input p-2"}>
        {drafts.length > 0 && (
          <div className="mb-2 flex gap-1.5 overflow-x-auto pb-1">
            {drafts.map((d) => (
              <div key={d.id} className="relative h-[60px] w-[60px] shrink-0 overflow-hidden rounded-[8px] border border-line">
                <img src={d.url} alt="" className="h-full w-full object-cover" />
                <button
                  type="button"
                  aria-label="Убрать снимок"
                  onClick={() => dropDraft(d.id)}
                  className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/65 text-white [&>svg]:h-3 [&>svg]:w-3"
                >
                  <IconClose />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-end gap-1.5">
          <input
            ref={picker}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              void attach(e.target.files);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            aria-label="Приложить фото"
            title="Приложить фото"
            disabled={!!busy}
            onClick={() => picker.current?.click()}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-field text-ink-muted transition-colors duration-150 hover:bg-surface-raised hover:text-ink [&>svg]:h-5 [&>svg]:w-5"
          >
            <IconAttach />
          </button>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            rows={Math.min(6, Math.max(1, text.split("\n").length))}
            maxLength={4000}
            placeholder="Написать в историю…"
            aria-label="Сообщение в историю ремонта"
            className="min-h-[40px] flex-1 resize-none bg-transparent px-1 py-2 text-[14.5px] text-ink placeholder:text-ink-dim focus:outline-none"
          />
          <button
            type="button"
            aria-label="Отправить"
            title="Отправить (Ctrl+Enter)"
            disabled={!!busy || (!text.trim() && !drafts.length)}
            onClick={() => void send()}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-field bg-brand text-white transition-opacity duration-150 disabled:opacity-40 [&>svg]:h-5 [&>svg]:w-5"
          >
            <IconSend />
          </button>
        </div>
        {busy && <p className="mt-1 px-1 text-[12px] text-ink-dim">{busy}</p>}
      </div>
  );

  return (
    <Card className={docked ? "flex h-full flex-col" : undefined}>
      <div id="history" className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 scroll-mt-20">
        <SectionLabel>История ремонта</SectionLabel>
        <span className="flex items-center gap-1.5 text-[12.5px] text-ink-dim">
        <span className="flex items-center gap-1.5" data-history-mode>
          Показывать:
          <button type="button" onClick={() => switchMode(false)} className={onlyMessages ? "hover:text-ink" : "font-bold text-ink"} aria-pressed={!onlyMessages}>
            всё
          </button>
          ·
          <button type="button" onClick={() => switchMode(true)} className={onlyMessages ? "font-bold text-ink" : "hover:text-ink"} aria-pressed={onlyMessages}>
            только сообщения{count > 0 ? ` (${count})` : ""}
          </button>
        </span>
        <button
          type="button"
          onClick={() => {
            stick.current = true;
            setOrder(top ? "bottom" : "top");
          }}
          title="Порядок истории"
          className="whitespace-nowrap hover:text-ink"
          data-history-order={order}
        >
          {top ? "↑ новые сверху" : "↓ новые снизу"}
        </button>
        {dock && <DockMenu dock={dock} />}
        </span>
      </div>

      {top && composer}
      <div
        ref={list}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = top ? el.scrollTop < 60 : el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
        className={"mt-3 space-y-2 overflow-y-auto pr-1 " + (docked ? "min-h-0 flex-1" : "max-h-[520px]")}
        data-history-list
      >
        {messages === null ? (
          <p className="py-6 text-center text-[13.5px] text-ink-dim">Загружаем…</p>
        ) : timeline.length === 0 ? (
          <p className="py-6 text-center text-[13.5px] text-ink-dim">
            Здесь мастера записывают ход ремонта: что нашли, что заказали, о чём договорились с клиентом.
          </p>
        ) : (
          timeline.map((item, i) => {
            const newDay = i === 0 || dayLabel(timeline[i - 1].at) !== dayLabel(item.at);
            if (item.ev) {
              return (
                <Fragment key={"ev" + item.ev.id}>
                  {newDay && <div className="py-1 text-center text-[12px] font-semibold text-ink-dim">{dayLabel(item.at)}</div>}
                  {item.ev.kind === "CALL" && item.ev.call ? (
                    <CallLine call={item.ev.call} canMove={canMoveCalls} onMoved={() => void load()} />
                  ) : (
                    <EventLine ev={item.ev} />
                  )}
                </Fragment>
              );
            }
            const m = item.msg!;
            const mine = !!myId && m.author?.id === myId;
            return (
              <Fragment key={m.id}>
                {newDay && (
                  <div className="py-1 text-center text-[12px] font-semibold text-ink-dim">{dayLabel(m.createdAt)}</div>
                )}
                {m.system && !m.deleted ? (
                  // Запись программы — по центру, без автора: это не чьи-то слова, а событие заказа.
                  <div id={`message-${m.id}`} data-system className="flex scroll-mt-16 justify-center">
                    <p className="max-w-[92%] rounded-[12px] border border-dashed border-line px-3 py-1.5 text-center text-[13px] leading-snug text-ink-muted sm:max-w-[80%]">
                      <span className="mr-1.5 font-semibold text-ink-soft">FineCRM</span>
                      <span className="mr-1.5 text-ink-dim">{timeLabel(m.createdAt)}</span>
                      {m.text}
                    </p>
                  </div>
                ) : (
                <div id={`message-${m.id}`} className={"flex scroll-mt-16 " + (mine ? "justify-end" : "justify-start")}>
                  <div
                    className={
                      "group max-w-[88%] rounded-[14px] border px-3 py-2 transition-colors duration-500 sm:max-w-[75%] " +
                      (glow === m.id
                        ? "border-brand bg-brand-tint ring-2 ring-brand"
                        : mine
                          ? "border-brand/30 bg-brand-tint"
                          : "border-line bg-surface-raised")
                    }
                  >
                    <div className="flex items-baseline gap-2 text-[12px]">
                      <span className="font-semibold text-ink-soft">{m.author?.fullName ?? "Сотрудник"}</span>
                      <span className="text-ink-dim">{timeLabel(m.createdAt)}</span>
                      {!m.deleted && (mine || canModerate) && (
                        <button
                          type="button"
                          onClick={() => setRemoving(m.id)}
                          // На телефоне наведения нет — там кнопка видна всегда.
                          className="ml-auto text-ink-dim transition-opacity duration-150 hover:text-state-off focus:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100"
                        >
                          удалить
                        </button>
                      )}
                    </div>
                    {m.deleted ? (
                      <p className="mt-1 text-[13.5px] italic text-ink-dim">Сообщение удалено</p>
                    ) : (
                      <>
                        {m.text && (
                          <p className="mt-1 whitespace-pre-wrap break-words text-[14px] leading-snug text-ink">{m.text}</p>
                        )}
                        {m.attachments.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {m.attachments.map((a) => (
                              <button
                                key={a.id}
                                type="button"
                                onClick={() => openPhoto(a.id)}
                                title={a.fileName}
                                className="h-[84px] w-[84px] overflow-hidden rounded-[10px] border border-line bg-surface-input"
                              >
                                <img src={a.url} alt={a.fileName} loading="lazy" className="h-full w-full object-cover" />
                              </button>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                    {removing === m.id && (
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-[12.5px]">
                        <span className="text-ink-muted">Удалить сообщение?</span>
                        <button type="button" className="font-semibold text-state-off" onClick={() => void remove(m.id)}>
                          Удалить
                        </button>
                        <button type="button" className="text-ink-muted" onClick={() => setRemoving(null)}>
                          Оставить
                        </button>
                      </div>
                    )}
                  </div>
                </div>
                )}
              </Fragment>
            );
          })
        )}
      </div>

      {error && (
        <div className="mt-3">
          <Banner tone="error">{error}</Banner>
        </div>
      )}

      {!top && composer}

      {viewing && (
        <PhotoViewer
          orderId={orderId}
          photos={viewing.photos}
          start={viewing.start}
          canDelete={false}
          onDeleted={() => undefined}
          onClose={() => setViewing(null)}
        />
      )}
    </Card>
  );
}

/** Служебная строка истории: приём, статус, мастер, ярлык — кто и когда. */
function EventLine({ ev }: { ev: OrderEventRow }) {
  const who = ev.who ? `${ev.who.name}${ev.who.position ? `, ${ev.who.position}` : ""}` : "FineCRM";
  const stage = (g?: string) => STAGES.find((s) => s.key === g);
  let icon: React.ReactNode = null;
  let text: React.ReactNode = null;
  let dim = false;
  if (ev.kind === "CREATED") {
    icon = <IconPlus />;
    text = (
      <>
        Заказ принят{ev.to ? <> · статус <b className="text-ink">{ev.to.name}</b></> : null}
        {ev.comment && ev.comment !== "Принято в работу" ? <span className="text-ink-dim"> ({ev.comment})</span> : null}
      </>
    );
  } else if (ev.kind === "STATUS") {
    icon = <span className={"h-2 w-2 rounded-full " + (stage(ev.to?.group)?.dot ?? "bg-ink-dim")} />;
    text = (
      <>
        Статус: {ev.from?.name ?? "—"} → <b className="text-ink">{ev.to?.name}</b>
        {ev.comment ? <span className="text-ink-dim"> — {ev.comment}</span> : null}
      </>
    );
  } else if (ev.kind === "MASTER") {
    icon = <IconPerson />;
    const d = ev.data ?? {};
    text = d.to ? (
      d.from ? (
        <>
          Мастер: {d.from} → <b className="text-ink">{d.to}</b>
        </>
      ) : (
        <>
          Назначен мастер <b className="text-ink">{d.to}</b>
        </>
      )
    ) : (
      <>Снят мастер {d.from ?? ""}</>
    );
  } else if (ev.kind === "LABEL_SET" || ev.kind === "LABEL_UNSET") {
    const d = ev.data ?? {};
    dim = ev.kind === "LABEL_UNSET";
    icon = <LabelDot icon={d.icon ?? "flag"} color={d.color ?? "#6B7A99"} className="!h-[18px] !w-[18px] [&>svg]:!h-[10px] [&>svg]:!w-[10px]" />;
    text = ev.kind === "LABEL_SET" ? (
      <>
        Поставлен ярлык <b className="text-ink">«{d.name}»</b>
      </>
    ) : (
      <>Снят ярлык «{d.name}»</>
    );
  } else {
    return null;
  }
  return (
    <div className={"flex items-start gap-2 px-1 text-[13px] leading-snug " + (dim ? "opacity-70" : "")} data-history-event={ev.kind}>
      <span className="mt-[1px] flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-surface-raised text-ink-muted [&>svg]:h-3 [&>svg]:w-3">
        {icon}
      </span>
      <p className="min-w-0 text-ink-soft">
        {text}
        <span className="text-[12px] text-ink-dim">
          {" "}
          · {who} · {timeLabel(ev.at)}
        </span>
      </p>
    </div>
  );
}

/** Значок места панели: рамка заказа и закрашенная полоса там, где история. */
function DockGlyph({ side }: { side: HistoryDock }) {
  return (
    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px] shrink-0" fill="none" stroke="currentColor" strokeWidth={1.7} aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      {side === "left" && <rect x="4.6" y="5.6" width="5" height="12.8" rx="1.3" fill="currentColor" stroke="none" opacity={0.45} />}
      {side === "right" && <rect x="14.4" y="5.6" width="5" height="12.8" rx="1.3" fill="currentColor" stroke="none" opacity={0.45} />}
      {side === null && <rect x="6" y="12.4" width="12" height="5" rx="1.3" fill="currentColor" stroke="none" opacity={0.45} />}
    </svg>
  );
}

/**
 * Шестерёнка в шапке истории (Андрей, 27.10.2026): «Прикрепить слева»,
 * «Прикрепить справа», «Открепить» — вернуть панель на прежнее место.
 */
function DockMenu({ dock }: { dock: NonNullable<Parameters<typeof OrderChat>[0]["dock"]> }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: globalThis.KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  const items: Array<[HistoryDock, string]> = [
    ["left", "Прикрепить слева"],
    ["right", "Прикрепить справа"],
    [null, "Открепить — вернуть на место"],
  ];
  return (
    <span ref={box} className="relative hidden md:inline-flex">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Где показывать историю ремонта"
        title="Где показывать историю ремонта"
        aria-haspopup="menu"
        aria-expanded={open}
        data-history-dock-menu
        className={
          "ml-1 flex h-8 w-8 items-center justify-center rounded-field text-ink-muted transition-colors duration-150 hover:bg-surface-raised hover:text-ink [&>svg]:h-[17px] [&>svg]:w-[17px] " +
          (open ? "bg-surface-raised text-ink" : "")
        }
      >
        <IconSettings />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-[calc(100%+6px)] z-40 w-[290px] rounded-field border border-line-strong bg-surface-raised p-1.5 text-[13.5px] shadow-raised">
          {items.map(([side, label], i) => {
            const on = dock.value === side;
            return (
              <Fragment key={label}>
                {i === 2 && <div className="mx-1 my-1 h-px bg-line" />}
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={on}
                  onClick={() => {
                    dock.set(side);
                    setOpen(false);
                  }}
                  data-history-dock-option={side ?? "none"}
                  className={
                    "flex w-full items-center gap-2.5 rounded-[8px] px-2.5 py-2 text-left transition-colors duration-100 " +
                    (on ? "bg-brand-tint font-semibold text-ink" : "text-ink-soft hover:bg-surface-input hover:text-ink")
                  }
                >
                  <DockGlyph side={side} />
                  <span className="flex-1">{label}</span>
                  {on && <span className="text-brand-ink">✓</span>}
                </button>
              </Fragment>
            );
          })}
          {dock.value && !dock.fits && (
            <p className="px-2.5 pb-1 pt-2 text-[12px] leading-snug text-ink-dim" data-history-dock-narrow>
              Окно узкое для трёх колонок — пока панель на своём месте. Станет шире — прикрепится сама.
            </p>
          )}
        </div>
      )}
    </span>
  );
}
