import { Router, type Request } from "express";
import { withTenant } from "../../lib/db";
import {
  APPEARANCE_ITEMS,
  COMPLETENESS_ITEMS,
  DEVICE_KINDS,
  ORDER_KINDS,
} from "../../lib/dictionaries";
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
    const [statuses, masters] = await withTenant(tenantOf(req), async (tx) => [
      await tx.orderStatus.findMany({ orderBy: { sortOrder: "asc" } }),
      await tx.user.findMany({
        where: { deletedAt: null, isActive: true, role: { code: "MASTER" } },
        orderBy: { fullName: "asc" },
        select: { id: true, fullName: true },
      }),
    ]);

    res.json({
      deviceKinds: DEVICE_KINDS,
      completeness: COMPLETENESS_ITEMS,
      appearance: APPEARANCE_ITEMS,
      orderKinds: ORDER_KINDS,
      statuses: statuses.map((s) => ({
        id: s.id,
        name: s.name,
        group: s.group,
        color: s.color,
        isInitial: s.isInitial,
      })),
      masters,
    });
  })
);
