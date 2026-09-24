import { z } from "zod";

/**
 * Логины мастерских: nikita@lenina.
 *
 * Мастерская с доступом из интернета выбирает себе имя (lenina), и логины всех
 * её сотрудников становятся «имя@мастерская». Один и тот же логин работает и
 * в локальной сети, и на общем сайте: по части после @ облако понимает, в
 * какую Основу отправить вход.
 *
 * Главное правило — **после @ нет точки.** Логин с точкой (nikita@lenina.ru)
 * выглядел бы как настоящая почта, и мастерская, назвавшаяся «mail», забрала
 * бы себе вход всех облачных пользователей @mail.ru. Настоящих адресов без
 * точки в домене не бывает, поэтому пересечься логины и почты не могут.
 */

/** Имя мастерской: 3–30 знаков, латиница, цифры, дефис не по краям. */
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;

/** Часть логина до @: как в почте, но без экзотики. */
const LOCAL_RE = /^[a-z0-9]([a-z0-9._-]{0,38}[a-z0-9])?$/;

/**
 * Занятые слова. Не из суеверия: «admin@admin» или «ivan@finecrm» выглядели бы
 * как служебные учётки и годились бы, чтобы выдать себя за поддержку.
 * «local» с цифрами — прежние приставки: пусть не путаются с новыми именами.
 */
const RESERVED = new Set([
  "admin", "administrator", "api", "app", "assets", "b", "demo", "email", "finecrm", "help", "info",
  "localhost", "login", "mail", "me", "null", "owner", "platform", "register", "relay", "root",
  "server", "service", "settings", "static", "support", "system", "test", "undefined", "www",
]);

export const normalizeName = (raw: unknown): string => String(raw ?? "").trim().toLowerCase();

/** Что не так с именем мастерской — или null, если всё так. */
export function nameProblem(raw: string): string | null {
  const name = normalizeName(raw);
  if (name.length < 3) return "Имя — не короче 3 знаков";
  if (name.length > 30) return "Имя — не длиннее 30 знаков";
  if (/[^a-z0-9-]/.test(name)) return "Только латинские буквы, цифры и дефис";
  if (name.startsWith("-") || name.endsWith("-")) return "Дефис не может стоять в начале или в конце";
  if (!NAME_RE.test(name)) return "Только латинские буквы, цифры и дефис";
  if (RESERVED.has(name) || /^local[0-9]*$/.test(name)) return "Это имя зарезервировано — выберите другое";
  return null;
}

/** Что не так с частью логина до @ — или null. */
export function localProblem(raw: string): string | null {
  const local = normalizeName(raw);
  if (!local) return "Укажите логин";
  if (local.length > 40) return "Логин — не длиннее 40 знаков";
  if (!LOCAL_RE.test(local)) return "Логин — латинские буквы, цифры, точка, дефис или подчёркивание";
  return null;
}

/**
 * Разобрать логин мастерской: nikita@lenina → { local: "nikita", name: "lenina" }.
 * Настоящая почта (с точкой после @) сюда не подходит и даёт null.
 */
export function splitWorkshopLogin(raw: string): { local: string; name: string } | null {
  const text = normalizeName(raw);
  const at = text.lastIndexOf("@");
  if (at <= 0) return null;
  const local = text.slice(0, at);
  const name = text.slice(at + 1);
  if (name.includes(".")) return null;
  if (localProblem(local) || !NAME_RE.test(name)) return null;
  return { local, name };
}

export const isWorkshopLogin = (raw: string) => splitWorkshopLogin(raw) !== null;

const asEmail = z.string().email();

/**
 * Похоже ли на настоящую почту, на которую можно написать.
 *
 * Адреса вида master1@proba.local владельцы заводили, когда почты у
 * сотрудника не было: такие в «почту для связи» не переносим — писать на них
 * некуда.
 */
export function looksLikeMailbox(raw: string | null | undefined): boolean {
  const text = normalizeName(raw);
  if (!asEmail.safeParse(text).success) return false;
  return !/\.(local|localhost|invalid|test|example)$/.test(text);
}

/**
 * Предложить часть логина до @ по нынешнему логину.
 *
 * nikita@mail.ru → nikita; nikita@lenina → nikita; «Иван.Петров+crm@x.ru» →
 * ivan.petrov (что после плюса — служебное). Если от почты ничего не осталось
 * — по имени человека.
 */
export function suggestLocal(login: string, fullName: string): string {
  const before = normalizeName(login).split("@")[0].split("+")[0];
  const clean = (s: string) =>
    translit(s)
      .replace(/[^a-z0-9._-]+/g, ".")
      .replace(/[._-]{2,}/g, ".")
      .replace(/^[._-]+|[._-]+$/g, "")
      .slice(0, 40)
      .replace(/[._-]+$/g, "");
  return clean(before) || clean(fullName.split(/\s+/)[0] ?? "") || "user";
}

const RU: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k",
  л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts",
  ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

const translit = (s: string) =>
  s
    .toLowerCase()
    .split("")
    .map((ch) => RU[ch] ?? ch)
    .join("");
