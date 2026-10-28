/**
 * «89189998877» и «+79189998877» — один номер (Андрей, 28.10.2026). Сличаем
 * по последним 10 цифрам — так же, как сервер (backend/src/lib/phone.ts).
 */

export const phoneTail = (raw: string | null | undefined): string => (raw ?? "").replace(/\D/g, "").slice(-10);

/** Что искать в хвосте номера: «8918» и «+7918» — это «918» с кодом страны. */
export function phoneNeedles(raw: string): string[] {
  const d = raw.replace(/\D/g, "");
  if (d.length >= 11) return [d.slice(-10)];
  const out = new Set<string>();
  if (d.length >= 3) out.add(d);
  if (d.length >= 4 && (d[0] === "7" || d[0] === "8")) out.add(d.slice(1));
  return [...out];
}

/** Похоже ли слово на кусок телефона. */
export const looksLikePhone = (w: string): boolean => /^[\d\s()+-]+$/.test(w) && w.replace(/\D/g, "").length >= 3;

/** Совпадает ли кусок номера с одним из телефонов. */
export const phoneMatches = (query: string, ...phones: Array<string | null | undefined>): boolean => {
  const tails = phones.map(phoneTail).filter(Boolean);
  return phoneNeedles(query).some((n) => tails.some((t) => t.includes(n)));
};
