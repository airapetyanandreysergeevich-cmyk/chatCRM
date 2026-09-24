/**
 * Поиск по словам и исправление раскладки.
 *
 *   npx tsx test/search.ts
 */

import { fixLayout, otherLayout, searchWords } from "../src/lib/search";

let fails = 0;
const check = (ok: boolean, msg: string, extra?: unknown) => {
  console.log((ok ? "ok    " : "БЕДА  ") + msg + (ok || extra === undefined ? "" : `  → ${JSON.stringify(extra)}`));
  if (!ok) fails += 1;
};

check(searchWords("  ноутбук   xiaomi bd9 ").join("|") === "ноутбук|xiaomi|bd9", "строка делится на слова, лишние пробелы не мешают");
check(searchWords("Ноутбук ноутбук").length === 1, "повтор слова не удваивает условие");
check(searchWords("a b c d e f g h i j").length === 8, "не больше восьми слов");
check(searchWords("").length === 0 && searchWords(undefined).length === 0, "пусто — без условий");

check(otherLayout("yjen,er") === "ноутбук", "yjen,er → ноутбук (запятая — это «б»)");
check(otherLayout("Yjen,er") === "Ноутбук", "заглавная остаётся заглавной");
check(otherLayout("чшфщьш") === "xiaomi", "и обратно: чшфщьш → xiaomi");
check(otherLayout("iktqa") === "шлейф", "iktqa → шлейф");
check(otherLayout("vfnhbwf") === "матрица", "vfnhbwf → матрица");
check(otherLayout("`krf") === "ёлка", "обратная кавычка — это «ё»");
check(otherLayout("12345") === null, "цифры переводить нечего");
check(otherLayout("ноутbook") === null, "смесь раскладок — не опечатка раскладки");
check(otherLayout("15.6") === null, "число с точкой — не слово");

// Нашлось как набрано — не трогаем; не нашлось — пробуем раскладку.
const base = new Set(["xiaomi", "bd9", "ноутбук"]);
const found = async (w: string) => base.has(w.toLowerCase());
const run = async (q: string) => fixLayout(searchWords(q), found);

async function main() {
let r = await run("yjen,er xiaomi bd9");
check(r.words.join(" ") === "ноутбук xiaomi bd9" && r.fixed === "ноутбук xiaomi bd9", "исправлено только слово в неверной раскладке", r);
r = await run("ноутбук xiaomi bd9");
check(r.fixed === null && r.words.join(" ") === "ноутбук xiaomi bd9", "всё нашлось — ничего не подменяем", r);
r = await run("bd9");
check(r.words[0] === "bd9" && r.fixed === null, "bd9 не превращается в ив9, раз нашлось", r);
r = await run("qqq");
check(r.words[0] === "qqq" && r.fixed === null, "не нашлось ни так, ни иначе — оставляем как набрано", r);

console.log(fails ? `\nНЕ ПРОШЛО: ${fails}` : "\nвсе проверки прошли");
process.exit(fails ? 1 : 0);
}

void main();
