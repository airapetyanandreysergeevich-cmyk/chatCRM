import { Router, type Request } from "express";
import multer from "multer";
import { z } from "zod";
import { withTenant } from "../../lib/db";
import { env } from "../../lib/env";
import { ah, badRequest, forbidden, notFound } from "../../lib/errors";
import { notifyTenant } from "../../lib/notify";
import { PERMISSIONS } from "../../lib/permissions";
import { isAllowedUpload, putOrderFile, removeFile, signedUrl } from "../../lib/storage";
import { originalName } from "../../lib/uploadName";
import {
  actorUserId,
  authenticate,
  currentTenantId,
  permissionsOf,
  requireTenant,
} from "../../middleware/auth";
import { enforceTenantStatus } from "../../middleware/tenantStatus";
import { assertOrderAccess } from "./orders.service";

/**
 * История ремонта — переписка мастеров в карточке заказа.
 *
 * Зачем отдельно от «Комментария мастера»: тот — итог для квитанции, одна
 * строка, которую видит клиент. Здесь — рабочий журнал: «вскрыл, залит
 * чаем», «заказал шлейф, ждём до пятницы», «клиент просил не менять клавиатуру».
 * Кто и когда написал, видно у каждого сообщения; снимки лежат рядом с
 * текстом, к которому относятся, а не общей кучей в фотографиях заказа.
 *
 * Писать может каждый, кому виден заказ: история нужна и приёмщику, который
 * звонит клиенту, и мастеру, который его чинит. Удалить сообщение может его
 * автор или тот, кто вправе править заказ; удалённое не исчезает из журнала,
 * а остаётся строкой «сообщение удалено» — иначе ответы повисли бы в воздухе.
 */

export const messagesRouter = Router({ mergeParams: true });
messagesRouter.use(authenticate, requireTenant, enforceTenantStatus);

const tenantOf = (req: Request) => currentTenantId(req)!;
const has = (req: Request, code: string) => permissionsOf(req).includes(code);

const MAX_FILES = 10;
const MAX_TEXT = 4000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.maxFileSizeMb * 1024 * 1024, files: MAX_FILES },
});

async function loadOrder(req: Request, tx: Parameters<Parameters<typeof withTenant>[1]>[0]) {
  const order = await tx.order.findFirst({
    where: { id: req.params.id, deletedAt: null },
    select: { id: true, number: true, assignedMasterId: true },
  });
  if (!order) throw notFound("Заказ не найден");
  assertOrderAccess(req, order);
  return order;
}

/**
 * Сообщение для окна. Ссылки на снимки — сразу здесь: история с двадцатью
 * фотографиями не должна делать двадцать запросов за ссылками.
 */
const view = async (m: {
  id: string;
  text: string;
  createdAt: Date;
  deletedAt: Date | null;
  author: { id: string; fullName: string } | null;
  attachments: Array<{ id: string; fileName: string; mimeType: string; sizeBytes: number; objectKey: string }>;
}) => ({
  id: m.id,
  text: m.deletedAt ? "" : m.text,
  createdAt: m.createdAt,
  deleted: !!m.deletedAt,
  author: m.author,
  attachments: m.deletedAt
    ? []
    : await Promise.all(
        m.attachments.map(async ({ objectKey, ...a }) => ({ ...a, url: await signedUrl(objectKey) }))
      ),
});

const messageSelect = {
  id: true,
  text: true,
  createdAt: true,
  deletedAt: true,
  author: { select: { id: true, fullName: true } },
  attachments: {
    orderBy: { createdAt: "asc" as const },
    select: { id: true, fileName: true, mimeType: true, sizeBytes: true, objectKey: true },
  },
};

messagesRouter.get(
  "/",
  ah(async (req, res) => {
    const rows = await withTenant(tenantOf(req), async (tx) => {
      const order = await loadOrder(req, tx);
      return tx.orderMessage.findMany({
        where: { orderId: order.id },
        orderBy: { createdAt: "asc" },
        take: 500,
        select: messageSelect,
      });
    });
    res.json(await Promise.all(rows.map(view)));
  })
);

messagesRouter.post(
  "/",
  upload.array("files", MAX_FILES),
  ah(async (req, res) => {
    const text = z
      .string()
      .max(MAX_TEXT, `Слишком длинное сообщение — до ${MAX_TEXT} знаков`)
      .catch("")
      .parse(req.body?.text)
      .replace(/\r\n/g, "\n")
      .trim();
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (!text && !files.length) throw badRequest("Напишите сообщение или приложите фото");
    for (const f of files) {
      if (!isAllowedUpload(f.mimetype) || f.mimetype === "application/pdf") {
        throw badRequest(`К сообщению прикладываются только фотографии: ${originalName(f.originalname)}`);
      }
    }

    const tenantId = tenantOf(req);
    const author = actorUserId(req);
    const order = await withTenant(tenantId, (tx) => loadOrder(req, tx));

    // Файлы — вне транзакции: десяток снимков по мобильному интернету это
    // секунды, держать ради них открытое соединение с базой незачем.
    const keys: Array<{ key: string; file: Express.Multer.File }> = [];
    try {
      for (const f of files) {
        keys.push({ key: await putOrderFile({ tenantId, orderId: order.id, buffer: f.buffer, mimeType: f.mimetype }), file: f });
      }
    } catch (err) {
      // Не дозалилось — не оставляем в хранилище снимков без сообщения.
      await Promise.all(keys.map((k) => removeFile(k.key).catch(() => {})));
      throw err;
    }

    const { message, notify } = await withTenant(tenantId, async (tx) => {
      const created = await tx.orderMessage.create({
        data: { tenantId, orderId: order.id, authorId: author, text },
      });
      for (const { key, file } of keys) {
        await tx.attachment.create({
          data: {
            tenantId,
            orderId: order.id,
            messageId: created.id,
            kind: "MESSAGE",
            objectKey: key,
            fileName: originalName(file.originalname).slice(0, 200),
            mimeType: file.mimetype,
            sizeBytes: file.size,
            uploadedById: author,
          },
        });
      }
      // Кому сообщить: назначенному мастеру и всем, кто уже писал в эту
      // историю, — это и есть участники разговора. Себе — не сообщаем.
      const earlier = await tx.orderMessage.findMany({
        where: { orderId: order.id, deletedAt: null, authorId: { not: null } },
        distinct: ["authorId"],
        select: { authorId: true },
      });
      const people = new Set<string>(earlier.map((m) => m.authorId!).filter(Boolean));
      if (order.assignedMasterId) people.add(order.assignedMasterId);
      if (author) people.delete(author);

      const full = await tx.orderMessage.findFirstOrThrow({ where: { id: created.id }, select: messageSelect });
      return { message: full, notify: [...people] };
    });

    const preview = text ? (text.length > 120 ? `${text.slice(0, 117)}…` : text) : `Фото: ${keys.length}`;
    const who = message.author?.fullName ?? "Сотрудник";
    // Одним оповещением: иначе роли из матрицы настроек получили бы его
    // столько раз, сколько участников в разговоре.
    void notifyTenant(tenantId, {
      event: "order.message",
      title: `${who} — заказ ${order.number}`,
      body: preview,
      url: `/orders/${order.id}#history`,
      targetUserIds: notify,
      exceptUserId: author,
      payload: { orderId: order.id, messageId: message.id },
    });

    res.status(201).json(await view(message));
  })
);

messagesRouter.delete(
  "/:messageId",
  ah(async (req, res) => {
    const tenantId = tenantOf(req);
    const me = actorUserId(req);
    const keys = await withTenant(tenantId, async (tx) => {
      const order = await loadOrder(req, tx);
      const message = await tx.orderMessage.findFirst({
        where: { id: req.params.messageId, orderId: order.id, deletedAt: null },
        select: { id: true, authorId: true, attachments: { select: { id: true, objectKey: true } } },
      });
      if (!message) throw notFound("Сообщение не найдено");
      const own = !!me && message.authorId === me;
      if (!own && !has(req, PERMISSIONS.ORDERS_EDIT)) throw forbidden("Удалить можно только своё сообщение");

      await tx.orderMessage.update({ where: { id: message.id }, data: { deletedAt: new Date() } });
      await tx.attachment.deleteMany({ where: { messageId: message.id } });
      return message.attachments.map((a) => a.objectKey);
    });
    await Promise.all(keys.map((k) => removeFile(k).catch(() => {})));
    res.json({ ok: true });
  })
);
