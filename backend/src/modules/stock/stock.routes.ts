import { Router, type Request } from "express";
import { z } from "zod";
import { clientIp, writeAudit } from "../../lib/audit";
import { withTenant } from "../../lib/db";
import { ah, badRequest, conflict, notFound } from "../../lib/errors";
import { PERMISSIONS } from "../../lib/permissions";
import {
  actorUserId,
  authenticate,
  currentTenantId,
  permissionsOf,
  requirePermission,
  requireTenant,
} from "../../middleware/auth";
import { enforceTenantStatus } from "../../middleware/tenantStatus";
import { recalcTotals } from "../orders/orders.service";
import { applyMovement, defaultWarehouse, num } from "./stock.service";

/**
 * Склад.
 *
 * Главное правило раздела: остаток нельзя изменить «просто так». Любое
 * изменение — это движение с автором, временем и причиной, а остаток лишь
 * его следствие. Иначе через месяц никто не объяснит, куда делись четыре
 * планки памяти, и складу перестанут верить — а склад, которому не верят,
 * хуже, чем его отсутствие.
 *
 * Второе правило: в минус не уходим. Списать больше, чем лежит, — это почти
 * всегда опечатка в количестве или списание не с того склада, и поймать её
 * надо в момент ввода, а не при инвентаризации через полгода.
 */

export const stockRouter = Router();
stockRouter.use(authenticate, requireTenant, enforceTenantStatus);

const tenantOf = (req: Request) => currentTenantId(req)!;
const has = (req: Request, code: string) => permissionsOf(req).includes(code);

/** Себестоимость видит не каждый: мастеру знать закупочную цену незачем. */
const seesCost = (req: Request) =>
  has(req, PERMISSIONS.ORDERS_COST) ||
  has(req, PERMISSIONS.FINANCE_VIEW) ||
  has(req, PERMISSIONS.STOCK_MOVE);

// ------------------------------------------------------------------ склады

stockRouter.get(
  "/warehouses",
  requirePermission(PERMISSIONS.STOCK_VIEW),
  ah(async (req, res) => {
    const rows = await withTenant(tenantOf(req), (tx) =>
      tx.warehouse.findMany({ orderBy: [{ isDefault: "desc" }, { name: "asc" }] })
    );
    res.json(rows.map((w) => ({ id: w.id, name: w.name, isDefault: w.isDefault })));
  })
);

// ------------------------------------------------------------ номенклатура

stockRouter.get(
  "/",
  requirePermission(PERMISSIONS.STOCK_VIEW),
  ah(async (req, res) => {
    const q = z
      .object({
        search: z.string().trim().max(120).optional(),
        filter: z.enum(["all", "low", "zero", "in"]).default("all"),
        limit: z.coerce.number().int().min(1).max(300).default(120),
      })
      .parse(req.query);

    const cost = seesCost(req);

    const rows = await withTenant(tenantOf(req), (tx) =>
      tx.stockItem.findMany({
        where: {
          isActive: true,
          ...(q.search
            ? {
                OR: [
                  { name: { contains: q.search, mode: "insensitive" as const } },
                  { sku: { contains: q.search, mode: "insensitive" as const } },
                  { category: { contains: q.search, mode: "insensitive" as const } },
                ],
              }
            : {}),
        },
        orderBy: { name: "asc" },
        take: q.limit,
        include: { balances: { include: { warehouse: { select: { id: true, name: true } } } } },
      })
    );

    const items = rows.map((i) => {
      const qty = i.balances.reduce((n, b) => n + num(b.qty), 0);
      const minQty = num(i.minQty);
      // Средняя себестоимость по всем складам, взвешенная по количеству:
      // простое среднее врало бы, когда на одном складе три штуки, а на
      // другом сорок.
      const value = i.balances.reduce((n, b) => n + num(b.qty) * num(b.avgCost), 0);
      return {
        id: i.id,
        sku: i.sku,
        name: i.name,
        unit: i.unit,
        category: i.category,
        minQty,
        qty,
        low: minQty > 0 && qty < minQty,
        // Деньги считаем всегда, а наружу отдаём ниже — только тому, кому
        // они положены. Условная форма объекта тут дороже, чем одно поле.
        avgCost: qty > 0 ? value / qty : 0,
        value,
        places: i.balances
          .filter((b) => num(b.qty) !== 0)
          .map((b) => ({ warehouseId: b.warehouse.id, warehouse: b.warehouse.name, qty: num(b.qty) })),
      };
    });

    const filtered =
      q.filter === "low"
        ? items.filter((i) => i.low)
        : q.filter === "zero"
          ? items.filter((i) => i.qty <= 0)
          : q.filter === "in"
            ? items.filter((i) => i.qty > 0)
            : items;

    res.json({
      items: filtered.map(({ avgCost, value, ...rest }) => (cost ? { ...rest, avgCost, value } : rest)),
      totals: {
        positions: items.length,
        low: items.filter((i) => i.low).length,
        ...(cost ? { value: items.reduce((n, i) => n + i.value, 0) } : {}),
      },
    });
  })
);

const itemSchema = z.object({
  sku: z.string().trim().max(60).optional(),
  name: z.string().trim().min(1, "Без названия позицию не найти").max(200),
  unit: z.string().trim().min(1).max(20).default("шт"),
  category: z.string().trim().max(80).optional(),
  minQty: z.coerce.number().min(0).max(1_000_000).default(0),
});

stockRouter.post(
  "/",
  requirePermission(PERMISSIONS.STOCK_MOVE),
  ah(async (req, res) => {
    const body = itemSchema.parse(req.body);
    const tenantId = tenantOf(req);

    const item = await withTenant(tenantId, async (tx) => {
      if (body.sku) {
        const same = await tx.stockItem.findFirst({ where: { sku: body.sku, isActive: true } });
        if (same) throw conflict(`Артикул «${body.sku}» уже занят позицией «${same.name}»`);
      }
      const created = await tx.stockItem.create({
        data: {
          tenantId,
          sku: body.sku || null,
          name: body.name,
          unit: body.unit,
          category: body.category || null,
          minQty: body.minQty,
        },
      });
      await writeAudit(tx, {
        tenantId,
        userId: actorUserId(req),
        entity: "stockItem",
        entityId: created.id,
        action: "CREATE",
        diff: { name: created.name, sku: created.sku },
        ip: clientIp(req),
      });
      return created;
    });

    res.status(201).json({ id: item.id, name: item.name });
  })
);

stockRouter.patch(
  "/:id",
  requirePermission(PERMISSIONS.STOCK_MOVE),
  ah(async (req, res) => {
    const body = itemSchema.partial().parse(req.body);
    const tenantId = tenantOf(req);

    await withTenant(tenantId, async (tx) => {
      const item = await tx.stockItem.findFirst({ where: { id: req.params.id } });
      if (!item) throw notFound("Позиция не найдена");
      await tx.stockItem.update({
        where: { id: item.id },
        data: {
          ...(body.sku !== undefined ? { sku: body.sku || null } : {}),
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.unit !== undefined ? { unit: body.unit } : {}),
          ...(body.category !== undefined ? { category: body.category || null } : {}),
          ...(body.minQty !== undefined ? { minQty: body.minQty } : {}),
        },
      });
      await writeAudit(tx, {
        tenantId,
        userId: actorUserId(req),
        entity: "stockItem",
        entityId: item.id,
        action: "UPDATE",
        diff: body as Record<string, unknown>,
        ip: clientIp(req),
      });
    });

    res.json({ ok: true });
  })
);

// --------------------------------------------------------------- движения

const movementSchema = z.object({
  stockItemId: z.string().uuid(),
  warehouseId: z.string().uuid().optional(),
  type: z.enum(["IN", "OUT", "WRITE_OFF", "RETURN", "INVENTORY"]),
  qty: z.coerce.number().min(0).max(1_000_000),
  price: z.coerce.number().min(0).max(10_000_000).optional(),
  /** Списание в заказ: позиция сразу попадает в калькуляцию этого заказа. */
  orderId: z.string().uuid().optional(),
  /** Цена для клиента, если позиция уходит в заказ. По умолчанию — себестоимость. */
  salePrice: z.coerce.number().min(0).max(10_000_000).optional(),
  comment: z.string().trim().max(300).optional(),
});

stockRouter.post(
  "/movements",
  requirePermission(PERMISSIONS.STOCK_MOVE, PERMISSIONS.STOCK_WRITE_OFF_OWN, PERMISSIONS.STOCK_INVENTORY),
  ah(async (req, res) => {
    const body = movementSchema.parse(req.body);
    const tenantId = tenantOf(req);
    const userId = actorUserId(req);

    // Мастеру можно только списывать в свой заказ. Приход и инвентаризация —
    // это уже распоряжение имуществом мастерской.
    const fullAccess = has(req, PERMISSIONS.STOCK_MOVE);
    if (!fullAccess) {
      if (body.type === "INVENTORY" && !has(req, PERMISSIONS.STOCK_INVENTORY)) {
        throw badRequest("Инвентаризацию проводит управляющий");
      }
      if (body.type === "IN" || body.type === "RETURN") {
        throw badRequest("Приход на склад оформляет управляющий или приёмщик");
      }
      if (body.type === "OUT" && !body.orderId) {
        throw badRequest("Списать можно только в свой заказ");
      }
    }

    if (body.type !== "INVENTORY" && body.qty <= 0) {
      throw badRequest("Количество должно быть больше нуля");
    }

    const result = await withTenant(tenantId, async (tx) => {
      const item = await tx.stockItem.findFirst({ where: { id: body.stockItemId } });
      if (!item) throw notFound("Позиция не найдена");

      const warehouse = await defaultWarehouse(tx, tenantId, body.warehouseId ?? null);

      let order: { id: string; number: string; assignedMasterId: string | null } | null = null;
      if (body.orderId) {
        order = await tx.order.findFirst({
          where: { id: body.orderId, deletedAt: null },
          select: { id: true, number: true, assignedMasterId: true },
        });
        if (!order) throw notFound("Заказ не найден");
        if (!fullAccess && order.assignedMasterId !== userId) {
          throw badRequest("Этот заказ вам не назначен");
        }
      }

      const movement = await applyMovement(tx, {
        tenantId,
        warehouseId: warehouse.id,
        stockItemId: item.id,
        type: body.type,
        qty: body.qty,
        price: body.price ?? null,
        orderId: order?.id ?? null,
        userId,
        comment: body.comment ?? null,
      });

      // Списание в заказ должно быть видно в самом заказе, иначе запчасть
      // уходит со склада, а клиент за неё не платит.
      if (order && body.type === "OUT") {
        const balance = await tx.stockBalance.findFirst({
          where: { warehouseId: warehouse.id, stockItemId: item.id },
          select: { avgCost: true },
        });
        const cost = num(balance?.avgCost);
        await tx.orderPart.create({
          data: {
            tenantId,
            orderId: order.id,
            name: item.name,
            qty: body.qty,
            price: body.salePrice ?? cost,
            cost,
            source: "STOCK",
            stockItemId: item.id,
          },
        });
        await recalcTotals(tx, order.id);
      }

      await writeAudit(tx, {
        tenantId,
        userId,
        entity: "stockMovement",
        entityId: movement.id,
        action: "CREATE",
        diff: { item: item.name, type: body.type, qty: body.qty, order: order?.number ?? null },
        ip: clientIp(req),
      });

      const after = await tx.stockBalance.findFirst({
        where: { warehouseId: warehouse.id, stockItemId: item.id },
        select: { qty: true },
      });
      return { id: movement.id, qty: num(after?.qty) };
    });

    res.status(201).json(result);
  })
);

const MOVEMENT_LABEL: Record<string, string> = {
  IN: "Приход",
  OUT: "В заказ",
  WRITE_OFF: "Списание",
  RETURN: "Возврат",
  TRANSFER: "Перемещение",
  INVENTORY: "Инвентаризация",
};

stockRouter.get(
  "/movements",
  requirePermission(PERMISSIONS.STOCK_VIEW),
  ah(async (req, res) => {
    const q = z
      .object({
        stockItemId: z.string().uuid().optional(),
        orderId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(60),
      })
      .parse(req.query);

    const cost = seesCost(req);

    const rows = await withTenant(tenantOf(req), (tx) =>
      tx.stockMovement.findMany({
        where: {
          ...(q.stockItemId ? { stockItemId: q.stockItemId } : {}),
          ...(q.orderId ? { orderId: q.orderId } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: q.limit,
        include: {
          stockItem: { select: { id: true, name: true, unit: true } },
          warehouse: { select: { id: true, name: true } },
          order: { select: { id: true, number: true } },
          user: { select: { id: true, fullName: true } },
        },
      })
    );

    res.json(
      rows.map((m) => ({
        id: m.id,
        type: m.type,
        typeLabel: MOVEMENT_LABEL[m.type] ?? m.type,
        qty: num(m.qty),
        ...(cost ? { price: m.price === null ? null : num(m.price) } : {}),
        item: m.stockItem,
        warehouse: m.warehouse,
        order: m.order,
        user: m.user,
        comment: m.comment,
        createdAt: m.createdAt,
      }))
    );
  })
);
