/**
 * Месяцы по часам мастерской.
 *
 * Зарплата считается по календарным месяцам, и граница месяца — полночь
 * там, где мастерская, а не в Гринвиче: заказ, оплаченный 1 октября в
 * 01:30 по Москве, — октябрьский, хотя в UTC это ещё 30 сентября.
 */

export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** «2026-09» для момента времени в часовом поясе мастерской. */
export function monthOf(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit" }).formatToParts(date);
  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  return `${y}-${m}`;
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Все месяцы от from до to включительно. Пусто, если from позже to. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = from; m <= to && out.length < 1200; m = shiftMonth(m, 1)) out.push(m);
  return out;
}

/** Смещение часового пояса в миллисекундах для данного момента. */
function offsetMs(date: Date, timeZone: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(date)
      .map((x) => [x.type, x.value])
  );
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Начало месяца (полночь 1-го числа по часам мастерской) как момент времени. */
export function monthStart(month: string, timeZone: string): Date {
  const [y, m] = month.split("-").map(Number);
  const guess = new Date(Date.UTC(y, m - 1, 1));
  return new Date(guess.getTime() - offsetMs(guess, timeZone));
}

/** Границы месяца: [начало, начало следующего). */
export function monthBounds(month: string, timeZone: string): { from: Date; to: Date } {
  return { from: monthStart(month, timeZone), to: monthStart(shiftMonth(month, 1), timeZone) };
}

const NAMES = [
  "январь", "февраль", "март", "апрель", "май", "июнь",
  "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь",
];

export const monthTitle = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  return `${NAMES[m - 1]} ${y}`;
};
