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

/**
 * Имя мастерской в облаке: local20.
 *
 * Код в адресе нарочно случайный, и это правильно — но продиктовать его
 * нельзя. А диктовать придётся: сотрудник входит на общем сайте и пишет свою
 * почту с хвостом, `anton@repair.ru.local20`. Поэтому имя короткое, из одного
 * знакомого слова и числа: услышал — записал без ошибки.
 *
 * Числа идут по порядку и ничего не выдают, кроме того, какой по счёту
 * мастерская подключилась. Адрес по имени не угадать: он остаётся случайным,
 * и облако не отдаёт его никому, пока человек не вошёл.
 */
const TAG_PREFIX = "local";

export async function nextTag(): Promise<string> {
  const taken = await prisma.box.findMany({ select: { tag: true } });
  let max = 0;
  for (const { tag } of taken) {
    const n = Number(tag.startsWith(TAG_PREFIX) ? tag.slice(TAG_PREFIX.length) : NaN);
    if (Number.isInteger(n) && n > max) max = n;
  }
  return `${TAG_PREFIX}${max + 1}`;
}

/** Хвост почты — это имя мастерской? Годится только наш вид: local и число. */
export function isTag(raw: string): boolean {
  return new RegExp(`^${TAG_PREFIX}[0-9]{1,9}$`).test(raw);
}

/**
 * Разобрать почту, набранную на общем входе.
 *
 * `anton@repair.ru.local20` → `{ email: "anton@repair.ru", tag: "local20" }`.
 * Хвост отрезаем только свой: почта на настоящем домене остаётся целой, и
 * облачные сотрудники ничего не замечают.
 */
export function splitTag(raw: string): { email: string; tag: string } | null {
  const text = String(raw ?? "").trim().toLowerCase();
  const dot = text.lastIndexOf(".");
  if (dot < 0) return null;
  const tail = text.slice(dot + 1);
  if (!isTag(tail)) return null;
  const email = text.slice(0, dot);
  return email.includes("@") ? { email, tag: tail } : null;
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
export async function authenticateBox(key: string): Promise<{ code: string; tag: string } | null> {
  const box = await prisma.box.findFirst({
    where: { keyHash: fingerprint(key), isActive: true },
    select: { code: true, tag: true },
  });
  return box;
}

/** Найти мастерскую по имени в облаке — для входа сотрудника с общего сайта. */
export async function boxByTag(tag: string): Promise<{ code: string; tag: string } | null> {
  if (!isTag(tag)) return null;
  return prisma.box.findFirst({ where: { tag, isActive: true }, select: { code: true, tag: true } });
}

/** Отметка «была на связи» — редкая запись, раз в подключение. */
export async function markSeen(code: string): Promise<void> {
  await prisma.box.updateMany({ where: { code }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
}
