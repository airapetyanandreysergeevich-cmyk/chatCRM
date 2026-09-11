import { Prisma } from "@prisma/client";
import { Router, type Request } from "express";
import { z } from "zod";
import { clientIp, writeAudit } from "../../lib/audit";
import { withTenant } from "../../lib/db";
import { ah, badRequest, notFound } from "../../lib/errors";
import { notifyTenant } from "../../lib/notify";
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
import { applyMovement, defaultWarehouse, num } from "../stock/stock.service";

/**
 * Закупки.
 *
 * Смысл раздела не в учёте покупок, а в разговоре между мастером и тем,
 * кто платит. Мастер видит, что нужна деталь, но не распоряжается деньгами;
 * управляющий распоряжается деньгами, но не видит, что деталь нужна. Заявка
 * — это место, где они договариваются, и где остаётся след договорённости.
 *
 * Приход по заявке кладёт детали на склад одним действием: иначе их
 * оприходуют «потом», а потом не наступает никогда.
 */

export const purchasesRouter = Router();
purchasesRouter.use(authenticate, requireTenant, enforceTenantStatus);

const tenantOf = (req: Request) => currentTenantId(req)!;
const has = (req: Request, code: string) => permissionsOf(req).includes(code);

const STATUS_LABEL: Record<string, string> = {
  DRAFT: "Черновик",
  PENDING: "На согласовании",
  APPROVED: "Согласована",
  ORDERED: "Заказано",
  RECEIVED: "Получено",
  REJECTED: "Отклонена",
};

/**
 * Номер заявки. Отдельного счётчика в базе нет, поэтому берём следующий за
 * наибольшим в этом году. Гонка возможна, если двое нажмут «отправить» в одну
 * миллисекунду, — на этот случай стоит повтор: уникальный индекс не даст
 * выдать один номер дважды, а человек ничего не заметит.
 */
async function nextNumber(tx: Prisma.TransactionClient): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `З-${year}-`;
  const last = await tx.purchaseRequest.findFirst({
    where: { number: { startsWith: prefix } },
    orderBy: { number: "desc" },
    select: { number: true },
  });
  const n = last ? Number(last.number.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(Number.isFinite(n) ? n : 1).padStart(5, "0")}`;
}

const isDuplicateNumber = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

// ------------------------------------------------------------------ список

purchasesRouter.get(
  "/",
  requirePermission(
    PERMISSIONS.PURCHASES_VIEW,
    PERMISSIONS.PURCHASES_CREATE,
    PERMISSIONS.PURCHASES_APPROVE
  ),
  ah(async (req, res) => {
    const q = z
      .object({
        status: z.enum(["DRAFT", "PENDING", "APPROVED", "ORDERED", "RECEIVED", "REJECTED"]).optional(),
        orderId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(60),
      })
      .parse(req.query);

    const me = actorUserId(req);
    // Мастер видит свои заявки. Он их создаёт, но чужие закупки — не его дело.
    const onlyMine = !has(req, PERMISSIONS.PURCHASES_VIEW) && !has(req, PERMISSIONS.PURCHASES_APPROVE);

    const rows = await withTenant(tenantOf(req), (tx) =>
      tx.purchaseRequest.findMany({
        where: {
          ...(q.status ? { status: q.status } : {}),
          ...(q.orderId ? { orderId: q.orderId } : {}),
          ...(onlyMine && me ? { createdById: me } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: q.limit,
        include: {
          items: true,
          createdBy: { select: { id: true, fullName: true } },
          approvedBy: { select: { id: true, fullName: true } },
          order: { select: { id: true, number: true } },
        },
      })
    );

    res.json(
      rows.map((r) => ({
        id: r.id,
        number: r.number,
        status: r.status,
        statusLabel: STATUS_LABEL[r.status] ?? r.status,
        comment: r.comment,
        rejectionReason: r.rejectionReason,
        createdBy: r.createdBy,
        approvedBy: r.approvedBy,
        order: r.order,
        createdAt: r.createdAt,
        approvedAt: r.approvedAt,
        items: r.items.map((i) => ({
          id: i.id,
          name: i.name,
          qty: num(i.qty),
          unit: i.unit,
          link: i.link,
          expectedPrice: i.expectedPrice === null ? null : num(i.expectedPrice),
          receivedQty: num(i.receivedQty),
          note: i.note,
          stockItemId: i.stockItemId,
        })),
        total: r.items.reduce((n, i) => n + num(i.qty) * num(i.expectedPrice), 0),
      }))
    );
  })
);

// ------------------------------------------------------------------ заявка

const createSchema = z.object({
  orderId: z.string().uuid().optional(),
  comment: z.string().trim().max(500).optional(),
  items: z
    .array(
      z.object({
        name: z.string().trim().min(1, "Без названия непонятно, что покупать").max(200),
        qty: z.coerce.number().min(0.001).max(100_000).default(1),
        unit: z.string().trim().min(1).max(20).default("шт"),
        link: z.string().trim().max(500).optional(),
        expectedPrice: z.coerce.number().min(0).max(10_000_000).optional(),
        stockItemId: z.string().uuid().optional(),
        note: z.string().trim().max(300).optional(),
      })
    )
    .min(1, "Добавьте хотя бы одну позицию")
    .max(50),
});

purchasesRouter.post(
  "/",
  requirePermission(PERMISSIONS.PURCHASES_CREATE),
  ah(async (req, res) => {
    const body = createSchema.parse(req.body);
    const tenantId = tenantOf(req);
    const userId = actorUserId(req);
    if (!userId) throw badRequest("Заявку создаёт сотрудник мастерской");

    let created: { id: string; number: string } | null = null;
    for (let attempt = 0; attempt < 5 && !created; attempt += 1) {
      try {
        created = await withTenant(tenantId, async (tx) => {
          if (body.orderId) {
            const order = await tx.order.findFirst({
              where: { id: body.orderId, deletedAt: null },
              select: { id: true },
            });
            if (!order) throw notFound("Заказ не найден");
          }

          const number = await nextNumber(tx);
          const request = await tx.purchaseRequest.create({
            data: {
              tenantId,
              number,
              createdById: userId,
              orderId: body.orderId ?? null,
              status: "PENDING",
              comment: body.comment ?? null,
            },
          });

          // Позиции создаём отдельным вызовом: вложенный create прокси
          // tenantId не подставит, и RLS такую вставку отклонит.
          await tx.purchaseRequestItem.createMany({
            data: body.items.map((i) => ({
              tenantId,
              requestId: request.id,
              name: i.name,
              qty: i.qty,
              unit: i.unit,
              link: i.link ?? null,
              expectedPrice: i.expectedPrice ?? null,
              stockItemId: i.stockItemId ?? null,
              note: i.note ?? null,
            })),
          });

          await writeAudit(tx, {
            tenantId,
            userId,
            entity: "purchaseRequest",
            entityId: request.id,
            action: "CREATE",
            diff: { number: request.number, positions: body.items.length },
            ip: clientIp(req),
          });

          return { id: request.id, number: request.number };
        });
      } catch (err) {
        if (!isDuplicateNumber(err)) throw err;
      }
    }
    if (!created) throw badRequest("Не удалось выдать номер заявки, попробуйте ещё раз");

    void notifyTenant(tenantId, {
      event: "purchase.requested",
      title: `Заявка на закупку ${created.number}`,
      body: body.items
        .slice(0, 3)
        .map((i) => `${i.name} — ${i.qty} ${i.unit}`)
        .join("; "),
      url: "/purchases",
      exceptUserId: userId,
    });

    res.status(201).json(created);
  })
);

// -------------------------------------------------------- решение по заявке

purchasesRouter.post(
  "/:id/approve",
  requirePermission(PERMISSIONS.PURCHASES_APPROVE),
  ah(async (req, res) => {
    const tenantId = tenantOf(req);
    const userId = actorUserId(req);

    await withTenant(tenantId, async (tx) => {
      const request = await tx.purchaseRequest.findFirst({ where: { id: req.params.id } });
      if (!request) throw notFound("Заявка не найдена");
      if (request.status === "RECEIVED") throw badRequest("Заявка уже получена");

      await tx.purchaseRequest.update({
        where: { id: request.id },
        data: { status: "APPROVED", approvedById: userId, approvedAt: new Date(), rejectionReason: null },
      });
      await writeAudit(tx, {
        tenantId,
        userId,
        entity: "purchaseRequest",
        entityId: request.id,
        action: "STATUS",
        diff: { from: request.status, to: "APPROVED" },
        ip: clientIp(req),
      });
    });

    res.json({ ok: true });
  })
);

purchasesRouter.post(
  "/:id/reject",
  requirePermission(PERMISSIONS.PURCHASES_APPROVE),
  ah(async (req, res) => {
    const body = z
      .object({ reason: z.string().trim().min(1, "Скажите мастеру, почему отказ").max(500) })
      .parse(req.body);
    const tenantId = tenantOf(req);
    const userId = actorUserId(req);

    await withTenant(tenantId, async (tx) => {
      const request = await tx.purchaseRequest.findFirst({ where: { id: req.params.id } });
      if (!request) throw notFound("Заявка не найдена");
      if (request.status === "RECEIVED") throw badRequest("Полученную заявку отклонить нельзя");

      await tx.purchaseRequest.update({
        where: { id: request.id },
        data: {
          status: "REJECTED",
          approvedById: userId,
          approvedAt: new Date(),
          rejectionReason: body.reason,
        },
      });
      await writeAudit(tx, {
        tenantId,
        userId,
        entity: "purchaseRequest",
        entityId: request.id,
        action: "STATUS",
        diff: { from: request.status, to: "REJECTED", reason: body.reason },
        ip: clientIp(req),
      });
    });

    res.json({ ok: true });
  })
);

// ------------------------------------------------------------------- приход

const receiveSchema = z.object({
  warehouseId: z.string().uuid().optional(),
  items: z
    .array(
      z.object({
        id: z.string().uuid(),
        qty: z.coerce.number().min(0).max(100_000),
        price: z.coerce.number().min(0).max(10_000_000).optional(),
      })
    )
    .min(1),
});

purchasesRouter.post(
  "/:id/receive",
  requirePermission(PERMISSIONS.PURCHASES_APPROVE, PERMISSIONS.STOCK_MOVE),
  ah(async (req, res) => {
    const body = receiveSchema.parse(req.body);
    const tenantId = tenantOf(req);
    const userId = actorUserId(req);

    const result = await withTenant(tenantId, async (tx) => {
      const request = await tx.purchaseRequest.findFirst({
        where: { id: req.params.id },
        include: { items: true },
      });
      if (!request) throw notFound("Заявка не найдена");
      if (request.status === "REJECTED") throw badRequest("Заявка отклонена — приходовать нечего");

      const warehouse = await defaultWarehouse(tx, tenantId, body.warehouseId ?? null);
      let received = 0;

      for (const line of body.items) {
        const item = request.items.find((i) => i.id === line.id);
        if (!item) throw badRequest("Позиция не из этой заявки");
        if (line.qty <= 0) continue;

        // Позиции номенклатуры может ещё не быть: мастер написал заявку
        // словами, а не выбрал из справочника. Заводим её при приходе —
        // иначе деталь придётся вбивать второй раз вручную.
        let stockItemId = item.stockItemId;
        if (!stockItemId) {
          const found = await tx.stockItem.findFirst({
            where: { name: item.name, isActive: true },
            select: { id: true },
          });
          stockItemId =
            found?.id ??
            (await tx.stockItem.create({ data: { tenantId, name: item.name, unit: item.unit } })).id;
          await tx.purchaseRequestItem.update({ where: { id: item.id }, data: { stockItemId } });
        }

        await applyMovement(tx, {
          tenantId,
          warehouseId: warehouse.id,
          stockItemId,
          type: "IN",
          qty: line.qty,
          price: line.price ?? (item.expectedPrice === null ? null : num(item.expectedPrice)),
          purchaseRequestId: request.id,
          orderId: request.orderId,
          userId,
          comment: `Приход по заявке ${request.number}`,
        });

        await tx.purchaseRequestItem.update({
          where: { id: item.id },
          data: { receivedQty: num(item.receivedQty) + line.qty },
        });
        received += 1;
      }

      if (received === 0) throw badRequest("Не указано ни одного полученного количества");

      // Полностью закрытой заявку считаем, когда по каждой позиции получено
      // не меньше заказанного. Частичный приход оставляем в «Заказано»:
      // половина деталей — это ещё не закрытая закупка.
      const after = await tx.purchaseRequestItem.findMany({ where: { requestId: request.id } });
      const complete = after.every((i) => num(i.receivedQty) >= num(i.qty));

      await tx.purchaseRequest.update({
        where: { id: request.id },
        data: { status: complete ? "RECEIVED" : "ORDERED" },
      });

      await writeAudit(tx, {
        tenantId,
        userId,
        entity: "purchaseRequest",
        entityId: request.id,
        action: "STATUS",
        diff: { to: complete ? "RECEIVED" : "ORDERED", positions: received },
        ip: clientIp(req),
      });

      return { status: complete ? "RECEIVED" : "ORDERED", positions: received };
    });

    res.json(result);
  })
);
