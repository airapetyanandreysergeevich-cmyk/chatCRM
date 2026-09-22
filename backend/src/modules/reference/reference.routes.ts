import { Router, type Request } from "express";
import { withTenant } from "../../lib/db";
import { DEVICE_KINDS, ORDER_KINDS } from "../../lib/dictionaries";
import { listQuickPicks } from "../quickpicks/quickpicks.service";
import { ah } from "../../lib/errors";
import { authenticate, currentTenantId, requireTenant } from "../../middleware/auth";
import { enforceTenantStatus } from "../../middleware/tenantStatus";

export const referenceRouter = Router();
referenceRouter.use(authenticate, requireTenant, enforceTenantStatus);

const tenantOf = (req: Request) => currentTenantId(req)!;

/**
 * Всё, что нужно бланку приёма, одним запросом: справочники плюс статусы
 * конкретной мастерской. Пять отдельных запросов на открытие формы —
 * это пять поводов ей не открыться.
 */
referenceRouter.get(
  "/",
  ah(async (req, res) => {
    const [statuses, masters, services, completeness, appearance, complaint] = await withTenant(tenantOf(req), async (tx) => [
      await tx.orderStatus.findMany({ orderBy: { sortOrder: "asc" } }),
      await tx.user.findMany({
        where: { deletedAt: null, isActive: true, role: { code: "MASTER" } },
        orderBy: { fullName: "asc" },
        select: { id: true, fullName: true },
      }),
      // Прайс едет вместе со справочниками, чтобы подсказки в карточке
      // заказа работали мгновенно и не ходили на сервер на каждую букву.
      await tx.service.findMany({ orderBy: { name: "asc" } }),
      // Кнопки бланка — свои у каждой мастерской и по частоте. Порядок
      // считается здесь, при открытии бланка, и до его закрытия не меняется:
      // кнопка, уехавшая из-под пальца, хуже, чем никакой сортировки.
      await listQuickPicks(tx, "completeness"),
      await listQuickPicks(tx, "appearance"),
      await listQuickPicks(tx, "complaint"),
    ] as const);

    res.json({
      deviceKinds: DEVICE_KINDS,
      completeness: completeness.map((q) => ({ key: q.id, label: q.label, locked: q.locked })),
      appearance: appearance.map((q) => ({ key: q.id, label: q.label, locked: q.locked })),
      complaint: complaint.map((q) => ({ key: q.id, label: q.label, locked: q.locked })),
      orderKinds: ORDER_KINDS,
      statuses: statuses.map((s) => ({
        id: s.id,
        name: s.name,
        group: s.group,
        color: s.color,
        isInitial: s.isInitial,
      })),
      masters,
      services: services.map((s) => ({
        id: s.id,
        name: s.name,
        price: Number(s.price),
        note: s.note,
        isPinned: s.isPinned,
      })),
    });
  })
);
