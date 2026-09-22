import { Fragment, useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ApiError } from "../lib/api";
import { dayLabel, messagesApi, timeLabel, type OrderMessage } from "../lib/messages";
import { compressPhoto } from "../lib/photos";
import { IconAttach, IconClose, IconSend } from "./icons";
import { PhotoViewer, type ViewerPhoto } from "./PhotoViewer";
import { Banner, Card, SectionLabel } from "./ui";

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
}: {
  orderId: string;
  myId: string | null;
  canModerate: boolean;
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

  const load = useCallback(async () => {
    try {
      setMessages(await messagesApi.list(orderId));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось загрузить историю");
    }
  }, [orderId]);

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
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

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

  return (
    <Card>
      <div id="history" className="flex items-center justify-between gap-3 scroll-mt-20">
        <SectionLabel>История ремонта</SectionLabel>
        {count > 0 && <span className="text-[12.5px] text-ink-dim">{count}</span>}
      </div>

      <div
        ref={list}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
        className="mt-3 max-h-[520px] space-y-2 overflow-y-auto pr-1"
      >
        {messages === null ? (
          <p className="py-6 text-center text-[13.5px] text-ink-dim">Загружаем…</p>
        ) : messages.length === 0 ? (
          <p className="py-6 text-center text-[13.5px] text-ink-dim">
            Здесь мастера записывают ход ремонта: что нашли, что заказали, о чём договорились с клиентом.
          </p>
        ) : (
          messages.map((m, i) => {
            const mine = !!myId && m.author?.id === myId;
            const newDay = i === 0 || dayLabel(messages[i - 1].createdAt) !== dayLabel(m.createdAt);
            return (
              <Fragment key={m.id}>
                {newDay && (
                  <div className="py-1 text-center text-[12px] font-semibold text-ink-dim">{dayLabel(m.createdAt)}</div>
                )}
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

      <div className="mt-3 rounded-field border border-line bg-surface-input p-2">
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
