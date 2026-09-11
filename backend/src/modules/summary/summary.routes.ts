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
import { seesCustomerContacts } from "../orders/orders.service";

/**
 * Главный экран мастерской — доска заказов по стадиям.
 *
 * Это не витрина показателей, а рабочее место: человек открывает систему,
 * чтобы увидеть, что лежит на каждой стадии, и ткнуть в нужный заказ.
 * Поэтому здесь нет ни выручки, ни графиков — только заказы, разложенные
 * по колонкам, и ровно те поля, которые видны на карточке.
 *
 * Колонки заданы группой статуса, а не названием: мастерская переименовывает
 * статусы под себя, и доска от переименования разъезжаться не должна.
 */

export const summaryRouter = Router();
summaryRouter.use(authenticate, requireTenant, enforceTenantStatus);

const tenantOf = (req: Request) => currentTenantId(req)!;
const has = (req: Request, code: string) => permissionsOf(req).includes(code);

/** Порядок здесь — порядок колонок на экране. */
const STAGES = ["NEW", "WAITING", "IN_PROGRESS", "DONE"] as const;
type Stage = (typeof STAGES)[number];

/**
 * Сколько заказов показываем в колонке. Больше шестидесяти карточек в
 * одном столбце всё равно никто не просматривает — за остальным человек
 * идёт в список заказов, где есть поиск и фильтры.
 */
const COLUMN_LIMIT = 60;

const cardSelect = {
  id: true,
  number: true,
  isUrgent: true,
  acceptedAt: true,
  dueAt: true,
  status: { select: { id: true, name: true, group: true, color: true } },
  customer: { select: { id: true, name: true, type: true } },
  device: { select: { kind: true, brand: true, model: true } },
  assignedMaster: { select: { id: true, fullName: true } },
} as const;

summaryRouter.get(
  "/",
  ah(async (req, res) => {
    const me = req.auth?.kind === "tenant" ? req.auth.userId : null;
    const seesAll = has(req, PERMISSIONS.ORDERS_VIEW_ALL);
    const onlyMine = !seesAll && has(req, PERMISSIONS.ORDERS_VIEW_ASSIGNED) && me;
    const contacts = seesCustomerContacts(req);

    // Мастер видит на доске только свои заказы — ровно то же, что и в списке.
    // Доска, не совпадающая со списком, читается как поломка.
    const mineWhere = onlyMine ? { assignedMasterId: me } : {};

    const stages = await withTenant(tenantOf(req), async (tx) => {
      const out: Array<{ key: Stage; total: number; items: unknown[] }> = [];

      for (const key of STAGES) {
        const where = { deletedAt: null, ...mineWhere, status: { group: key } };

        const total = await tx.order.count({ where });
        const rows = await tx.order.findMany({
          where,
          // Срочные сверху, дальше по сроку. Заказы без срока уходят вниз
          // сами: в Postgres возрастающая сортировка кладёт NULL в конец.
          orderBy: [{ isUrgent: "desc" }, { dueAt: "asc" }, { acceptedAt: "asc" }],
          take: COLUMN_LIMIT,
          select: cardSelect,
        });

        out.push({
          key,
          total,
          items: rows.map((o) => ({
            id: o.id,
            number: o.number,
            isUrgent: o.isUrgent,
            acceptedAt: o.acceptedAt,
            dueAt: o.dueAt,
            status: o.status,
            device: o.device,
            master: o.assignedMaster,
            // Имя клиента — часть контактов: мастеру база клиентов не нужна,
            // и сервер её просто не кладёт в ответ.
            customer: contacts ? o.customer : { id: o.customer.id, type: o.customer.type },
          })),
        });
      }

      return out;
    });

    res.json({ stages, scope: onlyMine ? "mine" : "all" });
  })
);
