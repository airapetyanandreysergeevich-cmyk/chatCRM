import { api } from "./api";

/** Кнопки быстрого заполнения на бланке приёма. */

export type QuickPickField = "completeness" | "appearance" | "complaint";

export interface QuickPick {
  id: string;
  label: string;
  /** Сколько раз пункт попадал в заказ — по этому числу кнопки и выстроены. */
  uses: number;
  /** Нельзя убрать и переименовать: по кнопке ставится флаг гарантии. */
  locked: boolean;
}

export const quickPicksApi = {
  list: (field: QuickPickField) => api.get<QuickPick[]>(`/quick-picks/${field}`),
  add: (field: QuickPickField, label: string) => api.post<QuickPick>(`/quick-picks/${field}`, { label }),
  rename: (field: QuickPickField, id: string, label: string) =>
    api.patch(`/quick-picks/${field}/${id}`, { label }),
  remove: (field: QuickPickField, id: string) => api.del(`/quick-picks/${field}/${id}`),
};
