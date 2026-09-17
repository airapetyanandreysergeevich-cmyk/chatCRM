import { Router, type Request } from "express";
import { z } from "zod";
import { clientIp, writeAudit } from "../../lib/audit";
import { withTenant } from "../../lib/db";
import { ah } from "../../lib/errors";
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
 * Цвета интерфейса мастерской.
 *
 * Хранятся в Tenant.settings.theme рядом с настройками оповещений — своей
 * колонки не заводим: это не данные, по которым что-то ищут или считают.
 *
 * Светлую или тёмную тему сотрудник выбирает себе сам, и её здесь нет
 * вовсе — она живёт в его браузере. Сервер хранит только палитру, потому
 * что цвет колонки «Ремонт» должен значить одно и то же для всех.
 */

export const settingsRouter = Router();
settingsRouter.use(authenticate, requireTenant, enforceTenantStatus);

const tenantOf = (req: Request) => currentTenantId(req)!;

const hex = z
  .string()
  .trim()
  .regex(/^#[0-9A-Fa-f]{6}$/, "Цвет задаётся шестнадцатеричным кодом вида #1A2B3C");

const palette = z.object({
  bg: hex,
  surface: hex,
  brand: hex,
  stageNew: hex,
  stageWaiting: hex,
  stageProgress: hex,
  stageDone: hex,
});

/** Палитры раздельные: цвет, читаемый на чёрном, на белом слепнет. */
const themeSchema = z.object({ dark: palette, light: palette });

async function readSettings(tenantId: string): Promise<Record<string, unknown>> {
  const tenant = await withTenant(tenantId, (tx) =>
    tx.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } })
  );
  return ((tenant?.settings as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
}

settingsRouter.get(
  "/theme",
  ah(async (req, res) => {
    const settings = await readSettings(tenantOf(req));
    // null значит «ничего не настраивали» — фронтенд подставит стандартную.
    res.json({ theme: settings.theme ?? null });
  })
);

settingsRouter.put(
  "/theme",
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  ah(async (req, res) => {
    const { theme } = z.object({ theme: themeSchema }).parse(req.body);
    const tenantId = tenantOf(req);

    await withTenant(tenantId, async (tx) => {
      const tenant = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: { settings: true },
      });
      // Дописываем свой ключ, а не перезаписываем весь объект: рядом лежат
      // настройки оповещений, и потерять их из-за смены цвета было бы дико.
      const settings = { ...((tenant?.settings as object) ?? {}), theme };
      await tx.tenant.update({ where: { id: tenantId }, data: { settings } });

      await writeAudit(tx, {
        tenantId,
        userId: actorUserId(req),
        entity: "Tenant",
        entityId: tenantId,
        action: "UPDATE",
        diff: { theme },
        ip: clientIp(req),
      });
    });

    res.json({ ok: true });
  })
);

settingsRouter.delete(
  "/theme",
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  ah(async (req, res) => {
    const tenantId = tenantOf(req);

    await withTenant(tenantId, async (tx) => {
      const tenant = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: { settings: true },
      });
      const { theme: _dropped, ...rest } = { ...((tenant?.settings as object) ?? {}) } as {
        theme?: unknown;
      };
      await tx.tenant.update({ where: { id: tenantId }, data: { settings: rest } });

      await writeAudit(tx, {
        tenantId,
        userId: actorUserId(req),
        entity: "Tenant",
        entityId: tenantId,
        action: "UPDATE",
        diff: { theme: "сброшена к стандартной" },
        ip: clientIp(req),
      });
    });

    res.json({ ok: true });
  })
);
