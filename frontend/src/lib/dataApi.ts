import { api } from "./api";

/** Выгрузка и загрузка данных мастерской. */

export type DatasetKey = "customers" | "orders" | "stock" | "services";
export type FormatKey = "xlsx" | "csv" | "html";

export interface DatasetInfo {
  key: DatasetKey;
  title: string;
  hint: string;
  matchBy: string;
  /** Сколько записей сейчас в разделе. Нужно окну стирания, чтобы назвать число. */
  count: number;
  columns: Array<{ title: string; required: boolean; readOnly: boolean }>;
}

export interface WipeResult {
  datasets: DatasetKey[];
  titles: string[];
  /** Сколько строк ушло, по таблицам базы. */
  rows: Record<string, number>;
  files: number;
  finishedAt: string;
}

export interface FormatInfo {
  key: FormatKey;
  title: string;
  canImport: boolean;
}

export interface DataReference {
  datasets: DatasetInfo[];
  formats: FormatInfo[];
  maxImportRows: number;
}

export interface RowIssue {
  row: number;
  message: string;
  column?: string;
}

export interface ImportPreview {
  dataset: DatasetKey;
  fileName: string;
  totalRows: number;
  toCreate: number;
  toUpdate: number;
  /** Сколько вернётся из удалённых — это не обновление, и называть так нечестно. */
  toRestore: number;
  issues: RowIssue[];
  /** Сколько строк не прошло всего — список замечаний обрезан. */
  issuesTotal: number;
  ignoredColumns: string[];
  missingColumns: string[];
  /** Беды всего файла: съехавшая шапка и прочее, что не про отдельную строку. */
  hints: string[];
  sample: Array<Record<string, string>>;
}

export interface ImportResult {
  created: number;
  updated: number;
  restored: number;
  failed: RowIssue[];
  dataset: DatasetKey;
  fileName: string;
  finishedAt: string;
}

/** Слово, которым владелец подтверждает стирание. Совпадает с проверкой на сервере. */
export const WIPE_WORD = "УДАЛИТЬ";

export const dataApi = {
  reference: () => api.get<DataReference>("/data"),

  /**
   * Стирание разделов насовсем. Слово сверяет и сервер — окно здесь для
   * человека, а не вместо запрета.
   */
  wipe: (datasets: DatasetKey[], confirm: string) =>
    api.del<WipeResult>("/data", { datasets, confirm }),

  /**
   * Скачивание идёт обычным запросом с токеном, а не переходом по ссылке:
   * токен живёт в памяти вкладки, в адресную строку его класть нельзя —
   * он утечёт в журнал сервера и в историю браузера.
   */
  exportFile: async (datasets: DatasetKey[], format: FormatKey): Promise<void> => {
    const query = `datasets=${datasets.join(",")}&format=${format}`;
    const { blob, fileName } = await api.download(`/data/export?${query}`);

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Освобождаем сразу: браузер уже забрал содержимое.
    URL.revokeObjectURL(url);
  },

  parse: (dataset: DatasetKey, file: File) => {
    const form = new FormData();
    form.append("dataset", dataset);
    form.append("file", file);
    return api.upload<{ token: string | null; preview: ImportPreview }>("/data/import/parse", form);
  },

  apply: (token: string) => api.post<ImportResult>("/data/import/apply", { token }),
};
