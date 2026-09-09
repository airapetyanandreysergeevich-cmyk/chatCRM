import ExcelJS from "exceljs";

/**
 * Чтение и запись табличных файлов.
 *
 * Отдельным файлом, потому что здесь собраны все мелочи, из-за которых
 * «загрузите Excel» превращается в «у меня не работает»: кодировка русского
 * Excel, точка с запятой вместо запятой, метка порядка байтов, даты как числа.
 */

/**
 * Таблица cp1251. Русский Excel сохраняет csv именно в ней, и файл из него
 * приезжает к нам не в utf-8. Таблица вшита, а не берётся из TextDecoder,
 * потому что набор кодировок в контейнере может оказаться урезанным —
 * и тогда весь импорт молча превратился бы в вопросительные знаки.
 */
const CP1251_HIGH =
  "ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏђ‘’“”•–—™љ›њќћџ ЎўЈ¤Ґ¦§Ё©Є«¬­®Ї°±Ііґµ¶·ё№є»јЅѕїАБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя";

function decodeCp1251(buf: Buffer): string {
  let out = "";
  for (const byte of buf) {
    out += byte < 0x80 ? String.fromCharCode(byte) : CP1251_HIGH[byte - 0x80];
  }
  return out;
}

/** Текст файла: utf-8, если он валиден, иначе считаем, что это Excel из Windows. */
export function decodeText(buf: Buffer): string {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return text.replace(/^﻿/, "");
  } catch {
    return decodeCp1251(buf);
  }
}

/** Разделитель угадываем по первой строке: у русского Excel это точка с запятой. */
export function guessDelimiter(text: string): string {
  const line = text.split(/\r?\n/, 1)[0] ?? "";
  const semicolons = (line.match(/;/g) ?? []).length;
  const commas = (line.match(/,/g) ?? []).length;
  const tabs = (line.match(/\t/g) ?? []).length;
  if (tabs > semicolons && tabs > commas) return "\t";
  return semicolons >= commas ? ";" : ",";
}

/**
 * Свой разбор csv вместо библиотеки: правил всего три (кавычки, удвоенная
 * кавычка внутри, перевод строки внутри кавычек), а лишняя зависимость в
 * обмен на них не окупается.
 */
export function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }

  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }

  // Пустые строки в конце файла — обычное дело, они не ошибка.
  while (rows.length && rows[rows.length - 1].every((c) => c.trim() === "")) rows.pop();
  return rows;
}

export type Cell = string | number | Date | null;

/**
 * Строка файла вместе с её настоящим номером.
 *
 * Номер тащим отдельно, а не считаем по порядку: пустая строка посреди
 * таблицы сдвигает всё, что ниже, и тогда «ошибка в строке 5» указывает
 * человеку не туда. Отчёт, который врёт про номер строки, хуже, чем его
 * отсутствие: по нему идут искать и не находят.
 */
export interface TableRow {
  /** Как строка пронумерована в Excel: шапка — первая. */
  n: number;
  cells: Cell[];
}

export async function readTable(buf: Buffer, fileName: string): Promise<TableRow[]> {
  const isCsv = /\.(csv|txt|tsv)$/i.test(fileName);

  if (isCsv) {
    const text = decodeText(buf);
    return parseCsv(text, guessDelimiter(text)).map((r, i) => ({
      n: i + 1,
      cells: r.map((c) => (c === "" ? null : c)),
    }));
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) return [];

  const rows: TableRow[] = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    // values[0] у ExcelJS всегда пустой — нумерация колонок с единицы.
    const values = (row.values as unknown[]).slice(1);
    rows.push({ n: rowNumber, cells: values.map(toCell) });
  });
  return rows;
}

function toCell(v: unknown): Cell {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) return v;
  if (typeof v === "number" || typeof v === "string") return v;
  // Формулы и ссылки ExcelJS отдаёт объектами — берём то, что видит человек.
  const o = v as { result?: unknown; text?: unknown; richText?: Array<{ text: string }> };
  if (Array.isArray(o.richText)) return o.richText.map((p) => p.text).join("");
  if (o.text !== undefined) return String(o.text);
  if (o.result !== undefined) return String(o.result);
  return String(v);
}

// ------------------------------------------------------------------ запись

export interface SheetData {
  name: string;
  columns: Array<{ title: string; width?: number }>;
  rows: Array<Array<string | number | Date | null>>;
}

export async function writeXlsx(sheets: SheetData[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "FineCRM";
  wb.created = new Date();

  for (const sheet of sheets) {
    const ws = wb.addWorksheet(sheet.name.slice(0, 31));
    ws.columns = sheet.columns.map((c) => ({ header: c.title, width: c.width ?? 18 }));
    ws.getRow(1).font = { bold: true };
    // Шапка остаётся на месте при прокрутке — иначе на трёхстах строках
    // непонятно, что в какой колонке.
    ws.views = [{ state: "frozen", ySplit: 1 }];
    for (const row of sheet.rows) ws.addRow(row);
  }

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

export function writeCsv(sheet: SheetData): Buffer {
  const esc = (v: string | number | Date | null): string => {
    if (v === null || v === undefined) return "";
    const s = v instanceof Date ? formatDate(v) : String(v);
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const lines = [
    sheet.columns.map((c) => esc(c.title)).join(";"),
    ...sheet.rows.map((r) => r.map(esc).join(";")),
  ];

  // Метка порядка байтов обязательна: без неё Excel открывает utf-8
  // как cp1251 и вместо русского текста показывает кракозябры.
  return Buffer.from("﻿" + lines.join("\r\n") + "\r\n", "utf8");
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot", "'": "#39" }[c]};`);

export function writeHtml(sheets: SheetData[], title: string): Buffer {
  const table = (sheet: SheetData): string => `
    <h2>${escapeHtml(sheet.name)} <small>${sheet.rows.length} строк</small></h2>
    <table>
      <thead><tr>${sheet.columns.map((c) => `<th>${escapeHtml(c.title)}</th>`).join("")}</tr></thead>
      <tbody>${sheet.rows
        .map(
          (r) =>
            `<tr>${r
              .map((v) => `<td>${escapeHtml(v instanceof Date ? formatDate(v) : String(v ?? ""))}</td>`)
              .join("")}</tr>`
        )
        .join("")}</tbody>
    </table>`;

  const html = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  body { font: 14px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; margin: 24px; color: #16181d; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 28px 0 8px; }
  h2 small { font-weight: 400; color: #6b7280; margin-left: 6px; }
  p.meta { color: #6b7280; margin: 0 0 8px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { border: 1px solid #d8dbe0; padding: 5px 8px; text-align: left; vertical-align: top; }
  th { background: #f3f4f6; position: sticky; top: 0; }
  tbody tr:nth-child(even) { background: #fafafa; }
  @media print { body { margin: 0; } th { position: static; } }
</style></head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <p class="meta">Выгружено ${formatDate(new Date())}</p>
  ${sheets.map(table).join("")}
</body></html>`;

  return Buffer.from(html, "utf8");
}

const pad = (n: number): string => String(n).padStart(2, "0");

export function formatDate(d: Date): string {
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
