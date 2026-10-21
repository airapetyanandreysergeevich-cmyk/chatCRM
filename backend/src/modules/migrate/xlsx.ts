import ExcelJS from "exceljs";
import { BadFile, type SqlRow, type SqlTable } from "./sqlite";

/**
 * Выгрузка другой программы в Excel — теми же «таблицами», что и база SQLite:
 * лист — таблица, первая строка — названия колонок.
 *
 * Даты Excel хранит без часового пояса, а ExcelJS отдаёт их так, будто это
 * UTC. Отдаём их строкой «2023-12-15T17:54» — ровно то время, что видно в
 * ячейке, а источник уже сам решает, как его прочитать.
 */

const p2 = (n: number) => String(n).padStart(2, "0");
const naive = (d: Date) =>
  `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}T${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;

/** Название колонки: неразрывные пробелы и пробелы по краям — убрать. */
const headName = (v: unknown) => String(v ?? "").replace(/ /g, " ").replace(/\s+/g, " ").trim();

function value(v: unknown): string | number | null {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : naive(v);
  if (typeof v === "number" || typeof v === "string") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  const o = v as { result?: unknown; text?: unknown; richText?: Array<{ text: string }> };
  if (Array.isArray(o.richText)) return o.richText.map((p) => p.text).join("");
  if (o.result !== undefined) return value(o.result);
  if (o.text !== undefined) return String(o.text);
  return String(v);
}

export const isXlsx = (buf: Buffer) => buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;

export async function readXlsxTables(buf: Buffer): Promise<Record<string, SqlTable>> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
  } catch {
    throw new BadFile("это не книга Excel (.xlsx) или файл повреждён");
  }
  const out: Record<string, SqlTable> = {};
  for (const ws of wb.worksheets) {
    let columns: string[] | null = null;
    const rows: SqlRow[] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const cells = (row.values as unknown[]).slice(1);
      if (!columns) {
        columns = cells.map(headName);
        return;
      }
      const r: SqlRow = {};
      columns.forEach((c, i) => {
        if (c) r[c] = value(cells[i]);
      });
      rows.push(r);
    });
    if (columns) out[ws.name] = { columns: (columns as string[]).filter(Boolean), rows };
  }
  if (!Object.keys(out).length) throw new BadFile("в книге нет ни одного листа с данными");
  return out;
}
