/**
 * «Редактор бланков» (05.11.2026): чистка бланка и HTML текста — то, что
 * сервер пропускает в базу из сохранения и чужого файла.
 *
 *   npx tsx test/doc-layouts.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
import { cleanDesign, fieldsUsed, sanitizeHtml } from "../src/modules/blanks/blankModel";

let fails = 0;
const check = (ok: boolean, msg: string, extra?: unknown) => {
  console.log((ok ? "ok    " : "БЕДА  ") + msg + (ok || extra === undefined ? "" : `  → ${JSON.stringify(extra)}`));
  if (!ok) fails += 1;
};

// ------------------------------------------------------------ копии модели
const back = readFileSync(join(__dirname, "../src/modules/blanks/blankModel.ts"), "utf8");
const front = readFileSync(join(__dirname, "../../frontend/src/lib/blankModel.ts"), "utf8");
check(back === front, "blankModel.ts одинаковый у сервера и интерфейса");

// ------------------------------------------------------------ HTML
const s = (h: string) => sanitizeHtml(h);
check(s("<b>Клиент:</b> <span data-f=\"customer\">Клиент</span>") === '<b>Клиент:</b> <span data-f="customer"></span>', "поле хранится пустым", s("<b>Клиент:</b> <span data-f=\"customer\">Клиент</span>"));
check(s('<img src=x onerror="alert(1)">текст') === "текст", "картинка с обработчиком — прочь", s('<img src=x onerror="alert(1)">текст'));
check(s("<script>alert(1)</script>ок") === "ок", "скрипт вместе с содержимым — прочь", s("<script>alert(1)</script>ок"));
check(s('<div onclick="x()" style="text-align: center; position: fixed">А</div>') === '<div style="text-align: center">А</div>', "обработчик и чужой стиль — прочь", s('<div onclick="x()" style="text-align: center; position: fixed">А</div>'));
check(s('<span style="font-size: 16px; color: rgb(255, 0, 0); background: url(javascript:x)">к</span>') === '<span style="font-size: 12pt; color: #ff0000">к</span>', "px → pt, rgb → #, url — прочь", s('<span style="font-size: 16px; color: rgb(255, 0, 0); background: url(javascript:x)">к</span>'));
check(s('<a href="javascript:alert(1)">ссылка</a>') === "ссылка", "ссылка — только текст");
check(s("1 < 2 & 3 > 2") === "1 &lt; 2 & 3 &gt; 2", "знаки в тексте экранируются", s("1 < 2 & 3 > 2"));
check(s('<span data-f="x&quot;onload=1">а</span>') === "<span>а</span>", "кривой ключ поля — не поле", s('<span data-f="x&quot;onload=1">а</span>'));
check(s("<div><b>не закрыт") === "<div><b>не закрыт</b></div>", "незакрытые теги закрываются");
check(s('<span style="font-family: &quot;PT Serif&quot;, serif">т</span>') === '<span style="font-family: &quot;PT Serif&quot;, &quot;Times New Roman&quot;, serif">т</span>', "шрифт — из нашего списка", s('<span style="font-family: &quot;PT Serif&quot;, serif">т</span>'));
check(s('<p style="font-family: Comic Sans">т</p>') === "<p>т</p>", "чужой шрифт — прочь");
check(s('<o:p></o:p><font face="Arial" color="red">Word</font>') === "Word", "мусор из Word — прочь, текст остаётся", s('<o:p></o:p><font face="Arial" color="red">Word</font>'));

// ------------------------------------------------------------ бланк
const d = cleanDesign({
  page: { size: "A5", landscape: true, margin: 99 },
  els: [
    { id: "t1", type: "text", x: 10, y: 10, w: 50, h: 8, html: "<b>№</b> <span data-f=\"number\"></span>", st: { size: 200, font: "comic", color: "red" }, grow: true },
    { id: "t1", type: "text", x: "15", y: 20, w: 50, h: 8, html: "дубль id" },
    { type: "image", x: 0, y: 0, w: 10, h: 10, src: "https://evil/x.png" },
    { type: "image", x: 0, y: 0, w: 10, h: 10, src: "logo" },
    { type: "image", x: 0, y: 0, w: 10, h: 10, src: "data:image/svg+xml;base64,PHN2Zz4=" },
    { type: "table", x: 10, y: 40, w: 190, h: 12, source: "hack", cols: [{ key: "name", title: "Наименование", w: 100 }, { key: "rm -rf", title: "x", w: 10 }] },
    { type: "table", x: 10, y: 40, w: 190, h: 12, cols: [] },
    { type: "code", x: 10, y: 60, w: 40, h: 12, kind: "qr", value: "https://отзыв/{number}" },
    { type: "virus", x: 1, y: 1, w: 1, h: 1 },
  ],
});
check(d.page.size === "A5" && d.page.landscape && d.page.margin === 40, "лист: A5 альбомный, поля зажаты", d.page);
check(d.els.length === 5, "выброшены: картинка по ссылке, svg, таблица без столбцов, чужой тип", d.els.map((e) => e.type));
const t = d.els[0];
check(t.type === "text" && t.st.size === 72 && t.st.font === "pt-sans" && t.st.color === "#000000" && t.grow && t.hideEmpty, "текст: размер зажат, шрифт и цвет — по умолчанию", t);
check(d.els[1].id !== "t1" && d.els[1].x === 15, "повтор id получает новый, число из строки — число");
const tb = d.els.find((e) => e.type === "table");
check(tb?.type === "table" && tb.source === "lines" && tb.cols.length === 1, "таблица: источник по умолчанию, чужой столбец — прочь", tb);
check(fieldsUsed(d).sort().join(",") === "number", "поля бланка: из текста и QR-кода", fieldsUsed(d));
check(cleanDesign(null).els.length === 0 && cleanDesign("x").page.size === "A4", "мусор вместо бланка — пустой лист");
const many = cleanDesign({ els: Array.from({ length: 500 }, () => ({ type: "line", x: 1, y: 1, w: 10, h: 1 })) });
check(many.els.length === 300, "не больше 300 элементов");
const big = "data:image/png;base64," + "A".repeat(1_000_000);
const heavy = cleanDesign({ els: Array.from({ length: 6 }, () => ({ type: "image", x: 0, y: 0, w: 10, h: 10, src: big })) });
check(heavy.els.length === 3, "картинок не больше 4 млн знаков на бланк", heavy.els.length);

console.log(fails ? `\nПровалов: ${fails}` : "\nВсё в порядке");
process.exit(fails ? 1 : 0);
