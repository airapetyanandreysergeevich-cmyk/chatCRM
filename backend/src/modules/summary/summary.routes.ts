import { Router, type Request } from "express";
import { withTenant } from "../../lib/db";
import { ah } from "../../lib/errors";
import { PERMISSIONS } from "../../lib/permissions";
import {
  authenticate,
  currentTenantId,
  permissionsOf,
  requireTenant,
} from "../../middleware/auth";
import { enforceTenantStatus } from "../../middleware/tenantStatus";
import { orderInclude, projectOrder, seesCustomerContacts, seesMoney } from "../orders/orders.service";

/**
 * Сводка мастерской — то, что человек видит первым, открыв систему.
 *
 * Правило раздела: ни одной цифры, за которой не стоит запрос к базе.
 * Показатель, который нельзя посчитать честно, лучше не показывать вовсе —
 * по сводке принимают решения, и один выдуманный итог обесценивает все
 * остальные.
 *
 * Второе правило: сводка показывает ровно то, что человеку и так доступно.
 * Мастер видит свои заказы, а не общую выручку, — не потому что интерфейс
 * прячет, а потому что сервер этих цифр ему не считает.
 */

export const summaryRouter = Router();
summaryRouter.use(authenticate, requireTenant, enforceTenantStatus);

const tenantOf = (req: Request) => currentTenantId(req)!;
const has = (req: Request, code: string) => permissionsOf(req).includes(code);

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

const daysAgo = (n: number) => {
  const d = startOfToday();
  d.setDate(d.getDate() - n);
  return d;
};

summaryRouter.get(
  "/",
  ah(async (req, res) => {
    const me = req.auth?.kind === "tenant" ? req.auth.userId : null;
    const seesAll = has(req, PERMISSIONS.ORDERS_VIEW_ALL);
    const onlyMine = !seesAll && has(req, PERMISSIONS.ORDERS_VIEW_ASSIGNED) && me;
    const money = seesMoney(req);
    const contacts = seesCustomerContacts(req);

    // Мастеру считаем только его заказы. Это не косметика: он и в списке
    // видит только их, и сводка обязана совпадать со списком, иначе
    // «в работе 14» при четырёх видимых строках выглядит как поломка.
    const mineWhere = onlyMine ? { assignedMasterId: me } : {};
    const today = startOfToday();

    const data = await withTenant(tenantOf(req), async (tx) => {
      const statuses = await tx.orderStatus.findMany({ select: { id: true, group: true } });
      const groupOf = new Map(statuses.map((s) => [s.id, s.group]));

      const byStatus = await tx.order.groupBy({
        by: ["statusId"],
        where: { deletedAt: null, ...mineWhere },
        _count: { _all: true },
      });

      const groups: Record<string, number> = {
        NEW: 0,
        IN_PROGRESS: 0,
        WAITING: 0,
        DONE: 0,
        CLOSED: 0,
        CANCELLED: 0,
      };
      for (const row of byStatus) {
        const g = groupOf.get(row.statusId);
        if (g) groups[g] += row._count._all;
      }

      // Просрочка: срок прошёл, а заказ ещё не выдан и не отменён.
      const overdue = await tx.order.count({
        where: {
          deletedAt: null,
          ...mineWhere,
          dueAt: { lt: new Date() },
          status: { group: { in: ["NEW", "IN_PROGRESS", "WAITING", "DONE"] } },
        },
      });

      const acceptedToday = await tx.order.count({
        where: { deletedAt: null, ...mineWhere, acceptedAt: { gte: today } },
      });
      const issuedToday = await tx.order.count({
        where: { deletedAt: null, ...mineWhere, issuedAt: { gte: today } },
      });

      const recentRows = await tx.order.findMany({
        where: { deletedAt: null, ...mineWhere },
        orderBy: [{ acceptedAt: "desc" }],
        take: 6,
        include: orderInclude,
      });

      // --- то, что видно только тем, кому положено -----------------------

      let revenue: { today: number; week: number; month: number } | null = null;
      if (money) {
        const sum = async (from: Date) => {
          const r = await tx.order.aggregate({
            where: { deletedAt: null, issuedAt: { gte: from } },
            _sum: { total: true },
          });
          return Number(r._sum.total ?? 0);
        };
        revenue = { today: await sum(today), week: await sum(daysAgo(6)), month: await sum(daysAgo(29)) };
      }

      let masters: Array<{ id: string; fullName: string; active: number }> | null = null;
      if (seesAll) {
        // Загрузка мастеров: сколько заказов сейчас реально на руках.
        // Считаем одним groupBy, а не запросом на каждого — мастеров может
        // быть и двадцать.
        const staff = await tx.user.findMany({
          where: { deletedAt: null, isActive: true },
          select: { id: true, fullName: true },
        });
        const load = await tx.order.groupBy({
          by: ["assignedMasterId"],
          where: {
            deletedAt: null,
            assignedMasterId: { not: null },
            status: { group: { in: ["NEW", "IN_PROGRESS", "WAITING"] } },
          },
          _count: { _all: true },
        });
        const loadOf = new Map(load.map((l) => [l.assignedMasterId, l._count._all]));
        masters = staff
          .map((u) => ({ id: u.id, fullName: u.fullName, active: loadOf.get(u.id) ?? 0 }))
          .filter((m) => m.active > 0)
          .sort((a, b) => b.active - a.active);
      }

      let lowStock: number | null = null;
      if (has(req, PERMISSIONS.STOCK_VIEW)) {
        // Позиции ниже минимума. Prisma не умеет сравнивать две колонки
        // одной строки, поэтому сверяем остаток с минимумом в JS —
        // номенклатура мастерской это сотни строк, не миллионы.
        const items = await tx.stockItem.findMany({
          where: { isActive: true },
          select: { id: true, minQty: true, balances: { select: { qty: true } } },
        });
        lowStock = items.filter((i) => {
          const min = Number(i.minQty);
          if (min <= 0) return false;
          const have = i.balances.reduce((n, b) => n + Number(b.qty), 0);
          return have < min;
        }).length;
      }

      let purchasesPending: number | null = null;
      if (has(req, PERMISSIONS.PURCHASES_VIEW) || has(req, PERMISSIONS.PURCHASES_APPROVE)) {
        purchasesPending = await tx.purchaseRequest.count({ where: { status: "PENDING" } });
      }

      return {
        groups,
        overdue,
        acceptedToday,
        issuedToday,
        revenue,
        masters,
        lowStock,
        purchasesPending,
        recent: recentRows.map((o) => projectOrder(o, { contacts, money })),
      };
    });

    res.json({ ...data, scope: onlyMine ? "mine" : "all" });
  })
);
