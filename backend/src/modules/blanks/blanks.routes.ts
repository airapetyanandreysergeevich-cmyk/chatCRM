import type { Prisma } from "@prisma/client";
import express, { Router, type Request } from "express";
import { z } from "zod";
import { clientIp, writeAudit } from "../../lib/audit";
import { withTenant } from "../../lib/db";
import { ah, badRequest, forbidden, notFound } from "../../lib/errors";
import { orderPayments } from "../../lib/payment";
import { PERMISSIONS } from "../../lib/permissions";
import { actorUserId, authenticate, currentTenantId, permissionsOf, requireTenant } from "../../middleware/auth";
import { enforceTenantStatus } from "../../middleware/tenantStatus";
import { assertOrderAccess, orderInclude, projectOrder, seesCustomerContacts, seesMoney } from "../orders/orders.service";
import { example, fill, scan, toBuffer, toHtml, type FillData } from "./excel";
import { listsOf, marksOf, norm, ROW_NO, type Target } from "./marks";
import { rublesWords } from "./words";

/**
 * Свои бланки из Excel (03.11.2026, просьба коллеги Андрея): мастерская
 * загружает .xlsx с метками {номер}, {клиент}…, а в заказе (или продаже)
 * печатает его заполненным — из браузера или скачивает .xlsx.
 *
 *   GET    /api/blanks                    — список (всем: меню печати)
 *   GET    /api/blanks/marks              — метки с пояснениями (для настроек)
 *   GET    /api/blanks/example.xlsx?for=  — образец с метками
 *   POST   /api/blanks?name=&for=         — загрузить (тело — файл .xlsx)
 *   PATCH  /api/blanks/:id                — название, для чего, порядок
 *   PUT    /api/blanks/:id/file           — заменить файл
 *   DELETE /api/blanks/:id
 *   GET    /api/blanks/:id/file           — исходный шаблон
 *   GET    /api/blanks/:id/render?orderId=|saleId=  — лист для печати (HTML)
 *   GET    /api/blanks/:id/fill?orderId=|saleId=    — заполненный .xlsx
 */
export const blanksRouter = Router();
blanksRouter.use(authenticate, requireTenant, enforceTenantStatus);

const tenantOf = (req: Request) => currentTenantId(req)!;
const has = (req: Request, p: string) => permissionsOf(req).includes(p);
const manage = (req: Request) => {
  if (!has(req, PERMISSIONS.SETTINGS_MANAGE)) throw forbidden("Бланки настраивает владелец мастерской");
};

const MAX_BYTES = 3 * 1024 * 1024;
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const rawXlsx = express.raw({ type: () => true, limit: MAX_BYTES });

const targetField = z.enum(["order", "sale"]).catch("order");

const listView = (t: { id: string; name: string; target: string; fileName: string; marks: Prisma.JsonValue; updatedAt: Date; data?: Buffer | Uint8Array }) => ({
  id: t.id,
  name: t.name,
  target: t.target === "sale" ? "sale" : "order",
  fileName: t.fileName,
  marks: t.marks,
  updatedAt: t.updatedAt,
});

blanksRouter.get(
  "/",
  ah(async (req, res) => {
    const target = req.query.for ? targetField.parse(req.query.for) : null;
    const rows = await withTenant(tenantOf(req), (tx) =>
      tx.printTemplate.findMany({
        where: target ? { target } : {},
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        select: { id: true, name: true, target: true, fileName: true, marks: true, updatedAt: true },
      })
    );
    res.json({ items: rows.map(listView), canManage: has(req, PERMISSIONS.SETTINGS_MANAGE) });
  })
);

blanksRouter.get(
  "/marks",
  ah(async (_req, res) => {
    const one = (t: Target) => ({
      marks: marksOf(t),
      lists: listsOf(t).map((l) => ({ key: l.key, title: l.title, fields: l.fields })),
      rowNo: ROW_NO,
    });
    res.json({ order: one("order"), sale: one("sale") });
  })
);

blanksRouter.get(
  "/example.xlsx",
  ah(async (req, res) => {
    const target = targetField.parse(req.query.for);
    const buf = await example(target);
    res.setHeader("Content-Type", XLSX);
    const name = target === "sale" ? "Образец товарного чека.xlsx" : "Образец бланка FineCRM.xlsx";
    res.setHeader("Content-Disposition", `attachment; filename="blank.xlsx"; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.send(buf);
  })
);

function fileOf(req: Request): Buffer {
  const body = req.body as unknown;
  if (!Buffer.isBuffer(body) || body.length === 0) throw badRequest("Выберите файл .xlsx");
  if (body.length > MAX_BYTES) throw badRequest("Файл больше 3 МБ — уменьшите картинки в нём");
  // .xlsx — это zip: «PK» в начале.
  if (body[0] !== 0x50 || body[1] !== 0x4b) throw badRequest("Это не .xlsx. В Excel: «Файл → Сохранить как → Книга Excel (*.xlsx)»");
  return body;
}

async function scanned(buf: Buffer, target: Target) {
  try {
    return await scan(buf, target);
  } catch (err) {
    throw badRequest((err as Error).message);
  }
}

blanksRouter.post(
  "/",
  rawXlsx,
  ah(async (req, res) => {
    manage(req);
    const q = z
      .object({
        name: z.string().trim().min(1, "Назовите бланк").max(60),
        for: targetField,
        fileName: z.string().trim().max(200).optional(),
      })
      .parse(req.query);
    const buf = fileOf(req);
    const marks = await scanned(buf, q.for);
    const tenantId = tenantOf(req);
    const row = await withTenant(tenantId, async (tx) => {
      const n = await tx.printTemplate.count();
      if (n >= 30) throw badRequest("Не больше 30 своих бланков");
      const t = await tx.printTemplate.create({
        data: {
          tenantId,
          name: q.name,
          target: q.for,
          fileName: q.fileName || `${q.name}.xlsx`,
          data: new Uint8Array(buf),
          marks: marks as unknown as Prisma.InputJsonValue,
          sortOrder: n + 1,
          createdById: actorUserId(req),
        },
      });
      await writeAudit(tx, { tenantId, userId: actorUserId(req), entity: "PrintTemplate", entityId: t.id, action: "CREATE", diff: { name: q.name, for: q.for, bytes: buf.length }, ip: clientIp(req) });
      return t;
    });
    res.status(201).json(listView(row));
  })
);

blanksRouter.put(
  "/:id/file",
  rawXlsx,
  ah(async (req, res) => {
    manage(req);
    const fileName = z.string().trim().max(200).optional().parse(req.query.fileName);
    const buf = fileOf(req);
    const tenantId = tenantOf(req);
    const row = await withTenant(tenantId, async (tx) => {
      const t = await tx.printTemplate.findFirst({ where: { id: req.params.id } });
      if (!t) throw notFound("Бланк не найден");
      const marks = await scanned(buf, t.target === "sale" ? "sale" : "order");
      const u = await tx.printTemplate.update({
        where: { id: t.id },
        data: { data: new Uint8Array(buf), marks: marks as unknown as Prisma.InputJsonValue, ...(fileName ? { fileName } : {}) },
      });
      await writeAudit(tx, { tenantId, userId: actorUserId(req), entity: "PrintTemplate", entityId: t.id, action: "UPDATE", diff: { file: true, bytes: buf.length }, ip: clientIp(req) });
      return u;
    });
    res.json(listView(row));
  })
);

blanksRouter.patch(
  "/:id",
  ah(async (req, res) => {
    manage(req);
    const body = z
      .object({ name: z.string().trim().min(1).max(60).optional(), for: z.enum(["order", "sale"]).optional(), sortOrder: z.number().int().min(0).max(1000).optional() })
      .parse(req.body);
    const tenantId = tenantOf(req);
    const row = await withTenant(tenantId, async (tx) => {
      const t = await tx.printTemplate.findFirst({ where: { id: req.params.id } });
      if (!t) throw notFound("Бланк не найден");
      // Сменили «для чего» — метки проверяем заново: у продажи их меньше.
      const marks = body.for && body.for !== t.target ? await scanned(Buffer.from(t.data), body.for) : undefined;
      return tx.printTemplate.update({
        where: { id: t.id },
        data: {
          ...(body.name ? { name: body.name } : {}),
          ...(body.for ? { target: body.for } : {}),
          ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
          ...(marks ? { marks: marks as unknown as Prisma.InputJsonValue } : {}),
        },
      });
    });
    res.json(listView(row));
  })
);

blanksRouter.delete(
  "/:id",
  ah(async (req, res) => {
    manage(req);
    const tenantId = tenantOf(req);
    await withTenant(tenantId, async (tx) => {
      const t = await tx.printTemplate.findFirst({ where: { id: req.params.id }, select: { id: true, name: true } });
      if (!t) throw notFound("Бланк не найден");
      await tx.printTemplate.delete({ where: { id: t.id } });
      await writeAudit(tx, { tenantId, userId: actorUserId(req), entity: "PrintTemplate", entityId: t.id, action: "DELETE", diff: { name: t.name }, ip: clientIp(req) });
    });
    res.json({ ok: true });
  })
);

blanksRouter.get(
  "/:id/file",
  ah(async (req, res) => {
    const t = await withTenant(tenantOf(req), (tx) => tx.printTemplate.findFirst({ where: { id: req.params.id } }));
    if (!t) throw notFound("Бланк не найден");
    res.setHeader("Content-Type", XLSX);
    res.setHeader("Content-Disposition", `attachment; filename="blank.xlsx"; filename*=UTF-8''${encodeURIComponent(t.fileName)}`);
    res.send(Buffer.from(t.data));
  })
);

// ------------------------------------------------------------------ данные для меток

const dateRu = (d: Date | string | null | undefined, tz: string) =>
  d ? new Intl.DateTimeFormat("ru-RU", { timeZone: tz, day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(d)) : "";
const qtyText = (n: number) => String(Math.round(n * 1000) / 1000).replace(".", ",");

async function workshopOf(tx: Prisma.TransactionClient, tenantId: string) {
  const t = await tx.tenant.findUnique({ where: { id: tenantId }, select: { name: true, timezone: true, settings: true } });
  const s = (t?.settings ?? {}) as Record<string, unknown>;
  const print = (s.print ?? {}) as Record<string, unknown>;
  const branding = (s.branding ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : "");
  return {
    name: str(print.name) || t?.name || "",
    requisites: "requisites" in print ? str(print.requisites) : str(branding.printNote),
    tz: t?.timezone ?? "Europe/Moscow",
  };
}

async function orderData(req: Request, tx: Prisma.TransactionClient, tenantId: string, orderId: string): Promise<FillData> {
  const order = await tx.order.findFirst({ where: { id: orderId, deletedAt: null }, include: orderInclude });
  if (!order) throw notFound("Заказ не найден");
  assertOrderAccess(req, order);
  const money = seesMoney(req);
  const o = projectOrder(order, { contacts: seesCustomerContacts(req), money }) as ReturnType<typeof projectOrder> & {
    total?: number;
    prepayment?: number;
    discount?: number;
    workDiscount?: number | null;
  };
  const w = await workshopOf(tx, tenantId);
  const payments = money ? await orderPayments(tx, order.id) : [];
  const paid = payments.reduce((a, p) => a + p.amount, 0);
  const total = money ? Number(o.total ?? 0) : 0;
  const worksWarranty = Math.max(0, ...o.works.map((x) => x.warrantyDays ?? 0)) || null;
  const warranty = o.warrantyDays || worksWarranty;
  const base = order.completedAt ?? order.issuedAt;
  const until = order.warrantyUntil ?? (warranty && base ? new Date(base.getTime() + warranty * 86_400_000) : null);
  const acts = [...new Set(payments.map((p) => p.act))];
  const c = o.customer as { name?: string; phone?: string; phone2?: string | null; email?: string | null; address?: string | null };
  const dev = order.device;
  const m = (n: number) => (money ? n : "");
  const values: Record<string, string | number> = {
    номер: order.number,
    дата: dateRu(new Date(), w.tz),
    "дата приёма": dateRu(order.acceptedAt, w.tz),
    "дата готовности": dateRu(order.completedAt, w.tz),
    "дата выдачи": dateRu(order.issuedAt, w.tz),
    срок: dateRu(order.dueAt, w.tz),
    статус: order.status?.name ?? "",
    клиент: c.name ?? "",
    телефон: c.phone ?? "",
    "телефон 2": c.phone2 ?? "",
    почта: c.email ?? "",
    адрес: c.address ?? "",
    "номер аутсорса": order.outsourceNumber ?? "",
    устройство: [dev?.kind, dev?.brand, dev?.model].filter(Boolean).join(" "),
    "тип техники": dev?.kind ?? "",
    бренд: dev?.brand ?? "",
    модель: dev?.model ?? "",
    серийный: dev?.serial ?? "",
    пароль: o.devicePasscode ?? "",
    комплектность: o.completeness.join(", "),
    состояние: [...o.appearance, o.appearanceNote].filter(Boolean).join(", "),
    неисправность: order.complaint ?? "",
    диагноз: order.diagnosis ?? "",
    рекомендации: order.recommendation ?? "",
    мастер: order.assignedMaster?.fullName ?? "",
    принял: order.acceptedBy?.fullName ?? "",
    выдал: order.issuedBy?.fullName ?? "",
    "работы итого": m(Number(order.totalWork ?? 0)),
    "запчасти итого": m(Number(order.totalParts ?? 0)),
    скидка: m(Number(o.discount ?? 0) + Number(o.workDiscount ?? 0)),
    итого: m(total),
    "итого прописью": money ? rublesWords(total) : "",
    предоплата: m(Number(o.prepayment ?? 0)),
    оплачено: m(Math.round(paid * 100) / 100),
    "к оплате": m(Math.max(0, Math.round((total - paid) * 100) / 100)),
    оплата: acts.length ? acts.map((a) => (a === "CASH" ? "наличный расчёт" : "безналичный расчёт")).join(", ") : order.paymentMethod === "DEBT" ? "в долг" : "",
    гарантия: warranty ? String(warranty) : "",
    "гарантия до": dateRu(until, w.tz),
    мастерская: w.name,
    реквизиты: w.requisites,
  };
  const nq = (v: number | null | undefined) => Number(v ?? 0);
  const works = o.works.map((x) => ({
    работа: x.name,
    "работа кол-во": qtyText(nq(x.qty)),
    "работа цена": m(nq(x.price)),
    "работа сумма": m(Math.round(nq(x.qty) * nq(x.price) * 100) / 100),
    "работа гарантия": x.warrantyDays ? String(x.warrantyDays) : "",
  }));
  const parts = o.parts.map((x) => ({
    запчасть: x.name,
    "запчасть кол-во": qtyText(nq(x.qty)),
    "запчасть цена": m(nq(x.price)),
    "запчасть сумма": m(Math.round(nq(x.qty) * nq(x.price) * 100) / 100),
  }));
  const lines = [...o.works, ...o.parts].map((x) => ({
    строка: x.name,
    "строка кол-во": qtyText(nq(x.qty)),
    "строка цена": m(nq(x.price)),
    "строка сумма": m(Math.round(nq(x.qty) * nq(x.price) * 100) / 100),
  }));
  return { values, lists: { работа: works, запчасть: parts, строка: lines }, money: moneySet("order") };
}

const moneySet = (t: Target) =>
  new Set([...marksOf(t).filter((x) => x.money), ...listsOf(t).flatMap((l) => l.fields.filter((f) => f.money))].map((x) => norm(x.key)));

async function saleData(req: Request, tx: Prisma.TransactionClient, tenantId: string, saleId: string): Promise<FillData> {
  if (!has(req, PERMISSIONS.STOCK_SELL) && !has(req, PERMISSIONS.FINANCE_VIEW)) throw forbidden();
  const s = await tx.sale.findFirst({
    where: { id: saleId },
    include: {
      items: { orderBy: { id: "asc" } },
      customer: { select: { name: true, phone: true } },
      soldBy: { select: { fullName: true } },
      transactions: { where: { direction: "IN", deletedAt: null }, select: { method: true, payMethod: { select: { actKind: true } } } },
    },
  });
  if (!s) throw notFound("Продажа не найдена");
  const w = await workshopOf(tx, tenantId);
  const act = s.transactions[0]?.payMethod?.actKind ?? (s.payment === "CASH" ? "CASH" : "CARD");
  const total = Number(s.total);
  const values: Record<string, string | number> = {
    номер: s.number,
    дата: dateRu(s.createdAt, w.tz),
    клиент: s.customer?.name ?? "",
    телефон: has(req, PERMISSIONS.ORDERS_CUSTOMER_CONTACTS) ? (s.customer?.phone ?? "") : "",
    продавец: s.soldBy?.fullName ?? "",
    "сумма без скидки": Number(s.subtotal),
    скидка: Number(s.discount),
    итого: total,
    "итого прописью": rublesWords(total),
    оплата: act === "CASH" ? "наличный расчёт" : "безналичный расчёт",
    гарантия: s.warrantyDays ? String(s.warrantyDays) : "",
    "гарантия до": s.warrantyDays ? dateRu(new Date(s.createdAt.getTime() + s.warrantyDays * 86_400_000), w.tz) : "",
    примечание: s.note ?? "",
    мастерская: w.name,
    реквизиты: w.requisites,
  };
  const items = s.items.map((i) => ({
    товар: i.name,
    "товар артикул": i.sku ?? "",
    "товар кол-во": qtyText(Number(i.qty)),
    "товар цена": Number(i.price),
    "товар сумма": Math.round(Number(i.qty) * Number(i.price) * 100) / 100,
  }));
  return { values, lists: { товар: items }, money: moneySet("sale") };
}

async function filled(req: Request) {
  const q = z.object({ orderId: z.string().uuid().optional(), saleId: z.string().uuid().optional() }).parse(req.query);
  if (!q.orderId && !q.saleId) throw badRequest("Нужен заказ или продажа");
  const tenantId = tenantOf(req);
  return withTenant(tenantId, async (tx) => {
    const t = await tx.printTemplate.findFirst({ where: { id: req.params.id } });
    if (!t) throw notFound("Бланк не найден");
    const target: Target = t.target === "sale" ? "sale" : "order";
    if ((target === "sale") !== !!q.saleId) throw badRequest(target === "sale" ? "Этот бланк — для продажи со склада" : "Этот бланк — для заказа");
    const data = q.saleId ? await saleData(req, tx, tenantId, q.saleId) : await orderData(req, tx, tenantId, q.orderId!);
    try {
      const wb = await fill(Buffer.from(t.data), target, data);
      return { t, wb, number: String(data.values["номер"] ?? "") };
    } catch (err) {
      throw badRequest(`Бланк «${t.name}» не заполнился: ${(err as Error).message}`);
    }
  });
}

blanksRouter.get(
  "/:id/render",
  ah(async (req, res) => {
    const { t, wb } = await filled(req);
    res.json({ name: t.name, sheets: toHtml(wb) });
  })
);

blanksRouter.get(
  "/:id/fill",
  ah(async (req, res) => {
    const { t, wb, number } = await filled(req);
    const buf = await toBuffer(wb);
    const name = `${t.name} ${number}.xlsx`.replace(/[\\/:*?"<>|]+/g, " ");
    res.setHeader("Content-Type", XLSX);
    res.setHeader("Content-Disposition", `attachment; filename="blank.xlsx"; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.send(buf);
  })
);

