"use strict";

/**
 * Меню «Копировать / Вставить» в полях ввода.
 *
 *   node test/edit-menu.js
 */

const { editMenuItems } = require("../src/editMenu");

let bad = 0;
const ok = (name, cond) => {
  console.log((cond ? "ok     " : "ПЛОХО  ") + name);
  if (!cond) bad += 1;
};
const by = (items, role) => items.find((i) => i.role === role);

ok("не поле ввода — меню нет", editMenuItems({ isEditable: false, selectionText: "abc" }, "x").length === 0);

let items = editMenuItems({ isEditable: true, selectionText: "", editFlags: { canCopy: false, canPaste: true } }, "+7 912");
ok("в поле — два пункта, по-русски", items.map((i) => i.label).join() === "Копировать,Вставить");
ok("ничего не выделено — «Копировать» серый", by(items, "copy").enabled === false);
ok("в буфере есть текст — «Вставить» доступен", by(items, "paste").enabled === true);

items = editMenuItems({ isEditable: true, selectionText: "Иван", editFlags: { canCopy: true, canPaste: true } }, "");
ok("выделено — «Копировать» доступен", by(items, "copy").enabled === true);
ok("буфер пуст — «Вставить» серый", by(items, "paste").enabled === false);

items = editMenuItems({ isEditable: true, selectionText: "x", editFlags: { canCopy: true, canPaste: false } }, "y");
ok("поле только для чтения — вставлять нельзя", by(items, "paste").enabled === false);
ok("роли — системные copy и paste", items.every((i) => i.role === "copy" || i.role === "paste"));

console.log(bad ? `\nНЕ ПРОШЛО: ${bad}` : "\nвсе проверки прошли");
process.exitCode = bad ? 1 : 0;
