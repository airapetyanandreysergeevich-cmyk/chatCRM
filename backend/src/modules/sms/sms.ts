import type { Prisma, SmsStatus } from "@prisma/client";
import { withTenant } from "../../lib/db";
import * as gateway from "../../lib/semysms";

/**
 * SMS клиентам через SemySMS: настройки мастерской, шаблоны, отправка и
 * статусы. Маршруты — в sms.routes.ts, предложение «отправить SMS» после
 * «Готов к выдаче» — readyHint() из orders.routes.ts.
 *
 * Сеть — всегда вне транзакции (claude/grabli.md, «Сеть внутри транзакции»):
 * сначала запись «в очереди», потом запрос к SemySMS, потом итог отдельной
 * короткой транзакцией.
 */

export const KIND = "semysms";
export const ON_READY = ["ask", "auto", "off"] as const;
export type OnReady = (typeof ON_READY)[number];

export const DEFAULT_TEMPLATES = {
  ready: "Здравствуйте! Ваш {техника} (заказ {номер}) готов к выдаче. {мастерская}",
};
export type TemplateKey = keyof typeof DEFAULT_TEMPLATES;

/** Подстановки шаблона — те же подсказки показывает интерфейс. */
export const PLACEHOLDERS = ["{клиент}", "{номер}", "{техника}", "{сумма}", "{мастерская}"] as const;

export interface SmsConfig {
  /** Код телефона в SemySMS или "active" — любой включённый. */
  device: string;
  deviceName: string | null;
  onReady: OnReady;
  templates: { ready: string | null };
}

export interface SmsSettings extends SmsConfig {
  enabled: boolean;
  token: string | null;
}

function readConfig(raw: unknown): SmsConfig {
  const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const t = (c.templates && typeof c.templates === "object" ? c.templates : {}) as Record<string, unknown>;
  return {
    device: typeof c.device === "string" && c.device.trim() ? c.device.trim() : "active",
    deviceName: typeof c.deviceName === "string" && c.deviceName.trim() ? c.deviceName.trim() : null,
    onReady: ON_READY.includes(c.onReady as OnReady) ? (c.onReady as OnReady) : "ask",
    templates: { ready: typeof t.ready === "string" && t.ready.trim() ? t.ready : null },
  };
}

export async function loadSettings(tx: Prisma.TransactionClient): Promise<SmsSettings> {
  const row = await tx.integration.findFirst({ where: { kind: KIND } });
  return { enabled: !!row?.enabled, token: row?.secret ?? null, ...readConfig(row?.config) };
}

/** Готово ли к отправке: включено, есть ключ. */
export const ready = (s: SmsSettings): s is SmsSettings & { token: string } => s.enabled && !!s.token;

/** Ключ в интерфейсе — только последние четыре знака. */
export const tokenHint = (token: string | null) => (token ? `•••• ${token.slice(-4)}` : null);

export const templateOf = (s: SmsSettings, key: TemplateKey) => s.templates[key] ?? DEFAULT_TEMPLATES[key];

const rub = (n: number) => `${Math.round(n).toLocaleString("ru-RU").replace(/ /g, " ")} ₽`;

/** Данные заказа для подстановок и номер клиента. */
export async function orderFacts(tx: Prisma.TransactionClient, tenantId: string, orderId: string) {
  const order = await tx.order.findFirst({
    where: { id: orderId, deletedAt: null },
    select: {
      id: true,
      number: true,
      total: true,
      assignedMasterId: true,
      customer: { select: { id: true, name: true, phone: true } },
      device: { select: { kind: true, brand: true, model: true } },
    },
  });
  if (!order) return null;
  const paid = await tx.transaction.groupBy({
    by: ["direction"],
    where: { deletedAt: null, orderId: order.id },
    _sum: { amount: true },
  });
  const sum = (dir: "IN" | "OUT") => Number(paid.find((p) => p.direction === dir)?._sum.amount ?? 0);
  const due = Math.max(0, Number(order.total ?? 0) - (sum("IN") - sum("OUT")));
  const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { name: true, settings: true } });
  const print = ((tenant?.settings as Record<string, unknown> | null)?.print ?? {}) as Record<string, unknown>;
  const workshop = (typeof print.name === "string" && print.name.trim()) || tenant?.name || "";
  const kind = order.device?.kind?.trim() ?? "";
  // «Ноутбук» в середине фразы — со строчной: «Ваш ноутбук Lenovo готов».
  const device = [kind ? kind.charAt(0).toLocaleLowerCase("ru-RU") + kind.slice(1) : "", order.device?.brand, order.device?.model]
    .filter(Boolean)
    .join(" ") || "техника";
  return {
    order,
    values: {
      "{клиент}": order.customer?.name ?? "",
      "{номер}": order.number,
      "{техника}": device,
      "{сумма}": rub(due),
      "{мастерская}": workshop,
    } as Record<string, string>,
    phone: gateway.gatewayPhone(order.customer?.phone),
  };
}

export function render(template: string, values: Record<string, string>): string {
  let out = template;
  for (const [k, v] of Object.entries(values)) out = out.split(k).join(v);
  return out.replace(/[ \t]+/g, " ").replace(/ +([,.!?])/g, "$1").trim();
}

/** Номер для глаз сотрудника без доступа к контактам: только последние цифры. */
export const maskPhone = (phone: string) => `•••${phone.slice(-4)}`;

export interface SmsView {
  id: string;
  kind: string;
  text: string;
  phone: string;
  status: SmsStatus;
  error: string | null;
  createdAt: Date;
  author: string | null;
}

/**
 * Отправить и записать. Сначала строка «в очереди» — чтобы попытка осталась в
 * истории, даже если сеть оборвётся на полпути, — потом запрос к шлюзу.
 */
export async function sendSms(
  tenantId: string,
  settings: SmsSettings & { token: string },
  msg: { orderId?: string | null; customerId?: string | null; phone: string; text: string; kind: string; userId?: string | null }
) {
  const row = await withTenant(tenantId, (tx) =>
    tx.smsMessage.create({
      data: {
        tenantId,
        orderId: msg.orderId ?? null,
        customerId: msg.customerId ?? null,
        phone: msg.phone,
        text: msg.text,
        kind: msg.kind,
        createdById: msg.userId ?? null,
      },
    })
  );
  try {
    const providerId = await gateway.send(settings.token, settings.device, msg.phone, msg.text);
    return await withTenant(tenantId, (tx) => tx.smsMessage.update({ where: { id: row.id }, data: { providerId } }));
  } catch (err) {
    const error = err instanceof gateway.SmsGatewayError ? err.message : "Не удалось отправить SMS";
    return await withTenant(tenantId, (tx) =>
      tx.smsMessage.update({ where: { id: row.id }, data: { status: "FAILED", error } })
    );
  }
}

/** Как часто спрашивать SemySMS о статусах одного и того же сообщения. */
const CHECK_EVERY_MS = 20_000;
/** Старше — уже не спрашиваем: телефон за трое суток либо отправил, либо нет. */
const CHECK_WITHIN_MS = 3 * 24 * 60 * 60 * 1000;

/** Освежить статусы неокончательных сообщений. Ошибка шлюза статусы не трогает. */
export async function refreshStatuses(tenantId: string, settings: SmsSettings, where: Prisma.SmsMessageWhereInput) {
  if (!settings.token) return;
  const now = Date.now();
  const pending = await withTenant(tenantId, (tx) =>
    tx.smsMessage.findMany({
      where: {
        ...where,
        status: { in: ["QUEUED", "SENT"] },
        providerId: { not: null },
        createdAt: { gte: new Date(now - CHECK_WITHIN_MS) },
        OR: [{ checkedAt: null }, { checkedAt: { lt: new Date(now - CHECK_EVERY_MS) } }],
      },
      select: { id: true, providerId: true, status: true, createdAt: true },
      take: 50,
    })
  );
  if (!pending.length) return;
  let states: gateway.GatewayStatus[];
  try {
    const since = new Date(Math.min(...pending.map((p) => p.createdAt.getTime())));
    states = await gateway.outbox(settings.token, pending.map((p) => p.providerId!), since);
  } catch {
    return;
  }
  const byId = new Map(states.map((s) => [s.id, s]));
  await withTenant(tenantId, async (tx) => {
    for (const p of pending) {
      const s = byId.get(p.providerId!);
      const status: SmsStatus = !s
        ? p.status
        : s.failed
          ? "FAILED"
          : s.delivered
            ? "DELIVERED"
            : s.sent
              ? "SENT"
              : "QUEUED";
      await tx.smsMessage.update({
        where: { id: p.id },
        data: {
          checkedAt: new Date(),
          status,
          ...(status === "FAILED" && p.status !== "FAILED" ? { error: "Телефон-шлюз не отправил SMS" } : {}),
        },
      });
    }
  });
}
