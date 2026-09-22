/**
 * История ремонта: подписи дней в ленте.
 *
 *   npx tsx test/messages.ts
 */
import { dayLabel } from "../src/lib/messages";

let bad = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "ok    " : "БЕДА  ") + m); if (!c) bad++; };

const now = new Date(2026, 8, 22, 0, 30); // 22 сентября, полпервого ночи
ok(dayLabel(new Date(2026, 8, 22, 0, 5).toISOString(), now) === "Сегодня", "сегодня");
ok(dayLabel(new Date(2026, 8, 21, 23, 55).toISOString(), now) === "Вчера", "десять минут назад, но вчера — «Вчера», а не «Сегодня»");
ok(dayLabel(new Date(2026, 8, 12, 15, 0).toISOString(), now) === "12 сентября", `дата этого года без года (${dayLabel(new Date(2026, 8, 12).toISOString(), now)})`);
ok(dayLabel(new Date(2025, 11, 31, 12, 0).toISOString(), now).includes("2025"), "прошлый год — с годом");

console.log(bad === 0 ? "\nвсе проверки прошли" : `\nпровалов: ${bad}`);
process.exitCode = bad === 0 ? 0 : 1;
