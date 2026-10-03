import type { Prisma } from "@prisma/client";
import { matchableSerial, realSerial } from "../../lib/serial";

/**
 * История техники: прошлые заказы того же устройства и с тем же серийным
 * номером.
 *
 * Устройство — карточка `Device`: её заводит приём и переиспользует, когда
 * приёмщик выбирает «Эта техника» из прошлых заказов клиента. Но в старых
 * базах и при ручном вводе одна и та же вещь бывает заведена дважды —
 * поэтому ищем ещё и по серийному номеру, без учёта регистра. Заглушки
 * («N/N», «нет») и короткие номера не сличаем (lib/serial.ts): иначе пятьсот
 * чужих заказов оказались бы «историей» одного телефона.
 *
 * Серийный совпал у другого клиента — показываем с пометкой: техника могла
 * сменить хозяина, и прошлый ремонт всё равно важен мастеру.
 */

export type Outcome = "ok" | "no" | "work";

export const historySelect = {
  id: true,
  number: true,
  kind: true,
  customerId: true,
  deviceId: true,
  acceptedAt: true,
  completedAt: true,
  issuedAt: true,
  complaint: true,
  diagnosis: true,
  status: { select: { name: true, group: true, color: true } },
  device: { select: { id: true, kind: true, brand: true, model: true, serial: true } },
  assignedMaster: { select: { fullName: true } },
} satisfies Prisma.OrderSelect;

type Row = Prisma.OrderGetPayload<{ select: typeof historySelect }>;

/** Итог заказа — то же правило, что в статистике (stats.sql.ts). */
export function outcomeOf(o: { completedAt: Date | null; issuedAt: Date | null; status: { group: string } }): Outcome {
  if (o.completedAt && o.status.group !== "CANCELLED") return "ok";
  if (o.status.group === "CANCELLED" || (o.issuedAt && !o.completedAt)) return "no";
  return "work";
}

const short = (s: string | null | undefined, n = 140) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export function historyRow(o: Row, extra: Record<string, unknown> = {}) {
  return {
    id: o.id,
    number: o.number,
    kind: o.kind,
    acceptedAt: o.acceptedAt,
    completedAt: o.completedAt,
    issuedAt: o.issuedAt,
    status: o.status,
    outcome: outcomeOf(o),
    complaint: short(o.complaint),
    diagnosis: short(o.diagnosis),
    master: o.assignedMaster?.fullName ?? null,
    device: o.device,
    ...extra,
  };
}

/** Прошлые и другие заказы той же техники, что у заказа `order`, — новые сверху. */
export async function deviceHistory(
  tx: Prisma.TransactionClient,
  order: { id: string; customerId: string; deviceId: string | null },
  limit = 50
) {
  const device = order.deviceId
    ? await tx.device.findFirst({ where: { id: order.deviceId }, select: { serial: true } })
    : null;
  const serial = realSerial(device?.serial);
  const bySerial = matchableSerial(serial);
  if (!order.deviceId && !bySerial) return [];

  const rows = await tx.order.findMany({
    where: {
      deletedAt: null,
      id: { not: order.id },
      OR: [
        ...(order.deviceId ? [{ deviceId: order.deviceId }] : []),
        ...(bySerial ? [{ device: { is: { serial: { equals: serial, mode: "insensitive" as const } } } }] : []),
      ],
    },
    select: historySelect,
    orderBy: { acceptedAt: "desc" },
    take: limit,
  });
  return rows.map((o) =>
    historyRow(o, {
      sameDevice: !!order.deviceId && o.deviceId === order.deviceId,
      otherCustomer: o.customerId !== order.customerId,
    })
  );
}

/**
 * Техника клиента для приёма: каждое устройство — с его заказами, новые
 * сверху. Одна вещь, чинившаяся трижды, — одна строка «ремонтов: 3».
 */
export async function customerDevices(tx: Prisma.TransactionClient, customerId: string) {
  const orders = await tx.order.findMany({
    where: { customerId, deletedAt: null },
    select: historySelect,
    orderBy: { acceptedAt: "desc" },
    take: 300,
  });
  const groups = new Map<string, { device: Row["device"]; orders: ReturnType<typeof historyRow>[] }>();
  for (const o of orders) {
    // Заказ без карточки техники (старые базы) — сам себе группа.
    const key = o.deviceId ?? `order:${o.id}`;
    const g = groups.get(key) ?? { device: o.device, orders: [] };
    g.orders.push(historyRow(o));
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => ({ device: g.device, orders: g.orders, last: g.orders[0].acceptedAt }));
}
