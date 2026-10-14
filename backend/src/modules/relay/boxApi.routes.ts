import { Router, type Request } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { clientIp } from "../../lib/audit";
import { ah, badRequest, conflict, unauthorized } from "../../lib/errors";
import { normalizeName } from "../../lib/login";
import { prisma } from "../../lib/db";
import { loadDictionary } from "../plate/plate.dictionary";
import { forgetKnowledge, platformKnowledge } from "../plate/plate.learn";
import { modelKeys } from "../plate/plate.parse";
import { notifyPlatform } from "../feedback/feedback.delivery";
import { authenticateBox, claimName, nameStatus } from "./boxes.service";

/**
 * Облако для Основы: то, о чём мастерская спрашивает сама.
 *
 * Имя мастерской: свободно ли оно, знает только облако — оно одно видит все
 * мастерские сразу. Поэтому Основа, когда владелец выбирает имя, спрашивает
 * сюда, а сюда — только со своим ключом.
 *
 * И марки моделей для распознавания шильдиков: Основа присылает свои пары
 * «модель → марка», получает словарь платформы и общий итог (plate.sync.ts).
 *
 * Ключ — тот же, с которым Основа держит туннель, и в том же заголовке.
 * Отдельного пароля у мастерской нет и не нужно.
 *
 * И обратная связь: обращения из Основы — единственное здесь, что принимается
 * и без ключа.
 */

export const boxApiRouter = Router();

/** Проверка имени идёт на каждую набранную букву — но не быстрее человека. */
boxApiRouter.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Слишком много запросов — подождите минуту" },
  })
);

async function boxOf(req: Request) {
  const key = String(req.headers["x-box-key"] ?? "");
  const box = key ? await authenticateBox(key) : null;
  if (!box) throw unauthorized("Ключ мастерской не подошёл");
  return box;
}

/** Нынешнее имя и, если спросили, — свободно ли другое. */
boxApiRouter.get(
  "/name",
  ah(async (req, res) => {
    const box = await boxOf(req);
    const q = z.object({ check: z.string().max(60).optional() }).parse(req.query);
    const check = q.check !== undefined ? normalizeName(q.check) : undefined;
    res.json({
      name: box.name,
      ...(check !== undefined ? { check: { name: check, ...(await nameStatus(check, box.id)) } } : {}),
    });
  })
);

/** Закрепить имя. Своё нынешнее — не ошибка: повтор после сбоя проходит. */
boxApiRouter.put(
  "/name",
  ah(async (req, res) => {
    const box = await boxOf(req);
    const { name } = z.object({ name: z.string().max(60) }).parse(req.body);
    const done = await claimName(box.id, name);
    if (!done.ok) {
      if (/занято/.test(done.reason)) throw conflict(done.reason);
      throw badRequest(done.reason);
    }
    res.json({ name: done.name });
  })
);

// ---------------------------------------------------------------- марки моделей

const reportSchema = z.object({
  models: z
    .array(
      z.object({
        model: z.string().trim().min(3).max(60),
        brand: z.string().trim().min(2).max(40),
        uses: z.number().int().min(1).max(1_000_000),
      })
    )
    .max(5000),
  misses: z
    .array(z.object({ model: z.string().trim().min(2).max(60), uses: z.number().int().min(1).max(1_000_000) }))
    .max(500)
    .default([]),
});

/**
 * Обмен знанием о марках. Свои строки Основа заменяет целиком: что она
 * прислала в прошлый раз, уже не в счёт.
 */
boxApiRouter.put(
  "/plate-knowledge",
  ah(async (req, res) => {
    const box = await boxOf(req);
    const report = reportSchema.parse(req.body);

    const rows = new Map<string, { modelKey: string; brand: string; model: string; uses: number }>();
    for (const m of report.models) {
      const key = modelKeys(m.model)[0];
      if (!key) continue;
      const id = `${key}\u0000${m.brand.toUpperCase()}`;
      const cur = rows.get(id);
      if (cur) cur.uses += m.uses;
      else rows.set(id, { modelKey: key, brand: m.brand.replace(/\s+/g, " "), model: m.model, uses: m.uses });
    }
    const misses = new Map<string, { modelKey: string; model: string; uses: number }>();
    for (const m of report.misses) {
      const keys = modelKeys(m.model);
      const key = keys[keys.length - 1];
      if (!key) continue;
      const cur = misses.get(key);
      if (cur) cur.uses += m.uses;
      else misses.set(key, { modelKey: key, model: m.model, uses: m.uses });
    }

    await prisma.$transaction([
      prisma.plateBoxModel.deleteMany({ where: { boxId: box.id } }),
      prisma.plateBoxModel.createMany({ data: [...rows.values()].map((r) => ({ ...r, boxId: box.id })) }),
      prisma.plateMiss.deleteMany({ where: { source: box.id } }),
      prisma.plateMiss.createMany({ data: [...misses.values()].map((m) => ({ ...m, source: box.id })) }),
    ]);

    // Свежие пары Основы — сразу в счёт: итог пересчитается этим же запросом.
    forgetKnowledge();
    const [dictionary, known] = await Promise.all([loadDictionary(), platformKnowledge()]);
    res.json({ dictionary, learned: [...known.decided.entries()] });
  })
);

// ---------------------------------------------------------------- обратная связь

/**
 * Обращение мастерской из Основы (feedback.delivery.ts на её стороне).
 *
 * Ключ не обязателен: обратную связь пишут и те, кто доступ из интернета не
 * подключал. С ключом облако знает, какая это Основа; без него — только то,
 * что она о себе сказала. Поэтому отдельный счётчик частоты и потолки длины:
 * адрес открыт всем, и лента обращений не должна стать почтовым ящиком для
 * чужих рассылок.
 */
const feedbackLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Слишком много обращений — подождите час" },
});

const feedbackSchema = z.object({
  localId: z.string().uuid(),
  kind: z.enum(["REMARK", "WISH", "BUG"]),
  text: z.string().trim().min(10).max(4000),
  writtenAt: z.coerce.date(),
  workshop: z.string().trim().min(1).max(120),
  email: z.string().trim().max(200).optional(),
  version: z.string().trim().max(40).optional(),
});

boxApiRouter.post(
  "/feedback",
  feedbackLimiter,
  ah(async (req, res) => {
    const body = feedbackSchema.parse(req.body);
    const key = String(req.headers["x-box-key"] ?? "");
    // Ключ не подошёл (доступ отозвали) — обращение всё равно принимаем, как без ключа.
    const box = key ? await authenticateBox(key) : null;
    const now = Date.now();
    const writtenAt = body.writtenAt.getTime() > now || Number.isNaN(body.writtenAt.getTime()) ? new Date(now) : body.writtenAt;

    const existing = await prisma.boxFeedback.findUnique({ where: { localId: body.localId }, select: { id: true } });
    if (existing) return res.json({ id: existing.id, repeated: true });

    let created: { id: string };
    try {
      created = await prisma.boxFeedback.create({
        data: {
          localId: body.localId,
          boxId: box?.id ?? null,
          kind: body.kind,
          text: body.text,
          workshop: body.workshop,
          email: body.email || null,
          version: body.version || null,
          ip: clientIp(req),
          writtenAt,
        },
        select: { id: true },
      });
    } catch (err) {
      // Две попытки одной Основы разом — вторая упирается в уникальный номер. Это не ошибка.
      if ((err as { code?: string }).code === "P2002") return res.json({ repeated: true });
      throw err;
    }

    const who = box?.name ? `${body.workshop} (@${box.name})` : body.workshop;
    void notifyPlatform(created.id, body.kind, `Основа: ${who}`, body.text);
    res.status(201).json({ id: created.id });
  })
);
