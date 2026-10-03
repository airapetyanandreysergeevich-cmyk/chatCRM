import { useEffect, useState } from "react";
import { ApiError } from "../lib/api";
import { formatDate } from "../lib/format";
import { ordersApi, type CustomerDevice } from "../lib/orders";
import { deviceName, OUTCOME_LABEL } from "./DeviceHistory";
import { Banner, Button, Spinner } from "./ui";

/**
 * Прошлые заказы клиента при приёме — по технике.
 *
 * Клиент принёс ту же вещь снова: «Эта техника» переносит тип, марку, модель
 * и серийный в новый заказ и привязывает его к той же карточке устройства —
 * история ремонтов вещи не рвётся. Номер заказа открывает его окном поверх
 * приёма (OrderPeek), набранное на бланке остаётся на месте.
 */
export function CustomerDevices({
  customerId,
  pickedId,
  onPick,
  onPeek,
}: {
  customerId: string;
  pickedId: string | null;
  onPick: (d: NonNullable<CustomerDevice["device"]>, from: { id: string; number: string }) => void;
  onPeek: (orderId: string) => void;
}) {
  const [items, setItems] = useState<CustomerDevice[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setItems(null);
    setError(null);
    ordersApi
      .customerDevices(customerId)
      .then((r) => setItems(r.items))
      .catch((err) => setError(err instanceof ApiError ? err.message : "Не удалось загрузить заказы клиента"));
  }, [customerId]);

  if (error) return <Banner tone="error">{error}</Banner>;
  if (!items) return <Spinner label="Заказы клиента" />;
  if (!items.length) return <p className="text-[13px] text-ink-dim">Прошлых заказов нет</p>;

  return (
    <ul className="divide-y divide-line overflow-hidden rounded-field border border-line" aria-label="Прошлые заказы клиента">
      {items.map((g) => {
        const last = g.orders[0];
        const o = OUTCOME_LABEL[last.outcome];
        const chosen = !!g.device && g.device.id === pickedId;
        return (
          <li key={g.device?.id ?? last.id} className={"flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center " + (chosen ? "bg-brand-tint" : "")}>
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-semibold">
                {deviceName(g.device)}
                {g.device?.serial && <span className="ml-2 font-mono text-[12.5px] font-normal text-ink-muted">S/N {g.device.serial}</span>}
              </p>
              <p className="mt-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12.5px] text-ink-dim">
                <span>{g.orders.length > 1 ? `ремонтов: ${g.orders.length} —` : "заказ"}</span>
                {g.orders.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => onPeek(r.id)}
                    title={`${r.complaint}${r.diagnosis ? ` → ${r.diagnosis}` : ""}`}
                    className="font-mono font-semibold text-brand-ink hover:underline"
                  >
                    {r.number}
                  </button>
                ))}
              </p>
              <p className="mt-0.5 text-[12.5px] text-ink-dim">
                последний — {formatDate(last.acceptedAt)}, <span className={o.cls}>{o.label}</span>
              </p>
            </div>
            {g.device && (
              <Button
                type="button"
                variant={chosen ? "primary" : "secondary"}
                onClick={() => onPick(g.device!, { id: last.id, number: last.number })}
                className="shrink-0 px-3.5 text-[13px]"
              >
                {chosen ? "Выбрана" : "Эта техника"}
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
