/**
 * Свои бланки из Excel (03.11.2026): метки, строки-списки, объединения,
 * числа по формату, сумма прописью, лист для печати.
 *
 *   npx tsx test/blanks.ts
 */
import ExcelJS from "exceljs";
import { example, fill, formatNumber, scan, toBuffer, toHtml } from "../src/modules/blanks/excel";
import { norm, suggest } from "../src/modules/blanks/marks";
import { numberWords, rublesWords } from "../src/modules/blanks/words";
import { normalizeParts } from "../src/lib/payment";

let fails = 0;
const check = (ok: boolean, msg: string, extra?: unknown) => {
  console.log((ok ? "ok    " : "БЕДА  ") + msg + (ok || extra === undefined ? "" : `  → ${JSON.stringify(extra)}`));
  if (!ok) fails += 1;
};

async function main() {
  // ------------------------------------------------------------ прописью
  check(numberWords(4700) === "четыре тысячи семьсот", "4700 словами", numberWords(4700));
  check(numberWords(1021) === "одна тысяча двадцать один", "1021 — «одна тысяча»", numberWords(1021));
  check(numberWords(2002002) === "два миллиона две тысячи два", "2 002 002", numberWords(2002002));
  check(numberWords(11) === "одиннадцать" && numberWords(0) === "ноль", "11 и 0");
  check(rublesWords(4700) === "Четыре тысячи семьсот рублей 00 копеек", "рубли прописью", rublesWords(4700));
  check(rublesWords(1.21) === "Один рубль 21 копейка", "1 рубль 21 копейка", rublesWords(1.21));
  check(rublesWords(22.03) === "Двадцать два рубля 03 копейки", "22 рубля 03 копейки", rublesWords(22.03));

  // ------------------------------------------------------------ числа
  check(formatNumber(1500, '#,##0 "₽";-#,##0 "₽"') === "1 500 ₽", "формат рублей", formatNumber(1500, '#,##0 "₽";-#,##0 "₽"'));
  check(formatNumber(-200, '#,##0 "₽";-#,##0 "₽"') === "-200 ₽", "минус", formatNumber(-200, '#,##0 "₽";-#,##0 "₽"'));
  check(formatNumber(3850, '#,##0.00\\ "р."') === "3 850,00 р.", "копейки и «р.»", formatNumber(3850, '#,##0.00\\ "р."'));
  check(formatNumber(0.15, "0%") === "15%", "проценты");

  // ------------------------------------------------------------ метки
  check(norm(" Итого   Прописью ") === "итого прописью" && norm("{Дата приёма}".slice(1, -1)) === "дата приема", "метка без регистра, «ё» и пробелов");
  check(suggest("телефн", "order") === "телефон", "опечатка — подсказка", suggest("телефн", "order"));

  // ------------------------------------------------------------ шаблон руками
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Бланк");
  ws.columns = [{ width: 5 }, { width: 30 }, { width: 10 }, { width: 12 }];
  ws.getCell("A1").value = "Заказ {номер} — {Клиент}";
  ws.mergeCells("A1:D1");
  ws.getCell("A3").value = "{№}";
  ws.getCell("B3").value = "{работа}";
  ws.mergeCells("B3:C3");
  ws.getCell("D3").value = "{работа сумма}";
  ws.getCell("B3").border = { bottom: { style: "thin" } };
  ws.getRow(3).height = 20;
  ws.getCell("A5").value = "Итого: {итого}";
  ws.getCell("D5").value = "{итого}";
  ws.mergeCells("A6:D6");
  ws.getCell("A6").value = { richText: [{ text: "Прописью: ", font: { bold: true } }, { text: "{итого прописью}" }] };
  ws.getCell("A8").value = "{телефн}";
  const tpl = await toBuffer(wb);

  const s = await scan(tpl, "order");
  check(s.known.includes("номер") && s.known.includes("клиент") && s.known.includes("работа сумма") && s.known.includes("№"), "узнал метки", s.known);
  check(s.unknown.length === 1 && s.unknown[0].mark === "телефн" && s.unknown[0].suggest === "телефон", "не узнал опечатку и подсказал", s.unknown);
  check(s.lists.includes("Работы"), "нашёл строку-список", s.lists);

  const money = new Set(["итого", "работа сумма", "работа цена"]);
  const filled = await fill(tpl, "order", {
    values: { номер: "Р-1", клиент: "Иван", итого: 4700, "итого прописью": rublesWords(4700) },
    lists: {
      работа: [
        { работа: "Чистка", "работа сумма": 1500 },
        { работа: "Пайка", "работа сумма": 2000 },
        { работа: "Прошивка", "работа сумма": 1200 },
      ],
    },
    money,
  });
  const f = filled.worksheets[0];
  check(f.getCell("A1").value === "Заказ Р-1 — Иван", "метки в тексте", f.getCell("A1").value);
  check(f.getCell("B3").value === "Чистка" && f.getCell("B4").value === "Пайка" && f.getCell("B5").value === "Прошивка", "строка работ размножилась", [f.getCell("B3").value, f.getCell("B4").value, f.getCell("B5").value]);
  check(f.getCell("A4").value === "2" && f.getCell("A5").value === "3", "{№} — номер строки");
  check(f.getCell("D4").value === 2000 && /₽/.test(f.getCell("D4").numFmt ?? ""), "сумма работы — числом с форматом", [f.getCell("D4").value, f.getCell("D4").numFmt]);
  check(f.getRow(5).height === 20, "высота строки сохранилась", f.getRow(5).height);
  check(!!f.getCell("B5").border?.bottom, "рамка скопирована");
  const merges = ((f as unknown as { model: { merges: string[] } }).model.merges ?? []).sort();
  check(merges.includes("B3:C3") && merges.includes("B4:C4") && merges.includes("B5:C5"), "объединение в каждой строке списка", merges);
  check(merges.includes("A8:D8") && merges.includes("A1:D1"), "объединение ниже сдвинулось, выше — на месте", merges);
  check(f.getCell("A7").value === "Итого: 4 700 ₽" && f.getCell("D7").value === 4700, "итог: в тексте и числом", [f.getCell("A7").value, f.getCell("D7").value]);
  const rt = f.getCell("A8").value as { richText: Array<{ text: string }> };
  check(rt.richText.map((r) => r.text).join("") === "Прописью: Четыре тысячи семьсот рублей 00 копеек", "богатый текст: метка заменена, жирный сохранён", rt);
  check(f.getCell("A10").value === "{телефн}", "незнакомая метка — как есть");

  const empty = await fill(tpl, "order", { values: { номер: "Р-2" }, lists: { работа: [] }, money });
  check(empty.worksheets[0].getCell("B3").value === "" && empty.worksheets[0].getCell("A5").value === "Итого: {итого}", "пустой список — строка пустая, ниже не сдвинулось", [empty.worksheets[0].getCell("B3").value, empty.worksheets[0].getCell("A5").value]);

  const html = toHtml(filled);
  check(html.length === 1 && /Прошивка/.test(html[0].html) && /colspan="2"/.test(html[0].html) && /colspan="4"/.test(html[0].html), "лист для печати: строки и объединения", html[0]?.html.slice(0, 200));
  check(/4 700 ₽/.test(html[0].html) && /font-weight:700/.test(html[0].html), "лист: деньги по формату, жирный шрифт");
  check(html[0].width > 300 && html[0].width < 600, "лист: ширина из столбцов", html[0].width);

  // ------------------------------------------------------------ образец
  const ex = await example("order");
  const es = await scan(ex, "order");
  check(es.unknown.length === 0 && es.known.length >= 15 && es.sheets === 1, "образец: все метки знакомые, лист «Метки» не печатается", es);
  const exSale = await scan(await example("sale"), "sale");
  check(exSale.unknown.length === 0 && exSale.lists.includes("Товары"), "образец чека", exSale);

  // ------------------------------------------------------------ оплата частями
  const parts = normalizeParts(
    [
      { method: "CASH", amount: 3000 },
      { method: "CARD", amount: 5000 },
      { method: "x", amount: 100 },
    ],
    5000
  );
  check(parts.length === 2 && parts[0].amount === 3000 && parts[1].amount === 2000, "части: не больше суммы к оплате", parts);

  console.log(fails ? `\nПровалов: ${fails}` : "\nВсё в порядке");
  process.exit(fails ? 1 : 0);
}

main();
