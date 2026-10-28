import express, { Router } from "express";
import { z } from "zod";
import { withTenant } from "../../lib/db";
import { env } from "../../lib/env";
import { ah, badRequest, notFound } from "../../lib/errors";
import { isAllowedAudio, putCallFile, removeFile } from "../../lib/storage";
import { assertStorageRoom } from "../../lib/usage";
import { requirePhone } from "../sms/sms.phone";
import { loadCallSettings, reportCall } from "./calls";

/**
 * Звонки от телефона «FineCRM Телефон» (бывший «FineCRM SMS», с версии 1.3).
 * Ключ тот же, что у SMS: «X-Phone-Token».
 *
 *   POST /api/sms/phone/calls          — звонок из журнала: номер, время, длительность
 *   POST /api/sms/phone/calls/:id/audio — запись разговора (тело — сам файл, audio/*)
 */
export const callsPhoneRouter = Router();

const callSchema = z.object({
  key: z.string().trim().min(3).max(120),
  direction: z.enum(["in", "out", "missed", "rejected"]),
  number: z.string().trim().min(3).max(40),
  startedAt: z.number().int().positive(),
  durationSec: z.number().min(0).max(24 * 3600).default(0),
});

callsPhoneRouter.post(
  "/",
  ah(async (req, res) => {
    const auth = await requirePhone(req, res);
    if (!auth) return;
    const body = callSchema.parse(req.body);
    // Звонок «из будущего» или древний — это сбитые часы телефона, а не звонок.
    const at = new Date(body.startedAt);
    if (at.getTime() > Date.now() + 10 * 60_000) throw badRequest("Время звонка из будущего — проверьте часы телефона");
    await withTenant(auth.tenantId, (tx) => tx.smsPhone.update({ where: { id: auth.phoneId }, data: { lastSeenAt: new Date() } }));
    const out = await reportCall(auth.tenantId, auth.phoneId, {
      key: `${auth.phoneId.slice(0, 8)}:${body.key}`,
      direction: body.direction.toUpperCase() as "IN" | "OUT" | "MISSED" | "REJECTED",
      number: body.number,
      startedAt: at,
      durationSec: body.durationSec,
    });
    res.json(out);
  })
);

callsPhoneRouter.post(
  "/:id/audio",
  express.raw({ type: () => true, limit: `${env.maxFileSizeMb}mb` }),
  ah(async (req, res) => {
    const auth = await requirePhone(req, res);
    if (!auth) return;
    const mimeType = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    if (!isAllowedAudio(mimeType)) throw badRequest("Это не запись разговора: ожидается файл audio/*");
    const buffer = req.body as Buffer;
    if (!Buffer.isBuffer(buffer) || buffer.length < 200) throw badRequest("Файл записи пустой");

    const call = await withTenant(auth.tenantId, async (tx) => {
      const s = await loadCallSettings(tx);
      const row = await tx.callRecord.findFirst({ where: { id: req.params.id }, select: { id: true, attachmentId: true, startedAt: true } });
      return { s, row };
    });
    if (!call.row) throw notFound("Звонок не найден");
    // Уже есть — повтор после обрыва связи: отвечаем «готово», второй раз не храним.
    if (call.row.attachmentId) return res.json({ ok: true, already: true });
    if (!call.s.enabled || !call.s.audio) return res.json({ ok: false, off: true });

    await assertStorageRoom(auth.tenantId, buffer.length);
    const objectKey = await putCallFile({ tenantId: auth.tenantId, buffer, mimeType });
    const stamp = call.row.startedAt.toISOString().slice(0, 16).replace("T", " ").replace(":", "-");
    const ext = objectKey.split(".").pop() ?? "m4a";
    try {
      await withTenant(auth.tenantId, async (tx) => {
        const att = await tx.attachment.create({
          data: {
            tenantId: auth.tenantId,
            kind: "CALL",
            objectKey,
            fileName: `Звонок ${stamp}.${ext}`,
            mimeType,
            sizeBytes: buffer.length,
          },
          select: { id: true },
        });
        // Условие на attachmentId: две загрузки сразу — запишется одна.
        const done = await tx.callRecord.updateMany({ where: { id: call.row!.id, attachmentId: null }, data: { attachmentId: att.id } });
        if (!done.count) throw new Error("already");
      });
    } catch (err) {
      await removeFile(objectKey).catch(() => undefined);
      if (err instanceof Error && err.message === "already") return res.json({ ok: true, already: true });
      throw err;
    }
    res.json({ ok: true });
  })
);
