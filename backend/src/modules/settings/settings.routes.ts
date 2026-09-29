import type { Prisma } from "@prisma/client";
import { Router, type Request } from "express";
import { z, ZodError } from "zod";
import { clientIp, writeAudit } from "../../lib/audit";
import { withTenant } from "../../lib/db";
import { ah, badRequest, conflict } from "../../lib/errors";
import {
  STANDARD_PREFIX,
  parseTemplate,
  tenantYear,
  upcoming,
  type OrderNumberFormat,
} from "../../lib/orderNumber";
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
import { parseInvite, publicAddress } from "../relay/invite";

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

/**
 * Бланки на печать: логотип, шапка, тексты условий и гарантии, подписи.
 *
 * Хранится только то, что мастерская поменяла. Стандартные тексты живут в
 * интерфейсе (lib/printForms.ts) — там же, где их печатают, — и поле, равное
 * стандартному, сюда не пишется: улучшим формулировку, и её получат все, кто
 * свою не задавал.
 *
 * Логотип бланков отдельный от логотипа интерфейса: на белой бумаге и на
 * тёмном окне хорошо смотрятся разные картинки. Пока бланки не трогали, в
 * них стоит логотип интерфейса — так было до разделения, так и остаётся.
 */
const text = (max: number) => z.string().max(max, `Не длиннее ${max} знаков`).nullable().optional();
const logoField = z
  .string()
  .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/, "Подойдёт PNG, JPEG или WebP")
  .max(LOGO_LIMIT, "Логотип слишком тяжёлый — уменьшите картинку")
  .nullable()
  .optional();

/**
 * Размер и межстрочный интервал текста условий (гарантии в акте). Пусто —
 * стандартные. Пределы — то, что ещё читается и ещё помещается на лист.
 */
const textSize = z.number().min(8).max(14).multipleOf(0.5).nullable().optional();
const textLeading = z.number().min(1.1).max(2).nullable().optional();

const printSchema = z
  .object({
    logo: logoField,
    name: text(80),
    requisites: text(400),
    intake: z
      .object({ title: text(80), terms: text(2000), signClient: text(100), signStaff: text(100), size: textSize, leading: textLeading })
      .strip()
      .optional(),
    act: z
      .object({ title: text(80), warranty: text(2000), signClient: text(100), signStaff: text(100), size: textSize, leading: textLeading })
      .strip()
      .optional(),
    footer: text(200),
    stamp: z.boolean().optional(),
  })
  .strip();

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

/** Бланки — всем, кто печатает: мастеру и приёмщику они нужны так же, как владельцу. */
settingsRouter.get(
  "/print",
  ah(async (req, res) => {
    const settings = await readSettings(tenantOf(req));
    const branding = (settings.branding ?? {}) as Record<string, unknown>;
    res.json({
      print: (settings.print ?? {}) as Record<string, unknown>,
      // Что стоит в бланках, пока их не настраивали: логотип интерфейса и
      // прежняя «строка в бланках».
      fallback: {
        logo: typeof branding.logo === "string" ? branding.logo : null,
        requisites: typeof branding.printNote === "string" ? branding.printNote : null,
      },
    });
  })
);

settingsRouter.put(
  "/print",
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  ah(async (req, res) => {
    const print = printSchema.parse(req.body);
    const tenantId = tenantOf(req);

    await withTenant(tenantId, async (tx) => {
      const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } });
      const before = ((tenant?.settings as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
      await tx.tenant.update({ where: { id: tenantId }, data: { settings: { ...before, print } as Prisma.InputJsonObject } });

      const old = (before.print ?? {}) as Record<string, unknown>;
      const changed = Object.keys({ ...old, ...print }).filter(
        (k) => JSON.stringify(old[k] ?? null) !== JSON.stringify((print as Record<string, unknown>)[k] ?? null)
      );
      await writeAudit(tx, {
        tenantId,
        userId: actorUserId(req),
        entity: "Tenant",
        entityId: tenantId,
        action: "UPDATE",
        // Тексты целиком в журнал не кладём — только что именно правили.
        diff: {
          print: changed,
          ...(changed.includes("logo") ? { printLogo: print.logo ? "загружен" : "убран" } : {}),
        },
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
      const current = ((tenant?.settings as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
      const print = { ...((current.print ?? {}) as Record<string, unknown>) };
      // Логотип интерфейса меняют — а бланки его до сих пор наследовали.
      // Закрепляем в бланках прежний: логотипы теперь раздельные, и смена
      // картинки в окне программы не должна молча менять бумагу. Если
      // прежнего не было, закреплять нечего: пусть мастерская, которая
      // бланки ещё не открывала, получит логотип и на бумаге, как раньше.
      const oldBranding = (current.branding ?? {}) as Record<string, unknown>;
      if (!("logo" in print) && typeof oldBranding.logo === "string" && oldBranding.logo !== branding.logo) {
        print.logo = oldBranding.logo;
      }
      if (
        !("requisites" in print) &&
        typeof oldBranding.printNote === "string" &&
        oldBranding.printNote !== branding.printNote
      ) {
        print.requisites = oldBranding.printNote;
      }
      const settings = { ...current, branding, print } as Prisma.InputJsonObject;
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
      /** Имя мастерской: логины сотрудников — имя@мастерская. */
      name: saved?.name ?? "",
      address: publicAddress(url, saved?.code ?? ""),
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
    // Имя принадлежит мастерской в облаке, а не фразе: вставили фразу другой
    // мастерской — прежнее имя больше не наше. Настоящее пришлёт узел связи
    // при подключении (см. relay.instance).
    const name = !invite || invite.code === saved?.code ? saved?.name ?? "" : "";
    if (body.enabled && !key) throw badRequest("Вставьте фразу подключения — её выдаёт поставщик программы");

    await saveRemoteAccess({ enabled: body.enabled, url, key, code, email, name });
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
      name,
      address: publicAddress(url, code),
      state: agent.state,
    });
  })
);

// ---------------------------------------------------------------- номер заказа

/**
 * Свой формат номера заказа (см. lib/orderNumber.ts).
 *
 * Менять можно, только пока в мастерской нет ни одного заказа — считая
 * удалённые и загруженные из файла. Иначе номера на выданных квитанциях
 * разошлись бы с базой, а новый счётчик мог бы выдать номер, который уже
 * есть у старого заказа.
 */
async function orderNumberState(tenantId: string) {
  return withTenant(tenantId, async (tx) => {
    const [tenant, orders, year] = await Promise.all([
      tx.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: {
          orderNumberPrefix: true,
          orderNumberNext: true,
          orderNumberTemplate: true,
          orderNumberWidth: true,
          orderNumberStart: true,
          orderNumberWithYear: true,
          orderNumberYear: true,
        },
      }),
      tx.order.count(),
      tenantYear(tx, tenantId),
    ]);
    const format: OrderNumberFormat = {
      template: tenant.orderNumberTemplate,
      prefix: tenant.orderNumberPrefix,
      width: tenant.orderNumberWidth,
      start: tenant.orderNumberStart,
      withYear: tenant.orderNumberWithYear,
    };
    return {
      template: tenant.orderNumberTemplate ?? "",
      withYear: tenant.orderNumberWithYear,
      /** Заказы уже есть — формат менять нельзя. */
      locked: orders > 0,
      orders,
      year,
      next: upcoming(format, { next: tenant.orderNumberNext, year: tenant.orderNumberYear }, year),
    };
  });
}

const orderNumberSchema = z.object({
  /** Пусто — стандартный формат. */
  template: z.string().max(40).default(""),
  withYear: z.boolean().default(false),
});

/** Разобрать запрос в формат — или объяснить, что не так. */
function formatFrom(body: z.infer<typeof orderNumberSchema>): OrderNumberFormat {
  const template = body.template.trim();
  if (!template) return { template: null, prefix: STANDARD_PREFIX, width: 5, start: 1, withYear: false };
  const parsed = parseTemplate(template);
  if (!parsed.ok) throw new ZodError([{ code: "custom", path: ["template"], message: parsed.reason }]);
  return { template, prefix: parsed.prefix, width: parsed.width, start: parsed.start, withYear: body.withYear };
}

settingsRouter.get(
  "/order-number",
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  ah(async (req, res) => {
    res.json(await orderNumberState(tenantOf(req)));
  })
);

/** Как будут выглядеть номера — пока владелец печатает, до сохранения. */
settingsRouter.get(
  "/order-number/preview",
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  ah(async (req, res) => {
    const q = z
      .object({ template: z.string().max(40).default(""), withYear: z.enum(["1", "0"]).default("0") })
      .parse(req.query);
    const format = formatFrom({ template: q.template, withYear: q.withYear === "1" });
    const year = await withTenant(tenantOf(req), (tx) => tenantYear(tx, tenantOf(req)));
    res.json({ next: upcoming(format, { next: format.start, year: null }, year) });
  })
);

settingsRouter.put(
  "/order-number",
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  ah(async (req, res) => {
    const format = formatFrom(orderNumberSchema.parse(req.body));
    const tenantId = tenantOf(req);

    await withTenant(tenantId, async (tx) => {
      if ((await tx.order.count()) > 0) {
        throw conflict("Нумерация уже идёт — менять её нельзя, иначе номера на выданных квитанциях разойдутся с базой");
      }
      await tx.tenant.update({
        where: { id: tenantId },
        data: {
          orderNumberTemplate: format.template,
          orderNumberPrefix: format.prefix,
          orderNumberWidth: format.width,
          orderNumberStart: format.start,
          orderNumberWithYear: format.withYear,
          // Счётчик — с первого номера образца; год выставится при первом заказе.
          orderNumberNext: format.start,
          orderNumberYear: null,
        },
      });
      await writeAudit(tx, {
        tenantId,
        userId: actorUserId(req),
        entity: "Tenant",
        entityId: tenantId,
        action: "UPDATE",
        diff: { orderNumber: format.template ?? "стандартный", withYear: format.withYear },
        ip: clientIp(req),
      });
    });

    res.json(await orderNumberState(tenantId));
  })
);
