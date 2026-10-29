import { Prisma } from "@prisma/client";
import { Router, type Request } from "express";
import { z } from "zod";
import { clientIp, writeAudit } from "../../lib/audit";
import { withTenant } from "../../lib/db";
import { ah, badRequest, conflict, notFound } from "../../lib/errors";
import { paged, pageFields, skipTake } from "../../lib/paging";
import { categoryNamed, registerFor } from "../../lib/payment";
import { PERMISSIONS } from "../../lib/permissions";
import { searchWords } from "../../lib/search";
import { actorUserId, authenticate, currentTenantId, permissionsOf, requirePermission, requireTenant } from "../../middleware/auth";
import { enforceTenantStatus } from "../../middleware/tenantStatus";
import { applyMovement, homeWarehouse, num } from "../stock/stock.service";

/**
 * Продажа со склада без ремонта (16.10.2026, первая просьба мастерских:
 * «сделать продажу со склада не в ремонт возможно?»).
 *
 * Одно действие у стойки — и товар ушёл со склада, и деньги легли в кассу.
 * Разнести это на «списать» и «принять оплату» значит однажды сделать одно
 * без другого: склад и касса разойдутся, и никто не вспомнит почему.
 *
 * Правила склада те же, что везде: в минус не продаём, всякое изменение
 * остатка — движение с автором и причиной («Продажа П-2026-00042»).
 * Возврат — зеркально: товар обратно на склад по той же себестоимости,
 * деньги — расходом из той же кассы.
 */

export const salesRouter = Router();
salesRouter.use(authenticate, requireTenant, enforceTenantStatus);

const tenantOf = (req: Request) => currentTenantId(req)!;
const has = (req: Request, code: string) => permissionsOf(req).includes(code);

export const SALE_PAYMENTS = ["CASH", "CARD", "TRANSFER"] as const;
export type SalePayment = (typeof SALE_PAYMENTS)[number];

const IN_CATEGORY = "Продажа товаров";
const OUT_CATEGORY = "Возврат продажи";

const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Номер продажи: П-2026-00042. Счётчика нет — следующий за наибольшим в году;
 * двойной номер не даст уникальный индекс, тогда повторяем.
 */
async function nextSaleNumber(tx: Prisma.TransactionClient): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `П-${year}-`;
  const last = await tx.sale.findFirst({
    where: { number: { startsWith: prefix } },
    orderBy: { number: "desc" },
    select: { number: true },
  });
  const n = last ? Number(last.number.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(Number.isFinite(n) ? n : 1).padStart(5, "0")}`;
}

/**
 * Продажи одной мастерской проводятся по одной: две кассы, продающие
 * последнюю зарядку одновременно, не должны обе её продать.
 */
async function lockSales(tx: Prisma.TransactionClient, tenantId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"stock-sale:" + tenantId}))`;
}

const saleInclude = {
  items: { orderBy: { id: "asc" } },
  customer: { select: { id: true, name: true, phone: true } },
  soldBy: { select: { id: true, fullName: true } },
  returnedBy: { select: { id: true, fullName: true } },
} satisfies Prisma.SaleInclude;

type SaleRow = Prisma.SaleGetPayload<{ include: typeof saleInclude }>;

/** Наружу: деньги числами; себестоимость — только тем, кому положено её видеть. */
function project(s: SaleRow, seesCost: boolean) {
  return {
    id: s.id,
    number: s.number,
    createdAt: s.createdAt,
    payment: s.payment as SalePayment,
    subtotal: num(s.subtotal),
    discount: num(s.discount),
    total: num(s.total),
    warrantyDays: s.warrantyDays,
    warrantyUntil: s.warrantyDays ? new Date(s.createdAt.getTime() + s.warrantyDays * 86_400_000) : null,
    note: s.note,
    customer: s.customer,
    soldBy: s.soldBy,
    returnedAt: s.returnedAt,
    returnedBy: s.returnedBy,
    returnReason: s.returnReason,
    items: s.items.map((i) => ({
      id: i.id,
      stockItemId: i.stockItemId,
      name: i.name,
      sku: i.sku,
      qty: num(i.qty),
      price: num(i.price),
      sum: round2(num(i.qty) * num(i.price)),
      ...(seesCost ? { cost: num(i.cost) } : {}),
    })),
  };
}

const seesCost = (req: Request) => has(req, PERMISSIONS.ORDERS_COST) || has(req, PERMISSIONS.FINANCE_VIEW);

// ------------------------------------------------------------------ журнал

salesRouter.get(
  "/",
  requirePermission(PERMISSIONS.STOCK_SELL, PERMISSIONS.FINANCE_VIEW, PERMISSIONS.CUSTOMERS_VIEW),
  ah(async (req, res) => {
    const q = z
      .object({
        q: z.string().trim().max(120).optional(),
        customerId: z.string().uuid().optional(),
        ...pageFields,
      })
      .parse(req.query);
    // Покупки клиента видит тот, кто видит клиента; весь журнал — продающий или касса.
    if (!q.customerId && !has(req, PERMISSIONS.STOCK_SELL) && !has(req, PERMISSIONS.FINANCE_VIEW)) {
      return res.status(403).json({ error: "Недостаточно прав" });
    }
    const words = searchWords(q.q);
    const where: Prisma.SaleWhereInput = {
      ...(q.customerId ? { customerId: q.customerId } : {}),
      ...(words.length
        ? {
            AND: words.map((w) => ({
              OR: [
                { number: { contains: w, mode: "insensitive" as const } },
                { items: { some: { name: { contains: w, mode: "insensitive" as const } } } },
                { items: { some: { sku: { contains: w, mode: "insensitive" as const } } } },
                { customer: { is: { name: { contains: w, mode: "insensitive" as const } } } },
              ],
            })),
          }
        : {}),
    };
    const out = await withTenant(tenantOf(req), async (tx) => {
      const [rows, total, sums] = await Promise.all([
        tx.sale.findMany({ where, orderBy: { createdAt: "desc" }, include: saleInclude, ...skipTake(q) }),
        tx.sale.count({ where }),
        tx.sale.aggregate({ where: { ...where, returnedAt: null }, _sum: { total: true } }),
      ]);
      return { rows, total, sum: num(sums._sum.total) };
    });
    const cost = seesCost(req);
    res.json({ ...paged(out.rows.map((s) => project(s, cost)), out.total, q), sum: out.sum });
  })
);

salesRouter.get(
  "/:id",
  requirePermission(PERMISSIONS.STOCK_SELL, PERMISSIONS.FINANCE_VIEW, PERMISSIONS.CUSTOMERS_VIEW),
  ah(async (req, res) => {
    const sale = await withTenant(tenantOf(req), (tx) => tx.sale.findFirst({ where: { id: req.params.id }, include: saleInclude }));
    if (!sale) throw notFound("Продажа не найдена");
    res.json(project(sale, seesCost(req)));
  })
);

// ------------------------------------------------------------------ продать

const saleSchema = z.object({
  items: z
    .array(
      z.object({
        stockItemId: z.string().uuid(),
        qty: z.number().int("Количество — целое").min(1, "Количество — от 1").max(100_000),
        price: z.number().min(0, "Цена не бывает отрицательной").max(100_000_000),
      })
    )
    .min(1, "Добавьте в чек хотя бы один товар")
    .max(200, "Слишком много строк в одном чеке"),
  discount: z.number().min(0).max(100_000_000).default(0),
  payment: z.enum(SALE_PAYMENTS),
  customerId: z.string().uuid().nullable().optional(),
  warrantyDays: z.number().int().min(0).max(3650).nullable().optional(),
  note: z.string().trim().max(500).optional(),
});

salesRouter.post(
  "/",
  requirePermission(PERMISSIONS.STOCK_SELL),
  ah(async (req, res) => {
    const body = saleSchema.parse(req.body);
    const tenantId = tenantOf(req);
    const userId = actorUserId(req);

    // Одна позиция двумя строками («+» нажали дважды из разных мест) — одной строкой.
    const lines = new Map<string, { qty: number; price: number }>();
    for (const l of body.items) {
      const cur = lines.get(l.stockItemId);
      if (cur && cur.price !== l.price) throw badRequest("Один и тот же товар в чеке по разной цене — оставьте одну строку");
      lines.set(l.stockItemId, { qty: (cur?.qty ?? 0) + l.qty, price: l.price });
    }
    const subtotal = round2([...lines.values()].reduce((s, l) => s + l.qty * l.price, 0));
    const discount = round2(body.discount);
    if (discount > subtotal) throw badRequest("Скидка больше суммы чека");
    const total = round2(subtotal - discount);

    let saleId = "";
    for (let attempt = 0; ; attempt++) {
      try {
        saleId = await withTenant(tenantId, async (tx) => {
          await lockSales(tx, tenantId);
          if (body.customerId) {
            const c = await tx.customer.findFirst({ where: { id: body.customerId, deletedAt: null }, select: { id: true } });
            if (!c) throw badRequest("Клиент не найден — выберите заново");
          }
          const stock = await tx.stockItem.findMany({
            where: { id: { in: [...lines.keys()] } },
            select: { id: true, name: true, sku: true, isActive: true, warehouseId: true },
          });
          const byId = new Map(stock.map((s) => [s.id, s]));
          for (const id of lines.keys()) {
            const s = byId.get(id);
            if (!s || !s.isActive) throw badRequest("Одного из товаров больше нет на складе — обновите чек");
          }

          const number = await nextSaleNumber(tx);
          const sale = await tx.sale.create({
            data: {
              tenantId,
              number,
              customerId: body.customerId ?? null,
              soldById: userId,
              payment: body.payment,
              subtotal,
              discount,
              total,
              warrantyDays: body.warrantyDays || null,
              note: body.note || null,
            },
          });

          for (const [id, l] of lines) {
            const s = byId.get(id)!;
            // Продаём со склада самой позиции (29.10.2026).
            const warehouse = await homeWarehouse(tx, tenantId, s.warehouseId);
            const bal = await tx.stockBalance.findFirst({ where: { warehouseId: warehouse.id, stockItemId: id } });
            const have = num(bal?.qty);
            if (l.qty > have) {
              throw badRequest(
                have > 0
                  ? `«${s.name}»: на складе ${have} шт., а в чеке ${l.qty}`
                  : `«${s.name}» на складе закончился — уберите его из чека`
              );
            }
            const cost = round2(num(bal?.avgCost));
            const mv = await applyMovement(tx, {
              tenantId,
              warehouseId: warehouse.id,
              stockItemId: id,
              type: "OUT",
              qty: l.qty,
              price: cost,
              userId,
              comment: `Продажа ${number}`,
            });
            await tx.stockMovement.update({ where: { id: mv.id }, data: { saleId: sale.id } });
            await tx.saleItem.create({
              data: { tenantId, saleId: sale.id, stockItemId: id, name: s.name, sku: s.sku, qty: l.qty, price: l.price, cost },
            });
          }

          // Ноль в кассу не пишем: продали со скидкой в 100 % — денег не было.
          if (total > 0) {
            const register = await registerFor(tx, tenantId, body.payment);
            const category = await categoryNamed(tx, tenantId, IN_CATEGORY, "IN");
            await tx.transaction.create({
              data: {
                tenantId,
                cashRegisterId: register.id,
                categoryId: category.id,
                direction: "IN",
                amount: total,
                saleId: sale.id,
                customerId: body.customerId ?? null,
                userId,
                comment: `Продажа ${number}`,
              },
            });
          }

          await writeAudit(tx, {
            tenantId,
            userId,
            entity: "sale",
            entityId: sale.id,
            action: "CREATE",
            diff: { number, total, items: lines.size, payment: body.payment },
            ip: clientIp(req),
          });
          return sale.id;
        });
        break;
      } catch (err) {
        if (attempt < 3 && err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") continue;
        throw err;
      }
    }

    const sale = await withTenant(tenantId, (tx) => tx.sale.findFirst({ where: { id: saleId }, include: saleInclude }));
    res.status(201).json(project(sale!, seesCost(req)));
  })
);

// ------------------------------------------------------------------ возврат

/**
 * Вернуть продажу целиком: товар — на склад, деньги — покупателю. Частичный
 * возврат пока не делаем: на практике возвращают «не подошло» — весь чек.
 */
salesRouter.post(
  "/:id/return",
  requirePermission(PERMISSIONS.STOCK_SELL),
  ah(async (req, res) => {
    const { reason } = z.object({ reason: z.string().trim().max(300).optional() }).parse(req.body ?? {});
    const tenantId = tenantOf(req);
    const userId = actorUserId(req);

    await withTenant(tenantId, async (tx) => {
      await lockSales(tx, tenantId);
      const sale = await tx.sale.findFirst({ where: { id: req.params.id }, include: { items: true } });
      if (!sale) throw notFound("Продажа не найдена");
      if (sale.returnedAt) throw conflict("Эта продажа уже возвращена");

      for (const i of sale.items) {
        // Позицию со склада могли удалить — тогда вернуть некуда, деньги всё равно отдаём.
        if (!i.stockItemId) continue;
        const exists = await tx.stockItem.findFirst({ where: { id: i.stockItemId }, select: { id: true, warehouseId: true } });
        if (!exists) continue;
        const warehouse = await homeWarehouse(tx, tenantId, exists.warehouseId);
        const mv = await applyMovement(tx, {
          tenantId,
          warehouseId: warehouse.id,
          stockItemId: i.stockItemId,
          type: "RETURN",
          qty: num(i.qty),
          price: num(i.cost),
          userId,
          comment: `Возврат продажи ${sale.number}${reason ? `: ${reason}` : ""}`,
        });
        await tx.stockMovement.update({ where: { id: mv.id }, data: { saleId: sale.id } });
      }

      const total = num(sale.total);
      if (total > 0) {
        // Деньги — из той же кассы, куда пришли.
        const paidTo = await tx.transaction.findFirst({ where: { saleId: sale.id, direction: "IN" }, select: { cashRegisterId: true } });
        const registerId = paidTo?.cashRegisterId ?? (await registerFor(tx, tenantId, sale.payment as SalePayment)).id;
        const category = await categoryNamed(tx, tenantId, OUT_CATEGORY, "OUT");
        await tx.transaction.create({
          data: {
            tenantId,
            cashRegisterId: registerId,
            categoryId: category.id,
            direction: "OUT",
            amount: total,
            saleId: sale.id,
            customerId: sale.customerId,
            userId,
            comment: `Возврат продажи ${sale.number}${reason ? `: ${reason}` : ""}`,
          },
        });
      }

      await tx.sale.update({
        where: { id: sale.id },
        data: { returnedAt: new Date(), returnedById: userId, returnReason: reason || null },
      });
      await writeAudit(tx, {
        tenantId,
        userId,
        entity: "sale",
        entityId: sale.id,
        action: "UPDATE",
        diff: { returned: true, reason: reason ?? null },
        ip: clientIp(req),
      });
    });

    const sale = await withTenant(tenantId, (tx) => tx.sale.findFirst({ where: { id: req.params.id }, include: saleInclude }));
    res.json(project(sale!, seesCost(req)));
  })
);
