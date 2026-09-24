import crypto from "crypto";
import { prisma } from "../../lib/db";
import { nameProblem, normalizeName } from "../../lib/login";

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
export async function authenticateBox(key: string): Promise<{ id: string; code: string; name: string | null } | null> {
  return prisma.box.findFirst({
    where: { keyHash: fingerprint(key), isActive: true },
    select: { id: true, code: true, name: true },
  });
}

/** Сколько прежнее имя держится за мастерской после смены. */
export const NAME_HOLD_DAYS = 30;

export type WorkshopLookup =
  | { found: true; code: string; name: string }
  /** Имя сменили недавно: подсказываем новое. */
  | { found: false; renamedTo: string }
  | { found: false; renamedTo?: undefined };

/** Найти мастерскую по имени — для входа сотрудника с общего сайта. */
export async function findWorkshop(rawName: string): Promise<WorkshopLookup> {
  const name = normalizeName(rawName);
  if (!name) return { found: false };
  const box = await prisma.box.findFirst({ where: { name, isActive: true }, select: { code: true, name: true } });
  if (box?.name) return { found: true, code: box.code, name: box.name };
  const moved = await prisma.box.findFirst({
    where: { previousName: name, previousNameUntil: { gt: new Date() }, name: { not: null } },
    select: { name: true },
  });
  return moved?.name ? { found: false, renamedTo: moved.name } : { found: false };
}

/**
 * Свободно ли имя для этой мастерской.
 *
 * Занято — если это нынешнее имя другой мастерской или её прежнее, пока то
 * ещё держится. Своё прежнее имя вернуть можно.
 */
export async function nameStatus(rawName: string, boxId: string): Promise<{ ok: boolean; reason?: string }> {
  const name = normalizeName(rawName);
  const problem = nameProblem(name);
  if (problem) return { ok: false, reason: problem };
  const taken = await prisma.box.findFirst({
    where: {
      id: { not: boxId },
      OR: [{ name }, { previousName: name, previousNameUntil: { gt: new Date() } }],
    },
    select: { id: true },
  });
  return taken ? { ok: false, reason: "Это имя уже занято другой мастерской" } : { ok: true };
}

/**
 * Закрепить имя за мастерской.
 *
 * Прежнее имя месяц держится за ней же: никто его не займёт, пока сотрудники
 * привыкают к новому, а входящие по старой памяти получают подсказку.
 * Совпадение по уникальному ключу базы (двое нажали «Зарегистрировать» в одну
 * секунду) превращается в тот же честный ответ «занято».
 */
export async function claimName(boxId: string, rawName: string): Promise<{ ok: true; name: string } | { ok: false; reason: string }> {
  const name = normalizeName(rawName);
  const status = await nameStatus(name, boxId);
  if (!status.ok) return { ok: false, reason: status.reason ?? "Имя недоступно" };

  const box = await prisma.box.findUnique({ where: { id: boxId }, select: { name: true, previousName: true } });
  if (!box) return { ok: false, reason: "Мастерская не найдена" };
  if (box.name === name) return { ok: true, name };

  const hold = box.name
    ? { previousName: box.name, previousNameUntil: new Date(Date.now() + NAME_HOLD_DAYS * 24 * 60 * 60 * 1000) }
    : box.previousName === name
      ? { previousName: null, previousNameUntil: null }
      : {};
  try {
    await prisma.box.update({ where: { id: boxId }, data: { name, ...hold } });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") return { ok: false, reason: "Это имя уже занято другой мастерской" };
    throw err;
  }
  return { ok: true, name };
}

/** Отметка «была на связи» — редкая запись, раз в подключение. */
export async function markSeen(code: string): Promise<void> {
  await prisma.box.updateMany({ where: { code }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
}
