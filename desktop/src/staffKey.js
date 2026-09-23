"use strict";

/**
 * Ключ подключения, выданный сотруднику.
 *
 * Владелец мастерской, открывший доступ из интернета, раздаёт своим людям
 * строку вида `FINECRM-S-<base64url>`. Внутри — адрес его мастерской и её
 * название; ключа туннеля там нет, прав она не даёт никаких. Нужна она
 * только затем, чтобы человеку не диктовали по телефону адрес из
 * четырнадцати случайных знаков: в третьем он всё равно ошибётся.
 *
 * Здесь строка превращается в адрес. То же самое умеет и сайт
 * (`frontend/src/lib/staffKey.ts`) — правила разбора должны совпадать.
 */

const STAFF_PREFIX = "FINECRM-S-";

/** База64 без знаков, которые ломаются в письмах и ссылках. */
function fromBase64url(text) {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64").toString("utf8");
}

/**
 * Разобрать вставленное.
 *
 * Человек вставляет из мессенджера, и вокруг ключа оказывается что угодно:
 * «вот твой ключ:», переводы строк, кавычки. Поэтому ключ выкусывается из
 * текста, а не требуется в одиночестве. Если вместо ключа вставили сам адрес
 * мастерской — тоже принимаем: человек сделал разумное, и спорить не о чем.
 *
 * Возвращает `{ address, workshop, label }` или `null`.
 */
function parseStaffKey(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return null;

  const found = text.match(new RegExp(`${STAFF_PREFIX}[A-Za-z0-9_-]+`));
  if (found) {
    try {
      const data = JSON.parse(fromBase64url(found[0].slice(STAFF_PREFIX.length)));
      const address = typeof data.a === "string" ? data.a : "";
      if (!/^https?:\/\//.test(address)) return null;
      return {
        address,
        workshop: typeof data.w === "string" ? data.w : "",
        label: typeof data.l === "string" ? data.l : "",
      };
    } catch {
      return null;
    }
  }

  // Вставили адрес мастерской целиком — им и воспользуемся.
  const url = text.match(/https?:\/\/[^\s"'<>]+/);
  if (url && /\/b\/[a-z0-9-]{3,40}\/?$/i.test(url[0])) {
    return { address: url[0], workshop: "", label: "" };
  }
  return null;
}

/**
 * Адрес, по которому программа будет стучаться.
 *
 * Хвостовой слэш убираем: и проверка связи, и запросы приложения клеят свой
 * путь через косую черту, а `…/b/код//api/health` — уже не тот адрес.
 */
function addressFromKey(raw) {
  const parsed = parseStaffKey(raw);
  return parsed ? parsed.address.replace(/\/+$/, "") : null;
}

/** Похоже ли вставленное на ключ, а не на адрес в локальной сети. */
function looksLikeKey(raw) {
  return String(raw ?? "").includes(STAFF_PREFIX);
}

module.exports = { STAFF_PREFIX, parseStaffKey, addressFromKey, looksLikeKey };
