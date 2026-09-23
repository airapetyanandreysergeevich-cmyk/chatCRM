/**
 * Фраза подключения: адрес, ключ и код мастерской одной строкой.
 *
 * Зачем. Раньше владельцу надо было передать три вещи: адрес узла связи, ключ
 * и код в адресе. По телефону это разговор на пять минут, в переписке —
 * три сообщения, и ошибиться можно в каждом. Одна строка копируется целиком
 * и вставляется целиком: ошибиться негде.
 *
 * Внутри — обычный JSON в base64url с приставкой FINECRM-. Это не шифрование
 * и им не притворяется: ключ внутри читается любым желающим, поэтому фразу
 * передают так же бережно, как пароль. Приставка нужна, чтобы программа сразу
 * понимала, что ей дали, и не пыталась подключиться к строке из письма.
 */

export const INVITE_PREFIX = "FINECRM-";

export interface Invite {
  /** Адрес узла связи: wss://www.finecrm.ru/relay/agent */
  url: string;
  /** Ключ мастерской. */
  key: string;
  /** Код в адресе: https://www.finecrm.ru/b/<code>/ */
  code: string;
  /** Почта, на которую выдан доступ: видно, кому принадлежит фраза. */
  email?: string;
  /** Имя мастерской в облаке (local20): по нему входят её сотрудники. */
  tag?: string;
}

export function encodeInvite(invite: Invite): string {
  const payload = JSON.stringify({
    v: 1,
    u: invite.url,
    k: invite.key,
    c: invite.code,
    e: invite.email,
    t: invite.tag,
  });
  return INVITE_PREFIX + Buffer.from(payload, "utf8").toString("base64url");
}

/**
 * Разобрать вставленное.
 *
 * Человек вставляет из мессенджера, и в строку попадает что угодно: переводы
 * строк, пробелы посередине, кавычки, слово «ключ:» перед самой фразой.
 * Поэтому сначала вычищаем всё лишнее и только потом разбираем. Если
 * приставки нет вовсе, считаем, что дали голый ключ, — со старым порядком
 * выдачи это по-прежнему работает.
 */
export function parseInvite(raw: string, defaultUrl: string): Invite | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;

  const found = text.match(new RegExp(`${INVITE_PREFIX}[A-Za-z0-9_-]+`));
  if (!found) {
    const key = text.replace(/\s+/g, "");
    return /^[\x21-\x7e]{16,200}$/.test(key) ? { url: defaultUrl, key, code: "" } : null;
  }

  try {
    const json = Buffer.from(found[0].slice(INVITE_PREFIX.length), "base64url").toString("utf8");
    const data = JSON.parse(json) as {
      u?: string;
      k?: string;
      c?: string;
      e?: string;
      n?: string;
      t?: string;
    };
    if (!data.k || !/^[\x21-\x7e]+$/.test(data.k)) return null;
    const url = typeof data.u === "string" && /^wss?:\/\//.test(data.u) ? data.u : defaultUrl;
    // n — от прежних фраз, где вместо почты стояло название мастерской.
    return {
      url,
      key: data.k,
      code: typeof data.c === "string" ? data.c : "",
      email: data.e ?? data.n,
      tag: typeof data.t === "string" ? data.t : undefined,
    };
  } catch {
    return null;
  }
}

/** Человеческий адрес мастерской по коду: его показываем и в панели, и в программе. */
export function publicAddress(relayUrl: string, code: string): string {
  if (!code) return "";
  try {
    const u = new URL(relayUrl);
    const scheme = u.protocol === "ws:" ? "http:" : "https:";
    return `${scheme}//${u.host}/b/${code}/`;
  } catch {
    return "";
  }
}
