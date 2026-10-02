import type { Prisma, SmsStatus } from "@prisma/client";
import { withTenant } from "../../lib/db";
import * as gateway from "../../lib/semysms";

/**
 * SMS клиентам: настройки мастерской, шаблоны, отправка и статусы. Отправляет
 * либо свой телефон с приложением «FineCRM SMS» (provider "phone",
 * sms.phone.ts), либо SemySMS. Маршруты — в sms.routes.ts, предложение
 * «отправить SMS» после «Готов к выдаче» — readyHint() из orders.routes.ts.
 *
 * Сеть — всегда вне транзакции (claude/grabli.md, «Сеть внутри транзакции»):
 * сначала запись «в очереди», потом запрос к SemySMS, потом итог отдельной
 * короткой транзакцией.
 */

/** Строка подключения в "Integration". Имя историческое: в ней все настройки SMS, не только SemySMS. */
export const KIND = "semysms";
export const PROVIDERS = ["phone", "semysms"] as const;
export type Provider = (typeof PROVIDERS)[number];
export const ON_READY = ["ask", "auto", "off"] as const;
export type OnReady = (typeof ON_READY)[number];

export const DEFAULT_TEMPLATES = {
  ready: "Здравствуйте! Ваш {техника} (заказ {номер}) готов к выдаче. {мастерская}",
};
export type TemplateKey = keyof typeof DEFAULT_TEMPLATES;

/** Подстановки шаблона — те же подсказки показывает интерфейс. */
export const PLACEHOLDERS = ["{клиент}", "{номер}", "{техника}", "{сумма}", "{мастерская}"] as const;

export interface SmsConfig {
  /** Чем отправлять: свой телефон с приложением FineCRM SMS или SemySMS. */
  provider: Provider;
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
    provider: PROVIDERS.includes(c.provider as Provider) ? (c.provider as Provider) : "phone",
    device: typeof c.device === "string" && c.device.trim() ? c.device.trim() : "active",
    deviceName: typeof c.deviceName === "string" && c.deviceName.trim() ? c.deviceName.trim() : null,
    onReady: ON_READY.includes(c.onReady as OnReady) ? (c.onReady as OnReady) : "ask",
    templates: { ready: typeof t.ready === "string" && t.ready.trim() ? t.ready : null },
  };
}

export async function loadSettings(tx: Prisma.TransactionClient): Promise<SmsSettings> {
  const row = await tx.integration.findFirst({ where: { kind: KIND } });
  const config = readConfig(row?.config);
  // Подключали SemySMS до того, как появился выбор, — так и остаётся.
  const raw = (row?.config ?? {}) as Record<string, unknown>;
  if (!raw.provider && row?.secret) config.provider = "semysms";
  return { enabled: !!row?.enabled, token: row?.secret ?? null, ...config };
}

/** Готово ли к отправке: включено и, для SemySMS, есть ключ. Свой телефон проверяется при отправке. */
export const ready = (s: SmsSettings) => s.enabled && (s.provider === "phone" || !!s.token);

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
  settings: SmsSettings,
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
  const fail = (error: string) =>
    withTenant(tenantId, (tx) => tx.smsMessage.update({ where: { id: row.id }, data: { status: "FAILED", error } }));

  // Свой телефон: сообщение ждёт в очереди, телефон заберёт его сам (sms.phone.ts).
  // Если ни один телефон давно не выходил на связь — говорим сразу, а не через полчаса.
  if (settings.provider === "phone") {
    const alive = await withTenant(tenantId, (tx) =>
      tx.smsPhone.count({
        where: { revokedAt: null, tokenHash: { not: null }, lastSeenAt: { gte: new Date(Date.now() - PHONE_GRACE_MS) } },
      })
    );
    return alive ? row : fail("Телефон-шлюз не на связи — проверьте, что он включён и приложение FineCRM SMS запущено");
  }

  if (!settings.token) return fail("Не указан токен SemySMS");
  try {
    const providerId = await gateway.send(settings.token, settings.device, msg.phone, msg.text);
    return await withTenant(tenantId, (tx) => tx.smsMessage.update({ where: { id: row.id }, data: { providerId } }));
  } catch (err) {
    return fail(err instanceof gateway.SmsGatewayError ? err.message : "Не удалось отправить SMS");
  }
}

/** Телефон «есть», если выходил на связь за это время: короткий обрыв сети — не повод отказывать. */
export const PHONE_GRACE_MS = 10 * 60 * 1000;
/** Телефон на связи прямо сейчас: опрос — каждые 25 секунд. */
export const PHONE_ONLINE_MS = 75_000;
/** Никто не забрал за это время — SMS уже неактуальна, лучше сказать честно. */
const PHONE_PICK_TTL_MS = 30 * 60 * 1000;
/** Забрал, но так и не сказал, ушла ли. */
const PHONE_RESULT_TTL_MS = 15 * 60 * 1000;

/** Свой телефон: просроченные сообщения — в «не отправлена» с понятной причиной. */
export async function expirePhoneQueue(tx: Prisma.TransactionClient, where: Prisma.SmsMessageWhereInput = {}) {
  const now = Date.now();
  await tx.smsMessage.updateMany({
    where: { ...where, status: "QUEUED", providerId: null, pickedAt: null, createdAt: { lt: new Date(now - PHONE_PICK_TTL_MS) } },
    data: { status: "FAILED", error: "Телефон-шлюз не забрал SMS за 30 минут — он был выключен или без интернета" },
  });
  await tx.smsMessage.updateMany({
    where: { ...where, status: "QUEUED", providerId: null, pickedAt: { lt: new Date(now - PHONE_RESULT_TTL_MS) } },
    data: { status: "FAILED", error: "Телефон-шлюз забрал SMS, но не сообщил, ушла ли она" },
  });
}

/** Как часто спрашивать SemySMS о статусах одного и того же сообщения. */
const CHECK_EVERY_MS = 20_000;
/** Старше — уже не спрашиваем: телефон за трое суток либо отправил, либо нет. */
const CHECK_WITHIN_MS = 3 * 24 * 60 * 60 * 1000;

/** Освежить статусы неокончательных сообщений. Ошибка шлюза статусы не трогает. */
export async function refreshStatuses(tenantId: string, settings: SmsSettings, where: Prisma.SmsMessageWhereInput) {
  await withTenant(tenantId, (tx) => expirePhoneQueue(tx, where));
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
