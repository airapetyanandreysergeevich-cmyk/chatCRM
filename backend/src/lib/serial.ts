/**
 * Серийный номер: настоящий или заглушка.
 *
 * В старых базах вместо «серийника нет» пишут что угодно: NN, N/N, N.N, N\N,
 * Б/Н, n/a, «нет», нули, прочерки. Заглушка — не номер. Загрузка, принявшая
 * «N/N» за номер, решила, что пятьсот разных заказов — один и тот же
 * телефон, и приписала их всех к первому попавшемуся iPhone 5S чужого
 * клиента (02.10.2026, перенос из baza.sqlite).
 */

/** Что остаётся от заглушки, если выбросить пробелы и разделители. */
const PLACEHOLDERS = new Set([
  "n",
  "nn",
  "na",
  "nan",
  "no",
  "none",
  "null",
  "nil",
  "bn",
  "н",
  "нн",
  "бн",
  "нет",
  "безномера",
  "безн",
  "отсутствует",
  "неизвестно",
  "нечитается",
  "нечитаем",
  "стерт",
  "стёрт",
]);

/** Номер или null, если это заглушка. Регистр и написание не меняются. */
export function realSerial(raw: unknown): string | null {
  const s = (raw === null || raw === undefined ? "" : String(raw)).replace(/\s+/g, " ").trim();
  if (!s) return null;
  const compact = s.toLowerCase().replace(/[\s\\/.,_\-–—|:;'"`*#()]+/g, "");
  if (!compact) return null;
  if (PLACEHOLDERS.has(compact)) return null;
  // «0000», «xxxx», «????»: один и тот же знак — тоже не номер.
  if (/^(.)\1*$/u.test(compact)) return null;
  return s;
}

/**
 * Годится ли номер, чтобы по нему узнать уже заведённое устройство. Короткий
 * («12», «A1») совпадёт у разных вещей случайно — такой храним, но не сличаем.
 */
export const matchableSerial = (serial: string | null): serial is string =>
  !!serial && serial.replace(/[\s\\/.\-_]/g, "").length >= 5;
