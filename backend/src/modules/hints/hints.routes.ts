import { Router, type Request } from "express";
import { z } from "zod";
import { clientIp, writeAudit } from "../../lib/audit";
import { withTenant } from "../../lib/db";
import { ah, notFound } from "../../lib/errors";
import { PERMISSIONS } from "../../lib/permissions";
import {
  actorUserId,
  authenticate,
  currentTenantId,
  requirePermission,
  requireTenant,
} from "../../middleware/auth";
import { enforceTenantStatus } from "../../middleware/tenantStatus";

/**
 * Подсказки для полей техники: что мастерская уже вводила раньше.
 *
 * Список отдаём целиком и один раз при открытии бланка, а не по букве:
 * вариантов в мастерской сотни, они умещаются в один небольшой ответ, а
 * подбор в браузере срабатывает мгновенно — без ожидания сети на каждое
 * нажатие клавиши.
 */

export const hintsRouter = Router();
hintsRouter.use(authenticate, requireTenant, enforceTenantStatus);

const tenantOf = (req: Request) => currentTenantId(req)!;

/** Потолок на поле: дальше список всё равно никто не листает. */
const LIMIT = 400;

hintsRouter.get(
  "/",
  ah(async (req, res) => {
    const rows = await withTenant(tenantOf(req), (tx) =>
      tx.deviceHint.findMany({
        // Сначала то, что чаще нужно; при равном счёте — по алфавиту,
        // чтобы порядок не прыгал от запроса к запросу.
        orderBy: [{ uses: "desc" }, { value: "asc" }],
        take: LIMIT * 3,
        select: { id: true, field: true, scope: true, value: true, uses: true },
      })
    );

    res.json({
      kind: rows.filter((r) => r.field === "kind").slice(0, LIMIT),
      brand: rows.filter((r) => r.field === "brand").slice(0, LIMIT),
      model: rows.filter((r) => r.field === "model").slice(0, LIMIT),
    });
  })
);

/**
 * Удаление варианта из памяти.
 *
 * Право то же, что на приём заказа: кто вводит эти поля, тот и вычищает из
 * них свои опечатки. Удаляем по-настоящему — это не данные о заказах, а
 * заметка на полях, и «удалённая, но лежит» подсказка никому не нужна.
 */
hintsRouter.delete(
  "/:id",
  requirePermission(PERMISSIONS.ORDERS_CREATE),
  ah(async (req, res) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const tenantId = tenantOf(req);

    await withTenant(tenantId, async (tx) => {
      const hint = await tx.deviceHint.findFirst({ where: { id } });
      if (!hint) throw notFound("Такого варианта уже нет");

      await tx.deviceHint.delete({ where: { id } });
      await writeAudit(tx, {
        tenantId,
        userId: actorUserId(req),
        entity: "DeviceHint",
        entityId: id,
        action: "DELETE",
        diff: { field: hint.field, value: hint.value },
        ip: clientIp(req),
      });
    });

    res.json({ ok: true });
  })
);
