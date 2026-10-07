import { Router, type Request } from "express";
import { z } from "zod";
import { withTenant } from "../../lib/db";
import { badRequest, conflict, forbidden, notFound, ah } from "../../lib/errors";
import { clientIp, writeAudit } from "../../lib/audit";
import { PERMISSIONS } from "../../lib/permissions";
import { actorUserId, authenticate, currentTenantId, permissionsOf, requireTenant } from "../../middleware/auth";
import { enforceTenantStatus } from "../../middleware/tenantStatus";
import { assertOrderAccess, seesCustomerContacts } from "../orders/orders.service";
import { createPairCode, listPhones, revokePhone } from "./sms.phone";
import { env } from "../../lib/env";
import { lanAddresses } from "../../lib/lan";
import { relayAgentState } from "../relay/relay.instance";
import { defaultRelayUrl, readRemoteAccess } from "../relay/remoteAccess";
import { publicAddress } from "../relay/invite";
import {
  DEFAULT_TEMPLATES,
  KIND,
  ON_READY,
  PLACEHOLDERS,
  approvalOn,
  loadSettings,
  maskPhone,
  normalizePhone,
  orderFacts,
  ready,
  refreshStatuses,
  render,
  sendSms,
  templateOf,
  type SmsSettings,
  type TemplateKey,
} from "./sms";
import { approvalStatuses, cancelApproval, decideApproval, lastApproval, startApproval } from "./sms.approval";

/**
 * «Настройки → Интеграции → SMS» и SMS клиенту из заказа.
 *
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

const TEMPLATE_KEYS = Object.keys(DEFAULT_TEMPLATES) as TemplateKey[];

function settingsView(s: SmsSettings) {
  return {
    enabled: s.enabled,
    onReady: s.onReady,
    templates: Object.fromEntries(TEMPLATE_KEYS.map((k) => [k, templateOf(s, k)])) as Record<TemplateKey, string>,
    approval: s.approval,
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
  onReady: z.enum(ON_READY).default("ask"),
  templates: z
    .object({
      ready: z.string().max(TEXT_MAX).optional(),
      approval: z.string().max(TEXT_MAX).optional(),
      approvalYes: z.string().max(TEXT_MAX).optional(),
      approvalNo: z.string().max(TEXT_MAX).optional(),
    })
    .default({}),
  approval: z
    .object({
      enabled: z.boolean().default(false),
      onWaiting: z.enum(ON_READY).default("ask"),
      statusId: z.string().uuid().nullable().default(null),
      yesStatusId: z.string().uuid().nullable().default(null),
      replyYes: z.boolean().default(true),
      replyNo: z.boolean().default(true),
    })
    .optional(),
});

smsRouter.put(
  "/settings",
  ah(async (req, res) => {
    manage(req);
    const body = settingsSchema.parse(req.body);
    const tenantId = tenantOf(req);
    const saved = await withTenant(tenantId, async (tx) => {
      const before = await tx.integration.findFirst({ where: { kind: KIND } });
      const prev = await loadSettings(tx);
      // Шаблон, совпавший со стандартным, не храним: поменяем стандартный — поменяется и у мастерской.
      const keep = (k: TemplateKey) => {
        const v = body.templates[k]?.trim();
        if (v === undefined) return prev.templates[k];
        return v && v !== DEFAULT_TEMPLATES[k] ? v : null;
      };
      const approval = body.approval ?? prev.approval;
      if (approval.statusId || approval.yesStatusId) {
        const ids = [approval.statusId, approval.yesStatusId].filter((v): v is string => !!v);
        const found = await tx.orderStatus.count({ where: { id: { in: ids } } });
        if (found !== new Set(ids).size) throw badRequest("Такого статуса нет — выберите из списка");
      }
      const config = {
        onReady: body.onReady,
        templates: Object.fromEntries(TEMPLATE_KEYS.map((k) => [k, keep(k)])),
        approval,
      };
      // Токен SemySMS больше не нужен — не держим его в базе.
      const row = before
        ? await tx.integration.update({ where: { id: before.id }, data: { enabled: body.enabled, secret: null, config } })
        : await tx.integration.create({ data: { tenantId, kind: KIND, enabled: body.enabled, secret: null, config } });
      await writeAudit(tx, {
        tenantId,
        userId: actorUserId(req),
        entity: "Integration",
        entityId: row.id,
        action: "UPDATE",
        diff: { kind: KIND, enabled: body.enabled, onReady: body.onReady, approval: approval.enabled },
        ip: clientIp(req),
      });
      return loadSettings(tx);
    });
    res.json(settingsView(saved));
  })
);

/** Тестовая SMS — по сохранённым настройкам, на номер, который ввёл администратор. */
smsRouter.post(
  "/test",
  ah(async (req, res) => {
    manage(req);
    const { phone } = z.object({ phone: z.string().trim().min(5).max(30) }).parse(req.body);
    const tenantId = tenantOf(req);
    const to = normalizePhone(phone);
    if (!to) throw badRequest("Номер не похож на телефон — например, +7 921 123-45-67");
    const s = await withTenant(tenantId, (tx) => loadSettings(tx));
    const tenant = await withTenant(tenantId, (tx) => tx.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }));
    const text = `Проверка SMS из FineCRM: всё работает. ${tenant?.name ?? ""}`.trim();
    if (!s.enabled) throw badRequest("Сначала включите SMS и сохраните");
    const row = await sendSms(tenantId, { phone: to, text, kind: "test", userId: actorUserId(req) });
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
async function phoneAddresses(): Promise<{ box?: true; remote?: string; lan?: string; lans?: string[] }> {
  if (env.storageDriver !== "local") return {};
  const out: { box: true; remote?: string; lan?: string; lans?: string[] } = { box: true };
  const saved = await readRemoteAccess().catch(() => null);
  if (saved?.enabled && saved.code && relayAgentState().state === "online") {
    out.remote = publicAddress(saved.url || defaultRelayUrl(), saved.code);
  }
  // Основа слушает только себя, пока раздача по сети не включена, — тогда адрес в сети бесполезен.
  if (env.bindHost !== "127.0.0.1" && env.bindHost !== "localhost") {
    const lans = lanAddresses().map((ip) => `http://${ip}:${env.port}/`);
    if (lans.length) {
      out.lan = lans[0];
      out.lans = lans;
    }
  }
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
    const { s, statuses } = await withTenant(tenantOf(req), async (tx) => {
      const s = await loadSettings(tx);
      return { s, statuses: await approvalStatuses(tx, s) };
    });
    res.json({
      enabled: ready(s),
      onReady: s.onReady,
      canSend: ready(s) && canSendSms(req),
      // Для меню заказа: «Согласовать по SMS» у заказов в «Согласовании».
      approval: approvalOn(s) ? { onWaiting: s.approval.onWaiting, statusId: statuses.waiting?.id ?? null } : null,
    });
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
    await refreshStatuses(tenantId, { orderId: facts.order.id });
    const [rows, approval] = await withTenant(tenantId, async (tx) => [
      await tx.smsMessage.findMany({ where: { orderId: facts.order.id }, orderBy: { createdAt: "desc" }, take: 50 }),
      await lastApproval(tx, facts.order.id),
    ] as const);
    const ids = [...new Set(rows.map((r) => r.createdById).filter((v): v is string => !!v))];
    const users = await withTenant(tenantId, (tx) => tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true } }));
    const names = new Map(users.map((u) => [u.id, u.fullName]));
    const toView = view(req);
    res.json({
      enabled: ready(settings),
      canSend: ready(settings) && canSendSms(req),
      hasPhone: !!facts.phone,
      messages: rows.map((r) => toView(r, names)),
      // Согласование: включено ли, можно ли спросить сейчас (заказ в «Согласовании»), последнее.
      approval: {
        enabled: approvalOn(settings),
        canAsk: approvalOn(settings) && canSendSms(req) && facts.order.status.group === "WAITING",
        last: approval ? { ...approval, phone: seesCustomerContacts(req) ? approval.phone : maskPhone(approval.phone) } : null,
      },
    });
  })
);

/** Готовый текст по шаблону — окно его показывает и даёт поправить. */
smsRouter.get(
  "/order/:id/preview",
  ah(async (req, res) => {
    const { facts, settings } = await orderContext(req);
    const kind = req.query.kind === "free" ? "free" : req.query.kind === "approval" ? "approval" : "ready";
    const text = kind === "free" ? "" : render(templateOf(settings, kind), facts.values);
    res.json({
      enabled: ready(settings),
      kind,
      text,
      phone: facts.phone ? (seesCustomerContacts(req) ? facts.phone : maskPhone(facts.phone)) : null,
      customer: seesCustomerContacts(req) ? (facts.order.customer?.name ?? null) : null,
      templates: {
        ready: render(templateOf(settings, "ready"), facts.values),
        approval: render(templateOf(settings, "approval"), facts.values),
      },
      approval: {
        enabled: approvalOn(settings),
        cost: facts.cost,
        hasWorks: facts.hasWorks,
      },
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
    const row = await sendSms(tenantId, {
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
  void sendSms(tenantId, {
    orderId,
    customerId: facts.order.customer?.id ?? null,
    phone: facts.phone,
    text: render(templateOf(settings, "ready"), facts.values),
    kind: "ready",
    userId: actorUserId(req),
  }).catch(() => undefined);
  return { auto: true };
}

// ------------------------------------------------------------------ согласование

/** Спросить клиента: текст — из окна, где его можно было поправить. */
smsRouter.post(
  "/order/:id/approval",
  ah(async (req, res) => {
    const body = z.object({ text: z.string().trim().min(1, "Напишите текст").max(TEXT_MAX) }).parse(req.body);
    if (!canSendSms(req)) throw forbidden("Отправлять SMS клиентам вам нельзя");
    const { tenantId, facts, settings } = await orderContext(req);
    if (!approvalOn(settings)) throw conflict("Согласование по SMS выключено — «Настройки → Интеграции»");
    if (!facts.phone) throw badRequest("У клиента не указан телефон");
    const r = await startApproval(tenantId, facts.order.id, body.text, actorUserId(req));
    if (!r.ok) {
      res.status(502).json({ error: r.error });
      return;
    }
    res.status(201).json({ ok: true });
  })
);

/** Ответ непонятен или клиент ответил по телефону — решает сотрудник. */
smsRouter.post(
  "/order/:id/approval/decide",
  ah(async (req, res) => {
    const { answer } = z.object({ answer: z.enum(["yes", "no"]) }).parse(req.body);
    if (!canSendSms(req)) throw forbidden("Решать за клиента вам нельзя");
    const { tenantId, facts } = await orderContext(req);
    const done = await decideApproval(tenantId, facts.order.id, answer, actorUserId(req));
    if (!done) throw conflict("По этому заказу нет согласования, ждущего ответа");
    res.json({ ok: true });
  })
);

smsRouter.post(
  "/order/:id/approval/cancel",
  ah(async (req, res) => {
    if (!canSendSms(req)) throw forbidden("Отменять согласование вам нельзя");
    const { tenantId, facts } = await orderContext(req);
    await cancelApproval(tenantId, facts.order.id, actorUserId(req));
    res.json({ ok: true });
  })
);

/**
 * Заказ перевели в статус согласования: что делать. Как readyHint: «ask» —
 * интерфейс откроет окно с готовым вопросом, «auto» — уходит сам.
 */
export async function approvalHint(req: Request, orderId: string, statusId: string): Promise<{ offer: true } | { auto: true } | { failed: string } | null> {
  const tenantId = tenantOf(req);
  const { facts, settings, statuses } = await withTenant(tenantId, async (tx) => {
    const settings = await loadSettings(tx);
    return { facts: await orderFacts(tx, tenantId, orderId), settings, statuses: await approvalStatuses(tx, settings) };
  });
  if (!approvalOn(settings) || settings.approval.onWaiting === "off") return null;
  if (!facts?.phone || statuses.waiting?.id !== statusId || !canSendSms(req)) return null;
  if (settings.approval.onWaiting === "ask") return { offer: true };
  const r = await startApproval(tenantId, orderId, render(templateOf(settings, "approval"), facts.values), actorUserId(req));
  return r.ok ? { auto: true } : { failed: r.error };
}
