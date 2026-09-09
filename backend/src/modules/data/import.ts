import type { Prisma } from "@prisma/client";
import { DATASETS, matchColumns, type ColumnDef, type DatasetKey } from "./dataset";
import type { Cell, TableRow } from "./tableFile";

/**
 * Загрузка данных из файла — в два шага.
 *
 * Первый шаг только разбирает файл и рассказывает, что произойдёт. Второй
 * применяет разобранное. Так ошибка в файле видна до того, как она попала в
 * базу, а не после: откатывать импорт в живой мастерской нечем.
 */

export const MAX_IMPORT_ROWS = 5000;

export interface RowIssue {
  /** Номер строки в файле, как его видит человек в Excel: шапка — первая. */
  row: number;
  message: string;
}

export interface ParsedRow {
  row: number;
  values: Record<string, string>;
  /** Существующая запись, с которой строка совпала. */
  existingId?: string;
  action: "create" | "update";
}

export interface ImportPreview {
  dataset: DatasetKey;
  fileName: string;
  totalRows: number;
  toCreate: number;
  toUpdate: number;
  issues: RowIssue[];
  /** Колонки файла, которые мы не узнали, — они будут пропущены. */
  ignoredColumns: string[];
  /** Обязательные колонки, которых в файле нет. */
  missingColumns: string[];
  /** Первые несколько строк — чтобы человек глазами убедился, что понял файл верно. */
  sample: Array<Record<string, string>>;
}

const asText = (v: Cell): string => {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  return String(v).trim();
};

/** Телефон сравниваем по цифрам: +7(921)555-00-11 и 89215550011 — один человек. */
export function phoneKey(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && (digits[0] === "8" || digits[0] === "7")) return "7" + digits.slice(1);
  if (digits.length === 10) return "7" + digits;
  return digits;
}

export function parseNumber(raw: string): number | null {
  if (!raw) return null;
  // «1 234,56» и «1234.56» — оба варианта живут в реальных файлах.
  const cleaned = raw.replace(/\s| /g, "").replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Разбор строк файла в общий вид + проверка. Ничего не пишет.
 */
export async function parseRows(
  tx: Prisma.TransactionClient,
  dataset: DatasetKey,
  table: TableRow[]
): Promise<{ preview: ImportPreview; rows: ParsedRow[] }> {
  const def = DATASETS[dataset];
  const issues: RowIssue[] = [];

  const headerRow = table[0]?.cells ?? [];
  const mapping = matchColumns(headerRow, def);

  const ignoredColumns = headerRow
    .map((h, i) => (mapping.has(i) ? null : asText(h)))
    .filter((h): h is string => !!h);

  const known = new Set([...mapping.values()].map((c) => c.title));
  const missingColumns = def.columns
    .filter((c) => c.required && !known.has(c.title))
    .map((c) => c.title);

  const body = table.slice(1);
  const rows: ParsedRow[] = [];

  if (missingColumns.length) {
    return {
      rows: [],
      preview: {
        dataset,
        fileName: "",
        totalRows: body.length,
        toCreate: 0,
        toUpdate: 0,
        issues,
        ignoredColumns,
        missingColumns,
        sample: [],
      },
    };
  }

  // Ключи уже разобранных строк: дубликат внутри одного файла — частая беда
  // выгрузок из старых программ, и молча схлопывать его нельзя.
  const seen = new Map<string, number>();

  for (let i = 0; i < body.length && rows.length < MAX_IMPORT_ROWS; i += 1) {
    const line = body[i].cells;
    // Настоящий номер строки, а не порядковый: по нему человек пойдёт
    // искать ошибку в своём файле.
    const rowNo = body[i].n;

    if (!line || line.every((c) => asText(c) === "")) continue;

    const values: Record<string, string> = {};
    for (const [idx, col] of mapping) values[col.title] = asText(line[idx]);

    const rowIssues = validateRow(def.columns, values, rowNo);
    if (rowIssues.length) {
      issues.push(...rowIssues);
      continue;
    }

    const key = matchKey(dataset, values);
    if (key) {
      const before = seen.get(key);
      if (before !== undefined) {
        issues.push({
          row: rowNo,
          message: `повтор строки ${before} в этом же файле (${def.matchBy}: ${key}) — взята первая`,
        });
        continue;
      }
      seen.set(key, rowNo);
    }

    rows.push({ row: rowNo, values, action: "create" });
  }

  if (body.length > MAX_IMPORT_ROWS) {
    issues.push({
      row: body[MAX_IMPORT_ROWS]?.n ?? MAX_IMPORT_ROWS,
      message: `в файле больше ${MAX_IMPORT_ROWS} строк — остальные не разбирались, разбейте файл на части`,
    });
  }

  await markExisting(tx, dataset, rows);

  return {
    rows,
    preview: {
      dataset,
      fileName: "",
      totalRows: body.length,
      toCreate: rows.filter((r) => r.action === "create").length,
      toUpdate: rows.filter((r) => r.action === "update").length,
      issues: issues.slice(0, 200),
      ignoredColumns,
      missingColumns,
      sample: rows.slice(0, 5).map((r) => r.values),
    },
  };
}

function validateRow(columns: ColumnDef[], values: Record<string, string>, row: number): RowIssue[] {
  const out: RowIssue[] = [];
  for (const col of columns) {
    const raw = values[col.title] ?? "";
    if (col.required && !raw) {
      out.push({ row, message: `не заполнена обязательная колонка «${col.title}»` });
      continue;
    }
    if (!raw) continue;

    if (col.kind === "phone" && phoneKey(raw).length < 10) {
      out.push({ row, message: `телефон «${raw}» не похож на номер` });
    }
    if (col.kind === "number" && parseNumber(raw) === null) {
      out.push({ row, message: `в колонке «${col.title}» не число: «${raw}»` });
    }
  }
  return out;
}

function matchKey(dataset: DatasetKey, values: Record<string, string>): string | null {
  if (dataset === "customers") return phoneKey(values["Телефон"] ?? "") || null;
  if (dataset === "orders") return (values["Номер"] ?? "").trim() || null;
  // На складе артикул есть не всегда — тогда сличаем по названию.
  const sku = (values["Артикул"] ?? "").trim();
  return sku || (values["Наименование"] ?? "").trim().toLowerCase() || null;
}

/** Помечаем строки, которые обновят существующие записи, а не создадут новые. */
async function markExisting(
  tx: Prisma.TransactionClient,
  dataset: DatasetKey,
  rows: ParsedRow[]
): Promise<void> {
  if (rows.length === 0) return;

  if (dataset === "customers") {
    // Телефоны в базе хранятся как введены, поэтому сличаем по цифрам уже в коде.
    const existing = await tx.customer.findMany({
      where: { deletedAt: null },
      select: { id: true, phone: true },
    });
    const byKey = new Map(existing.map((c) => [phoneKey(c.phone), c.id]));
    for (const r of rows) {
      const id = byKey.get(phoneKey(r.values["Телефон"] ?? ""));
      if (id) {
        r.existingId = id;
        r.action = "update";
      }
    }
    return;
  }

  if (dataset === "orders") {
    const numbers = rows.map((r) => (r.values["Номер"] ?? "").trim()).filter(Boolean);
    const existing = await tx.order.findMany({
      where: { number: { in: numbers } },
      select: { id: true, number: true },
    });
    const byNumber = new Map(existing.map((o) => [o.number, o.id]));
    for (const r of rows) {
      const id = byNumber.get((r.values["Номер"] ?? "").trim());
      if (id) {
        r.existingId = id;
        r.action = "update";
      }
    }
    return;
  }

  const items = await tx.stockItem.findMany({ select: { id: true, sku: true, name: true } });
  const bySku = new Map(items.filter((i) => i.sku).map((i) => [i.sku as string, i.id]));
  const byName = new Map(items.map((i) => [i.name.trim().toLowerCase(), i.id]));
  for (const r of rows) {
    const sku = (r.values["Артикул"] ?? "").trim();
    const id = (sku && bySku.get(sku)) || byName.get((r.values["Наименование"] ?? "").trim().toLowerCase());
    if (id) {
      r.existingId = id;
      r.action = "update";
    }
  }
}
