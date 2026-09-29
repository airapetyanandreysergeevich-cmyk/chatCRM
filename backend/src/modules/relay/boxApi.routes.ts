import { Router, type Request } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { ah, badRequest, conflict, unauthorized } from "../../lib/errors";
import { normalizeName } from "../../lib/login";
import { prisma } from "../../lib/db";
import { loadDictionary } from "../plate/plate.dictionary";
import { forgetKnowledge, platformKnowledge } from "../plate/plate.learn";
import { modelKeys } from "../plate/plate.parse";
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
