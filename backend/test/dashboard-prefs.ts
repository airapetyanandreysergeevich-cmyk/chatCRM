/**
 * Настройки главного экрана: что бы ни пришло — получаются правильные.
 *
 *   npx tsx test/dashboard-prefs.ts
 */
import { COLUMN_KEYS, kindKey, normalizePrefs } from "../src/modules/summary/prefs";

let fails = 0;
const check = (ok: boolean, msg: string, extra?: unknown) => {
  console.log((ok ? "ok    " : "БЕДА  ") + msg + (ok || extra === undefined ? "" : `  → ${JSON.stringify(extra)}`));
  if (!ok) fails += 1;
};

let p = normalizePrefs(null);
check(p.order.join() === COLUMN_KEYS.join() && p.hidden.length === 0 && Object.keys(p.panels).length === 0, "пусто — всё по умолчанию", p);

p = normalizePrefs({ order: ["DEBTORS", "DONE", "мусор", "DONE"] });
check(p.order.join() === "DEBTORS,DONE,NEW,WAITING,IN_PROGRESS", "порядок: известные по разу, недостающие в конец", p.order);

p = normalizePrefs({ hidden: ["NEW", "OVERDUE", "что-то", "NEW"] });
check(p.hidden.join() === "NEW,OVERDUE", "выключенные: только известные, без повторов", p.hidden);

p = normalizePrefs({
  panels: {
    NEW: { sort: "new", limit: 7, hiddenKinds: [" Ноутбук ", "ноутбук", "ИГРОВАЯ  приставка"] },
    WAITING: { sort: "urgent" },
    DEBTORS: { sort: "old", hiddenKinds: ["ноутбук"] },
    IN_PROGRESS: { sort: "sum" },
    NOPE: { sort: "new" },
  },
});
check(
  JSON.stringify(p.panels.NEW) === JSON.stringify({ sort: "new", limit: 7, hiddenKinds: ["игровая приставка", "ноутбук"] }),
  "типы техники приводятся к одному виду и не повторяются",
  p.panels.NEW
);
check(p.panels.WAITING === undefined, "сортировка по умолчанию не хранится");
check(JSON.stringify(p.panels.DEBTORS) === JSON.stringify({ sort: "old" }), "у должников нет фильтра техники", p.panels.DEBTORS);
check(p.panels.IN_PROGRESS === undefined, "чужая сортировка у стадии выброшена");
check(!("NOPE" in p.panels), "незнакомая панель выброшена");

p = normalizePrefs({ panels: { NEW: { limit: 500 } } });
check(p.panels.NEW === undefined, "количество больше 60 — не принимается");
p = normalizePrefs("битое");
check(p.order.length === COLUMN_KEYS.length, "битые настройки — по умолчанию");

check(kindKey("  Игровая   Приставка ") === "игровая приставка" && kindKey(null) === "", "kindKey");

if (fails) {
  console.log(`\nНе прошло: ${fails}`);
  process.exit(1);
}
console.log("\nВсё прошло");
