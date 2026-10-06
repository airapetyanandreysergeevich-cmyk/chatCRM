import { prisma, withTenant } from "./db";
import { env } from "./env";
import { AppError } from "./errors";

/**
 * Расход ресурсов облака — для панели собственника.
 *
 * Здесь только счётчики: сколько снимков шильдиков распознано, сколько байт
 * прошло через доступ из интернета, сколько места заняли фотографии. Что
 * именно мастерская распознавала и что лежит в её заказах, собственнику не
 * видно и не нужно.
 */

/** "2026-10" — месяц по московскому времени: так считает и собственник. */
export function monthKey(d = new Date()): string {
  const msk = new Date(d.getTime() + 3 * 60 * 60 * 1000);
  return `${msk.getUTCFullYear()}-${String(msk.getUTCMonth() + 1).padStart(2, "0")}`;
}

export const tenantSubject = (id: string) => `t:${id}`;
export const boxSubject = (id: string) => `b:${id}`;

/** Прибавить к счётчику месяца. Ошибка счётчика никогда не ломает работу. */
export async function countUsage(
  subject: string,
  add: { plateOcr?: number; relayBytes?: number; relayRequests?: number }
): Promise<void> {
  const plateOcr = add.plateOcr ?? 0;
  const relayBytes = BigInt(Math.max(0, Math.round(add.relayBytes ?? 0)));
  const relayRequests = add.relayRequests ?? 0;
  const month = monthKey();
  await prisma.usageMonth
    .upsert({
      where: { subject_month: { subject, month } },
      create: { subject, month, plateOcr, relayBytes, relayRequests },
      update: {
        plateOcr: { increment: plateOcr },
        relayBytes: { increment: relayBytes },
        relayRequests: { increment: relayRequests },
      },
    })
    .catch(() => undefined);
}

// ---------------------------------------------------------------- активность

/** Чаще раза в минуту отметку не пишем: это одна строка на мастерскую. */
const TOUCH_EVERY_MS = 60_000;
const touched = new Map<string, number>();

/**
 * «В мастерской кто-то работает» — от любого запроса сотрудника. Пишем мимо
 * Prisma, чтобы не трогать updatedAt мастерской: это не правка её данных.
 */
export function touchTenant(tenantId: string): void {
  const now = Date.now();
  const last = touched.get(tenantId) ?? 0;
  if (now - last < TOUCH_EVERY_MS) return;
  touched.set(tenantId, now);
  if (touched.size > 5000) touched.clear();
  void prisma
    .$executeRaw`UPDATE "Tenant" SET "lastSeenAt" = now() WHERE "id" = ${tenantId}`
    .catch(() => touched.delete(tenantId));
}

// ---------------------------------------------------------------- хранилище

/** Сколько байт фотографий и файлов у мастерской. */
export async function storageUsedBytes(tenantId: string): Promise<number> {
  const agg = await withTenant(tenantId, (tx) => tx.attachment.aggregate({ _sum: { sizeBytes: true } }));
  return agg._sum.sizeBytes ?? 0;
}

/** С какой доли лимита владелец видит предупреждение. */
export const STORAGE_WARN_SHARE = 0.9;

const mb = (bytes: number) => bytes / (1024 * 1024);
export const formatMb = (value: number) =>
  value >= 1024 ? `${(value / 1024).toFixed(1).replace(".", ",").replace(",0", "")} ГБ` : `${Math.round(value)} МБ`;

/**
 * Место для новых файлов.
 *
 * Только в облаке: у локальной мастерской диск свой, и сколько на нём
 * хранить — её дело. Уже загруженное не трогаем никогда: лимит закрывает
 * только новые загрузки, и владелец получает понятное объяснение.
 */
export async function assertStorageRoom(tenantId: string, incomingBytes: number): Promise<void> {
  if (!env.relayEnabled) return;
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { maxStorageMb: true } });
  if (!tenant || tenant.maxStorageMb <= 0) return;
  const used = await storageUsedBytes(tenantId);
  if (mb(used + incomingBytes) <= tenant.maxStorageMb) return;
  throw new AppError(
    413,
    `Место для фотографий закончилось: занято ${formatMb(mb(used))} из ${formatMb(tenant.maxStorageMb)}. ` +
      "Уже загруженное цело. Чтобы добавить место, напишите нам: «Настройки → Обратная связь».",
    "STORAGE_FULL"
  );
}

/** Для владельца: сколько занято и сколько можно. null — лимита нет (локальная версия). */
export async function storageInfo(tenantId: string) {
  if (!env.relayEnabled) return null;
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { maxStorageMb: true } });
  if (!tenant) return null;
  const usedBytes = await storageUsedBytes(tenantId);
  const limitMb = tenant.maxStorageMb;
  const share = limitMb > 0 ? mb(usedBytes) / limitMb : 0;
  return { usedBytes, limitMb, share, warn: share >= STORAGE_WARN_SHARE, full: share >= 1 };
}
