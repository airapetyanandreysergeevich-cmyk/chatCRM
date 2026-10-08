import { useState } from "react";
import { ApiError } from "../lib/api";
import { formatDate } from "../lib/format";
import { ordersApi, type OrderStatus } from "../lib/orders";
import { Modal } from "./Modal";
import { Banner, Button, Field, Input, Select } from "./ui";

/**
 * «Вернуть в работу» выданный заказ.
 *
 * Клиент забрал технику и вернулся: забыл сказать о второй неисправности,
 * нужно доделать. Выдача снимается, первая остаётся в истории; заказ встаёт
 * в выбранный статус. Добавленное после этого при повторной выдаче
 * печатается «Актом доплаты» (backend orders/reopen.ts).
 *
 * Причина обязательна, но короткая: по ней потом понятно, почему заказ
 * выдавали дважды.
 */

/** В какие статусы можно вернуть: всё, кроме «Выдан» и «Отменён». */
export const reopenTargets = (statuses: OrderStatus[]) =>
  statuses.filter((s) => s.group !== "CLOSED" && s.group !== "CANCELLED");

export function ReopenDialog({
  order,
  statuses,
  statusId,
  onClose,
  onDone,
}: {
  order: { id: string; number: string; issuedAt?: string | null };
  /** Статусы мастерской; нет — сервер возьмёт первый статус «Ремонта». */
  statuses?: OrderStatus[];
  /** Выбрали статус в списке — он и предложен. */
  statusId?: string;
  onClose: () => void;
  onDone: () => void | Promise<void>;
}) {
  const targets = statuses ? reopenTargets(statuses) : [];
  const preferred = statusId ?? targets.find((s) => s.group === "IN_PROGRESS")?.id ?? targets[0]?.id ?? "";
  const [to, setTo] = useState(preferred);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = reason.trim().length >= 2;

  async function submit() {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await ordersApi.reopen(order.id, reason.trim(), to || undefined);
      await onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не получилось вернуть заказ в работу");
      setBusy(false);
    }
  }

  return (
    <Modal title={`Вернуть в работу · ${order.number}`} onClose={onClose}>
      <form
        className="space-y-4"
        data-reopen
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className="text-[14px] leading-relaxed text-ink-soft">
          {order.issuedAt ? `Выдан ${formatDate(order.issuedAt)} — выдача снимется` : "Выдача снимется"}, заказ снова
          будет в работе. Добавите работы или запчасти — при повторной выдаче распечатаете «Акт доплаты».
        </p>
        <Field label="Что нужно доделать">
          <Input
            value={reason}
            autoFocus
            maxLength={300}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Клиент вернулся: не работает звук"
          />
        </Field>
        {targets.length > 0 && (
          <Field label="Статус">
            <Select aria-label="Статус после возврата" value={to} onChange={(e) => setTo(e.target.value)}>
              {targets.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {error && <Banner tone="error">{error}</Banner>}
        <div className="flex flex-col gap-2 sm:flex-row-reverse">
          <Button type="submit" disabled={busy || !ready} className="sm:flex-1">
            {busy ? "Возвращаем…" : "Вернуть в работу"}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose} className="sm:flex-1">
            Отмена
          </Button>
        </div>
      </form>
    </Modal>
  );
}
