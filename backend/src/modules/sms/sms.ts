import type { Prisma, SmsStatus } from "@prisma/client";
import { withTenant } from "../../lib/db";

/**
 * SMS клиентам: настройки мастерской, шаблоны, отправка и статусы. Отправляет
 * свой телефон с приложением «FineCRM SMS» (sms.phone.ts): сообщение ждёт в
 * очереди, телефон забирает его сам. Маршруты — в sms.routes.ts, предложение
 * «отправить SMS» после «Готов к выдаче» — readyHint() из orders.routes.ts,
 * согласование по SMS — sms.approval.ts.
 *
 * SemySMS был вторым способом отправки — убран 07.10.2026 по решению Андрея.
 * Старые подключения через него считаются «свой телефон».
 */

/** Строка подключения в "Integration". Имя историческое (когда-то был SemySMS): в ней все настройки SMS. */
export const KIND = "semysms";
export const ON_READY = ["ask", "auto", "off"] as const;
export type OnReady = (typeof ON_READY)[number];

export const DEFAULT_TEMPLATES = {
  ready: "Здравствуйте! Ваш {техника} (заказ {номер}) готов к выдаче. {мастерская}",
  // Короче — дешевле: каждые 67 знаков по-русски — ещё одна платная SMS.
  approval: "{мастерская}: заказ {номер}, {работы} — {стоимость}. Делаем? Ответьте ДА или НЕТ",
  approvalYes: "Спасибо! Приступаем к ремонту. {мастерская}",
  approvalNo: "Поняли, ремонт делать не будем. Технику можно забрать. {мастерская}",
};
export type TemplateKey = keyof typeof DEFAULT_TEMPLATES;

/** Подстановки шаблона — те же подсказки показывает интерфейс. */
export const PLACEHOLDERS = ["{клиент}", "{номер}", "{техника}", "{сумма}", "{стоимость}", "{работы}", "{мастерская}"] as const;

export type ApprovalConfig = {
  enabled: boolean;
  /** Заказ перевели в статус согласования: спросить мастера, отправить сразу или ничего. */
  onWaiting: OnReady;
  /** Статус «на согласовании». Пусто — первый статус «Согласования» со словом «соглас». */
  statusId: string | null;
  /** Куда перевести заказ, если клиент согласился. Пусто — первый статус «Ремонта». */
  yesStatusId: string | null;
  /** Ответить клиенту, когда он согласился / отказался. */
  replyYes: boolean;
  replyNo: boolean;
};

export interface SmsConfig {
  onReady: OnReady;
  templates: Record<TemplateKey, string | null>;
  approval: ApprovalConfig;
}

export interface SmsSettings extends SmsConfig {
  enabled: boolean;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
const id = (v: unknown) => (typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v) ? v : null);

function readConfig(raw: unknown): SmsConfig {
  const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const t = (c.templates && typeof c.templates === "object" ? c.templates : {}) as Record<string, unknown>;
  const a = (c.approval && typeof c.approval === "object" ? c.approval : {}) as Record<string, unknown>;
  return {
    onReady: ON_READY.includes(c.onReady as OnReady) ? (c.onReady as OnReady) : "ask",
    templates: {
      ready: str(t.ready),
      approval: str(t.approval),
      approvalYes: str(t.approvalYes),
      approvalNo: str(t.approvalNo),
    },
    approval: {
      enabled: a.enabled === true,
      onWaiting: ON_READY.includes(a.onWaiting as OnReady) ? (a.onWaiting as OnReady) : "ask",
      statusId: id(a.statusId),
      yesStatusId: id(a.yesStatusId),
      replyYes: a.replyYes !== false,
      replyNo: a.replyNo !== false,
    },
  };
}

export async function loadSettings(tx: Prisma.TransactionClient): Promise<SmsSettings> {
  const row = await tx.integration.findFirst({ where: { kind: KIND } });
  return { enabled: !!row?.enabled, ...readConfig(row?.config) };
}

/** Готово ли к отправке. Есть ли живой телефон — проверяется при отправке. */
export const ready = (s: SmsSettings) => s.enabled;

/** Согласование по SMS включено (и сами SMS тоже). */
export const approvalOn = (s: SmsSettings) => s.enabled && s.approval.enabled;

export const templateOf = (s: SmsSettings, key: TemplateKey) => s.templates[key] ?? DEFAULT_TEMPLATES[key];

/**
 * Номер в международном виде для SIM-карты: 89211234567 → +79211234567.
 * По нему же сверяется, кто ответил на согласование.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (digits.length === 11 && digits[0] === "8") return "+7" + digits.slice(1);
  if (digits.length === 10 && digits[0] === "9") return "+7" + digits;
  if (digits.length >= 10 && digits.length <= 15) return "+" + digits;
  return null;
}

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
      estimatedCost: true,
      status: { select: { id: true, group: true } },
      customer: { select: { id: true, name: true, phone: true } },
      device: { select: { kind: true, brand: true, model: true } },
      works: { select: { name: true }, orderBy: { createdAt: "asc" } },
      parts: { select: { name: true }, orderBy: { createdAt: "asc" } },
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
  // «Что делаем» для согласования: работы и запчасти через запятую, коротко —
  // SMS платная за каждые 70 знаков.
  const names = [...order.works.map((w) => w.name), ...order.parts.map((p) => p.name)].map((n) => n.trim()).filter(Boolean);
  let works = names.join(", ");
  if (works.length > 90) works = works.slice(0, 88).replace(/[,\s]+[^,]*$/, "") + "…";
  // Стоимость — сумма работ и запчастей; пока их нет — предварительная оценка с приёма.
  const cost = Number(order.total ?? 0) > 0 ? Number(order.total) : Number(order.estimatedCost ?? 0);
  return {
    order,
    values: {
      "{клиент}": order.customer?.name ?? "",
      "{номер}": order.number,
      "{техника}": device,
      "{сумма}": rub(due),
      "{стоимость}": cost > 0 ? rub(cost) : "по договорённости",
      "{работы}": works || "по результатам диагностики",
      "{мастерская}": workshop,
    } as Record<string, string>,
    phone: normalizePhone(order.customer?.phone),
    cost,
    hasWorks: names.length > 0,
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

  // Сообщение ждёт в очереди, телефон заберёт его сам (sms.phone.ts).
  // Если ни один телефон давно не выходил на связь — говорим сразу, а не через полчаса.
  const alive = await withTenant(tenantId, (tx) =>
    tx.smsPhone.count({
      where: { revokedAt: null, tokenHash: { not: null }, lastSeenAt: { gte: new Date(Date.now() - PHONE_GRACE_MS) } },
    })
  );
  return alive ? row : fail("Телефон-шлюз не на связи — проверьте, что он включён и приложение FineCRM SMS запущено");
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

/** Освежить статусы: то, что телефон не забрал или о чём не отчитался, — в «не отправлена». */
export async function refreshStatuses(tenantId: string, where: Prisma.SmsMessageWhereInput) {
  await withTenant(tenantId, (tx) => expirePhoneQueue(tx, where));
}
