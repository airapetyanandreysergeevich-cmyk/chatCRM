import { Router, type Request } from "express";
import { z } from "zod";
import { clientIp, writeAudit } from "../../lib/audit";
import { withTenant } from "../../lib/db";
import { ah, forbidden, notFound } from "../../lib/errors";
import { PERMISSIONS } from "../../lib/permissions";
import { actorUserId, authenticate, currentTenantId, permissionsOf, requireTenant } from "../../middleware/auth";
import { enforceTenantStatus } from "../../middleware/tenantStatus";

/**
 * Свои способы оплаты мастерской (03.11.2026, «Настройки → Способы оплаты»).
 *
 *   GET    /api/pay-methods           — активные (всем: окно выдачи, продажа, долг);
 *                                       ?all=1 — и выключенные, кассы и сотрудники (тому, кто настраивает)
 *   POST   /api/pay-methods           — завести
 *   PATCH  /api/pay-methods/:id       — поправить, выключить (isActive)
 *   PUT    /api/pay-methods/order     — порядок кнопок {ids}
 *
 * Настраивает «Настройки мастерской» или «Управляет кассой». Удаления нет:
 * на способ ссылаются движения кассы — его выключают.
 */
export const payMethodsRouter = Router();
payMethodsRouter.use(authenticate, requireTenant, enforceTenantStatus);

const tenantOf = (req: Request) => currentTenantId(req)!;
const manages = (req: Request) => {
  const p = permissionsOf(req);
  return p.includes(PERMISSIONS.SETTINGS_MANAGE) || p.includes(PERMISSIONS.FINANCE_MANAGE);
};

const bodySchema = z.object({
  name: z.string().trim().min(2, "Название — хотя бы 2 буквы").max(40, "Не длиннее 40 знаков"),
  actKind: z.enum(["CASH", "CARD"]).default("CARD"),
  cashRegisterId: z.string().uuid().nullable().optional(),
  commissionPct: z.number().min(0).max(50).nullable().optional(),
  recipientIds: z.array(z.string().uuid()).max(50).default([]),
  isActive: z.boolean().optional(),
});

type Row = Awaited<ReturnType<typeof loadAll>>[number];

function loadAll(tx: Parameters<Parameters<typeof withTenant>[1]>[0], all: boolean) {
  return tx.payMethod.findMany({
    where: all ? {} : { isActive: true },
    orderBy: [{ isActive: "desc" }, { sortOrder: "asc" }, { createdAt: "asc" }],
    include: { cashRegister: { select: { id: true, name: true } } },
  });
}

function view(m: Row, names: Map<string, string>) {
  return {
    id: m.id,
    name: m.name,
    actKind: m.actKind === "CASH" ? "CASH" : "CARD",
    cashRegisterId: m.cashRegisterId,
    register: m.cashRegister?.name ?? null,
    commissionPct: m.commissionPct === null ? null : Number(m.commissionPct),
    recipients: m.recipientIds.filter((id) => names.has(id)).map((id) => ({ id, name: names.get(id)! })),
    isActive: m.isActive,
  };
}

payMethodsRouter.get(
  "/",
  ah(async (req, res) => {
    const all = req.query.all === "1" && manages(req);
    const out = await withTenant(tenantOf(req), async (tx) => {
      const rows = await loadAll(tx, all);
      const users = await tx.user.findMany({
        where: all ? { deletedAt: null } : { deletedAt: null, isActive: true, id: { in: [...new Set(rows.flatMap((r) => r.recipientIds))] } },
        select: { id: true, fullName: true, isActive: true },
        orderBy: { fullName: "asc" },
      });
      const names = new Map(users.filter((u) => u.isActive).map((u) => [u.id, u.fullName]));
      return {
        items: rows.map((r) => view(r, names)),
        ...(all
          ? {
              registers: await tx.cashRegister.findMany({ where: { isActive: true }, select: { id: true, name: true, kind: true }, orderBy: { name: "asc" } }),
              staff: users.filter((u) => u.isActive).map((u) => ({ id: u.id, name: u.fullName })),
            }
          : {}),
      };
    });
    res.json({ ...out, canManage: manages(req) });
  })
);

async function checkRefs(tx: Parameters<Parameters<typeof withTenant>[1]>[0], body: { cashRegisterId?: string | null; recipientIds?: string[] }) {
  if (body.cashRegisterId && !(await tx.cashRegister.findFirst({ where: { id: body.cashRegisterId }, select: { id: true } }))) {
    throw notFound("Касса не найдена");
  }
  if (body.recipientIds?.length) {
    const n = await tx.user.count({ where: { id: { in: body.recipientIds }, deletedAt: null } });
    if (n !== new Set(body.recipientIds).size) throw notFound("Часть сотрудников не найдена — обновите страницу");
  }
}

payMethodsRouter.post(
  "/",
  ah(async (req, res) => {
    if (!manages(req)) throw forbidden("Способы оплаты настраивает владелец или тот, кто ведёт кассу");
    const body = bodySchema.parse(req.body);
    const tenantId = tenantOf(req);
    const row = await withTenant(tenantId, async (tx) => {
      await checkRefs(tx, body);
      const last = await tx.payMethod.aggregate({ _max: { sortOrder: true } });
      const m = await tx.payMethod.create({
        data: {
          tenantId,
          name: body.name,
          actKind: body.actKind,
          cashRegisterId: body.cashRegisterId ?? null,
          commissionPct: body.commissionPct ?? null,
          recipientIds: [...new Set(body.recipientIds)],
          sortOrder: (last._max.sortOrder ?? 0) + 1,
        },
      });
      await writeAudit(tx, { tenantId, userId: actorUserId(req), entity: "PayMethod", entityId: m.id, action: "CREATE", diff: body, ip: clientIp(req) });
      return m;
    });
    res.status(201).json({ id: row.id });
  })
);

payMethodsRouter.put(
  "/order",
  ah(async (req, res) => {
    if (!manages(req)) throw forbidden();
    const { ids } = z.object({ ids: z.array(z.string().uuid()).max(100) }).parse(req.body);
    await withTenant(tenantOf(req), async (tx) => {
      for (let i = 0; i < ids.length; i++) await tx.payMethod.updateMany({ where: { id: ids[i] }, data: { sortOrder: i + 1 } });
    });
    res.json({ ok: true });
  })
);

payMethodsRouter.patch(
  "/:id",
  ah(async (req, res) => {
    if (!manages(req)) throw forbidden("Способы оплаты настраивает владелец или тот, кто ведёт кассу");
    const body = bodySchema.partial().parse(req.body);
    const tenantId = tenantOf(req);
    await withTenant(tenantId, async (tx) => {
      const m = await tx.payMethod.findFirst({ where: { id: req.params.id } });
      if (!m) throw notFound("Способ оплаты не найден");
      await checkRefs(tx, body);
      await tx.payMethod.update({
        where: { id: m.id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.actKind !== undefined ? { actKind: body.actKind } : {}),
          ...(body.cashRegisterId !== undefined ? { cashRegisterId: body.cashRegisterId } : {}),
          ...(body.commissionPct !== undefined ? { commissionPct: body.commissionPct } : {}),
          ...(body.recipientIds !== undefined ? { recipientIds: [...new Set(body.recipientIds)] } : {}),
          ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
        },
      });
      await writeAudit(tx, {
        tenantId,
        userId: actorUserId(req),
        entity: "PayMethod",
        entityId: m.id,
        action: "UPDATE",
        diff: { before: { name: m.name, actKind: m.actKind, recipientIds: m.recipientIds, isActive: m.isActive }, after: body },
        ip: clientIp(req),
      });
    });
    res.json({ ok: true });
  })
);
