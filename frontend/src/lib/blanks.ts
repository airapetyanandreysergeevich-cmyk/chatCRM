import { api } from "./api";

/**
 * Свои бланки из Excel (03.11.2026): шаблон .xlsx с метками {номер},
 * {клиент}… Печать — листом в браузере, или заполненный .xlsx (backend/src/modules/blanks).
 */

export type BlankTarget = "order" | "sale";

export interface BlankScan {
  known: string[];
  unknown: Array<{ mark: string; suggest: string | null }>;
  lists: string[];
  sheets: number;
}

export interface Blank {
  id: string;
  name: string;
  target: BlankTarget;
  fileName: string;
  marks: BlankScan;
  updatedAt: string;
}

export interface MarkInfo {
  key: string;
  hint: string;
  money?: boolean;
}

export interface MarksCatalog {
  marks: MarkInfo[];
  lists: Array<{ key: string; title: string; fields: MarkInfo[] }>;
  rowNo: string;
}

export interface RenderedSheet {
  name: string;
  html: string;
  width: number;
  height: number;
  landscape: boolean;
}

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Сохранить файл из ответа сервера — как выгрузки «Баз». */
export function saveBlob(blob: Blob, fileName: string) {
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

const ref = (o: { orderId?: string; saleId?: string }) => (o.orderId ? `orderId=${o.orderId}` : `saleId=${o.saleId}`);

export const blanksApi = {
  list: (target?: BlankTarget) => api.get<{ items: Blank[]; canManage: boolean }>(`/blanks${target ? `?for=${target}` : ""}`),
  marks: () => api.get<{ order: MarksCatalog; sale: MarksCatalog }>("/blanks/marks"),
  upload: (file: File, name: string, target: BlankTarget) =>
    api.raw<Blank>(`/blanks?name=${encodeURIComponent(name)}&for=${target}&fileName=${encodeURIComponent(file.name)}`, "POST", file, XLSX),
  replace: (id: string, file: File) => api.raw<Blank>(`/blanks/${id}/file?fileName=${encodeURIComponent(file.name)}`, "PUT", file, XLSX),
  update: (id: string, body: { name?: string; for?: BlankTarget }) => api.patch<Blank>(`/blanks/${id}`, body),
  remove: (id: string) => api.del<{ ok: true }>(`/blanks/${id}`),
  example: async (target: BlankTarget) => {
    const r = await api.download(`/blanks/example.xlsx?for=${target}`);
    saveBlob(r.blob, r.fileName);
  },
  template: async (id: string) => {
    const r = await api.download(`/blanks/${id}/file`);
    saveBlob(r.blob, r.fileName);
  },
  render: (id: string, o: { orderId?: string; saleId?: string }) => api.get<{ name: string; sheets: RenderedSheet[] }>(`/blanks/${id}/render?${ref(o)}`),
  fill: async (id: string, o: { orderId?: string; saleId?: string }) => {
    const r = await api.download(`/blanks/${id}/fill?${ref(o)}`);
    saveBlob(r.blob, r.fileName);
  },
};
