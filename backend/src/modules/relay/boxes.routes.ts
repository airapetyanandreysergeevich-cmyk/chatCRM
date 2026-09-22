import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/db";
import { ah, badRequest, conflict, notFound } from "../../lib/errors";
import { encodeInvite, publicAddress } from "./invite";
import { codeFromEmail, fingerprint, freeCode, newKey, normalizeCode } from "./boxes.service";
import { relayHub } from "./relay.instance";

/**
 * Панель собственника: кому открыт доступ из интернета.
 *
 * Здесь выдают и отзывают ключи коробочных мастерских. Это же и рубильник
 * услуги: выключили — Основа отвалилась, и адрес перестал работать, хотя сама
 * программа в мастерской продолжает работать как ни в чём не бывало, по
 * локальной сети. Отключение доступа не трогает ни базу, ни заказы.
 *
 * Подключается внутрь platformRouter, поэтому проверок прав здесь нет: до
 * сюда доходит только собственник платформы.
 */

export const boxesRouter = Router();

/**
 * Адрес узла связи для фразы подключения.
 *
 * Берём из запроса, а не из настроек: панель открыта на том самом домене, к
 * которому мастерской и предстоит подключаться. Так фраза остаётся верной и
 * на finecrm.ru, и на любом другом домене, куда систему поставят.
 */
function relayUrlFor(req: { headers: Record<string, unknown>; get(name: string): string | undefined }): string {
  const host = req.get("x-forwarded-host") || req.get("host") || "www.finecrm.ru";
  const proto = (req.get("x-forwarded-proto") || "https").split(",")[0];
  return `${proto === "http" ? "ws" : "wss"}://${host}/relay/agent`;
}

const boxSchema = z.object({
  /**
   * Почта того, кто запросил доступ. Обязательна: по ней делается адрес, по
   * ней видно, кому выдан ключ, и на неё по просьбе высылается фраза заново.
   */
  email: z.string().trim().toLowerCase().email("Похоже, это не email"),
  /** Код в адресе — обычно из почты, но можно задать свой. */
  code: z.string().trim().min(3, "Код от 3 знаков").max(40).optional(),
  note: z.string().trim().max(500).optional(),
});

const view = (
  box: {
    id: string;
    code: string;
    email: string;
    keyHint: string;
    note: string | null;
    isActive: boolean;
    lastSeenAt: Date | null;
    createdAt: Date;
  },
  online: boolean
) => ({ ...box, online });

boxesRouter.get(
  "/",
  ah(async (_req, res) => {
    const boxes = await prisma.box.findMany({ orderBy: { createdAt: "desc" } });
    const hub = relayHub();
    res.json(
      boxes.map((b) =>
        view(
          {
            id: b.id,
            code: b.code,
            email: b.email,
            keyHint: b.keyHint,
            note: b.note,
            isActive: b.isActive,
            lastSeenAt: b.lastSeenAt,
            createdAt: b.createdAt,
          },
          hub?.online(b.code) ?? false
        )
      )
    );
  })
);

boxesRouter.post(
  "/",
  ah(async (req, res) => {
    const body = boxSchema.parse(req.body);

    // Код задали руками — берём его как есть; нет — делаем из почты и, если
    // занят, дописываем номер.
    const asked = body.code ? normalizeCode(body.code) : "";
    if (body.code && asked.length < 3) throw badRequest("Код должен быть из латинских букв и цифр");
    if (asked && (await prisma.box.findUnique({ where: { code: asked } })))
      throw conflict("Такой код уже занят");
    const code = asked || (await freeCode(codeFromEmail(body.email)));

    const key = newKey();
    const box = await prisma.box.create({
      data: {
        code,
        email: body.email,
        note: body.note || null,
        keyHash: fingerprint(key),
        keyHint: key.slice(-4),
      },
    });
    // Ключ целиком — единственный раз в жизни. Дальше только его хвост.
    const url = relayUrlFor(req);
    res.status(201).json({
      id: box.id,
      code: box.code,
      email: box.email,
      phrase: encodeInvite({ url, key, code: box.code, email: box.email }),
      address: publicAddress(url, box.code),
    });
  })
);

/** Перевыпуск ключа: старый перестаёт работать сразу, Основу отключаем. */
boxesRouter.post(
  "/:id/key",
  ah(async (req, res) => {
    const box = await prisma.box.findUnique({ where: { id: req.params.id } });
    if (!box) throw notFound("Мастерская не найдена");
    const key = newKey();
    await prisma.box.update({
      where: { id: box.id },
      data: { keyHash: fingerprint(key), keyHint: key.slice(-4) },
    });
    relayHub()?.disconnect(box.code, "ключ перевыпущен");
    const url = relayUrlFor(req);
    res.json({
      code: box.code,
      email: box.email,
      phrase: encodeInvite({ url, key, code: box.code, email: box.email }),
      address: publicAddress(url, box.code),
    });
  })
);

boxesRouter.patch(
  "/:id",
  ah(async (req, res) => {
    const body = boxSchema.partial().extend({ isActive: z.boolean().optional() }).parse(req.body);
    const box = await prisma.box.findUnique({ where: { id: req.params.id } });
    if (!box) throw notFound("Мастерская не найдена");

    const code = body.code ? normalizeCode(body.code) : undefined;
    if (code && code !== box.code && (await prisma.box.findUnique({ where: { code } })))
      throw conflict("Такой код уже занят");

    const next = await prisma.box.update({
      where: { id: box.id },
      data: {
        ...(body.email ? { email: body.email } : {}),
        ...(code ? { code } : {}),
        ...(body.note !== undefined ? { note: body.note || null } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      },
    });
    // Выключили или переименовали код — прежнее соединение больше не годится.
    if (body.isActive === false || (code && code !== box.code)) {
      relayHub()?.disconnect(box.code, body.isActive === false ? "доступ выключен" : "код изменён");
    }
    res.json({ id: next.id, code: next.code, isActive: next.isActive });
  })
);

boxesRouter.delete(
  "/:id",
  ah(async (req, res) => {
    const box = await prisma.box.findUnique({ where: { id: req.params.id } });
    if (!box) throw notFound("Мастерская не найдена");
    await prisma.box.delete({ where: { id: box.id } });
    relayHub()?.disconnect(box.code, "доступ удалён");
    res.json({ ok: true });
  })
);
