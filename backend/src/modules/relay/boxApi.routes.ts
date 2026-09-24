import { Router, type Request } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { ah, badRequest, conflict, unauthorized } from "../../lib/errors";
import { normalizeName } from "../../lib/login";
import { authenticateBox, claimName, nameStatus } from "./boxes.service";

/**
 * Облако для Основы: то, о чём мастерская спрашивает сама.
 *
 * Сейчас это одно — имя мастерской. Свободно ли оно, знает только облако: оно
 * одно видит все мастерские сразу. Поэтому Основа, когда владелец выбирает
 * имя, спрашивает сюда, а сюда — только со своим ключом.
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
