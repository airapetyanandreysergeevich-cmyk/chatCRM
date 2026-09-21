import { Router, type Request } from "express";
import { z } from "zod";
import { clientIp, writeAudit } from "../../lib/audit";
import { withTenant } from "../../lib/db";
import { isLockedPick, type QuickPickField } from "../../lib/dictionaries";
import { ah, badRequest, conflict, notFound } from "../../lib/errors";
import { PERMISSIONS } from "../../lib/permissions";
import {
  actorUserId,
  authenticate,
  currentTenantId,
  requirePermission,
  requireTenant,
} from "../../middleware/auth";
import { enforceTenantStatus } from "../../middleware/tenantStatus";
import { isQuickPickField, labelSchema, listQuickPicks } from "./quickpicks.service";

/**
 * Правка кнопок быстрого заполнения — шестерёнкой на бланке приёма.
 *
 * Право — «Настройки мастерской», а не «Приём заказа». Кнопки общие на всю
 * мастерскую: убранная одним приёмщиком «Батарея» пропадёт у всех, и такое
 * решение должен принимать тот, кто отвечает за порядок, а не тот, кому она
 * сегодня мешала.
 */

export const quickPicksRouter = Router();
quickPicksRouter.use(authenticate, requireTenant, enforceTenantStatus);

const tenantOf = (req: Request) => currentTenantId(req)!;

const fieldParam = (raw: unknown): QuickPickField => {
  const field = String(raw ?? "");
  if (!isQuickPickField(field)) throw badRequest("Неизвестный список кнопок");
  return field;
};

quickPicksRouter.get(
  "/:field",
  ah(async (req, res) => {
    const field = fieldParam(req.params.field);
    res.json(await withTenant(tenantOf(req), (tx) => listQuickPicks(tx, field)));
  })
);

quickPicksRouter.post(
  "/:field",
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  ah(async (req, res) => {
    const field = fieldParam(req.params.field);
    const { label } = z.object({ label: labelSchema }).parse(req.body);
    const tenantId = tenantOf(req);

    const created = await withTenant(tenantId, async (tx) => {
      // Уникальность в базе — с учётом регистра, а «кабель» и «Кабель» для
      // человека одна кнопка. Сверяем сами, до записи.
      const twin = await tx.quickPick.findFirst({
        where: { field, label: { equals: label, mode: "insensitive" } },
        select: { id: true },
      });
      if (twin) throw conflict(`Кнопка «${label}» уже есть`);

      // Новая встаёт в конец: счёт у неё ноль, а среди нулей — после всех.
      const last = await tx.quickPick.aggregate({ where: { field }, _max: { sortOrder: true } });
      const row = await tx.quickPick.create({
        data: { tenantId, field, label, sortOrder: (last._max.sortOrder ?? -1) + 1 },
      });
      await writeAudit(tx, {
        tenantId,
        userId: actorUserId(req),
        entity: "QuickPick",
        entityId: row.id,
        action: "CREATE",
        diff: { field, label },
        ip: clientIp(req),
      });
      return row;
    });

    res.status(201).json({ id: created.id, label: created.label, uses: 0, locked: false });
  })
);

quickPicksRouter.patch(
  "/:field/:id",
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  ah(async (req, res) => {
    const field = fieldParam(req.params.field);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { label } = z.object({ label: labelSchema }).parse(req.body);
    const tenantId = tenantOf(req);

    await withTenant(tenantId, async (tx) => {
      const row = await tx.quickPick.findFirst({ where: { id, field } });
      if (!row) throw notFound("Такой кнопки уже нет");
      if (isLockedPick(field, row.label)) {
        throw badRequest(`«${row.label}» переименовать нельзя: по этой кнопке ставится флаг гарантии`);
      }

      const twin = await tx.quickPick.findFirst({
        where: { field, id: { not: id }, label: { equals: label, mode: "insensitive" } },
        select: { id: true },
      });
      if (twin) throw conflict(`Кнопка «${label}» уже есть`);

      // Счёт остаётся за кнопкой: переименование — это та же кнопка, а не
      // новая, и отправлять её в конец списка было бы наказанием за опечатку.
      await tx.quickPick.update({ where: { id }, data: { label } });
      await writeAudit(tx, {
        tenantId,
        userId: actorUserId(req),
        entity: "QuickPick",
        entityId: id,
        action: "UPDATE",
        diff: { field, from: row.label, to: label },
        ip: clientIp(req),
      });
    });

    res.json({ ok: true });
  })
);

quickPicksRouter.delete(
  "/:field/:id",
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  ah(async (req, res) => {
    const field = fieldParam(req.params.field);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const tenantId = tenantOf(req);

    await withTenant(tenantId, async (tx) => {
      const row = await tx.quickPick.findFirst({ where: { id, field } });
      if (!row) throw notFound("Такой кнопки уже нет");
      if (isLockedPick(field, row.label)) {
        throw badRequest(`«${row.label}» убрать нельзя: по этой кнопке ставится флаг гарантии`);
      }

      // Удаляем по-настоящему: принятые заказы кнопку не держат — пункт
      // записан в заказе текстом и останется в нём как был.
      await tx.quickPick.delete({ where: { id } });
      await writeAudit(tx, {
        tenantId,
        userId: actorUserId(req),
        entity: "QuickPick",
        entityId: id,
        action: "DELETE",
        diff: { field, label: row.label, uses: row.uses },
        ip: clientIp(req),
      });
    });

    res.json({ ok: true });
  })
);
