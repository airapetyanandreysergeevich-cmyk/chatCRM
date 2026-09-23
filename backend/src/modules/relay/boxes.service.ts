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
 * Код в адресе — случайный.
 *
 * Сначала он делался из почты владельца: `master@servis.ru` → `/b/master/`.
 * Читается приятно, но это вывеска: зная почту человека, чужой знает и адрес
 * его мастерской, а дальше остаётся подобрать только пароль сотрудника.
 * Адрес — не пароль, но и справочником быть не должен.
 *
 * Поэтому код ни о чём не говорит: четырнадцать случайных знаков из алфавита
 * без похожих букв (ни `l`, ни `1`, ни `0`, ни `o`), чтобы его можно было
 * продиктовать голосом и не ошибиться.
 */
const CODE_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
const CODE_LENGTH = 14;

export function newCode(): string {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let out = "";
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

/**
 * Свободный код. Совпадение на четырнадцати знаках невероятно, но проверка
 * стоит один запрос: получить отказ по уникальному ключу базы в середине
 * выдачи доступа — куда неприятнее.
 */
export async function freeCode(): Promise<string> {
  for (let i = 0; i < 5; i += 1) {
    const code = newCode();
    if (!(await prisma.box.findUnique({ where: { code }, select: { id: true } }))) return code;
  }
  return `${newCode()}${Date.now().toString(36)}`;
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
