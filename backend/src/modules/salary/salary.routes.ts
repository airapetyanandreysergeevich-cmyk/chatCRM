import { Router, type Request } from "express";
import { z } from "zod";
import { clientIp, writeAudit } from "../../lib/audit";
import { prisma, withTenant } from "../../lib/db";
import { ah, badRequest, conflict, forbidden, notFound } from "../../lib/errors";
import { PERMISSIONS } from "../../lib/permissions";
import { actorUserId, authenticate, currentTenantId, permissionsOf, requirePermission, requireTenant } from "../../middleware/auth";
import { enforceTenantStatus } from "../../middleware/tenantStatus";
import { computeMonth } from "./calc";
import { markPayoutRead, notifyAnswer } from "../finance/money";
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
      const orderIds = [...new Set(payouts.map((p) => p.orderId).filter((x): x is string => !!x))];
      const orders = orderIds.length ? await tx.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, number: true } }) : [];
      return { entries, payouts, orders: new Map(orders.map((o) => [o.id, o.number])) };
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
        /** Деньги клиента сразу сотруднику (03.11.2026): ✅ CONFIRMED · ⏳ PENDING · ⚠ DISPUTED. */
        source: p.source,
        status: p.status,
        order: p.orderId ? { id: p.orderId, number: data.orders.get(p.orderId) ?? null } : null,
        saleId: p.saleId,
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
      // Сумма денег клиента сходится с кассой — править её здесь нельзя.
      if (p.source === "CLIENT" && (body.amount !== undefined || body.paidAt !== undefined)) {
        throw badRequest("Это деньги клиента: сумма и дата — как в кассе. Ошиблись — уберите выплату и проведите оплату заново");
      }
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
      // Деньги клиента: вместе с выплатой убираем и расход «Выплата сотруднику» — деньги остаются в кассе.
      if (p.outTxId) await tx.transaction.updateMany({ where: { id: p.outTxId, deletedAt: null }, data: { deletedAt: new Date() } });
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

// ------------------------------------------------------------------ деньги клиента у сотрудника (03.11.2026)

/**
 * 💵 в шапке: деньги клиентов, принятые на меня и ещё не подтверждённые.
 * Любому сотруднику про себя — даже без права видеть свою зарплату.
 */
salaryRouter.get(
  "/incoming",
  ah(async (req, res) => {
    const me = actorUserId(req);
    if (!me) return res.json({ items: [] });
    const tenantId = tenantOf(req);
    const items = await withTenant(tenantId, async (tx) => {
      const rows = await tx.salaryPayout.findMany({
        where: { userId: me, deletedAt: null, status: "PENDING" },
        orderBy: { paidAt: "asc" },
        take: 50,
      });
      const orderIds = [...new Set(rows.map((r) => r.orderId).filter((x): x is string => !!x))];
      const userIds = [...new Set(rows.map((r) => r.takenById).filter((x): x is string => !!x))];
      const methodIds = [...new Set(rows.map((r) => r.payMethodId).filter((x): x is string => !!x))];
      const [orders, users, methods] = await Promise.all([
        tx.order.findMany({
          where: { id: { in: orderIds } },
          select: { id: true, number: true, device: { select: { kind: true, brand: true, model: true } }, customer: { select: { name: true } } },
        }),
        tx.user.findMany({ where: { id: { in: userIds } }, select: { id: true, fullName: true } }),
        tx.payMethod.findMany({ where: { id: { in: methodIds } }, select: { id: true, name: true } }),
      ]);
      const om = new Map(orders.map((o) => [o.id, o]));
      const um = new Map(users.map((u) => [u.id, u.fullName]));
      const mm = new Map(methods.map((m) => [m.id, m.name]));
      return rows.map((r) => {
        const o = r.orderId ? om.get(r.orderId) : null;
        return {
          id: r.id,
          amount: Number(r.amount),
          at: r.paidAt,
          method: (r.payMethodId && mm.get(r.payMethodId)) ?? null,
          order: o
            ? {
                id: o.id,
                number: o.number,
                device: [o.device?.kind, o.device?.brand, o.device?.model].filter(Boolean).join(" ") || null,
                customer: o.customer?.name ?? null,
              }
            : null,
          sale: !!r.saleId,
          takenBy: (r.takenById && um.get(r.takenById)) ?? null,
        };
      });
    });
    res.json({ items });
  })
);

async function answer(req: Request, confirmed: boolean) {
  const me = actorUserId(req);
  const tenantId = tenantOf(req);
  const p = await withTenant(tenantId, async (tx) => {
    const row = await tx.salaryPayout.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!row) throw notFound("Платёж не найден");
    if (row.userId !== me) throw forbidden("Подтверждает тот, на кого приняли деньги");
    if (row.status !== "PENDING") throw conflict(row.status === "CONFIRMED" ? "Уже подтверждено" : "Уже отмечено «Не получал»");
    await tx.salaryPayout.update({
      where: { id: row.id },
      data: confirmed ? { status: "CONFIRMED", confirmedAt: new Date() } : { status: "DISPUTED", disputedAt: new Date() },
    });
    await writeAudit(tx, {
      tenantId,
      userId: me,
      entity: "SalaryPayout",
      entityId: row.id,
      action: "UPDATE",
      diff: { status: confirmed ? "CONFIRMED" : "DISPUTED", amount: Number(row.amount) },
      ip: clientIp(req),
    });
    const order = row.orderId ? await tx.order.findFirst({ where: { id: row.orderId }, select: { number: true } }) : null;
    return { ...row, orderNumber: order?.number ?? null };
  });
  await markPayoutRead(tenantId, p.id);
  void notifyAnswer(tenantId, { id: p.id, userId: p.userId, takenById: p.takenById, amount: Number(p.amount), orderId: p.orderId, orderNumber: p.orderNumber }, confirmed);
}

salaryRouter.post(
  "/payouts/:id/confirm",
  ah(async (req, res) => {
    await answer(req, true);
    res.json({ ok: true });
  })
);

salaryRouter.post(
  "/payouts/:id/dispute",
  ah(async (req, res) => {
    await answer(req, false);
    res.json({ ok: true });
  })
);

/**
 * «Не получал» разобрали: деньги всё-таки у сотрудника («received») — или
 * их нет у него («cancel»): выплата снимается, расход «Выплата сотруднику»
 * убирается, и деньги остаются в кассе обычной оплатой.
 */
salaryRouter.post(
  "/payouts/:id/resolve",
  requirePermission(PERMISSIONS.SALARY_MANAGE),
  ah(async (req, res) => {
    const { action } = z.object({ action: z.enum(["received", "cancel"]) }).parse(req.body);
    const tenantId = tenantOf(req);
    const me = actorUserId(req);
    await withTenant(tenantId, async (tx) => {
      const p = await tx.salaryPayout.findFirst({ where: { id: req.params.id, deletedAt: null } });
      if (!p) throw notFound("Платёж не найден");
      if (p.source !== "CLIENT") throw badRequest("Это выплата, записанная руками");
      await assertOpen(tx, p.month);
      if (action === "received") {
        await tx.salaryPayout.update({ where: { id: p.id }, data: { status: "CONFIRMED", resolvedAt: new Date(), resolvedById: me } });
      } else {
        await tx.salaryPayout.update({ where: { id: p.id }, data: { deletedAt: new Date(), resolvedAt: new Date(), resolvedById: me } });
        if (p.outTxId) await tx.transaction.updateMany({ where: { id: p.outTxId, deletedAt: null }, data: { deletedAt: new Date() } });
      }
      await writeAudit(tx, {
        tenantId,
        userId: me,
        entity: "SalaryPayout",
        entityId: p.id,
        action: "UPDATE",
        diff: { resolved: action, amount: Number(p.amount), userId: p.userId },
        ip: clientIp(req),
      });
    });
    await markPayoutRead(tenantId, req.params.id);
    res.json({ ok: true });
  })
);

