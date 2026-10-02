import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { withPlatform, withTenant } from "../../lib/db";
import { ah, badRequest, notFound } from "../../lib/errors";
import { PHONE_ONLINE_MS, expirePhoneQueue } from "./sms";

/**
 * Свой телефон-шлюз: приложение «FineCRM SMS» на Android (android/sms-gateway).
 *
 * Устроено как печать через программу FineCRM: телефон сам спрашивает у
 * сервера «есть ли что отправить?» (долгий опрос, до 25 секунд), забирает
 * SMS, отправляет со своей SIM-карты и сообщает «отправлено», «доставлено»
 * или «ошибка». Входящих соединений к телефону нет — ему не нужен белый адрес,
 * и он работает и через сотовую сеть, и через узел связи Основы (/b/<код>/).
 *
 * Подключение — одноразовым кодом из «Настройки → Интеграции» (QR-код или
 * 6 цифр). В ответ телефон получает ключ «<id>.<секрет>»; в базе хранится
 * только отпечаток секрета, поэтому даже выгрузка базы ключа не раскрывает.
 *
 * Этот маршрутизатор — без входа сотрудника: телефон не человек и паролей не
 * знает. Мастерскую он узнаёт по своему ключу.
 */

export const smsPhoneRouter = Router();

const PAIR_TTL_MS = 10 * 60 * 1000;
const LONG_POLL_MAX_S = 25;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Новый код подключения: 6 цифр, уникальный среди действующих по всей платформе. */
export async function createPairCode(tenantId: string): Promise<{ id: string; code: string; expiresAt: Date }> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const taken = await withPlatform((tx) =>
      tx.smsPhone.findFirst({ where: { pairCode: code }, select: { id: true, pairExpiresAt: true } })
    );
    if (taken && taken.pairExpiresAt && taken.pairExpiresAt.getTime() > Date.now()) continue;
    // Этот код когда-то был, но давно истёк — освобождаем его.
    if (taken) await withPlatform((p) => p.smsPhone.updateMany({ where: { id: taken.id }, data: { pairCode: null } }));
    const expiresAt = new Date(Date.now() + PAIR_TTL_MS);
    const row = await withTenant(tenantId, async (tx) => {
      // Прежние неиспользованные коды этой мастерской больше не нужны.
      await tx.smsPhone.deleteMany({ where: { tokenHash: null } });
      return tx.smsPhone.create({ data: { tenantId, pairCode: code, pairExpiresAt: expiresAt } });
    });
    return { id: row.id, code, expiresAt };
  }
  throw new Error("Не удалось подобрать свободный код подключения");
}

export interface PhoneView {
  id: string;
  name: string;
  online: boolean;
  lastSeenAt: Date | null;
  battery: number | null;
  charging: boolean | null;
  appVersion: string | null;
  sentToday: number;
  problems: string[];
}

/** Подключённые телефоны мастерской — для «Интеграций». */
export async function listPhones(tenantId: string): Promise<PhoneView[]> {
  return withTenant(tenantId, async (tx) => {
    const phones = await tx.smsPhone.findMany({
      where: { revokedAt: null, tokenHash: { not: null } },
      orderBy: { createdAt: "asc" },
    });
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    const sent = await tx.smsMessage.groupBy({
      by: ["phoneId"],
      where: { phoneId: { in: phones.map((p) => p.id) }, status: { in: ["SENT", "DELIVERED"] }, createdAt: { gte: since } },
      _count: { _all: true },
    });
    return phones.map((p) => {
      const info = (p.info ?? {}) as Record<string, unknown>;
      const problems: string[] = [];
      if (info.smsPermission === false) problems.push("нет разрешения на отправку SMS");
      if (info.batteryOptimized === true) problems.push("включена экономия батареи — Android может усыпить приложение");
      if (info.simReady === false) problems.push("SIM-карта не готова");
      return {
        id: p.id,
        name: p.name,
        online: !!p.lastSeenAt && Date.now() - p.lastSeenAt.getTime() < PHONE_ONLINE_MS,
        lastSeenAt: p.lastSeenAt,
        battery: typeof info.battery === "number" ? info.battery : null,
        charging: typeof info.charging === "boolean" ? info.charging : null,
        appVersion: typeof info.appVersion === "string" ? info.appVersion : null,
        sentToday: sent.find((s) => s.phoneId === p.id)?._count._all ?? 0,
        problems,
      };
    });
  });
}

export async function revokePhone(tenantId: string, id: string) {
  await withTenant(tenantId, async (tx) => {
    const done = await tx.smsPhone.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: new Date() } });
    if (!done.count) throw notFound("Телефон не найден");
  });
}

// ------------------------------------------------------------------ телефон

interface PhoneAuth {
  tenantId: string;
  phoneId: string;
}

/** Ключ телефона: «X-Phone-Token: <id>.<секрет>». */
async function phoneOf(req: Request): Promise<PhoneAuth | null> {
  const raw = String(req.headers["x-phone-token"] ?? "");
  const dot = raw.indexOf(".");
  if (dot < 1) return null;
  const id = raw.slice(0, dot);
  const secret = raw.slice(dot + 1);
  if (!/^[0-9a-f-]{36}$/.test(id) || secret.length < 20) return null;
  const row = await withPlatform((tx) =>
    tx.smsPhone.findFirst({ where: { id, revokedAt: null }, select: { tenantId: true, tokenHash: true } })
  );
  if (!row?.tokenHash) return null;
  const a = Buffer.from(sha(secret));
  const b = Buffer.from(row.tokenHash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { tenantId: row.tenantId, phoneId: id };
}

async function requirePhone(req: Request, res: Response): Promise<PhoneAuth | null> {
  const auth = await phoneOf(req);
  if (!auth) {
    // 401 — знак приложению: ключ больше не действует (телефон отключили в
    // настройках), нужно подключиться заново.
    res.status(401).json({ error: "Телефон отключён от мастерской — подключите его заново" });
    return null;
  }
  return auth;
}

/** Подбирать коды перебором — не выйдет: 10 попыток за 10 минут с адреса. */
const pairLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Слишком много попыток. Подождите 10 минут и возьмите новый код." },
});

const infoSchema = z
  .object({
    battery: z.number().min(0).max(100).optional(),
    charging: z.boolean().optional(),
    smsPermission: z.boolean().optional(),
    batteryOptimized: z.boolean().optional(),
    simReady: z.boolean().optional(),
    appVersion: z.string().max(40).optional(),
    android: z.string().max(40).optional(),
    model: z.string().max(100).optional(),
  })
  .passthrough();

smsPhoneRouter.post(
  "/pair",
  pairLimiter,
  ah(async (req, res) => {
    const body = z
      .object({ code: z.string().trim().regex(/^\d{6}$/, "Код — 6 цифр"), name: z.string().trim().max(100).optional(), info: infoSchema.optional() })
      .parse(req.body);
    const found = await withPlatform((tx) =>
      tx.smsPhone.findFirst({ where: { pairCode: body.code, tokenHash: null }, select: { id: true, tenantId: true, pairExpiresAt: true } })
    );
    if (!found || !found.pairExpiresAt || found.pairExpiresAt.getTime() < Date.now()) {
      throw badRequest("Код не подходит или устарел — возьмите новый в «Настройки → Интеграции»");
    }
    const secret = randomBytes(24).toString("hex");
    const tenant = await withTenant(found.tenantId, async (tx) => {
      await tx.smsPhone.update({
        where: { id: found.id },
        data: {
          pairCode: null,
          pairExpiresAt: null,
          tokenHash: sha(secret),
          name: body.name || body.info?.model || "Телефон",
          info: (body.info ?? {}) as object,
          lastSeenAt: new Date(),
        },
      });
      return tx.tenant.findUnique({ where: { id: found.tenantId }, select: { name: true } });
    });
    res.json({ token: `${found.id}.${secret}`, phoneId: found.id, workshop: tenant?.name ?? "" });
  })
);

/** Телефон рассказывает о себе: батарея, разрешения, SIM. Заодно — «я на связи». */
smsPhoneRouter.post(
  "/state",
  ah(async (req, res) => {
    const auth = await requirePhone(req, res);
    if (!auth) return;
    const info = infoSchema.parse(req.body ?? {});
    const tenant = await withTenant(auth.tenantId, async (tx) => {
      await tx.smsPhone.update({ where: { id: auth.phoneId }, data: { info: info as object, lastSeenAt: new Date() } });
      return tx.tenant.findUnique({ where: { id: auth.tenantId }, select: { name: true } });
    });
    res.json({ ok: true, workshop: tenant?.name ?? "" });
  })
);

/** Есть ли что отправить. Ждёт до 25 секунд и возвращается сразу, как появилось. */
smsPhoneRouter.get(
  "/next",
  ah(async (req, res) => {
    const auth = await requirePhone(req, res);
    if (!auth) return;
    const wait = Math.min(LONG_POLL_MAX_S, Math.max(0, Number(req.query.wait) || 0));
    let gone = false;
    res.on("close", () => {
      if (!res.writableEnded) gone = true;
    });
    const deadline = Date.now() + wait * 1000;
    for (;;) {
      if (gone) return;
      const job = await withTenant(auth.tenantId, async (tx) => {
        await tx.smsPhone.update({ where: { id: auth.phoneId }, data: { lastSeenAt: new Date() } });
        await expirePhoneQueue(tx);
        const next = await tx.smsMessage.findFirst({
          where: { status: "QUEUED", providerId: null, pickedAt: null },
          orderBy: { createdAt: "asc" },
          select: { id: true, phone: true, text: true },
        });
        if (!next) return null;
        // Забрать может только один телефон: условие на pickedAt — защита от двух сразу.
        const claimed = await tx.smsMessage.updateMany({
          where: { id: next.id, pickedAt: null },
          data: { pickedAt: new Date(), phoneId: auth.phoneId },
        });
        return claimed.count === 1 ? next : null;
      });
      if (job) return res.json({ job });
      if (gone || Date.now() >= deadline) return res.json({ job: null });
      await sleep(1500);
    }
  })
);

/** Итог отправки. «sent» — телефон отправил, «delivered» — оператор подтвердил доставку. */
smsPhoneRouter.post(
  "/result",
  ah(async (req, res) => {
    const auth = await requirePhone(req, res);
    if (!auth) return;
    const body = z
      .object({
        id: z.string().uuid(),
        status: z.enum(["sent", "delivered", "failed"]),
        error: z.string().trim().max(300).optional(),
      })
      .parse(req.body);
    await withTenant(auth.tenantId, async (tx) => {
      const msg = await tx.smsMessage.findFirst({ where: { id: body.id, phoneId: auth.phoneId }, select: { status: true } });
      if (!msg) throw notFound("Сообщение не найдено");
      // Порядок статусов только вперёд: опоздавшее «отправлено» не затирает «доставлено».
      const rank = { QUEUED: 0, SENT: 1, DELIVERED: 2, FAILED: 3 } as const;
      const next = body.status === "sent" ? "SENT" : body.status === "delivered" ? "DELIVERED" : "FAILED";
      // Исключение — «не отправлена» по сроку: если телефон всё-таки отправил, верим телефону.
      const forward = rank[next] > rank[msg.status] || (msg.status === "FAILED" && next !== "FAILED");
      if (!forward) return;
      await tx.smsMessage.update({
        where: { id: body.id },
        data: {
          status: next,
          checkedAt: new Date(),
          error: next === "FAILED" ? body.error || "Телефон не смог отправить SMS" : null,
        },
      });
      await tx.smsPhone.update({ where: { id: auth.phoneId }, data: { lastSeenAt: new Date() } });
    });
    res.json({ ok: true });
  })
);

/** Приложение отключили на самом телефоне. */
smsPhoneRouter.post(
  "/unpair",
  ah(async (req, res) => {
    const auth = await requirePhone(req, res);
    if (!auth) return;
    await revokePhone(auth.tenantId, auth.phoneId);
    res.json({ ok: true });
  })
);
