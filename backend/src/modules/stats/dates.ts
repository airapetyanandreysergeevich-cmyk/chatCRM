/**
 * Даты периода — строками YYYY-MM-DD, в местном календаре мастерской.
 *
 * Считаются в UTC нарочно: здесь нет времени суток, только календарь, и
 * UTC не знает переходов на летнее время, которые сдвинули бы день.
 */

export type Gran = "day" | "week" | "month";
export interface Range {
  from: string;
  to: string;
}

const parse = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
const fmt = (d: Date) => d.toISOString().slice(0, 10);

export const addDays = (s: string, n: number) => {
  const d = parse(s);
  d.setUTCDate(d.getUTCDate() + n);
  return fmt(d);
};

export const daysBetween = (a: string, b: string) => Math.round((parse(b).getTime() - parse(a).getTime()) / 86_400_000);

/** Шаг по длине периода: до полутора месяцев — дни, до полугода — недели, дальше — месяцы. */
export function autoGran(r: Range): Gran {
  const n = daysBetween(r.from, r.to) + 1;
  return n <= 45 ? "day" : n <= 200 ? "week" : "month";
}

/**
 * Начала корзин периода — ровно те строки, что даёт в SQL
 * to_char(date_trunc(gran, …), 'YYYY-MM-DD'): неделя с понедельника,
 * месяц с первого числа. Первая корзина может начинаться раньше периода.
 */
export function bucketKeys(r: Range, gran: Gran): string[] {
  const out: string[] = [];
  let d = parse(r.from);
  if (gran === "week") d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  if (gran === "month") d.setUTCDate(1);
  const end = parse(r.to);
  while (d <= end && out.length <= 2000) {
    out.push(fmt(d));
    if (gran === "day") d.setUTCDate(d.getUTCDate() + 1);
    else if (gran === "week") d.setUTCDate(d.getUTCDate() + 7);
    else d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  }
  return out;
}

/** Тот же период годом раньше. 29 февраля превращается в 28-е. */
export function shiftYear(r: Range): Range {
  const back = (s: string) => {
    const [y, m, d] = s.split("-").map(Number);
    const last = new Date(Date.UTC(y - 1, m, 0)).getUTCDate();
    return fmt(new Date(Date.UTC(y - 1, m - 1, Math.min(d, last))));
  };
  return { from: back(r.from), to: back(r.to) };
}
