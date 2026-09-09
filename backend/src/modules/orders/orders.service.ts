import type { Prisma } from "@prisma/client";
import type { Request } from "express";
import { forbidden } from "../../lib/errors";
import { PERMISSIONS } from "../../lib/permissions";
import { permissionsOf } from "../../middleware/auth";
import { signedUrl } from "../../lib/storage";

/** Prisma отдаёт Decimal объектом. Наружу отдаём число, чтобы фронтенду не разбирать. */
const num = (v: Prisma.Decimal | number | null | undefined): number | null =>
  v === null || v === undefined ? null : Number(v);

export const orderInclude = {
  status: { select: { id: true, name: true, group: true, color: true } },
  branch: { select: { id: true, name: true } },
  customer: {
    select: { id: true, name: true, phone: true, phone2: true, email: true, address: true, type: true },
  },
  device: { select: { id: true, kind: true, brand: true, model: true, serial: true } },
  acceptedBy: { select: { id: true, fullName: true } },
  assignedMaster: { select: { id: true, fullName: true } },
  issuedBy: { select: { id: true, fullName: true } },
  works: { orderBy: { createdAt: "asc" } },
  parts: { orderBy: { createdAt: "asc" } },
  attachments: { orderBy: { createdAt: "asc" } },
} satisfies Prisma.OrderInclude;

export type OrderWithRelations = Prisma.OrderGetPayload<{ include: typeof orderInclude }>;

const has = (req: Request, code: string) => permissionsOf(req).includes(code);

export const seesAllOrders = (req: Request) => has(req, PERMISSIONS.ORDERS_VIEW_ALL);
export const seesCustomerContacts = (req: Request) => has(req, PERMISSIONS.ORDERS_CUSTOMER_CONTACTS);
/** Себестоимость, наценка и итог для клиента. Мастеру они не нужны и не показываются. */
export const seesMoney = (req: Request) => has(req, PERMISSIONS.ORDERS_COST) || seesAllOrders(req);

/**
 * Мастер работает только со своими заказами. Проверка стоит на сервере,
 * а не в интерфейсе: спрятанная кнопка не защищает, если знать адрес.
 */
export function assertOrderAccess(req: Request, order: { assignedMasterId: string | null }): void {
  if (seesAllOrders(req)) return;
  if (has(req, PERMISSIONS.ORDERS_VIEW_ASSIGNED)) {
    const me = req.auth?.kind === "tenant" ? req.auth.userId : null;
    if (me && order.assignedMasterId === me) return;
  }
  if (has(req, PERMISSIONS.ORDERS_VIEW_DELIVERY)) return;
  throw forbidden("Этот заказ вам не назначен");
}

/** Короткая выжимка прошлого ремонта — то, ради чего мастер открывает гарантийный возврат. */
export async function previousRepairSummary(
  tx: Prisma.TransactionClient,
  parentOrderId: string
): Promise<Record<string, unknown> | null> {
  const parent = await tx.order.findFirst({
    where: { id: parentOrderId },
    include: {
      works: { select: { name: true, qty: true } },
      parts: { select: { name: true, qty: true } },
      assignedMaster: { select: { fullName: true } },
    },
  });
  if (!parent) return null;
  return {
    id: parent.id,
    number: parent.number,
    completedAt: parent.completedAt,
    issuedAt: parent.issuedAt,
    diagnosis: parent.diagnosis,
    masterComment: parent.masterComment,
    recommendation: parent.recommendation,
    warrantyUntil: parent.warrantyUntil,
    master: parent.assignedMaster?.fullName ?? null,
    works: parent.works.map((w) => ({ name: w.name, qty: num(w.qty) })),
    parts: parent.parts.map((p) => ({ name: p.name, qty: num(p.qty) })),
  };
}

interface ProjectOptions {
  contacts: boolean;
  money: boolean;
  previousRepair?: Record<string, unknown> | null;
}

/**
 * Одна проекция на все ответы по заказу. Что скрыто — скрыто на сервере:
 * поле просто не попадает в JSON, а не прячется стилями.
 */
export function projectOrder(order: OrderWithRelations, opts: ProjectOptions) {
  const base = {
    id: order.id,
    number: order.number,
    kind: order.kind,
    isUrgent: order.isUrgent,
    status: order.status,
    branch: order.branch,

    acceptedAt: order.acceptedAt,
    dueAt: order.dueAt,
    completedAt: order.completedAt,
    issuedAt: order.issuedAt,

    device: order.device,
    complaint: order.complaint,
    receptionNote: order.receptionNote,
    devicePasscode: order.devicePasscode,
    completeness: order.completeness,
    appearance: order.appearance,
    appearanceNote: order.appearanceNote,
    hasOpenTraces: order.hasOpenTraces,
    hasWaterDamage: order.hasWaterDamage,
    storageLocation: order.storageLocation,
    approvedLimit: num(order.approvedLimit),

    diagnosis: order.diagnosis,
    masterComment: order.masterComment,
    internalComment: order.internalComment,
    recommendation: order.recommendation,
    warrantyDays: order.warrantyDays,
    warrantyUntil: order.warrantyUntil,

    acceptedBy: order.acceptedBy,
    assignedMaster: order.assignedMaster,
    issuedBy: order.issuedBy,

    works: order.works.map((w) => ({
      id: w.id,
      name: w.name,
      qty: num(w.qty),
      price: num(w.price),
      masterId: w.masterId,
    })),
    parts: order.parts.map((p) => ({
      id: p.id,
      name: p.name,
      qty: num(p.qty),
      price: num(p.price),
      source: p.source,
      // Себестоимость — только тем, кто видит деньги.
      ...(opts.money ? { cost: num(p.cost) } : {}),
    })),
    attachments: order.attachments.map((a) => ({
      id: a.id,
      kind: a.kind,
      fileName: a.fileName,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
      createdAt: a.createdAt,
    })),

    totalWork: num(order.totalWork),
    totalParts: num(order.totalParts),
    previousRepair: opts.previousRepair ?? null,
    parentOrderId: order.parentOrderId,
  };

  return {
    ...base,
    customer: opts.contacts
      ? order.customer
      : // Мастеру имя клиента не нужно для работы, а лишний доступ к базе контактов —
        // это то, что уносят при увольнении.
        { id: order.customer.id, type: order.customer.type },
    ...(opts.money
      ? {
          estimatedCost: num(order.estimatedCost),
          prepayment: num(order.prepayment),
          discount: num(order.discount),
          total: num(order.total),
        }
      : {}),
  };
}

/** Пересчёт сумм после любой правки работ или запчастей — источник истины один. */
export async function recalcTotals(tx: Prisma.TransactionClient, orderId: string): Promise<void> {
  const order = await tx.order.findFirst({
    where: { id: orderId },
    include: { works: true, parts: true },
  });
  if (!order) return;

  const sum = (rows: Array<{ qty: Prisma.Decimal; price: Prisma.Decimal }>) =>
    rows.reduce((acc, r) => acc + Number(r.qty) * Number(r.price), 0);

  const totalWork = sum(order.works);
  const totalParts = sum(order.parts);
  const discount = Number(order.discount);

  await tx.order.update({
    where: { id: orderId },
    data: {
      totalWork,
      totalParts,
      total: Math.max(0, totalWork + totalParts - discount),
    },
  });
}

/**
 * Не вышла ли сумма за то, что согласовал клиент.
 *
 * Вызывать сразу после recalcTotals. Возвращает данные для оповещения ровно
 * один раз на заказ: мастер правит список работ по многу раз, и каждое
 * сохранение не должно приносить приёмщику новое сообщение об одном и том же.
 */
export async function limitExceeded(
  tx: Prisma.TransactionClient,
  orderId: string
): Promise<{ number: string; total: number; limit: number } | null> {
  const order = await tx.order.findFirst({
    where: { id: orderId },
    select: { number: true, approvedLimit: true, total: true },
  });
  if (!order?.approvedLimit) return null;

  const total = Number(order.total ?? 0);
  const limit = Number(order.approvedLimit);
  if (total <= limit) return null;

  const already = await tx.notification.findFirst({
    where: { type: "order.limit_exceeded", payload: { path: ["orderId"], equals: orderId } },
    select: { id: true },
  });
  if (already) return null;

  return { number: order.number, total, limit };
}

/** Подписанные ссылки на вложения выдаются по одной и живут 15 минут. */
export async function attachmentUrls(
  attachments: Array<{ id: string; objectKey: string }>
): Promise<Record<string, string>> {
  const pairs = await Promise.all(
    attachments.map(async (a) => [a.id, await signedUrl(a.objectKey)] as const)
  );
  return Object.fromEntries(pairs);
}
