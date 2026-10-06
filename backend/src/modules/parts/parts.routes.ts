import type { Prisma } from "@prisma/client";
import { Router, type Request } from "express";
import { z } from "zod";
import { withTenant } from "../../lib/db";
import { AppError, ah, badRequest } from "../../lib/errors";
import { authenticate, currentTenantId, requireTenant } from "../../middleware/auth";
import { enforceTenantStatus } from "../../middleware/tenantStatus";
import { SHOP_IDS, searchShop } from "./search";
import { SHOPS } from "./shops";
import { logoFor } from "./logo";

/**
 * Агент поиска запчастей: Склад и карточка заказа ищут деталь по магазинам.
 *
 * Магазины у каждого сотрудника свои (Настройки → Агенты): мастеру по
 * телефонам незачем ждать ответа магазина матриц. Храним выключенные —
 * новый магазин в списке включится у всех сам.
 *
 * Искать может любой сотрудник: это обычный поиск по чужим сайтам, ничего
 * из мастерской наружу не уходит, кроме набранного названия детали.
 */

export const partsRouter = Router();
partsRouter.use(authenticate, requireTenant, enforceTenantStatus);

const tenantOf = (req: Request) => currentTenantId(req)!;
const userOf = (req: Request) => (req.auth?.kind === "tenant" ? req.auth.userId : null);

interface AgentPrefs {
  parts?: { off?: string[] };
}

function offOf(raw: unknown): string[] {
  const p = (raw && typeof raw === "object" ? raw : {}) as AgentPrefs;
  const off = Array.isArray(p.parts?.off) ? p.parts!.off : [];
  return off.filter((x) => typeof x === "string" && SHOP_IDS.includes(x));
}

async function prefsRow(req: Request) {
  const userId = userOf(req);
  if (!userId) return null;
  return withTenant(tenantOf(req), (tx) => tx.user.findFirst({ where: { id: userId }, select: { agentPrefs: true } }));
}

partsRouter.get(
  "/shops",
  ah(async (req, res) => {
    const off = offOf((await prefsRow(req))?.agentPrefs);
    res.json({
      personal: userOf(req) !== null,
      shops: SHOPS.map((s) => ({
        id: s.id,
        name: s.name,
        site: s.site,
        about: s.about,
        linkOnly: !!s.linkOnly,
        probe: s.probe,
        enabled: !off.includes(s.id),
      })),
    });
  })
);

partsRouter.put(
  "/shops",
  ah(async (req, res) => {
    const userId = userOf(req);
    if (!userId) throw badRequest("Магазины выбирает себе сотрудник мастерской");
    const body = z.object({ off: z.array(z.string()).max(100) }).parse(req.body);
    const off = [...new Set(body.off.filter((x) => SHOP_IDS.includes(x)))];
    await withTenant(tenantOf(req), async (tx) => {
      const row = await tx.user.findFirst({ where: { id: userId }, select: { agentPrefs: true } });
      const cur = (row?.agentPrefs && typeof row.agentPrefs === "object" ? row.agentPrefs : {}) as Record<string, unknown>;
      await tx.user.updateMany({
        where: { id: userId },
        data: { agentPrefs: { ...cur, parts: { off } } as Prisma.InputJsonValue },
      });
    });
    res.json({ off });
  })
);

// ------------------------------------------------------------ поиск

/**
 * Сколько обращений к магазинам в минуту разрешаем мастерской. Один поиск —
 * это до десяти обращений (по магазину), так что это десятки поисков в минуту:
 * человеку хватит с запасом, а зациклившаяся вкладка не превратит сервер в
 * долбилку по чужим сайтам.
 */
export const PER_MINUTE = 150;
const windows = new Map<string, { start: number; count: number }>();

function takeQuota(tenantId: string) {
  const now = Date.now();
  const w = windows.get(tenantId);
  if (!w || now - w.start > 60_000) {
    windows.set(tenantId, { start: now, count: 1 });
    return true;
  }
  if (w.count >= PER_MINUTE) return false;
  w.count++;
  return true;
}

export function resetQuota() {
  windows.clear();
}

partsRouter.get(
  "/search",
  ah(async (req, res) => {
    const p = z
      .object({
        shop: z.string().refine((x) => SHOP_IDS.includes(x), "Нет такого магазина"),
        q: z.string().trim().min(2, "Наберите хотя бы два знака").max(80, "Слишком длинный запрос"),
        fresh: z.string().optional(),
      })
      .parse(req.query);
    if (!takeQuota(tenantOf(req))) throw new AppError(429, "Слишком много поисков подряд — подождите минуту");
    res.json(await searchShop(p.shop, p.q, { fresh: p.fresh === "1" }));
  })
);

/**
 * Значок магазина — без входа: картинку браузер просит тегом <img>, а он не
 * несёт токен. Отдать можно только значок магазина из нашего списка.
 */
export const partsLogoRouter = Router();
partsLogoRouter.get(
  "/:id",
  ah(async (req, res) => {
    const id = String(req.params.id);
    if (!SHOP_IDS.includes(id)) {
      res.status(404).end();
      return;
    }
    const logo = await logoFor(id);
    if (!logo) {
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.status(404).end();
      return;
    }
    res.setHeader("Content-Type", logo.type);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.end(logo.body);
  })
);
