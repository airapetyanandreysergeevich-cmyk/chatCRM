import type { Prisma } from "@prisma/client";

/**
 * Один номер — одна запись (Андрей, 28.10.2026): «89189998877» и
 * «+79189998877» — один и тот же клиент.
 *
 * В базе у клиента есть «хвост» номера — последние 10 цифр, его считает сама
 * база (Customer.phoneTail / phone2Tail). Сличаем всегда по нему: на приёме,
 * в поиске, в звонках и SMS-ответах.
 */

/** Последние 10 цифр: «8 (918) 999-88-77» → «9189998877». */
export const phoneTail = (raw: string | null | undefined): string => (raw ?? "").replace(/\D/g, "").slice(-10);

/**
 * Российский номер — в одном виде: «+7 918 999-88-77». Что не похоже на
 * российский мобильный или городской с кодом, оставляем как ввели: короткий
 * внутренний номер или зарубежный портить нельзя.
 */
export function formatPhone(raw: string | null | undefined): string {
  const text = (raw ?? "").trim();
  const d = text.replace(/\D/g, "");
  let ten: string | null = null;
  if (d.length === 11 && (d[0] === "8" || d[0] === "7")) ten = d.slice(1);
  else if (d.length === 10 && /^[3-9]/.test(d) && !text.startsWith("+")) ten = d;
  if (!ten) return text;
  return `+7 ${ten.slice(0, 3)} ${ten.slice(3, 6)}-${ten.slice(6, 8)}-${ten.slice(8)}`;
}

/**
 * Что искать в хвосте номера по набранному куску. «8918» и «+7918» — это
 * начало номера с кодом страны: в хвосте его нет, ищем «918». Сам кусок тоже
 * ищем — вдруг человек набрал середину номера.
 */
export function phoneNeedles(raw: string): string[] {
  const d = raw.replace(/\D/g, "");
  if (d.length >= 11) return [d.slice(-10)];
  const out = new Set<string>();
  if (d.length >= 3) out.add(d);
  if (d.length >= 4 && (d[0] === "7" || d[0] === "8")) out.add(d.slice(1));
  return [...out];
}

/** Похоже ли слово поиска на кусок телефона: цифры со скобками, плюсом и дефисами. */
export const looksLikePhone = (w: string): boolean => /^[\d\s()+-]+$/.test(w) && w.replace(/\D/g, "").length >= 3;

/** Условие «телефон клиента содержит этот кусок» — по обоим номерам. */
export function customerPhoneWhere(raw: string): Prisma.CustomerWhereInput[] {
  return phoneNeedles(raw).flatMap((n) => [{ phoneTail: { contains: n } }, { phone2Tail: { contains: n } }]);
}
