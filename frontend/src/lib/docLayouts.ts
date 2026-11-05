import { api } from "./api";
import { BLANK_FORMAT, BLANK_VERSION, cleanDesign, type BlankDesign, type BlankFile, type DocUse, type Target } from "./blankModel";

/** Бланки «Редактора бланков» (backend/src/modules/blanks/layouts.routes.ts). */

export interface LayoutMeta {
  id: string;
  name: string;
  target: Target;
  use: DocUse | null;
  sortOrder: number;
  updatedAt: string;
}
export interface Layout extends LayoutMeta {
  design: BlankDesign;
}

export const USE_LABEL: Record<DocUse, string> = {
  intake: "Квитанция о приёме",
  act: "Акт выполненных работ",
  extra: "Акт доплаты",
  sale: "Товарный чек",
};

export const layoutsApi = {
  list: (target?: Target) => api.get<{ items: LayoutMeta[] }>(`/doc-layouts${target ? `?for=${target}` : ""}`),
  get: (id: string) => api.get<Layout>(`/doc-layouts/${id}`),
  forPrint: (target: Target) => api.get<{ active: Partial<Record<DocUse, Layout>>; tabs: LayoutMeta[] }>(`/doc-layouts/print?for=${target}`),
  create: (body: { name: string; target: Target; use?: DocUse | null; data: BlankDesign }) => api.post<Layout>("/doc-layouts", body),
  update: (id: string, body: { name?: string; use?: DocUse | null; data?: BlankDesign }) => api.put<Layout>(`/doc-layouts/${id}`, body),
  remove: (id: string) => api.del<{ ok: true }>(`/doc-layouts/${id}`),
};

/** Файл обмена: .finecrm-blank (JSON). */
export function exportFile(name: string, target: Target, design: BlankDesign) {
  const file: BlankFile = { format: BLANK_FORMAT, v: BLANK_VERSION, name, target, design, exportedAt: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(file, null, 1)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name.replace(/[\\/:*?"<>|]+/g, " ").trim() || "Бланк"}.finecrm-blank`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Прочитать файл бланка: битый — понятная ошибка; содержимое — через ту же чистку, что на сервере. */
export async function readFile(f: File): Promise<{ name: string; target: Target; design: BlankDesign }> {
  if (f.size > 8 * 1024 * 1024) throw new Error("Файл больше 8 МБ — это не бланк FineCRM");
  let data: unknown;
  try {
    data = JSON.parse(await f.text());
  } catch {
    throw new Error("Это не файл бланка FineCRM: внутри не JSON");
  }
  const o = (data && typeof data === "object" ? data : {}) as Partial<BlankFile>;
  if (o.format !== BLANK_FORMAT) throw new Error("Это не файл бланка FineCRM");
  if (typeof o.v === "number" && o.v > BLANK_VERSION) throw new Error("Бланк сделан в более новой версии FineCRM — обновите программу");
  return {
    name: typeof o.name === "string" && o.name.trim() ? o.name.trim().slice(0, 60) : f.name.replace(/\.finecrm-blank$/i, "").slice(0, 60),
    target: o.target === "sale" ? "sale" : "order",
    design: cleanDesign(o.design),
  };
}
