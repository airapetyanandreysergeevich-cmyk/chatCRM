/**
 * Календарь раздела «Статистика»: корзины должны совпадать с тем, что
 * отдаёт PostgreSQL (date_trunc: неделя с понедельника, месяц с 1-го), иначе
 * столбики встанут не на свои места.
 *
 *   npx tsx test/stats-dates.ts
 */
import { autoGran, bucketKeys, shiftYear } from "../src/modules/stats/dates";

let fails = 0;
const check = (ok: boolean, msg: string, got?: unknown) => {
  console.log((ok ? "ok    " : "БЕДА  ") + msg + (ok || got === undefined ? "" : `  → ${JSON.stringify(got)}`));
  if (!ok) fails += 1;
};

const w = bucketKeys({ from: "2026-01-01", to: "2026-01-20" }, "week");
check(JSON.stringify(w) === JSON.stringify(["2025-12-29", "2026-01-05", "2026-01-12", "2026-01-19"]), "недели с понедельника, первая начинается до периода", w);
const m = bucketKeys({ from: "2025-11-15", to: "2026-02-03" }, "month");
check(JSON.stringify(m) === JSON.stringify(["2025-11-01", "2025-12-01", "2026-01-01", "2026-02-01"]), "месяцы с 1-го числа, через Новый год", m);
const d = bucketKeys({ from: "2024-02-27", to: "2024-03-02" }, "day");
check(JSON.stringify(d) === JSON.stringify(["2024-02-27", "2024-02-28", "2024-02-29", "2024-03-01", "2024-03-02"]), "дни через 29 февраля", d);
const sameDay = bucketKeys({ from: "2026-03-29", to: "2026-03-29" }, "day");
check(sameDay.length === 1, "один день — один столбик (и в день перевода часов)", sameDay);
check(JSON.stringify(shiftYear({ from: "2024-02-29", to: "2024-03-31" })) === JSON.stringify({ from: "2023-02-28", to: "2023-03-31" }), "год назад: 29 февраля → 28-е");
check(autoGran({ from: "2026-09-01", to: "2026-09-30" }) === "day", "месяц — по дням");
check(autoGran({ from: "2026-07-01", to: "2026-09-30" }) === "week", "квартал — по неделям");
check(autoGran({ from: "2026-01-01", to: "2026-09-30" }) === "month", "год — по месяцам");

console.log(fails === 0 ? "\nвсе проверки прошли" : `\nпровалов: ${fails}`);
process.exitCode = fails === 0 ? 0 : 1;
