/**
 * Формат номера заказа: разбор образца и сборка номера.
 *
 * Сам счётчик (UPDATE ... RETURNING со сбросом в новом году) проверяется на
 * живой базе; здесь — правила, которые видит человек.
 *
 *   npx tsx test/order-number.ts
 */

import { formatNumber, parseTemplate, upcoming, type OrderNumberFormat } from "../src/lib/orderNumber";

let fails = 0;
const check = (ok: boolean, msg: string, extra?: unknown) => {
  console.log((ok ? "ok    " : "БЕДА  ") + msg + (ok || extra === undefined ? "" : `  → ${JSON.stringify(extra)}`));
  if (!ok) fails += 1;
};

const fmt = (template: string, withYear = false): OrderNumberFormat => {
  const p = parseTemplate(template);
  if (!p.ok) throw new Error(p.reason);
  return { template, prefix: p.prefix, width: p.width, start: p.start, withYear };
};
const list = (f: OrderNumberFormat, year = 2026) => upcoming(f, { next: f.start, year: null }, year).join(", ");

const sc = parseTemplate("SC01");
check(sc.ok && sc.prefix === "SC" && sc.start === 1 && sc.width === 2, "SC01 → приставка SC, с 1, две цифры", sc);
check(list(fmt("SC01")) === "SC01, SC02, SC03", "SC01 без года", list(fmt("SC01")));
check(formatNumber(fmt("SC01"), 100, 2026) === "SC100", "за 99 — просто растёт: SC100");
check(list(fmt("З-001")) === "З-001, З-002, З-003", "З-001 без года");
check(list(fmt("1000")) === "1000, 1001, 1002", "одни цифры — без приставки");
check(list(fmt("SC01", true)) === "SC-2026-01, SC-2026-02, SC-2026-03", "SC01 с годом", list(fmt("SC01", true)));
check(list(fmt("З-001", true)) === "З-2026-001, З-2026-002, З-2026-003", "у приставки с дефисом второй не добавляется");
check(list(fmt("A/7", true)) === "A/2026-7, A/2026-8, A/2026-9", "и с косой чертой тоже");
check(list(fmt("1000", true)) === "2026-1000, 2026-1001, 2026-1002", "одни цифры с годом");

const standard: OrderNumberFormat = { template: null, prefix: "Р", width: 5, start: 1, withYear: false };
check(formatNumber(standard, 123, 2026) === "Р-2026-00123", "стандартный — как был");
check(upcoming(standard, { next: 7, year: null }, 2027)[0] === "Р-2027-00007", "стандартный не сбрасывается в новом году");

const yearly = fmt("SC01", true);
check(upcoming(yearly, { next: 58, year: 2026 }, 2026)[0] === "SC-2026-58", "с годом внутри года — дальше по счёту");
check(upcoming(yearly, { next: 58, year: 2026 }, 2027)[0] === "SC-2027-01", "с годом в новом году — заново с первого номера");
const plain = fmt("SC01");
check(upcoming(plain, { next: 58, year: 2026 }, 2027)[0] === "SC58", "без года новый год ничего не сбрасывает");

for (const [bad, why] of [
  ["", "пусто"],
  ["SC", "без цифры в конце"],
  ["SC 01", "пробел"],
  ["SC.01", "точка"],
  ["№01", "знак №"],
  ["A".repeat(19) + "01", "длиннее 20"],
  ["A1234567890", "счётчик длиннее 9 цифр"],
] as const) {
  check(!parseTemplate(bad).ok, `не принимается: ${why}`);
}
check(parseTemplate("  sc01 ").ok && (parseTemplate("  sc01 ") as { prefix: string }).prefix === "sc", "пробелы по краям отрезаются, регистр — как ввели");
check(parseTemplate("Ремонт-2/0").ok, "русские буквы, дефис, косая черта и ноль в начале");

console.log(fails ? `\nНЕ ПРОШЛО: ${fails}` : "\nвсе проверки прошли");
process.exit(fails ? 1 : 0);
