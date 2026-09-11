import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { Modal } from "../components/Modal";
import { IconPlus, IconPurchases } from "../components/icons";
import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  List,
  ListRow,
  PageHeader,
  Spinner,
  StatusGlyph,
  type GlyphTone,
} from "../components/ui";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatDateShort, plural } from "../lib/format";
import { money } from "../lib/orders";
import { purchasesApi, type Purchase, type PurchaseStatus } from "../lib/workshop";

/**
 * Закупки.
 *
 * Экран нужен двоим сразу. Мастер приходит сюда сказать «нужна деталь» и
 * увидеть, что с его просьбой стало. Управляющий — решить и не забыть
 * оприходовать купленное. Поэтому кнопка на строке всегда одна и та же:
 * следующее действие именно для этого человека и именно в этом состоянии.
 */

const FILTERS = [
  { value: "", label: "Все" },
  { value: "PENDING", label: "На согласовании" },
  { value: "APPROVED", label: "Согласованы" },
  { value: "ORDERED", label: "Заказано" },
  { value: "RECEIVED", label: "Получено" },
  { value: "REJECTED", label: "Отклонены" },
] as const;

const TONE: Record<PurchaseStatus, GlyphTone> = {
  DRAFT: "neutral",
  PENDING: "waiting",
  APPROVED: "progress",
  ORDERED: "progress",
  RECEIVED: "done",
  REJECTED: "cancelled",
};

const TEXT_TONE: Record<PurchaseStatus, string> = {
  DRAFT: "text-ink-muted",
  PENDING: "text-[#EFC079]",
  APPROVED: "text-[#79D2E2]",
  ORDERED: "text-[#79D2E2]",
  RECEIVED: "text-[#72D6A6]",
  REJECTED: "text-[#EE9494]",
};

export default function Purchases() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [rows, setRows] = useState<Purchase[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [rejecting, setRejecting] = useState<Purchase | null>(null);
  const [receiving, setReceiving] = useState<Purchase | null>(null);

  const status = params.get("status") ?? "";
  const canCreate = can("purchases.create");
  const canApprove = can("purchases.approve");

  const setStatus = (next: string) => {
    const p = new URLSearchParams(params);
    if (next) p.set("status", next);
    else p.delete("status");
    setParams(p, { replace: true });
  };

  const load = useCallback(async () => {
    try {
      setRows(await purchasesApi.list(status ? { status } : {}));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось загрузить заявки");
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  async function approve(p: Purchase) {
    await purchasesApi.approve(p.id);
    await load();
  }

  if (error) return <Banner tone="error">{error}</Banner>;

  const pending = rows?.filter((r) => r.status === "PENDING").length ?? 0;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Мастерская"
        title="Закупки"
        subtitle="Мастер просит деталь, управляющий согласовывает, полученное встаёт на склад."
        actions={
          canCreate && (
            <Button icon={<IconPlus />} onClick={() => setCreating(true)}>
              Новая заявка
            </Button>
          )
        }
      />

      <Card className="p-3.5">
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setStatus(f.value)}
              className={
                "rounded-pill px-3.5 py-1.5 text-[13px] font-semibold transition-colors duration-150 " +
                (status === f.value
                  ? "bg-brand text-white"
                  : "border border-line bg-surface-raised text-ink-muted hover:text-ink")
              }
            >
              {f.label}
            </button>
          ))}
        </div>
      </Card>

      {canApprove && pending > 0 && status !== "PENDING" && (
        <Banner tone="warning">
          {plural(pending, "заявка ждёт", "заявки ждут", "заявок ждут")} вашего решения.
        </Banner>
      )}

      {!rows ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<IconPurchases />}
          title={status ? "Таких заявок нет" : "Заявок пока нет"}
          action={
            canCreate && !status ? (
              <Button icon={<IconPlus />} onClick={() => setCreating(true)}>
                Создать первую
              </Button>
            ) : undefined
          }
        >
          {status
            ? "Снимите фильтр, чтобы увидеть остальные."
            : "Мастеру не нужно искать управляющего по мастерской: он пишет, что купить, и заявка приходит на согласование."}
        </EmptyState>
      ) : (
        <List>
          {rows.map((r) => (
            <ListRow
              key={r.id}
              glyph={<StatusGlyph tone={TONE[r.status]} title={r.statusLabel} icon={<IconPurchases />} />}
              title={
                <>
                  <span className="font-mono text-[14px] text-ink-soft">{r.number}</span>
                  <span className="truncate">
                    {r.items[0]?.name ?? "без позиций"}
                    {r.items.length > 1 && (
                      <span className="text-ink-dim"> и ещё {r.items.length - 1}</span>
                    )}
                  </span>
                  {r.order && <Badge>к заказу {r.order.number}</Badge>}
                </>
              }
              subtitle={
                <>
                  {r.createdBy?.fullName ?? "—"}
                  {r.comment ? ` · ${r.comment}` : ""}
                  {r.status === "REJECTED" && r.rejectionReason && (
                    <span className="text-state-off"> · отказ: {r.rejectionReason}</span>
                  )}
                </>
              }
              meta={
                <>
                  <span className={"whitespace-nowrap font-semibold lg:w-[132px] lg:text-right " + TEXT_TONE[r.status]}>
                    {r.statusLabel}
                  </span>
                  <span className="whitespace-nowrap lg:w-[96px] lg:text-right">
                    {r.total > 0 ? money(r.total) : "—"}
                  </span>
                  <span className="whitespace-nowrap lg:w-[76px] lg:text-right">
                    {formatDateShort(r.createdAt)}
                  </span>
                </>
              }
              actions={
                canApprove && r.status !== "RECEIVED" ? (
                  <div className="flex flex-wrap gap-1.5 sm:min-w-[212px] sm:justify-end">
                    {r.status === "PENDING" && (
                      <>
                        <Button
                          variant="secondary"
                          className="min-h-[34px] px-3 text-[13px]"
                          onClick={() => void approve(r)}
                        >
                          Согласовать
                        </Button>
                        <Button
                          variant="danger"
                          className="min-h-[34px] px-3 text-[13px]"
                          onClick={() => setRejecting(r)}
                        >
                          Отклонить
                        </Button>
                      </>
                    )}
                    {(r.status === "APPROVED" || r.status === "ORDERED") && (
                      <Button
                        className="min-h-[34px] px-3 text-[13px]"
                        onClick={() => setReceiving(r)}
                      >
                        Оприходовать
                      </Button>
                    )}
                  </div>
                ) : undefined
              }
            />
          ))}
        </List>
      )}

      {creating && (
        <CreateModal
          onClose={() => setCreating(false)}
          onDone={() => {
            setCreating(false);
            void load();
          }}
        />
      )}

      {rejecting && (
        <RejectModal
          request={rejecting}
          onClose={() => setRejecting(null)}
          onDone={() => {
            setRejecting(null);
            void load();
          }}
        />
      )}

      {receiving && (
        <ReceiveModal
          request={receiving}
          onClose={() => setReceiving(null)}
          onDone={() => {
            setReceiving(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ окна

interface DraftItem {
  name: string;
  qty: string;
  unit: string;
  price: string;
}

const emptyItem = (): DraftItem => ({ name: "", qty: "1", unit: "шт", price: "" });

function CreateModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [items, setItems] = useState<DraftItem[]>([emptyItem()]);
  const [comment, setComment] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  const patch = (idx: number, key: keyof DraftItem, value: string) =>
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, [key]: value } : it)));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await purchasesApi.create({
        comment: comment || undefined,
        items: items
          .filter((i) => i.name.trim())
          .map((i) => ({
            name: i.name.trim(),
            qty: Number(i.qty.replace(",", ".")) || 1,
            unit: i.unit || "шт",
            ...(i.price ? { expectedPrice: Number(i.price.replace(",", ".")) } : {}),
          })),
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "Сервер недоступен"));
    } finally {
      setBusy(false);
    }
  }

  const total = items.reduce(
    (n, i) => n + (Number(i.qty.replace(",", ".")) || 0) * (Number(i.price.replace(",", ".")) || 0),
    0
  );

  return (
    <Modal title="Заявка на закупку" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Banner tone="error">{error.message}</Banner>}

        <div className="space-y-3">
          {items.map((it, idx) => (
            <div key={idx} className="rounded-card border border-line p-3">
              <Field label={`Позиция ${idx + 1}`}>
                <Input
                  value={it.name}
                  onChange={(e) => patch(idx, "name", e.target.value)}
                  placeholder="Что купить — так, чтобы понял тот, кто пойдёт покупать"
                  autoFocus={idx === 0}
                />
              </Field>
              <div className="mt-3 grid grid-cols-3 gap-2">
                <Field label="Сколько">
                  <Input value={it.qty} onChange={(e) => patch(idx, "qty", e.target.value)} inputMode="decimal" />
                </Field>
                <Field label="Единица">
                  <Input value={it.unit} onChange={(e) => patch(idx, "unit", e.target.value)} />
                </Field>
                <Field label="Цена, ₽">
                  <Input value={it.price} onChange={(e) => patch(idx, "price", e.target.value)} inputMode="decimal" />
                </Field>
              </div>
              {items.length > 1 && (
                <button
                  type="button"
                  onClick={() => setItems((prev) => prev.filter((_, i) => i !== idx))}
                  className="mt-2 text-[12.5px] font-semibold text-state-off hover:underline"
                >
                  Убрать позицию
                </button>
              )}
            </div>
          ))}
          <Button
            type="button"
            variant="secondary"
            icon={<IconPlus />}
            onClick={() => setItems((prev) => [...prev, emptyItem()])}
          >
            Ещё позиция
          </Button>
        </div>

        <Field label="Комментарий" hint="Зачем нужно и к какому сроку — тому, кто будет согласовывать">
          <Input value={comment} onChange={(e) => setComment(e.target.value)} />
        </Field>

        {total > 0 && (
          <p className="text-[13.5px] text-ink-muted">
            Ориентировочно <b className="text-ink">{money(total)}</b>
          </p>
        )}

        <div className="flex flex-col gap-2 pt-2 sm:flex-row-reverse">
          <Button type="submit" disabled={busy} className="sm:flex-1">
            {busy ? "Отправляем…" : "Отправить на согласование"}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose} className="sm:flex-1">
            Отмена
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function RejectModal({
  request,
  onClose,
  onDone,
}: {
  request: Purchase;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await purchasesApi.reject(request.id, reason);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "Сервер недоступен"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Отклонить ${request.number}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Banner>Причину увидит тот, кто создавал заявку. Без неё он придёт спрашивать лично.</Banner>
        {error && <Banner tone="error">{error.message}</Banner>}
        <Field label="Почему отказ" error={error?.field("reason")}>
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Дорого, есть на складе, обойдёмся"
            autoFocus
          />
        </Field>
        <div className="flex flex-col gap-2 pt-2 sm:flex-row-reverse">
          <Button type="submit" variant="danger" disabled={busy} className="sm:flex-1">
            {busy ? "Отклоняем…" : "Отклонить"}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose} className="sm:flex-1">
            Отмена
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function ReceiveModal({
  request,
  onClose,
  onDone,
}: {
  request: Purchase;
  onClose: () => void;
  onDone: () => void;
}) {
  // По умолчанию подставляем недополученное: чаще всего привозят ровно то,
  // что заказывали, и человеку остаётся только нажать «оприходовать».
  const [lines, setLines] = useState(() =>
    request.items.map((i) => ({
      id: i.id,
      name: i.name,
      unit: i.unit,
      qty: String(Math.max(0, i.qty - i.receivedQty)),
      price: i.expectedPrice ? String(i.expectedPrice) : "",
    }))
  );
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  const patch = (idx: number, key: "qty" | "price", value: string) =>
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, [key]: value } : l)));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await purchasesApi.receive(
        request.id,
        lines.map((l) => ({
          id: l.id,
          qty: Number(l.qty.replace(",", ".")) || 0,
          ...(l.price ? { price: Number(l.price.replace(",", ".")) } : {}),
        }))
      );
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "Сервер недоступен"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Приход по ${request.number}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Banner>
          Позиции встанут на склад с указанной ценой. Если чего-то не привезли — поставьте ноль, заявка
          останется открытой.
        </Banner>
        {error && <Banner tone="error">{error.message}</Banner>}

        <div className="space-y-2.5">
          {lines.map((l, idx) => (
            <div key={l.id} className="rounded-card border border-line p-3">
              <p className="text-[14px] font-semibold">{l.name}</p>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <Field label={`Получено, ${l.unit}`}>
                  <Input value={l.qty} onChange={(e) => patch(idx, "qty", e.target.value)} inputMode="decimal" />
                </Field>
                <Field label="Цена за единицу, ₽">
                  <Input value={l.price} onChange={(e) => patch(idx, "price", e.target.value)} inputMode="decimal" />
                </Field>
              </div>
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-2 pt-2 sm:flex-row-reverse">
          <Button type="submit" disabled={busy} className="sm:flex-1">
            {busy ? "Приходуем…" : "Оприходовать"}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose} className="sm:flex-1">
            Отмена
          </Button>
        </div>
      </form>
    </Modal>
  );
}
