/**
 * Зарплата: месяцы по часам мастерской и доли мастеров в заказе.
 *
 *   npx tsx test/salary.ts
 */
import { sharesOf } from "../src/modules/salary/calc";
import { monthBounds, monthOf, monthsBetween, shiftMonth } from "../src/modules/salary/months";

let fails = 0;
const check = (ok: boolean, msg: string, extra?: unknown) => {
  console.log((ok ? "ok    " : "БЕДА  ") + msg + (ok || extra === undefined ? "" : `  → ${JSON.stringify(extra)}`));
  if (!ok) fails += 1;
};

// Месяцы
check(monthOf(new Date("2026-09-30T22:30:00Z"), "Europe/Moscow") === "2026-10", "1 октября 01:30 по Москве — октябрь, хотя в UTC ещё сентябрь");
check(monthOf(new Date("2026-09-30T20:30:00Z"), "Europe/Moscow") === "2026-09", "30 сентября 23:30 по Москве — сентябрь");
check(monthOf(new Date("2026-09-30T20:30:00Z"), "Asia/Vladivostok") === "2026-10", "во Владивостоке это уже октябрь");
const b = monthBounds("2026-10", "Europe/Moscow");
check(b.from.toISOString() === "2026-09-30T21:00:00.000Z" && b.to.toISOString() === "2026-10-31T21:00:00.000Z", "границы октября по Москве", b);
check(shiftMonth("2026-12", 1) === "2027-01" && shiftMonth("2026-01", -1) === "2025-12", "переход через год");
check(monthsBetween("2026-11", "2027-02").join() === "2026-11,2026-12,2027-01,2027-02" && monthsBetween("2026-05", "2026-04").length === 0, "месяцы подряд");

// Доли мастеров
const A = "a", M = "m", R = "r";
const isMaster = (id: string) => id !== R; // R — приёмщик, процента нет
let s = sharesOf(A, [], isMaster);
check(s.get(A) === 1 && s.size === 1, "без строк работ — весь заказ мастеру заказа");
s = sharesOf(A, [{ price: 1000, qty: 1, masterId: A }, { price: 1000, qty: 1, masterId: M }], isMaster);
check(s.get(A) === 0.5 && s.get(M) === 0.5, "две строки по 1000 у двух мастеров — пополам", [...s]);
s = sharesOf(A, [{ price: 3000, qty: 1, masterId: M }, { price: 500, qty: 2, masterId: null }], isMaster);
check(s.get(M) === 0.75 && s.get(A) === 0.25, "строка без мастера — мастеру заказа; количество учитывается", [...s]);
s = sharesOf(A, [{ price: 2000, qty: 1, masterId: R }], isMaster);
check(s.get(A) === 1 && !s.has(R), "строка, записанная на приёмщика, — мастеру заказа", [...s]);
s = sharesOf(null, [{ price: 2000, qty: 1, masterId: null }], isMaster);
check(s.size === 0, "ни мастера заказа, ни мастера строки — никому");

console.log(fails ? `\nНЕ ПРОШЛО: ${fails}` : "\nвсе проверки прошли");
process.exit(fails ? 1 : 0);
