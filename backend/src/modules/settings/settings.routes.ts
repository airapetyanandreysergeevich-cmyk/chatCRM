import { randomUUID } from "crypto";
import { Router, type Request } from "express";
import { z } from "zod";
import { clientIp, writeAudit } from "../../lib/audit";
import { withTenant } from "../../lib/db";
import { ah, badRequest } from "../../lib/errors";
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

import { applyRemoteAccess, relayAgentState } from "../relay/relay.instance";
import { defaultRelayUrl, readRemoteAccess, saveRemoteAccess } from "../relay/remoteAccess";
import { encodeStaffKey, parseInvite, publicAddress } from "../relay/invite";

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

/**
 * Логотип храним прямо в настройках, строкой data:.
 *
 * Отдельного файла в хранилище он не стоит: картинка нужна на каждой
 * странице и в каждом бланке, а подписанная ссылка живёт пятнадцать минут
 * и в окне печати успевает протухнуть. Размер режет клиент, здесь только
 * потолок — чтобы никто не положил в настройки фотографию с телефона.
 *
 * SVG не принимаем намеренно: внутри него бывает разметка и скрипты, а
 * растровая картинка — это просто пиксели.
 */
const LOGO_LIMIT = 200_000;

const brandingSchema = z.object({
  logo: z
    .string()
    .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/, "Подойдёт PNG, JPEG или WebP")
    .max(LOGO_LIMIT, "Логотип слишком тяжёлый — уменьшите картинку")
    .nullable(),
  /** Строка под названием в бланках: адрес, телефон, часы работы. */
  printNote: z.string().trim().max(200).nullable(),
});

async function readSettings(tenantId: string): Promise<Record<string, unknown>> {
  const tenant = await withTenant(tenantId, (tx) =>
    tx.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } })
  );
  return ((tenant?.settings as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
}

/**
 * Всё оформление одним запросом: и палитра, и логотип нужны при первой же
 * отрисовке, и разносить их по двум обращениям — значит моргнуть дважды.
 */
settingsRouter.get(
  "/appearance",
  ah(async (req, res) => {
    const settings = await readSettings(tenantOf(req));
    const branding = (settings.branding ?? {}) as Record<string, unknown>;
    res.json({
      // null значит «ничего не настраивали» — фронтенд подставит стандартное.
      theme: settings.theme ?? null,
      branding: {
        logo: typeof branding.logo === "string" ? branding.logo : null,
        printNote: typeof branding.printNote === "string" ? branding.printNote : null,
      },
    });
  })
);

/**
 * Название мастерской.
 *
 * Лежит не в settings, а в собственной колонке Tenant.name: по нему
 * мастерскую находит платформа, оно стоит в письмах и в печатных бланках.
 * Tenant — таблица платформы, RLS на неё не распространяется, поэтому
 * where по id здесь обязателен и написан руками.
 */
settingsRouter.put(
  "/workshop",
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  ah(async (req, res) => {
    const { name } = z
      .object({
        name: z
          .string()
          .trim()
          .min(2, "Название слишком короткое")
          .max(80, "Название длиннее 80 знаков не поместится в бланк"),
      })
      .parse(req.body);
    const tenantId = tenantOf(req);

    await withTenant(tenantId, async (tx) => {
      const before = await tx.tenant.findUnique({ where: { id: tenantId }, select: { name: true } });
      if (before?.name === name) return;

      await tx.tenant.update({ where: { id: tenantId }, data: { name } });
      await writeAudit(tx, {
        tenantId,
        userId: actorUserId(req),
        entity: "Tenant",
        entityId: tenantId,
        action: "UPDATE",
        diff: { name: { from: before?.name ?? null, to: name } },
        ip: clientIp(req),
      });
    });

    res.json({ ok: true });
  })
);

settingsRouter.put(
  "/branding",
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  ah(async (req, res) => {
    const branding = brandingSchema.parse(req.body);
    const tenantId = tenantOf(req);

    await withTenant(tenantId, async (tx) => {
      const tenant = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: { settings: true },
      });
      const settings = { ...((tenant?.settings as object) ?? {}), branding };
      await tx.tenant.update({ where: { id: tenantId }, data: { settings } });

      await writeAudit(tx, {
        tenantId,
        userId: actorUserId(req),
        entity: "Tenant",
        entityId: tenantId,
        action: "UPDATE",
        // Саму картинку в журнал не кладём: она весит больше, чем вся
        // остальная запись, и читать её там всё равно некому.
        diff: { logo: branding.logo ? "загружен" : "убран", printNote: branding.printNote },
        ip: clientIp(req),
      });
    });

    res.json({ ok: true });
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

// ---------- доступ из интернета (коробочная версия) ----------

/**
 * Доступ к Основе снаружи.
 *
 * Ключ выдаёт собственник платформы: он же в любой момент его отзывает. Здесь
 * владелец мастерской только вставляет выданный ключ и видит, есть ли связь.
 *
 * Наружу ключ не отдаётся никогда — только последние четыре знака, чтобы было
 * видно, тот ли ключ вставлен. Показывать его целиком незачем: тот, кто имеет
 * право его менять, может просто вставить новый.
 */
const remoteAccessSchema = z.object({
  enabled: z.boolean(),
  /**
   * Фраза подключения от поставщика — адрес, ключ и код одной строкой.
   * Пусто — остаётся прежняя: переключатель можно двигать, не вставляя ничего.
   */
  phrase: z.string().trim().max(2000).optional(),
});

settingsRouter.get(
  "/remote-access",
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  ah(async (_req, res) => {
    const saved = await readRemoteAccess();
    const agent = relayAgentState();
    const url = saved?.url || defaultRelayUrl();
    res.json({
      enabled: saved?.enabled ?? false,
      /** Подключена ли фраза вообще — сам ключ наружу не отдаётся никогда. */
      connected: Boolean(saved?.key),
      keyHint: saved?.key ? saved.key.slice(-4) : "",
      code: saved?.code ?? "",
      email: saved?.email ?? "",
      address: publicAddress(url, saved?.code ?? ""),
      staff: saved?.staff ?? [],
      state: agent.state,
      detail: agent.detail ?? null,
    });
  })
);

settingsRouter.put(
  "/remote-access",
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  ah(async (req, res) => {
    const body = remoteAccessSchema.parse(req.body);
    const saved = await readRemoteAccess();

    // Вставили новую фразу — разбираем её. Не вставили — работаем с прежней.
    const invite = body.phrase ? parseInvite(body.phrase, defaultRelayUrl()) : null;
    if (body.phrase && !invite) {
      throw badRequest("Это не похоже на фразу подключения — скопируйте её целиком и вставьте ещё раз");
    }
    const key = invite?.key ?? saved?.key ?? "";
    const url = invite?.url ?? saved?.url ?? defaultRelayUrl();
    const code = invite?.code || saved?.code || "";
    const email = invite?.email || saved?.email || "";
    if (body.enabled && !key) throw badRequest("Вставьте фразу подключения — её выдаёт поставщик программы");

    await saveRemoteAccess({ enabled: body.enabled, url, key, code, email });
    const agent = applyRemoteAccess(body.enabled ? { url, key } : null);

    await withTenant(tenantOf(req), (tx) =>
      writeAudit(tx, {
        tenantId: tenantOf(req),
        userId: actorUserId(req),
        entity: "Tenant",
        entityId: tenantOf(req),
        action: "UPDATE",
        // Ключ в журнал не пишем ни при каких обстоятельствах.
        diff: { remoteAccess: body.enabled ? "включён" : "выключен", keyChanged: !!invite },
        ip: clientIp(req),
      })
    );

    res.json({
      enabled: body.enabled,
      connected: Boolean(key),
      keyHint: key.slice(-4),
      code,
      email,
      address: publicAddress(url, code),
      state: agent.state,
    });
  })
);

/**
 * Ключ для сотрудника.
 *
 * Владелец выдаёт его каждому по отдельности — и не потому, что ключи разные
 * по правам (прав они не дают вовсе), а потому что так человеку нечего
 * запоминать: вставил строку в программу и попал на экран входа своей
 * мастерской. Кому выдавали, остаётся в списке — чтобы владелец помнил, а не
 * чтобы что-то проверять.
 */
settingsRouter.post(
  "/remote-access/staff-key",
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  ah(async (req, res) => {
    const { label } = z
      .object({ label: z.string().trim().min(1, "Напишите, кому выдаёте ключ").max(60) })
      .parse(req.body);

    const saved = await readRemoteAccess();
    if (!saved?.key || !saved.code) {
      throw badRequest("Сначала подключите мастерскую к интернету — тогда появится и адрес для сотрудников");
    }

    const address = publicAddress(saved.url || defaultRelayUrl(), saved.code);
    const tenant = await withTenant(tenantOf(req), (tx) =>
      tx.tenant.findUnique({ where: { id: tenantOf(req) }, select: { name: true } })
    );

    const entry = { id: randomUUID(), label, issuedAt: new Date().toISOString() };
    await saveRemoteAccess({ ...saved, staff: [...(saved.staff ?? []), entry] });

    res.status(201).json({
      key: encodeStaffKey({ address, workshop: tenant?.name ?? "", label }),
      address,
      staff: [...(saved.staff ?? []), entry],
    });
  })
);

/** Убрать запись из списка: сам ключ этим не отзывается — отзывается учётка сотрудника. */
settingsRouter.delete(
  "/remote-access/staff-key/:id",
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  ah(async (req, res) => {
    const saved = await readRemoteAccess();
    if (!saved) return res.json({ staff: [] });
    const staff = (saved.staff ?? []).filter((s) => s.id !== req.params.id);
    await saveRemoteAccess({ ...saved, staff });
    res.json({ staff });
  })
);
