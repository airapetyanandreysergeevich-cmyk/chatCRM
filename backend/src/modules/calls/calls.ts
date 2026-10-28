import { Prisma } from "@prisma/client";
import { withPlatform, withTenant } from "../../lib/db";
import { notifyTenant } from "../../lib/notify";
import { removeFile, signedUrl } from "../../lib/storage";
import { maskPhone, normalizePhone } from "../sms/sms";
import { formatPhone } from "../../lib/phone";

/**
 * Звонки клиентов (Андрей, 28.10.2026): «запись разговоров с клиентами и
 * прикреплять к текущему заказу клиента с этим номером».
 *
 * Записывает не наше приложение — с Android 10 обычные приложения звук
 * разговора не получают. Записывает встроенная «звонилка» телефона (Samsung,
 * Xiaomi, Honor, Realme…), а «FineCRM Телефон» находит её файл, берёт из
 * журнала звонков номер, время и длительность и присылает сюда.
 *
 * Что куда:
 *   номер есть у нас в клиентах? нет → ничего не храним (личные звонки);
 *   да → у клиента заказ в работе → к нему (самому свежему);
 *        заказа в работе нет → к карточке клиента.
 * Запись — вложение в том же хранилище, что и фотографии: в локальной версии
 * она лежит рядом с базой и сама попадает в резервные копии.
 */

export const CALLS_KIND = "calls";
export const KEEP_DAYS = [90, 365, 0] as const;

export interface CallSettings {
  enabled: boolean;
  /** Присылать записи разговоров (а не только сам звонок). */
  audio: boolean;
  /** Пропущенные — в историю и оповещением. */
  missed: boolean;
  /** Сколько дней хранить записи; 0 — всегда. Сам звонок в истории остаётся. */
  keepDays: number;
}

export const DEFAULT_CALL_SETTINGS: CallSettings = { enabled: false, audio: true, missed: true, keepDays: 365 };

export function readCallSettings(row: { enabled: boolean; config: unknown } | null): CallSettings {
  const c = (row?.config ?? {}) as Record<string, unknown>;
  return {
    enabled: !!row?.enabled,
    audio: typeof c.audio === "boolean" ? c.audio : DEFAULT_CALL_SETTINGS.audio,
    missed: typeof c.missed === "boolean" ? c.missed : DEFAULT_CALL_SETTINGS.missed,
    keepDays: typeof c.keepDays === "number" && (KEEP_DAYS as readonly number[]).includes(c.keepDays) ? c.keepDays : DEFAULT_CALL_SETTINGS.keepDays,
  };
}

export async function loadCallSettings(tx: Prisma.TransactionClient): Promise<CallSettings> {
  return readCallSettings(await tx.integration.findFirst({ where: { kind: CALLS_KIND } }));
}

/** Последние 10 цифр — так сличаем «8 921…», «+7 921…» и «921…». */
export const tail10 = (raw: string | null | undefined) => (raw ?? "").replace(/\D/g, "").slice(-10);

/**
 * Клиенты с этим номером (основным или вторым). Номер в карточке записан как
 * угодно — «+7 900 111-22-33», «89001112233», — поэтому сравниваем цифры.
 */
export async function customersByPhone(tx: Prisma.TransactionClient, number: string): Promise<string[]> {
  const key = tail10(number);
  if (key.length < 10) return [];
  // Хвост номера считает сама база (Customer.phoneTail) — «89…» и «+7 9…» одно.
  const rows = await tx.customer.findMany({
    where: { deletedAt: null, OR: [{ phoneTail: key }, { phone2Tail: key }] },
    select: { id: true },
    take: 20,
  });
  return rows.map((r) => r.id);
}

/**
 * Куда положить звонок: самый свежий заказ этих клиентов, который ещё в
 * работе (не выдан, не удалён). Нет такого — только клиент: из нескольких
 * клиентов с одним номером — тот, у кого последний заказ.
 */
export async function placeCall(
  tx: Prisma.TransactionClient,
  customerIds: string[]
): Promise<{ customerId: string; orderId: string | null; assignedMasterId: string | null; orderNumber: string | null }> {
  const active = await tx.order.findFirst({
    where: { customerId: { in: customerIds }, deletedAt: null, issuedAt: null, status: { group: { in: ["NEW", "WAITING", "IN_PROGRESS", "DONE"] } } },
    orderBy: { acceptedAt: "desc" },
    select: { id: true, number: true, customerId: true, assignedMasterId: true },
  });
  if (active) return { customerId: active.customerId, orderId: active.id, assignedMasterId: active.assignedMasterId, orderNumber: active.number };
  const last = await tx.order.findFirst({
    where: { customerId: { in: customerIds }, deletedAt: null },
    orderBy: { acceptedAt: "desc" },
    select: { customerId: true },
  });
  return { customerId: last?.customerId ?? customerIds[0], orderId: null, assignedMasterId: null, orderNumber: null };
}

export type Direction = "IN" | "OUT" | "MISSED" | "REJECTED";

export interface ReportedCall {
  key: string;
  direction: Direction;
  number: string;
  startedAt: Date;
  durationSec: number;
}

/**
 * Телефон сообщил о звонке. Чужой номер — { matched: false }, и ничего не
 * хранится. Повтор (тот же ключ) — тот же звонок, а не второй.
 */
export async function reportCall(
  tenantId: string,
  phoneId: string,
  call: ReportedCall
): Promise<{ matched: boolean; id?: string; wantAudio?: boolean; off?: boolean }> {
  const number = normalizePhone(call.number);
  if (!number) return { matched: false };
  const result = await withTenant(tenantId, async (tx) => {
    const s = await loadCallSettings(tx);
    if (!s.enabled) return { out: { matched: false, off: true } as const };
    if ((call.direction === "MISSED" || call.direction === "REJECTED") && !s.missed) return { out: { matched: false } as const };
    const ids = await customersByPhone(tx, number);
    if (!ids.length) return { out: { matched: false } as const };

    const existing = await tx.callRecord.findFirst({ where: { dedupeKey: call.key }, select: { id: true, attachmentId: true, direction: true, durationSec: true } });
    if (existing) {
      return { out: { matched: true, id: existing.id, wantAudio: s.audio && !existing.attachmentId && existing.durationSec > 0 && existing.direction !== "MISSED" } };
    }
    const place = await placeCall(tx, ids);
    const customer = await tx.customer.findFirst({ where: { id: place.customerId }, select: { name: true } });
    const row = await tx.callRecord.create({
      data: {
        tenantId,
        phoneId,
        direction: call.direction,
        number,
        startedAt: call.startedAt,
        durationSec: Math.max(0, Math.round(call.durationSec)),
        customerId: place.customerId,
        orderId: place.orderId,
        dedupeKey: call.key,
      },
      select: { id: true },
    });
    const missed = call.direction === "MISSED";
    return {
      out: { matched: true, id: row.id, wantAudio: s.audio && !missed && call.direction !== "REJECTED" && call.durationSec > 0 },
      notice: missed ? { place, name: customer?.name ?? number, id: row.id } : null,
    };
  });

  // Пропущенный от клиента — тем, кому перезванивать: мастеру заказа и ролям из матрицы.
  if ("notice" in result && result.notice) {
    const { place, name } = result.notice;
    void notifyTenant(tenantId, {
      event: "call.missed",
      title: `Пропущенный звонок — ${name}`,
      body: place.orderNumber ? `Заказ ${place.orderNumber}. Перезвоните клиенту.` : "Заказа в работе нет. Перезвоните клиенту.",
      url: place.orderId ? `/orders/${place.orderId}` : `/clients/${place.customerId}`,
      targetUserId: place.assignedMasterId,
      payload: { callId: result.notice.id, orderId: place.orderId, customerId: place.customerId },
    });
  }
  return result.out;
}

export const callSelect = {
  id: true,
  direction: true,
  number: true,
  startedAt: true,
  durationSec: true,
  orderId: true,
  customerId: true,
  movedById: true,
  createdAt: true,
  order: { select: { id: true, number: true } },
  customer: { select: { id: true, name: true } },
  phone: { select: { name: true } },
  attachment: { select: { objectKey: true, sizeBytes: true, mimeType: true } },
} as const;

type CallRow = Prisma.CallRecordGetPayload<{ select: typeof callSelect }>;

/**
 * Звонок для экрана. Номер — только тем, кто видит контакты клиентов; запись —
 * только тем, у кого право «Слушает записи звонков». Сам факт звонка, время
 * и длительность видят все, кому виден заказ.
 */
export async function callView(c: CallRow, opts: { contacts: boolean; listen: boolean }) {
  return {
    id: c.id,
    direction: c.direction,
    number: opts.contacts ? formatPhone(c.number) : maskPhone(c.number),
    startedAt: c.startedAt,
    durationSec: c.durationSec,
    order: c.order,
    customer: opts.contacts ? c.customer : c.customer ? { id: c.customer.id, name: null } : null,
    phone: c.phone?.name ?? null,
    moved: !!c.movedById,
    hasAudio: !!c.attachment,
    audio: opts.listen && c.attachment ? await signedUrl(c.attachment.objectKey, 3600) : null,
    audioBytes: c.attachment?.sizeBytes ?? null,
  };
}

/**
 * Срок хранения записей. Раз в час: записи старше срока удаляются из
 * хранилища, сам звонок в истории остаётся («запись удалена по сроку»).
 */
export async function trimOldRecordings(): Promise<number> {
  let removed = 0;
  try {
    const tenants = await withPlatform((tx) =>
      tx.integration.findMany({ where: { kind: CALLS_KIND }, select: { tenantId: true, enabled: true, config: true } })
    );
    for (const t of tenants) {
      const s = readCallSettings(t);
      if (!s.keepDays) continue;
      const before = new Date(Date.now() - s.keepDays * 86_400_000);
      const old = await withTenant(t.tenantId, (tx) =>
        tx.callRecord.findMany({
          where: { attachmentId: { not: null }, startedAt: { lt: before } },
          select: { id: true, attachment: { select: { id: true, objectKey: true } } },
          take: 500,
        })
      );
      for (const c of old) {
        if (!c.attachment) continue;
        await removeFile(c.attachment.objectKey).catch(() => undefined);
        await withTenant(t.tenantId, async (tx) => {
          await tx.callRecord.update({ where: { id: c.id }, data: { attachmentId: null } });
          await tx.attachment.deleteMany({ where: { id: c.attachment!.id } });
        });
        removed += 1;
      }
    }
  } catch (err) {
    console.error("Записи звонков: не удалось убрать старые", err);
  }
  return removed;
}

export function startCallsCleanup(): void {
  const hour = 60 * 60 * 1000;
  setTimeout(() => void trimOldRecordings(), 60_000).unref();
  setInterval(() => void trimOldRecordings(), hour).unref();
}
