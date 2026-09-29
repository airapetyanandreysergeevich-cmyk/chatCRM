import { Router, type Request } from "express";
import { z } from "zod";
import { prisma, withTenant } from "../../lib/db";
import { ah, badRequest, forbidden } from "../../lib/errors";
import { PERMISSIONS } from "../../lib/permissions";
import { actorUserId, authenticate, currentTenantId, permissionsOf, requireTenant } from "../../middleware/auth";
import { enforceTenantStatus } from "../../middleware/tenantStatus";
import * as S from "./stats.sql";
import { autoGran, bucketKeys, shiftYear, type Gran } from "./dates";

/**
 * Раздел «Статистика».
 *
 * Права:
 *  — «Статистика» (stats.view) — весь раздел. Суммы денег — только тем, кто
 *    ещё и видит кассу (finance.view) или финансовые отчёты: управляющий их
 *    видит, приёмщик с правом статистики — нет;
 *  — мастер без права видит только свою карточку, и без денег: суммы
 *    заказов ему не показываются нигде (MASTER_HIDDEN_ORDER_FIELDS).
 *
 * Все ответы — только чтение, одной транзакцией на запрос.
 */

export const statsRouter = Router();
statsRouter.use(authenticate, requireTenant, enforceTenantStatus);

const tenantOf = (req: Request) => currentTenantId(req)!;
const can = (req: Request, code: string) => permissionsOf(req).includes(code);
const full = (req: Request) => can(req, PERMISSIONS.STATS_VIEW);
const money = (req: Request) => full(req) && (can(req, PERMISSIONS.FINANCE_VIEW) || can(req, PERMISSIONS.REPORTS_FINANCE));

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const rangeSchema = z
  .object({
    from: z.string().regex(DATE, "Дата в виде 2026-09-01"),
    to: z.string().regex(DATE, "Дата в виде 2026-09-30"),
    gran: z.enum(["day", "week", "month"]).optional(),
  })
  .refine((r) => r.from <= r.to, "Начало периода позже конца");

function parseRange(req: Request): { r: S.Range; gran: Gran } {
  const q = rangeSchema.parse(req.query);
  const r = { from: q.from, to: q.to };
  let gran = q.gran ?? autoGran(r);
  // Больше 400 столбиков не прочитает никто, а считать их дорого.
  if (bucketKeys(r, gran).length > 400) gran = gran === "day" ? "week" : "month";
  if (bucketKeys(r, gran).length > 400) throw badRequest("Слишком длинный период для такого шага");
  return { r, gran };
}

async function timezoneOf(tenantId: string) {
  const t = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } });
  return t?.timezone ?? "Europe/Moscow";
}

/** Запрос в транзакции мастерской; срок побольше — сводка тяжелее обычного экрана. */
async function run<T>(req: Request, fn: (c: S.Ctx) => Promise<T>): Promise<T> {
  const tenantId = tenantOf(req);
  const tz = await timezoneOf(tenantId);
  return withTenant(tenantId, (tx) => fn({ tx, tenantId, tz }), { timeout: 30_000 });
}

const series = <T>(keys: string[], map: Map<string, T>, pick: (v: T) => number) => keys.map((k) => {
  const v = map.get(k);
  return v === undefined ? 0 : pick(v);
});
const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
const ratio = (a: number, b: number) => (b ? a / b : null);

/** Двенадцать месяцев, последний — месяц конца периода: для мини-графиков в плитках. */
function sparkRange(r: S.Range): S.Range {
  const [y, m] = r.to.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1 - 11, 1));
  return { from: start.toISOString().slice(0, 10), to: r.to };
}

// ---------------------------------------------------------------- доступ

statsRouter.get(
  "/access",
  ah(async (req, res) => {
    // Первый день с заказами — начало «всего времени»: без него график за
    // «всё» начинался бы с 2000 года пустыми месяцами.
    const firstDay = await run(req, (c) => S.firstDay(c));
    res.json({ full: full(req), money: money(req), me: actorUserId(req), firstDay });
  })
);

// ---------------------------------------------------------------- обзор

async function tiles(c: S.Ctx, r: S.Range, withMoney: boolean) {
  const [acc, iss, rev, done] = await Promise.all([
    S.acceptedByOutcome(c, r, "all"),
    S.issued(c, r, "all"),
    withMoney ? S.revenue(c, r, "all") : Promise.resolve(new Map<string, number>()),
    S.completed(c, r, "all"),
  ]);
  const a = acc.get("all") ?? { total: 0, ok: 0, no: 0, work: 0 };
  const i = iss.get("all") ?? { n: 0, check: 0 };
  const d = done.get("all");
  return {
    accepted: a.total,
    issued: i.n,
    revenue: withMoney ? round(rev.get("all") ?? 0) : null,
    check: withMoney ? round(i.check) : null,
    fixRate: ratio(a.ok, a.ok + a.no),
    readyMedian: d?.median ?? null,
    warrantyRate: d ? ratio(d.warranty, d.n) : null,
    outcomes: { ok: a.ok, no: a.no, work: a.work },
  };
}

statsRouter.get(
  "/overview",
  ah(async (req, res) => {
    if (!full(req)) throw forbidden("Статистика мастерской доступна по праву «Статистика»");
    const { r, gran } = parseRange(req);
    const withMoney = money(req);
    const prev = shiftYear(r);
    const keys = bucketKeys(r, gran);
    const prevKeys = bucketKeys(prev, gran);
    const sp = sparkRange(r);
    const spKeys = bucketKeys(sp, "month");

    const data = await run(req, async (c) => {
      const [cur, before, accS, accP, revS, revP, spAcc, spIss, spRev, spDone, heat, top, flags, idle, first] = await Promise.all([
        tiles(c, r, withMoney),
        tiles(c, prev, withMoney),
        S.acceptedByOutcome(c, r, gran),
        S.acceptedByOutcome(c, prev, gran),
        withMoney ? S.revenue(c, r, gran) : null,
        withMoney ? S.revenue(c, prev, gran) : null,
        S.acceptedByOutcome(c, sp, "month"),
        S.issued(c, sp, "month"),
        withMoney ? S.revenue(c, sp, "month") : null,
        S.completed(c, sp, "month"),
        S.heat(c, r),
        S.topDevice(c, r),
        S.flags(c, r),
        S.idleLong(c, r),
        S.firstDay(c),
      ]);

      // Сравниваем, только если год назад мастерская уже работала весь
      // период: сравнение с половиной прошлого года рисует рост, которого нет.
      const hasPrev = !!first && first <= prev.from;
      const accepted = series(keys, accS, (v) => v.total);
      const byDow = [0, 0, 0, 0, 0, 0, 0];
      const byHour = new Map<number, number>();
      for (const h of heat) {
        byDow[h.dow - 1] += h.n;
        byHour.set(h.hour, (byHour.get(h.hour) ?? 0) + h.n);
      }
      const bestI = accepted.length ? accepted.indexOf(Math.max(...accepted)) : -1;
      const peak = [...byHour.entries()].sort((a, b) => b[1] - a[1])[0];
      const anyDow = byDow.some((v) => v > 0);

      return {
        range: r,
        prev: hasPrev ? prev : null,
        firstDay: first,
        gran,
        keys,
        money: withMoney,
        tiles: { cur: { ...cur, outcomes: undefined }, prev: hasPrev ? { ...before, outcomes: undefined } : null },
        outcomes: cur.outcomes,
        series: {
          accepted,
          acceptedPrev: hasPrev ? prevKeys.map((k) => accP.get(k)?.total ?? 0).slice(0, keys.length) : null,
          revenue: revS ? series(keys, revS, (v) => round(v)) : null,
          revenuePrev: hasPrev && revP ? prevKeys.map((k) => round(revP.get(k) ?? 0)).slice(0, keys.length) : null,
        },
        spark: {
          keys: spKeys,
          accepted: series(spKeys, spAcc, (v) => v.total),
          issued: series(spKeys, spIss, (v) => v.n),
          check: withMoney ? series(spKeys, spIss, (v) => round(v.check)) : null,
          revenue: spRev ? series(spKeys, spRev, (v) => round(v)) : null,
          fixRate: series(spKeys, spAcc, (v) => (v.ok + v.no ? v.ok / (v.ok + v.no) : 0)),
          readyMedian: series(spKeys, spDone, (v) => v.median ?? 0),
          warrantyRate: series(spKeys, spDone, (v) => (v.n ? v.warranty / v.n : 0)),
        },
        facts: {
          busyDow: anyDow ? byDow.indexOf(Math.max(...byDow)) + 1 : null,
          calmDow: anyDow ? byDow.indexOf(Math.min(...byDow)) + 1 : null,
          peakHour: peak ? peak[0] : null,
          topDevice: top,
          best: bestI >= 0 && accepted[bestI] > 0 ? { key: keys[bestI], n: accepted[bestI] } : null,
          idleLong: idle,
          returning: { n: flags.returning, of: flags.total },
        },
      };
    });
    res.json(data);
  })
);

// ---------------------------------------------------------------- заказы

const READY_EDGES = [0, 1, 2, 3, 5, 10];
const WAIT_EDGES = [0, 1, 3, 7, 14];

statsRouter.get(
  "/orders",
  ah(async (req, res) => {
    if (!full(req)) throw forbidden("Статистика мастерской доступна по праву «Статистика»");
    const { r, gran } = parseRange(req);
    const keys = bucketKeys(r, gran);
    const data = await run(req, async (c) => {
      const [acc, heat, kinds, brands, ready, wait, why, flags, done] = await Promise.all([
        S.acceptedByOutcome(c, r, gran),
        S.heat(c, r),
        S.byDevice(c, r, "kind", 10),
        S.byDevice(c, r, "brand", 8),
        S.readyHistogram(c, r, READY_EDGES),
        S.waitHistogram(c, r, WAIT_EDGES),
        S.reasons(c, r, 8),
        S.flags(c, r),
        S.completed(c, r, "all"),
      ]);
      const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
      for (const h of heat) grid[h.dow - 1][h.hour] += h.n;
      const d = done.get("all");
      return {
        range: r, gran, keys,
        series: {
          ok: series(keys, acc, (v) => v.ok),
          no: series(keys, acc, (v) => v.no),
          work: series(keys, acc, (v) => v.work),
        },
        heat: grid,
        kinds, brands,
        ready: { edges: READY_EDGES, ...ready },
        wait: { edges: WAIT_EDGES, ...wait },
        reasons: why,
        counts: {
          accepted: flags.total, urgent: flags.urgent, returning: flags.returning,
          completed: d?.n ?? 0, late: d?.late ?? 0, lateOf: d?.lateOf ?? 0, warranty: d?.warranty ?? 0,
        },
      };
    });
    res.json(data);
  })
);

// ---------------------------------------------------------------- мастера

async function names(c: S.Ctx, ids: string[]) {
  if (!ids.length) return new Map<string, { name: string; active: boolean }>();
  const users = await c.tx.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, fullName: true, isActive: true, deletedAt: true },
  });
  return new Map(users.map((u) => [u.id, { name: u.fullName, active: u.isActive && !u.deletedAt }]));
}

statsRouter.get(
  "/masters",
  ah(async (req, res) => {
    if (!full(req)) throw forbidden("Статистика мастерской доступна по праву «Статистика»");
    const { r } = parseRange(req);
    const withMoney = money(req);
    const data = await run(req, async (c) => {
      const [acc, done, works, iss, recv] = await Promise.all([
        S.mastersAccepted(c, r),
        S.mastersCompleted(c, r),
        withMoney ? S.worksByMaster(c, r, "all") : Promise.resolve([]),
        S.issued(c, r, "all"),
        S.receivers(c, r),
      ]);
      const ids = [...new Set([...acc.map((a) => a.id), ...done.keys(), ...works.map((w) => w.id), ...recv.map((x) => x.id)])];
      const who = await names(c, ids);
      const worksOf = new Map<string, number>();
      for (const w of works) worksOf.set(w.id, (worksOf.get(w.id) ?? 0) + w.v);
      // Средний чек мастера — по выданным за период заказам, где он мастер заказа.
      const checks = withMoney ? await Promise.all(ids.map(async (id) => [id, (await S.issued(c, r, "all", id)).get("all")] as const)) : [];
      const checkOf = new Map(checks.map(([id, v]) => [id, v ? round(v.check) : 0]));

      const masterIds = [...new Set([...acc.map((a) => a.id), ...done.keys(), ...works.map((w) => w.id)])];
      const rows = masterIds.map((id) => {
        const a = acc.find((x) => x.id === id) ?? { accepted: 0, ok: 0, no: 0, work: 0 };
        const d = done.get(id);
        return {
          id,
          name: who.get(id)?.name ?? "Удалённый сотрудник",
          active: who.get(id)?.active ?? false,
          accepted: a.accepted, ok: a.ok, no: a.no, work: a.work,
          fixRate: ratio(a.ok, a.ok + a.no),
          warrantyRate: d ? ratio(d.warranty, d.n) : null,
          readyMedian: d?.median ?? null,
          works: withMoney ? round(worksOf.get(id) ?? 0) : null,
          check: withMoney ? checkOf.get(id) ?? 0 : null,
        };
      }).sort((x, y) => y.accepted - x.accepted);

      const all = iss.get("all");
      return {
        range: r,
        money: withMoney,
        rows,
        issued: all?.n ?? 0,
        receivers: recv
          .map((x) => ({ id: x.id, name: who.get(x.id)?.name ?? "Удалённый сотрудник", accepted: x.accepted, issued: x.issued }))
          .sort((a, b) => b.accepted + b.issued - (a.accepted + a.issued)),
      };
    });
    res.json(data);
  })
);

statsRouter.get(
  "/masters/:id",
  ah(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const me = actorUserId(req);
    if (!full(req) && id !== me) throw forbidden("Можно смотреть только свою статистику");
    const { r, gran } = parseRange(req);
    const withMoney = money(req);
    const keys = bucketKeys(r, gran);
    const data = await run(req, async (c) => {
      const [acc, accAll, done, doneAll, kinds, works, who] = await Promise.all([
        S.acceptedByOutcome(c, r, gran, id),
        S.acceptedByOutcome(c, r, "all", id),
        S.completed(c, r, "all", id),
        S.completed(c, r, "all"),
        S.byDevice(c, r, "kind", 8, id),
        withMoney ? S.worksByMaster(c, r, gran, id) : Promise.resolve([]),
        names(c, [id]),
      ]);
      const shop = await S.acceptedByOutcome(c, r, "all");
      const a = accAll.get("all") ?? { total: 0, ok: 0, no: 0, work: 0 };
      const s = shop.get("all") ?? { total: 0, ok: 0, no: 0, work: 0 };
      const d = done.get("all");
      const dAll = doneAll.get("all");
      const worksMap = new Map(works.map((w) => [w.b, w.v]));
      return {
        range: r, gran, keys, money: withMoney,
        id, name: who.get(id)?.name ?? "Сотрудник",
        tiles: {
          accepted: a.total, ok: a.ok, no: a.no, work: a.work,
          share: ratio(a.total, s.total),
          fixRate: ratio(a.ok, a.ok + a.no),
          warrantyRate: d ? ratio(d.warranty, d.n) : null,
          readyMedian: d?.median ?? null,
        },
        shop: {
          fixRate: ratio(s.ok, s.ok + s.no),
          warrantyRate: dAll ? ratio(dAll.warranty, dAll.n) : null,
          readyMedian: dAll?.median ?? null,
        },
        series: {
          ok: series(keys, acc, (v) => v.ok),
          no: series(keys, acc, (v) => v.no),
          work: series(keys, acc, (v) => v.work),
          works: withMoney ? series(keys, worksMap, (v) => round(v)) : null,
        },
        kinds,
      };
    });
    res.json(data);
  })
);

// ---------------------------------------------------------------- список под графиком

statsRouter.get(
  "/drill",
  ah(async (req, res) => {
    const q = z.object({ master: z.string().uuid().optional() }).parse(req.query);
    const me = actorUserId(req);
    if (!full(req) && (!q.master || q.master !== me)) throw forbidden("Можно смотреть только свои заказы");
    const { r } = parseRange(req);
    const withMoney = money(req);
    const data = await run(req, async (c) => {
      const [items, total] = await Promise.all([S.drill(c, r, q.master ?? null, 50), S.countAccepted(c, r, q.master ?? null)]);
      return {
        total,
        items: items.map((o) => ({
          id: o.id, number: o.number, acceptedAt: o.acceptedAt,
          device: [o.kind, o.brand, o.model].filter((x) => x && x.trim()).join(" ") || "Техника не указана",
          master: o.master, outcome: o.outcome, issued: o.issued,
          total: withMoney ? Number(o.total) : null,
        })),
      };
    });
    res.json(data);
  })
);

