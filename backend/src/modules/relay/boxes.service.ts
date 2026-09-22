import crypto from "crypto";
import { prisma } from "../../lib/db";

/**
 * Ключи доступа коробочных мастерских.
 *
 * Ключ — это пароль Основы: с ним она подключается к облаку и получает адрес
 * в интернете. Поэтому в базе лежит не он, а его отпечаток: утечь целиком ему
 * неоткуда, даже из копии базы. Показываем ключ один раз, при выдаче, — как
 * и полагается паролю.
 *
 * Отпечаток снимается быстрым sha256, а не медленным bcrypt, и это осознанно:
 * ключ придумывает не человек, а машина — 32 случайных байта. Перебирать такой
 * бессмысленно при любой скорости хеша, а искать по нему мастерскую нужно на
 * каждом соединении.
 */

export const fingerprint = (key: string) => crypto.createHash("sha256").update(key.trim()).digest("hex");

/** Ключ, который не стыдно продиктовать по телефону: без похожих знаков. */
export function newKey(): string {
  return crypto.randomBytes(24).toString("base64url");
}

/**
 * Код в адресе — из почты владельца.
 *
 * Доступ выдан человеку, а не безымянной коробке, поэтому и адрес делается из
 * его почты: `masterskaya@example.ru` → `/b/masterskaya/`. Часть после
 * собачки отбрасывается — она одинаковая у половины мастерских и в адресе
 * только мешает.
 *
 * Если такой код уже занят (два `info@…` у разных людей — обычное дело),
 * дописываем номер: `info-2`, `info-3`. Молча отдать второму человеку чужой
 * адрес нельзя, а придумывать ему псевдоним не за что.
 */
export function codeFromEmail(email: string): string {
  const local = email.trim().toLowerCase().split("@")[0] ?? "";
  const code = normalizeCode(local.replace(/\+.*$/, ""));
  if (code.length >= 3) return code.slice(0, 32);
  // Почта целиком не латиницей — адрес всё равно должен получиться, и
  // спрашивать человека не о чем: делаем короткий код из самой почты.
  return `box-${crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 6)}`;
}

/** Свободный код: занят — дописываем номер, пока не найдём свободный. */
export async function freeCode(base: string): Promise<string> {
  for (let i = 1; i < 100; i += 1) {
    const code = i === 1 ? base : `${base}-${i}`;
    if (!(await prisma.box.findUnique({ where: { code }, select: { id: true } }))) return code;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/** Код в адресе: только то, что человек наберёт руками и не ошибётся. */
export function normalizeCode(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

/**
 * Пустить Основу по ключу.
 *
 * Отключённая мастерская не пускается вовсе: выключатель в панели собственника
 * — это и есть способ прекратить услугу, не бегая к чужому компьютеру.
 */
export async function authenticateBox(key: string): Promise<{ code: string } | null> {
  const box = await prisma.box.findFirst({
    where: { keyHash: fingerprint(key), isActive: true },
    select: { code: true },
  });
  return box;
}

/** Отметка «была на связи» — редкая запись, раз в подключение. */
export async function markSeen(code: string): Promise<void> {
  await prisma.box.updateMany({ where: { code }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
}
