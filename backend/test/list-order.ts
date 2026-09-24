/**
 * Порядок строк в списках: цвета по палитре, пустое — в конце, страницы
 * режутся после сортировки, а не до.
 *
 * База не нужна: проверяем сами правила сравнения.
 *
 *   npx tsx test/list-order.ts
 */

import { colorRank, compareKeys, customerColorWhere, desc, inOrder, pageIds, time } from "../src/lib/listOrder";

let fails = 0;
const check = (ok: boolean, msg: string) => {
  console.log((ok ? "ok    " : "БЕДА  ") + msg);
  if (!ok) fails += 1;
};

check(colorRank("red") === 0 && colorRank("amber") === 1 && colorRank("purple") === 5, "цвета — в порядке палитры, красный первый");
check(colorRank(null) === 6 && colorRank("") === 6 && colorRank("чужой") === 6, "без метки и неизвестный цвет — после всех");

check(compareKeys([1, "б"], [1, "а"]) > 0, "при равенстве первого ключа решает второй");
check(compareKeys([null], [5]) > 0 && compareKeys([5], [null]) < 0, "пустое — в конце");
check(compareKeys([desc(null)], [desc(3)]) > 0, "пустое — в конце и при обратном порядке");
check(compareKeys(["Р-999"], ["Р-1021"]) < 0, "номера сравниваются как числа: Р-999 раньше Р-1021");
check(compareKeys(["ёж"], ["Ель"]) !== 0 && compareKeys(["анна"], ["Анна"]) === 0, "регистр в именах не важен");
check(time(null) === null && time(new Date(5)) === 5, "дата превращается в число, пустая — в пусто");

const rows = [
  { id: "a", c: "green" },
  { id: "b", c: null },
  { id: "c", c: "red" },
  { id: "d", c: "amber" },
  { id: "e", c: "red" },
];
const key = (r: (typeof rows)[number]) => [colorRank(r.c), r.id];
check(pageIds(rows, key, { page: 1, pageSize: 2 }).join() === "c,e", "первая страница — красные");
check(pageIds(rows, key, { page: 2, pageSize: 2 }).join() === "d,a", "вторая — жёлтый и зелёный");
check(pageIds(rows, key, { page: 3, pageSize: 2 }).join() === "b", "третья — без метки");
check(inOrder(["e", "c"], rows).map((r) => r.id).join() === "e,c", "дочитанные строки — в отобранном порядке");
check(inOrder(["x", "c"], rows).map((r) => r.id).join() === "c", "пропавшая строка просто пропускается");

check(JSON.stringify(customerColorWhere(undefined)) === "{}", "без отбора — без условия");
check(JSON.stringify(customerColorWhere("red")) === '{"color":"red"}', "отбор по цвету");
check(JSON.stringify(customerColorWhere("none")) === '{"OR":[{"color":null},{"color":""}]}', "«без метки» — и пусто, и пустая строка");

console.log(fails ? `\nНЕ ПРОШЛО: ${fails}` : "\nвсе проверки прошли");
process.exit(fails ? 1 : 0);
