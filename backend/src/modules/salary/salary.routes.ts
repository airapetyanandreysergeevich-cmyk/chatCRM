import { Router, type Request } from "express";
import { z } from "zod";
import { clientIp, writeAudit } from "../../lib/audit";
import { prisma, withTenant } from "../../lib/db";
import { ah, badRequest, conflict, forbidden, notFound } from "../../lib/errors";
import { PERMISSIONS } from "../../lib/permissions";
import { actorUserId, authenticate, currentTenantId, permissionsOf, requirePermission, requireTenant } from "../../middleware/auth";
import { enforceTenantStatus } from "../../middleware/tenantStatus";
import { computeMonth } from "./calc";
import { MONTH_RE, monthOf, monthsBetween, monthTitle, shiftMonth } from "./months";

/**
 * Зарплата: ведомость за месяц, начисления руками, выплаты, закрытие месяца.
 *
 * Права:
 *  — видит всех — «зарплата: все» (владелец, управляющий, бухгалтер);
 *    остальные — только себя;
 *  — оклад, премия, штраф, начальный остаток, правка и удаление выплат,
 *    закрытие месяца — «управление зарплатой»;
 *  — добавить выплату себе может любой сотрудник: деньги бывают выданы
 *    на месте, мастеру или курьеру, и записывает тот, кто получил. Видно,
 *    кто добавил.
 */
export const salaryRouter = Router();
salaryRouter.use(authenticate, requireTenant, enforceTenantStatus);

const tenantOf = (req: Request) => currentTenantId(req)!;
const can = (req: Request, code: string) => permissionsOf(req).includes(code);
const seesAll = (req: Request) => can(req, PERMISSIONS.SALARY_VIEW_ALL) || can(req, PERMISSIONS.SALARY_MANAGE);
const manages = (req: Request) => can(req, PERMISSIONS.SALARY_MANAGE);

async function timezoneOf(tenantId: string) {
  const t = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } });
  return t?.timezone ?? "Europe/Moscow";
}

const sum = (list: number[]) => Math.round(list.reduce((n, v) => n + v, 0) * 100) / 100;

const monthField = z.string().regex(MONTH_RE, "Месяц в виде 2026-09");

async function assertOpen(tx: Parameters<Parameters<typeof withTenant>[1]>[0], month: string) {
  if (await tx.salaryMonth.findFirst({ where: { month }, select: { id: true } })) {
    throw conflict("Этот месяц закрыт — сначала откройте его снова");
  }
}

// ------------------------------------------------------------------ ведомость

salaryRouter.get(
  "/",
  ah(async (req, res) => {
    const tenantId = tenantOf(req);
    const tz = await timezoneOf(tenantId);
    const month = monthField.catch(monthOf(new Date(), tz)).parse(req.query.month);
    const me = actorUserId(req);
    const all = seesAll(req);
    if (!all && !can(req, PERMISSIONS.SALARY_VIEW_OWN) && !me) throw forbidden();

    const result = await withTenant(tenantId, (tx) => computeMonth(tx, tenantId, month, tz), {
      timeout: 60_000,
      maxWait: 30_000,
    });
    const closedBy = result.closed?.byId
      ? await withTenant(tenantId, (tx) => tx.user.findFirst({ where: { id: result.closed!.byId! }, select: { fullName: true } }))
      : null;

    // Кто видит только себя — получает только себя, и без сумм заказов
    // целиком: итог и запчасти мастеру в карточке заказа не показываются, и
    // зарплата не должна становиться обходным путём к ним.
    const rows = all ? result.rows : result.rows.filter((r) => r.userId === me);
    const showOrderMoney = all || can(req, PERMISSIONS.ORDERS_COST);
    const details = Object.fromEntries(
      rows.map((r) => {
        const d = result.details[r.userId];
        return [
          r.userId,
          showOrderMoney ? d : { ...d, orders: d.orders.map(({ total: _t, parts: _p, ...o }) => o) },
        ];
      })
    );

    res.json({
      month,
      since: result.since,
      closed: result.closed ? { at: result.closed.at, by: closedBy?.fullName ?? null } : null,
      seesAll: all,
      canManage: manages(req),
      me,
      rows,
      details,
      totals: all
        ? {
            start: sum(rows.map((r) => r.start)),
            accrued: sum(rows.map((r) => r.accrued + r.bonus)),
            paid: sum(rows.map((r) => r.paid)),
            end: sum(rows.map((r) => r.end)),
          }
        : null,
    });
  })
);

/** Записи месяца по сотруднику: начисления руками и выплаты — для карточки. */
salaryRouter.get(
  "/records",
  ah(async (req, res) => {
    const q = z.object({ month: monthField, userId: z.string().uuid() }).parse(req.query);
    const me = actorUserId(req);
    if (!seesAll(req) && q.userId !== me) throw forbidden();
    const tenantId = tenantOf(req);
    const data = await withTenant(tenantId, async (tx) => {
      const [entries, payouts] = await Promise.all([
        tx.salaryEntry.findMany({
          where: { userId: q.userId, month: q.month },
          orderBy: { createdAt: "asc" },
          include: { createdBy: { select: { fullName: true } } },
        }),
        tx.salaryPayout.findMany({
          where: { userId: q.userId, month: q.month, deletedAt: null },
          orderBy: { paidAt: "asc" },
          include: { createdBy: { select: { fullName: true } } },
        }),
      ]);
      return { entries, payouts };
    });
    res.json({
      entries: data.entries.map((e) => ({
        id: e.id,
        kind: e.kind,
        amount: Number(e.amount),
        comment: e.comment,
        createdAt: e.createdAt,
        by: e.createdBy?.fullName ?? null,
      })),
      payouts: data.payouts.map((p) => ({
        id: p.id,
        amount: Number(p.amount),
        paidAt: p.paidAt,
        comment: p.comment,
        by: p.createdBy?.fullName ?? null,
      })),
    });
  })
);

// ------------------------------------------------------------------ начисления руками

const entrySchema = z.object({
  userId: z.string().uuid(),
  month: monthField,
  amount: z.number().refine((n) => n !== 0 && Math.abs(n) <= 10_000_000, "Сумма не ноль и не больше 10 млн"),
  comment: z.string().trim().max(200).optional(),
});

salaryRouter.post(
  "/entries",
  requirePermission(PERMISSIONS.SALARY_MANAGE),
  ah(async (req, res) => {
    const body = entrySchema.parse(req.body);
    const tenantId = tenantOf(req);
    const row = await withTenant(tenantId, async (tx) => {
      await assertOpen(tx, body.month);
      if (!(await tx.user.findFirst({ where: { id: body.userId }, select: { id: true } }))) throw notFound("Сотрудник не найден");
      const e = await tx.salaryEntry.create({
        data: {
          tenantId,
          userId: body.userId,
          month: body.month,
          kind: "BONUS",
          amount: Math.round(body.amount * 100) / 100,
          comment: body.comment || null,
          createdById: actorUserId(req),
        },
      });
      await writeAudit(tx, {
        tenantId,
        userId: actorUserId(req),
        entity: "Salary",
        entityId: e.id,
        action: "CREATE",
        diff: { kind: "BONUS", userId: body.userId, month: body.month, amount: body.amount, comment: body.comment },
        ip: clientIp(req),
      });
      return e;
    });
    res.status(201).json({ id: row.id });
  })
);

salaryRouter.delete(
  "/entries/:id",
  requirePermission(PERMISSIONS.SALARY_MANAGE),
  ah(async (req, res) => {
    const tenantId = tenantOf(req);
    await withTenant(tenantId, async (tx) => {
      const e = await tx.salaryEntry.findFirst({ where: { id: req.params.id } });
      if (!e) throw notFound("Запись не найдена");
      await assertOpen(tx, e.month);
      await tx.salaryEntry.delete({ where: { id: e.id } });
      await writeAudit(tx, {
        tenantId,
        userId: actorUserId(req),
        entity: "Salary",
        entityId: e.id,
        action: "DELETE",
        diff: { kind: e.kind, userId: e.userId, month: e.month, amount: Number(e.amount), comment: e.comment },
        ip: clientIp(req),
      });
    });
    res.json({ ok: true });
  })
);

/**
 * Остаток на начало месяца — руками. Нужен один раз, в первом месяце учёта;
 * дальше остаток переносится сам. Пусто — убрать введённый.
 */
salaryRouter.put(
  "/opening",
  requirePermission(PERMISSIONS.SALARY_MANAGE),
  ah(async (req, res) => {
    const body = z
      .object({ userId: z.string().uuid(), month: monthField, amount: z.number().min(-10_000_000).max(10_000_000).nullable() })
      .parse(req.body);
    const tenantId = tenantOf(req);
    await withTenant(tenantId, async (tx) => {
      await assertOpen(tx, body.month);
      if (!(await tx.user.findFirst({ where: { id: body.userId }, select: { id: true } }))) throw notFound("Сотрудник не найден");
      await tx.salaryEntry.deleteMany({ where: { userId: body.userId, month: body.month, kind: "OPENING" } });
      if (body.amount !== null) {
        await tx.salaryEntry.create({
          data: {
            tenantId,
            userId: body.userId,
            month: body.month,
            kind: "OPENING",
            amount: Math.round(body.amount * 100) / 100,
            createdById: actorUserId(req),
          },
        });
      }
      await writeAudit(tx, {
        tenantId,
        userId: actorUserId(req),
        entity: "Salary",
        entityId: body.userId,
        action: "UPDATE",
        diff: { kind: "OPENING", month: body.month, amount: body.amount },
        ip: clientIp(req),
      });
    });
    res.json({ ok: true });
  })
);

// ------------------------------------------------------------------ выплаты

const payoutSchema = z.object({
  userId: z.string().uuid(),
  amount: z.number().positive("Сумма больше нуля").max(10_000_000),
  paidAt: z.string().datetime().optional(),
  comment: z.string().trim().max(200).optional(),
});

salaryRouter.post(
  "/payouts",
  ah(async (req, res) => {
    const body = payoutSchema.parse(req.body);
    const me = actorUserId(req);
    // Себе — может любой сотрудник; другому — только тот, кто ведёт зарплату.
    if (body.userId !== me && !manages(req)) throw forbidden("Записать выплату другому сотруднику может только тот, кто ведёт зарплату");
    const tenantId = tenantOf(req);
    const tz = await timezoneOf(tenantId);
    const paidAt = body.paidAt ? new Date(body.paidAt) : new Date();
    if (paidAt.getTime() > Date.now() + 24 * 3600_000) throw badRequest("Выплата не может быть в будущем");
    const month = monthOf(paidAt, tz);
    const row = await withTenant(tenantId, async (tx) => {
      await assertOpen(tx, month);
      if (!(await tx.user.findFirst({ where: { id: body.userId }, select: { id: true } }))) throw notFound("Сотрудник не найден");
      const p = await tx.salaryPayout.create({
        data: {
          tenantId,
          userId: body.userId,
          amount: Math.round(body.amount * 100) / 100,
          paidAt,
          month,
          comment: body.comment || null,
          createdById: me,
        },
      });
      await writeAudit(tx, {
        tenantId,
        userId: me,
        entity: "SalaryPayout",
        entityId: p.id,
        action: "CREATE",
        diff: { userId: body.userId, amount: body.amount, paidAt: paidAt.toISOString(), comment: body.comment },
        ip: clientIp(req),
      });
      return p;
    });
    res.status(201).json({ id: row.id, month });
  })
);

salaryRouter.patch(
  "/payouts/:id",
  requirePermission(PERMISSIONS.SALARY_MANAGE),
  ah(async (req, res) => {
    const body = payoutSchema.partial().omit({ userId: true }).parse(req.body);
    const tenantId = tenantOf(req);
    const tz = await timezoneOf(tenantId);
    await withTenant(tenantId, async (tx) => {
      const p = await tx.salaryPayout.findFirst({ where: { id: req.params.id, deletedAt: null } });
      if (!p) throw notFound("Выплата не найдена");
      await assertOpen(tx, p.month);
      const paidAt = body.paidAt ? new Date(body.paidAt) : p.paidAt;
      const month = monthOf(paidAt, tz);
      if (month !== p.month) await assertOpen(tx, month);
      await tx.salaryPayout.update({
        where: { id: p.id },
        data: {
          ...(body.amount !== undefined ? { amount: Math.round(body.amount * 100) / 100 } : {}),
          ...(body.comment !== undefined ? { comment: body.comment || null } : {}),
          paidAt,
          month,
        },
      });
      await writeAudit(tx, {
        tenantId,
        userId: actorUserId(req),
        entity: "SalaryPayout",
        entityId: p.id,
        action: "UPDATE",
        diff: { before: { amount: Number(p.amount), paidAt: p.paidAt, comment: p.comment }, after: body },
        ip: clientIp(req),
      });
    });
    res.json({ ok: true });
  })
);

salaryRouter.delete(
  "/payouts/:id",
  requirePermission(PERMISSIONS.SALARY_MANAGE),
  ah(async (req, res) => {
    const tenantId = tenantOf(req);
    await withTenant(tenantId, async (tx) => {
      const p = await tx.salaryPayout.findFirst({ where: { id: req.params.id, deletedAt: null } });
      if (!p) throw notFound("Выплата не найдена");
      await assertOpen(tx, p.month);
      await tx.salaryPayout.update({ where: { id: p.id }, data: { deletedAt: new Date() } });
      await writeAudit(tx, {
        tenantId,
        userId: actorUserId(req),
        entity: "SalaryPayout",
        entityId: p.id,
        action: "DELETE",
        diff: { userId: p.userId, amount: Number(p.amount), paidAt: p.paidAt, comment: p.comment },
        ip: clientIp(req),
      });
    });
    res.json({ ok: true });
  })
);

// ------------------------------------------------------------------ закрытие месяца

salaryRouter.post(
  "/months/:month/close",
  requirePermission(PERMISSIONS.SALARY_MANAGE),
  ah(async (req, res) => {
    const month = monthField.parse(req.params.month);
    const tenantId = tenantOf(req);
    const tz = await timezoneOf(tenantId);
    if (month >= monthOf(new Date(), tz)) throw badRequest("Закрыть можно только прошедший месяц");
    await withTenant(
      tenantId,
      async (tx) => {
        await assertOpen(tx, month);
        // Месяцы закрываются по порядку: закрыть октябрь при открытом
        // сентябре значило бы заморозить остаток, который ещё поменяется.
        const result = await computeMonth(tx, tenantId, month, tz);
        if (month < result.since) {
          throw badRequest(`Учёт зарплаты ведётся с месяца ${monthTitle(result.since)} — раньше закрывать нечего`);
        }
        const closed = new Set((await tx.salaryMonth.findMany({ select: { month: true } })).map((m) => m.month));
        const open = monthsBetween(result.since, shiftMonth(month, -1)).find((m) => !closed.has(m));
        if (open) throw conflict(`Сначала закройте ${monthTitle(open)}: месяцы закрываются по порядку`);
        await tx.salaryMonth.create({
          data: {
            tenantId,
            month,
            closedById: actorUserId(req),
            snapshot: { rows: result.rows, details: result.details } as object,
          },
        });
        await writeAudit(tx, {
          tenantId,
          userId: actorUserId(req),
          entity: "Salary",
          entityId: month,
          action: "UPDATE",
          diff: { close: month, rows: result.rows.length },
          ip: clientIp(req),
        });
      },
      { timeout: 60_000, maxWait: 30_000 }
    );
    res.json({ ok: true });
  })
);

salaryRouter.delete(
  "/months/:month/close",
  requirePermission(PERMISSIONS.SALARY_MANAGE),
  ah(async (req, res) => {
    const month = monthField.parse(req.params.month);
    const tenantId = tenantOf(req);
    await withTenant(tenantId, async (tx) => {
      const later = await tx.salaryMonth.findFirst({ where: { month: { gt: month } }, select: { month: true } });
      if (later) throw conflict(`Сначала откройте более поздний закрытый месяц (${later.month})`);
      const removed = await tx.salaryMonth.deleteMany({ where: { month } });
      if (!removed.count) throw notFound("Этот месяц и так открыт");
      await writeAudit(tx, {
        tenantId,
        userId: actorUserId(req),
        entity: "Salary",
        entityId: month,
        action: "UPDATE",
        diff: { reopen: month },
        ip: clientIp(req),
      });
    });
    res.json({ ok: true });
  })
);
