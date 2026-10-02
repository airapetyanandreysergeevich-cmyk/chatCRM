import { useCallback, useEffect, useState } from "react";
import { Modal } from "./Modal";
import { Banner, Button, Card, SectionLabel, Spinner, Textarea } from "./ui";
import { ApiError } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { SMS_STATUS_LABEL, smsApi, smsCounter, type SmsMessage, type SmsPreview, type SmsStatus } from "../lib/sms";

/**
 * SMS клиенту в карточке заказа: что уже отправляли и кнопка «Написать SMS».
 * Карточки нет вовсе, пока SMS не подключены и ничего не отправляли.
 */

const STATUS_TONE: Record<SmsStatus, string> = {
  QUEUED: "text-state-waiting",
  SENT: "text-state-progress",
  DELIVERED: "text-state-done",
  FAILED: "text-state-off",
};

export function OrderSms({ orderId, version, onSent }: { orderId: string; version: number; onSent: () => void }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof smsApi.order>> | null>(null);
  const [writing, setWriting] = useState(false);

  const load = useCallback(() => smsApi.order(orderId).then(setData).catch(() => setData(null)), [orderId]);

  useEffect(() => {
    void load();
  }, [load, version]);

  // Пока есть неокончательные — переспрашиваем: телефон-шлюз отправляет за секунды, доставка — до минуты.
  const pending = !!data?.messages.some((m) => m.status === "QUEUED" || m.status === "SENT");
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [pending, load]);

  if (!data || (!data.enabled && data.messages.length === 0)) return null;

  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <SectionLabel>SMS клиенту</SectionLabel>
        {data.canSend && data.hasPhone && (
          <Button type="button" variant="secondary" className="min-h-[34px] px-3 text-[13px]" onClick={() => setWriting(true)}>
            Написать SMS
          </Button>
        )}
      </div>
      {data.canSend && !data.hasPhone && (
        <p className="mt-2 text-[13px] text-ink-dim">У клиента не указан телефон — SMS отправить некуда.</p>
      )}
      {data.messages.length === 0 ? (
        <p className="mt-3 text-[13.5px] text-ink-dim">Пока не отправляли.</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {data.messages.map((m) => (
            <li key={m.id} className="border-t border-line pt-3 first:border-t-0 first:pt-0">
              <p className="flex flex-wrap items-center gap-x-2 text-[12.5px] text-ink-dim">
                <span>{formatDateTime(m.createdAt)}</span>
                <span className={"font-semibold " + STATUS_TONE[m.status]}>{SMS_STATUS_LABEL[m.status]}</span>
                {m.author && <span>· {m.author}</span>}
                <span>· {m.phone}</span>
              </p>
              <p className="mt-1 whitespace-pre-wrap text-[14px] leading-snug">{m.text}</p>
              {m.status === "FAILED" && m.error && <p className="mt-1 text-[12.5px] text-state-off">{m.error}</p>}
            </li>
          ))}
        </ul>
      )}
      {writing && (
        <SmsModal
          orderId={orderId}
          kind="free"
          onClose={() => setWriting(false)}
          onSent={() => {
            setWriting(false);
            void load();
            onSent();
          }}
        />
      )}
    </Card>
  );
}

/**
 * Окно отправки. kind="ready" — предложение после «Готов к выдаче», текст уже
 * собран по шаблону; "free" — из кнопки, можно выбрать шаблон или писать своё.
 */
export function SmsModal({
  orderId,
  kind,
  onClose,
  onSent,
}: {
  orderId: string;
  kind: "ready" | "free";
  onClose: () => void;
  onSent: (m: SmsMessage) => void;
}) {
  const [preview, setPreview] = useState<SmsPreview | null>(null);
  const [mode, setMode] = useState<"ready" | "free">(kind);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    smsApi
      .preview(orderId, "ready")
      .then((p) => {
        setPreview(p);
        setText(kind === "ready" ? p.templates.ready : "");
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Не удалось подготовить SMS"));
  }, [orderId, kind]);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const r = await smsApi.send(orderId, text.trim(), mode);
      onSent(r.message);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "SMS не отправлена");
      setBusy(false);
    }
  }

  return (
    <Modal title={kind === "ready" ? "Отправить SMS клиенту?" : "SMS клиенту"} onClose={onClose}>
      {!preview && !error ? (
        <Spinner />
      ) : (
        <div className="space-y-4">
          {error && <Banner tone="error">{error}</Banner>}
          {preview && (
            <>
              {kind === "ready" && (
                <p className="text-[14px] text-ink-soft">Заказ готов к выдаче — сообщить клиенту?</p>
              )}
              <p className="text-[14px]">
                <span className="text-ink-dim">Кому: </span>
                <span className="font-semibold">{[preview.customer, preview.phone].filter(Boolean).join(" · ") || "—"}</span>
              </p>
              <div className="flex flex-wrap gap-1.5">
                {(["ready", "free"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={mode === m}
                    onClick={() => {
                      setMode(m);
                      setText(m === "ready" ? preview.templates.ready : "");
                    }}
                    className={
                      "rounded-pill border px-3.5 py-1.5 text-[13px] font-semibold transition-colors duration-150 " +
                      (mode === m ? "border-brand bg-brand text-white" : "border-line bg-surface-raised text-ink-muted hover:text-ink")
                    }
                  >
                    {m === "ready" ? "Готов к выдаче" : "Свой текст"}
                  </button>
                ))}
              </div>
              <div>
                <Textarea
                  aria-label="Текст SMS"
                  value={text}
                  maxLength={1000}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="Текст сообщения"
                />
                <p className="mt-1.5 text-[12.5px] text-ink-dim">{smsCounter(text)}</p>
              </div>
            </>
          )}
          <div className="flex flex-col gap-2 sm:flex-row-reverse">
            <Button type="button" disabled={busy || !text.trim() || !preview?.phone} onClick={() => void send()} className="sm:flex-1">
              {busy ? "Отправляем…" : "Отправить"}
            </Button>
            <Button type="button" variant="secondary" onClick={onClose} className="sm:flex-1">
              {kind === "ready" ? "Не сейчас" : "Отмена"}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
