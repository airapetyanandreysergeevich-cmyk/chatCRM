import { api } from "./api";

/**
 * Звонки клиентов (28.10.2026): телефон «FineCRM Телефон» присылает звонки с
 * номеров наших клиентов и записи разговоров, сделанные встроенной звонилкой.
 * В истории ремонта — строкой «📞 Входящий · 3:42 ▶».
 */

export type CallDirection = "IN" | "OUT" | "MISSED" | "REJECTED";

export interface CallItem {
  id: string;
  direction: CallDirection;
  /** У сотрудника без доступа к контактам — маской «•••2233». */
  number: string;
  startedAt: string;
  durationSec: number;
  order: { id: string; number: string } | null;
  customer: { id: string; name: string | null } | null;
  /** Каким телефоном мастерской принят. */
  phone: string | null;
  moved: boolean;
  hasAudio: boolean;
  /** Ссылка на запись — только с правом «Слушает записи звонков». */
  audio: string | null;
  audioBytes: number | null;
}

export interface CallSettings {
  enabled: boolean;
  audio: boolean;
  missed: boolean;
  keepDays: number;
}

export const KEEP_OPTIONS: Array<{ days: number; label: string }> = [
  { days: 90, label: "90 дней" },
  { days: 365, label: "Год" },
  { days: 0, label: "Всегда" },
];

export const DIRECTION_LABEL: Record<CallDirection, string> = {
  IN: "Входящий",
  OUT: "Исходящий",
  MISSED: "Пропущенный",
  REJECTED: "Отклонённый",
};

/** 222 → «3:42», 3725 → «1:02:05». */
export function durationText(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export const callsApi = {
  settings: () => api.get<{ settings: CallSettings; month: { total: number; withAudio: number }; lastAt: string | null }>("/calls/settings"),
  save: (s: CallSettings) => api.put<{ settings: CallSettings }>("/calls/settings", s),
  ofOrder: (orderId: string) => api.get<{ items: CallItem[]; canListen: boolean }>(`/calls?orderId=${orderId}`),
  ofCustomer: (customerId: string) => api.get<{ items: CallItem[]; canListen: boolean }>(`/calls?customerId=${customerId}`),
  move: (id: string, orderId: string | null) => api.patch<CallItem>(`/calls/${id}`, { orderId }),
  targets: (id: string) =>
    api.get<{ items: Array<{ id: string; number: string; acceptedAt: string; issuedAt: string | null; device: { kind: string; brand: string | null; model: string | null } | null }> }>(
      `/calls/${id}/targets`
    ),
};
