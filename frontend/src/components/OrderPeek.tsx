import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError } from "../lib/api";
import { formatDate, formatDateTime } from "../lib/format";
import { money, ordersApi, statusPill, ORDER_KIND_LABEL, type PeekOrder } from "../lib/orders";
import { Modal } from "./Modal";
import { Photo } from "./OrderPhoto";
import { PhotoViewer } from "./PhotoViewer";
import { Banner, Button, Spinner, StatusPill } from "./ui";

/**
 * Прошлый заказ окном поверх текущего: посмотреть, что делали, закрыть и
 * вернуться к своему ремонту или приёму. Только чтение.
 *
 * Открывается из истории техники в заказе и из прошлых заказов клиента при
 * приёме. Мастер видит и чужие ремонты (решение Андрея), деньги и контакты —
 * по обычным правам: сервер просто не присылает лишнего.
 */
export function OrderPeek({
  orderId,
  onClose,
  allowOpen = true,
}: {
  orderId: string;
  onClose: () => void;
  /** «Открыть заказ». На приёме кнопки нет: переход потерял бы набранный бланк. */
  allowOpen?: boolean;
}) {
  const navigate = useNavigate();
  const [order, setOrder] = useState<PeekOrder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);

  useEffect(() => {
    setOrder(null);
    setError(null);
    ordersApi
      .peek(orderId)
      .then(setOrder)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Не удалось открыть заказ"));
  }, [orderId]);

  const title = order ? `Заказ ${order.number}` : "Заказ";
  if (viewing !== null && order) {
    const photos = order.attachments.filter((a) => a.kind === "INTAKE" || a.kind === "COMPLETION");
    return (
      <PhotoViewer
        orderId={order.id}
        photos={photos}
        start={Math.min(viewing, photos.length - 1)}
        canDelete={false}
        onDeleted={() => undefined}
        onClose={() => setViewing(null)}
      />
    );
  }

  return (
    <Modal title={title} onClose={onClose} wide>
      {error ? (
        <Banner tone="error">{error}</Banner>
      ) : !order ? (
        <Spinner />
      ) : (
        <PeekBody order={order} onPhoto={setViewing} />
      )}
      <div className="mt-5 flex flex-col gap-2 sm:flex-row-reverse">
        <Button type="button" variant="secondary" onClick={onClose} className="sm:flex-1">
          Закрыть
        </Button>
        {allowOpen && order?.canOpen && (
          <Button type="button" variant="ghost" onClick={() => navigate(`/orders/${order.id}`)} className="sm:flex-1">
            Открыть заказ
          </Button>
        )}
      </div>
    </Modal>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="min-w-0">
      <h3 className="text-[12px] font-bold uppercase tracking-[0.08em] text-ink-dim">{title}</h3>
      <div className="mt-1.5 text-[14px] leading-relaxed">{children}</div>
    </section>
  );
}

function Lines({ items }: { items: Array<[string, ReactNode]> }) {
  const shown = items.filter(([, v]) => v !== null && v !== undefined && v !== "");
  if (!shown.length) return null;
  return (
    <dl className="grid gap-x-4 gap-y-1.5 text-[14px] sm:grid-cols-[auto_1fr]">
      {shown.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-ink-muted">{k}</dt>
          <dd className="min-w-0">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function PeekBody({ order: o, onPhoto }: { order: PeekOrder; onPhoto: (i: number) => void }) {
  const pill = statusPill(o);
  const device = [o.device?.kind, o.device?.brand, o.device?.model].filter((x) => x && x.trim()).join(" ") || "Техника не указана";
  const photos = o.attachments.filter((a) => a.kind === "INTAKE" || a.kind === "COMPLETION");
  const showMoney = o.total !== undefined;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill tone={pill.tone}>{pill.label}</StatusPill>
        {o.kind !== "REPAIR" && <span className="text-[13px] font-semibold text-ink-muted">{ORDER_KIND_LABEL[o.kind]}</span>}
        <span className="text-[13px] text-ink-dim">принят {formatDateTime(o.acceptedAt)}</span>
      </div>

      <Lines
        items={[
          ["Техника", <span key="d" className="font-semibold">{device}</span>],
          ["Серийный номер", o.device?.serial ? <span className="font-mono">{o.device.serial}</span> : null],
          ["Клиент", o.customer.name ?? null],
          ["Мастер", o.assignedMaster?.fullName ?? null],
          ["Готов", o.completedAt ? formatDate(o.completedAt) : null],
          ["Выдан", o.issuedAt ? formatDate(o.issuedAt) : null],
          ["Гарантия до", o.warrantyUntil ? formatDate(o.warrantyUntil) : null],
          ["Комплектность", o.completeness.length ? o.completeness.join(", ") : null],
        ]}
      />

      <div className="grid gap-5 sm:grid-cols-2">
        <Section title="Неисправность со слов клиента">{o.complaint || "—"}</Section>
        <Section title="Диагноз">{o.diagnosis || "—"}</Section>
        {o.masterComment && <Section title="Комментарий мастера">{o.masterComment}</Section>}
        {o.recommendation && <Section title="Рекомендация">{o.recommendation}</Section>}
        {o.internalComment && <Section title="Внутренний комментарий">{o.internalComment}</Section>}
        {o.receptionNote && <Section title="Примечание приёмщика">{o.receptionNote}</Section>}
      </div>

      {(o.works.length > 0 || o.parts.length > 0) && (
        <div className="grid gap-5 sm:grid-cols-2">
          <Section title="Работы">
            {o.works.length ? (
              <ul className="space-y-1">
                {o.works.map((w) => (
                  <li key={w.id} className="flex justify-between gap-3">
                    <span className="min-w-0">
                      {w.name}
                      {w.qty !== 1 && <span className="text-ink-dim"> × {w.qty}</span>}
                    </span>
                    {showMoney && <span className="shrink-0 tabular-nums text-ink-muted">{money(w.price * w.qty)}</span>}
                  </li>
                ))}
              </ul>
            ) : (
              "—"
            )}
          </Section>
          <Section title="Запчасти">
            {o.parts.length ? (
              <ul className="space-y-1">
                {o.parts.map((p) => (
                  <li key={p.id} className="flex justify-between gap-3">
                    <span className="min-w-0">
                      {p.name}
                      {p.qty !== 1 && <span className="text-ink-dim"> × {p.qty}</span>}
                    </span>
                    {showMoney && <span className="shrink-0 tabular-nums text-ink-muted">{money(p.price * p.qty)}</span>}
                  </li>
                ))}
              </ul>
            ) : (
              "—"
            )}
          </Section>
        </div>
      )}
      {showMoney && o.total !== undefined && (
        <p className="text-[14px]">
          <span className="text-ink-muted">Итого: </span>
          <span className="font-bold">{money(o.total)}</span>
        </p>
      )}

      {photos.length > 0 && (
        <Section title="Фотографии">
          <div className="flex flex-wrap gap-2">
            {photos.map((a, i) => (
              <Photo key={a.id} orderId={o.id} attachmentId={a.id} name={a.fileName} onOpen={() => onPhoto(i)} />
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}
