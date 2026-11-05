import { Prisma } from "@prisma/client";
import express, { Router, type Request } from "express";
import { z } from "zod";
import { clientIp, writeAudit } from "../../lib/audit";
import { withTenant } from "../../lib/db";
import { ah, badRequest, forbidden, notFound } from "../../lib/errors";
import { PERMISSIONS } from "../../lib/permissions";
import { actorUserId, authenticate, currentTenantId, permissionsOf, requireTenant } from "../../middleware/auth";
import { enforceTenantStatus } from "../../middleware/tenantStatus";
import { cleanDesign, LIMITS, USES_OF, type DocUse, type Target } from "./blankModel";

/**
 * «Настройки → Редактор бланков» (05.11.2026): бланки, собранные на листе из
 * элементов. Сам лист рисует интерфейс (frontend/src/components/blank), сервер
 * хранит и чистит то, что прислали (blankModel.cleanDesign).
 *
 *   GET    /api/doc-layouts?for=order|sale  — список без содержимого (всем)
 *   GET    /api/doc-layouts/print?for=      — для страницы печати: бланки, заменяющие
 *                                             стандартные документы (целиком), и вкладки
 *   GET    /api/doc-layouts/:id             — бланк целиком
 *   POST   /api/doc-layouts                 — {name, target, use?, data}
 *   PUT    /api/doc-layouts/:id             — {name?, use?, data?}
 *   PUT    /api/doc-layouts/order           — {ids}
 *   DELETE /api/doc-layouts/:id
 *
 * use — какой документ бланк заменяет при печати (квитанция, акт, акт
 * доплаты, товарный чек); у документа он один: новый снимает метку со старого.
 */
export const layoutsRouter = Router();
// Бланк с картинками больше общего предела в 1 МБ — свой разбор тела, до общего.
export const layoutsJson = express.json({ limit: "6mb" });
layoutsRouter.use(authenticate, requireTenant, enforceTenantStatus);

const MAX_LAYOUTS = 40;
const tenantOf = (req: Request) => currentTenantId(req)!;
const manage = (req: Request) => {
  if (!permissionsOf(req).includes(PERMISSIONS.SETTINGS_MANAGE)) throw forbidden("Бланки настраивает владелец мастерской");
};

const targetOf = (v: unknown): Target => (v === "sale" ? "sale" : "order");
/** Какой документ бланк заменяет: пусто — никакой; чужой для этого вида бланка — отказ. */
const useOf = (target: Target, v: unknown): DocUse | null => {
  if (v === null || v === undefined || v === "") return null;
  if (USES_OF[target].includes(v as DocUse)) return v as DocUse;
  throw badRequest(target === "sale" ? "Бланк продажи заменяет только товарный чек" : "Бланк заказа заменяет квитанцию, акт или акт доплаты");
};

const listView = (r: { id: string; name: string; target: string; use: string | null; sortOrder: number; updatedAt: Date }) => ({
  id: r.id,
  name: r.name,
  target: targetOf(r.target),
  use: r.use,
  sortOrder: r.sortOrder,
  updatedAt: r.updatedAt,
});
const fullView = (r: Parameters<typeof listView>[0] & { data: Prisma.JsonValue }) => ({ ...listView(r), design: cleanDesign(r.data) });

const LIST_SELECT = { id: true, name: true, target: true, use: true, sortOrder: true, updatedAt: true } as const;

layoutsRouter.get(
  "/",
  ah(async (req, res) => {
    const target = req.query.for ? targetOf(req.query.for) : null;
    const rows = await withTenant(tenantOf(req), (tx) =>
      tx.docLayout.findMany({ where: target ? { target } : {}, select: LIST_SELECT, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] })
    );
    res.json({ items: rows.map(listView) });
  })
);

layoutsRouter.get(
  "/print",
  ah(async (req, res) => {
    const target = targetOf(req.query.for);
    const rows = await withTenant(tenantOf(req), (tx) =>
      tx.docLayout.findMany({ where: { target }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] })
    );
    const active: Record<string, ReturnType<typeof fullView>> = {};
    for (const r of rows) if (r.use && !active[r.use]) active[r.use] = fullView(r);
    res.json({ active, tabs: rows.filter((r) => !r.use).map(listView) });
  })
);

layoutsRouter.get(
  "/:id",
  ah(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const row = await withTenant(tenantOf(req), (tx) => tx.docLayout.findFirst({ where: { id } }));
    if (!row) throw notFound("Бланк не найден");
    res.json(fullView(row));
  })
);

const nameField = z.string().trim().min(1, "Назовите бланк").max(LIMITS.name, `Название — не длиннее ${LIMITS.name} знаков`);

/** Метку «печатать вместо» у документа может носить только один бланк. */
async function takeUse(tx: Prisma.TransactionClient, target: Target, use: DocUse | null, except: string | null) {
  if (!use) return;
  await tx.docLayout.updateMany({ where: { target, use, ...(except ? { id: { not: except } } : {}) }, data: { use: null } });
}

layoutsRouter.post(
  "/",
  ah(async (req, res) => {
    manage(req);
    const body = z.object({ name: nameField, target: z.enum(["order", "sale"]), use: z.string().nullable().optional(), data: z.unknown() }).parse(req.body);
    const design = cleanDesign(body.data);
    const tenantId = tenantOf(req);
    const use = useOf(body.target, body.use);
    const row = await withTenant(tenantId, async (tx) => {
      const count = await tx.docLayout.count();
      if (count >= MAX_LAYOUTS) throw badRequest(`Бланков уже ${MAX_LAYOUTS} — удалите ненужные`);
      const last = await tx.docLayout.findFirst({ orderBy: { sortOrder: "desc" }, select: { sortOrder: true } });
      await takeUse(tx, body.target, use, null);
      const r = await tx.docLayout.create({
        data: {
          tenantId,
          name: body.name,
          target: body.target,
          use,
          data: design as unknown as Prisma.InputJsonValue,
          sortOrder: (last?.sortOrder ?? 0) + 1,
          createdById: actorUserId(req),
        },
      });
      await writeAudit(tx, { tenantId, userId: actorUserId(req), entity: "DocLayout", entityId: r.id, action: "CREATE", diff: { name: r.name, target: r.target, use, els: design.els.length }, ip: clientIp(req) });
      return r;
    });
    res.status(201).json(fullView(row));
  })
);

layoutsRouter.put(
  "/order",
  ah(async (req, res) => {
    manage(req);
    const { ids } = z.object({ ids: z.array(z.string().uuid()).max(MAX_LAYOUTS) }).parse(req.body);
    await withTenant(tenantOf(req), async (tx) => {
      for (let i = 0; i < ids.length; i++) await tx.docLayout.updateMany({ where: { id: ids[i] }, data: { sortOrder: i + 1 } });
    });
    res.json({ ok: true });
  })
);

layoutsRouter.put(
  "/:id",
  ah(async (req, res) => {
    manage(req);
    const id = z.string().uuid().parse(req.params.id);
    const body = z.object({ name: nameField.optional(), use: z.string().nullable().optional(), data: z.unknown().optional() }).parse(req.body);
    const tenantId = tenantOf(req);
    const row = await withTenant(tenantId, async (tx) => {
      const cur = await tx.docLayout.findFirst({ where: { id } });
      if (!cur) throw notFound("Бланк не найден");
      const target = targetOf(cur.target);
      const data: Prisma.DocLayoutUpdateInput = {};
      const diff: Record<string, unknown> = {};
      if (body.name !== undefined && body.name !== cur.name) {
        data.name = body.name;
        diff.name = { from: cur.name, to: body.name };
      }
      if (body.use !== undefined) {
        const use = useOf(target, body.use);
        if (use !== cur.use) {
          await takeUse(tx, target, use, id);
          data.use = use;
          diff.use = { from: cur.use, to: use };
        }
      }
      if (body.data !== undefined) {
        const design = cleanDesign(body.data);
        data.data = design as unknown as Prisma.InputJsonValue;
        diff.els = design.els.length;
      }
      const r = await tx.docLayout.update({ where: { id }, data });
      if (Object.keys(diff).length) await writeAudit(tx, { tenantId, userId: actorUserId(req), entity: "DocLayout", entityId: id, action: "UPDATE", diff, ip: clientIp(req) });
      return r;
    });
    res.json(fullView(row));
  })
);

layoutsRouter.delete(
  "/:id",
  ah(async (req, res) => {
    manage(req);
    const id = z.string().uuid().parse(req.params.id);
    const tenantId = tenantOf(req);
    await withTenant(tenantId, async (tx) => {
      const cur = await tx.docLayout.findFirst({ where: { id }, select: { id: true, name: true } });
      if (!cur) throw notFound("Бланк не найден");
      await tx.docLayout.delete({ where: { id } });
      await writeAudit(tx, { tenantId, userId: actorUserId(req), entity: "DocLayout", entityId: id, action: "DELETE", diff: { name: cur.name }, ip: clientIp(req) });
    });
    res.json({ ok: true });
  })
);
