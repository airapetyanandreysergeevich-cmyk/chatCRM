import { Router, type Request } from "express";
import { z } from "zod";
import { withTenant } from "../../lib/db";
import { badRequest, conflict, forbidden, notFound, ah } from "../../lib/errors";
import { clientIp, writeAudit } from "../../lib/audit";
import { PERMISSIONS } from "../../lib/permissions";
import * as gateway from "../../lib/semysms";
import { actorUserId, authenticate, currentTenantId, permissionsOf, requireTenant } from "../../middleware/auth";
import { enforceTenantStatus } from "../../middleware/tenantStatus";
import { assertOrderAccess, seesCustomerContacts } from "../orders/orders.service";
import { createPairCode, listPhones, revokePhone } from "./sms.phone";
import { networkInterfaces } from "node:os";
import { env } from "../../lib/env";
import { relayAgentState } from "../relay/relay.instance";
import { defaultRelayUrl, readRemoteAccess } from "../relay/remoteAccess";
import { publicAddress } from "../relay/invite";
import {
  DEFAULT_TEMPLATES,
  KIND,
  ON_READY,
  PLACEHOLDERS,
  PROVIDERS,
  loadSettings,
  maskPhone,
  orderFacts,
  ready,
  refreshStatuses,
  render,
  sendSms,
  templateOf,
  tokenHint,
  type SmsSettings,
} from "./sms";

/**
 * «Настройки → Интеграции → SMS» и SMS клиенту из заказа.
 *
 * Ключ SemySMS в интерфейс не возвращается никогда — только «•••• 4f2a».
 * Менять подключение может тот, у кого право «Настройки мастерской».
 * Отправлять — тот, кто работает с заказом: меняет статус, правит, выдаёт.
 * Номер клиента сотруднику без доступа к контактам показывается маской.
 */

export const smsRouter = Router();
smsRouter.use(authenticate, requireTenant, enforceTenantStatus);

const tenantOf = (req: Request) => currentTenantId(req)!;
const has = (req: Request, code: string) => permissionsOf(req).includes(code);

/** Кто может отправить SMS клиенту по заказу. */
export const canSendSms = (req: Request) =>
  [
    PERMISSIONS.ORDERS_EDIT,
    PERMISSIONS.ORDERS_STATUS,
    PERMISSIONS.ORDERS_STATUS_OWN,
    PERMISSIONS.ORDERS_ISSUE,
    PERMISSIONS.ORDERS_CREATE,
  ].some((p) => has(req, p));

const manage = (req: Request) => {
  if (!has(req, PERMISSIONS.SETTINGS_MANAGE)) throw forbidden("Подключение SMS меняет администратор мастерской");
};

const TEXT_MAX = 1000;

function settingsView(s: SmsSettings) {
  return {
    enabled: s.enabled,
    provider: s.provider,
    hasToken: !!s.token,
    tokenHint: tokenHint(s.token),
    device: s.device,
    deviceName: s.deviceName,
    onReady: s.onReady,
    templates: { ready: templateOf(s, "ready") },
    defaults: DEFAULT_TEMPLATES,
    placeholders: PLACEHOLDERS,
  };
}

// ------------------------------------------------------------------ настройки

smsRouter.get(
  "/settings",
  ah(async (req, res) => {
    manage(req);
    const s = await withTenant(tenantOf(req), (tx) => loadSettings(tx));
    res.json(settingsView(s));
  })
);

const settingsSchema = z.object({
  enabled: z.boolean(),
  provider: z.enum(PROVIDERS).default("phone"),
  /** Новый ключ. Не прислан — остаётся прежний. */
  token: z.string().trim().max(200).optional(),
  device: z.string().trim().min(1).max(100).default("active"),
  deviceName: z.string().trim().max(200).nullable().optional(),
  onReady: z.enum(ON_READY).default("ask"),
  templates: z.object({ ready: z.string().max(TEXT_MAX).optional() }).default({}),
});

smsRouter.put(
  "/settings",
  ah(async (req, res) => {
    manage(req);
    const body = settingsSchema.parse(req.body);
    const tenantId = tenantOf(req);
    const saved = await withTenant(tenantId, async (tx) => {
      const before = await tx.integration.findFirst({ where: { kind: KIND } });
      const secret = body.token ? body.token : (before?.secret ?? null);
      if (body.enabled && body.provider === "semysms" && !secret) {
        throw badRequest("Укажите токен API из личного кабинета SemySMS");
      }
      const ready = body.templates.ready?.trim();
      const config = {
        provider: body.provider,
        device: body.device,
        deviceName: body.device === "active" ? null : (body.deviceName ?? null),
        onReady: body.onReady,
        templates: { ready: ready && ready !== DEFAULT_TEMPLATES.ready ? ready : null },
      };
      const row = before
        ? await tx.integration.update({ where: { id: before.id }, data: { enabled: body.enabled, secret, config } })
        : await tx.integration.create({ data: { tenantId, kind: KIND, enabled: body.enabled, secret, config } });
      await writeAudit(tx, {
        tenantId,
        userId: actorUserId(req),
        entity: "Integration",
        entityId: row.id,
        action: "UPDATE",
        // Ключ в журнал не пишем — только факт замены.
        diff: { kind: KIND, enabled: body.enabled, provider: body.provider, tokenChanged: !!body.token, device: body.device, onReady: body.onReady },
        ip: clientIp(req),
      });
      return loadSettings(tx);
    });
    res.json(settingsView(saved));
  })
);

/** Телефоны-шлюзы: по новому ключу (ещё не сохранён) или по сохранённому. */
smsRouter.post(
  "/devices",
  ah(async (req, res) => {
    manage(req);
    const { token } = z.object({ token: z.string().trim().max(200).optional() }).parse(req.body ?? {});
    const s = await withTenant(tenantOf(req), (tx) => loadSettings(tx));
    const key = token || s.token;
    if (!key) throw badRequest("Сначала укажите токен API");
    try {
      res.json({ devices: await gateway.devices(key) });
    } catch (err) {
      if (err instanceof gateway.SmsGatewayError) throw conflict(err.message);
      throw err;
    }
  })
);

/** Тестовая SMS — по сохранённым настройкам, на номер, который ввёл администратор. */
smsRouter.post(
  "/test",
  ah(async (req, res) => {
    manage(req);
    const { phone } = z.object({ phone: z.string().trim().min(5).max(30) }).parse(req.body);
    const tenantId = tenantOf(req);
    const to = gateway.gatewayPhone(phone);
    if (!to) throw badRequest("Номер не похож на телефон — например, +7 921 123-45-67");
    const s = await withTenant(tenantId, (tx) => loadSettings(tx));
    if (s.provider === "semysms" && !s.token) throw badRequest("Сначала сохраните токен API");
    const tenant = await withTenant(tenantId, (tx) => tx.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }));
    const text = `Проверка SMS из FineCRM: всё работает. ${tenant?.name ?? ""}`.trim();
    const row = await sendSms(tenantId, s, { phone: to, text, kind: "test", userId: actorUserId(req) });
    res.json({ id: row.id, status: row.status, error: row.error });
  })
);

// ------------------------------------------------------------------ свой телефон

/**
 * Куда телефону стучаться — подсказки для Основы. В облаке телефон ходит туда
 * же, где открыт сайт, и подсказки не нужны. У Основы два пути: через
 * интернет (узел связи /b/<код>/ — работает и по сотовой сети) и по сети
 * мастерской (http://<адрес компьютера>:<порт>/ — только в том же Wi-Fi).
 */
async function phoneAddresses(): Promise<{ remote?: string; lan?: string }> {
  if (env.storageDriver !== "local") return {};
  const out: { remote?: string; lan?: string } = {};
  const saved = await readRemoteAccess().catch(() => null);
  if (saved?.enabled && saved.code && relayAgentState().state === "online") {
    out.remote = publicAddress(saved.url || defaultRelayUrl(), saved.code);
  }
  const ip = Object.values(networkInterfaces())
    .flat()
    .find((a) => a && a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254."));
  // Основа слушает только себя, пока раздача по сети не включена, — тогда адрес в сети бесполезен.
  if (ip && env.bindHost !== "127.0.0.1" && env.bindHost !== "localhost") out.lan = `http://${ip.address}:${env.port}/`;
  return out;
}

smsRouter.get(
  "/phones",
  ah(async (req, res) => {
    manage(req);
    res.json({ phones: await listPhones(tenantOf(req)) });
  })
);

/** Одноразовый код подключения телефона — 10 минут. */
smsRouter.post(
  "/phones/pair",
  ah(async (req, res) => {
    manage(req);
    const { code, expiresAt } = await createPairCode(tenantOf(req));
    res.json({ code, expiresAt, ...(await phoneAddresses()) });
  })
);

smsRouter.delete(
  "/phones/:id",
  ah(async (req, res) => {
    manage(req);
    await revokePhone(tenantOf(req), req.params.id);
    res.json({ ok: true });
  })
);

/** Включено ли и что делать при готовности — для окна в заказе. */
smsRouter.get(
  "/status",
  ah(async (req, res) => {
    const s = await withTenant(tenantOf(req), (tx) => loadSettings(tx));
    res.json({ enabled: ready(s), onReady: s.onReady, canSend: ready(s) && canSendSms(req) });
  })
);

// ------------------------------------------------------------------ заказ

async function orderContext(req: Request) {
  const tenantId = tenantOf(req);
  const ctx = await withTenant(tenantId, async (tx) => {
    const facts = await orderFacts(tx, tenantId, req.params.id);
    if (!facts) throw notFound("Заказ не найден");
    assertOrderAccess(req, facts.order);
    return { facts, settings: await loadSettings(tx) };
  });
  return { tenantId, ...ctx };
}

const view = (req: Request) => {
  const contacts = seesCustomerContacts(req);
  return (m: { id: string; kind: string; text: string; phone: string; status: string; error: string | null; createdAt: Date; createdById: string | null }, names: Map<string, string>) => ({
    id: m.id,
    kind: m.kind,
    text: m.text,
    phone: contacts ? m.phone : maskPhone(m.phone),
    status: m.status,
    error: m.error,
    createdAt: m.createdAt,
    author: m.createdById ? (names.get(m.createdById) ?? null) : null,
  });
};

smsRouter.get(
  "/order/:id",
  ah(async (req, res) => {
    const { tenantId, facts, settings } = await orderContext(req);
    await refreshStatuses(tenantId, settings, { orderId: facts.order.id });
    const rows = await withTenant(tenantId, (tx) =>
      tx.smsMessage.findMany({ where: { orderId: facts.order.id }, orderBy: { createdAt: "desc" }, take: 50 })
    );
    const ids = [...new Set(rows.map((r) => r.createdById).filter((v): v is string => !!v))];
    const users = await withTenant(tenantId, (tx) => tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true } }));
    const names = new Map(users.map((u) => [u.id, u.fullName]));
    const toView = view(req);
    res.json({
      enabled: ready(settings),
      canSend: ready(settings) && canSendSms(req),
      hasPhone: !!facts.phone,
      messages: rows.map((r) => toView(r, names)),
    });
  })
);

/** Готовый текст по шаблону — окно его показывает и даёт поправить. */
smsRouter.get(
  "/order/:id/preview",
  ah(async (req, res) => {
    const { facts, settings } = await orderContext(req);
    const kind = req.query.kind === "free" ? "free" : "ready";
    const text = kind === "ready" ? render(templateOf(settings, "ready"), facts.values) : "";
    res.json({
      enabled: ready(settings),
      kind,
      text,
      phone: facts.phone ? (seesCustomerContacts(req) ? facts.phone : maskPhone(facts.phone)) : null,
      customer: seesCustomerContacts(req) ? (facts.order.customer?.name ?? null) : null,
      templates: { ready: render(templateOf(settings, "ready"), facts.values) },
    });
  })
);

smsRouter.post(
  "/order/:id",
  ah(async (req, res) => {
    const body = z
      .object({ text: z.string().trim().min(1, "Напишите текст").max(TEXT_MAX), kind: z.enum(["ready", "free"]).default("free") })
      .parse(req.body);
    if (!canSendSms(req)) throw forbidden("Отправлять SMS клиентам вам нельзя");
    const { tenantId, facts, settings } = await orderContext(req);
    if (!ready(settings)) throw conflict("SMS не подключены — «Настройки → Интеграции»");
    if (!facts.phone) throw badRequest("У клиента не указан телефон");
    const row = await sendSms(tenantId, settings, {
      orderId: facts.order.id,
      customerId: facts.order.customer?.id ?? null,
      phone: facts.phone,
      text: body.text,
      kind: body.kind,
      userId: actorUserId(req),
    });
    const names = new Map<string, string>();
    if (row.status === "FAILED") {
      res.status(502).json({ error: row.error ?? "SMS не отправлена", message: view(req)(row, names) });
      return;
    }
    res.status(201).json({ message: view(req)(row, names) });
  })
);

/**
 * После перехода заказа в «Готов к выдаче»: что делать с SMS.
 * «auto» — отправляем сами, в фоне: смена статуса не должна ждать телефон.
 * «ask» — подсказываем интерфейсу открыть окно (если этому сотруднику можно).
 */
export async function readyHint(req: Request, orderId: string): Promise<{ offer: true } | { auto: true } | null> {
  const tenantId = tenantOf(req);
  const { facts, settings } = await withTenant(tenantId, async (tx) => ({
    facts: await orderFacts(tx, tenantId, orderId),
    settings: await loadSettings(tx),
  }));
  if (!facts?.phone || !ready(settings) || settings.onReady === "off") return null;
  if (settings.onReady === "ask") return canSendSms(req) ? { offer: true } : null;
  void sendSms(tenantId, settings, {
    orderId,
    customerId: facts.order.customer?.id ?? null,
    phone: facts.phone,
    text: render(templateOf(settings, "ready"), facts.values),
    kind: "ready",
    userId: actorUserId(req),
  }).catch(() => undefined);
  return { auto: true };
}
