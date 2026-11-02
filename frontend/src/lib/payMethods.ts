import { useEffect, useState } from "react";
import { api } from "./api";

/**
 * Способы оплаты (03.11.2026): «Наличные», «Безнал» и свои способы
 * мастерской — «Банковский перевод», «Криптовалюта»…
 *
 * У своего способа: как он выглядит в акте (наличный / безналичный расчёт),
 * касса, комиссия и сотрудники, которые могут принять деньги на себя. Тогда
 * деньги из кассы сразу уходят сотруднику выплатой, а он подтверждает
 * получение (💵 в шапке).
 */

export type ActKind = "CASH" | "CARD";

export interface PayMethod {
  id: string;
  name: string;
  actKind: ActKind;
  cashRegisterId: string | null;
  register: string | null;
  commissionPct: number | null;
  recipients: Array<{ id: string; name: string }>;
  isActive: boolean;
}

export interface PayMethodInput {
  name: string;
  actKind: ActKind;
  cashRegisterId: string | null;
  commissionPct: number | null;
  recipientIds: string[];
  isActive?: boolean;
}

/** Выбор в окне оплаты: CASH, CARD или id своего способа; кому — только у своего. */
export interface PayChoice {
  method: string;
  recipientId: string | null;
}

export const ACT_TEXT: Record<ActKind, string> = { CASH: "наличный расчёт", CARD: "безналичный расчёт" };

export const BUILTIN: Array<{ id: "CASH" | "CARD"; name: string; actKind: ActKind }> = [
  { id: "CASH", name: "Наличные", actKind: "CASH" },
  { id: "CARD", name: "Безнал", actKind: "CARD" },
];

export const payMethodsApi = {
  list: () => api.get<{ items: PayMethod[]; canManage: boolean }>("/pay-methods"),
  manage: () =>
    api.get<{
      items: PayMethod[];
      canManage: boolean;
      registers: Array<{ id: string; name: string; kind: string }>;
      staff: Array<{ id: string; name: string }>;
    }>("/pay-methods?all=1"),
  create: (b: PayMethodInput) => api.post<{ id: string }>("/pay-methods", b),
  update: (id: string, b: Partial<PayMethodInput>) => api.patch<{ ok: true }>(`/pay-methods/${id}`, b),
  reorder: (ids: string[]) => api.put<{ ok: true }>("/pay-methods/order", { ids }),
};

let cache: { at: number; items: PayMethod[] } | null = null;

/** Активные свои способы — для окон оплаты. Держим минуту: окно выдачи открывают часто. */
export function usePayMethods(): PayMethod[] {
  const [items, setItems] = useState<PayMethod[]>(cache?.items ?? []);
  useEffect(() => {
    if (cache && Date.now() - cache.at < 60_000) return;
    let live = true;
    payMethodsApi
      .list()
      .then((r) => {
        cache = { at: Date.now(), items: r.items };
        if (live) setItems(r.items);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return items;
}

export const dropPayMethodsCache = () => {
  cache = null;
};

/** Название способа по коду или id — для подписей. */
export function methodName(method: string, own: PayMethod[]): string {
  return BUILTIN.find((b) => b.id === method)?.name ?? own.find((m) => m.id === method)?.name ?? (method === "TRANSFER" ? "Перевод" : "Свой способ");
}

export function actOf(method: string, own: PayMethod[]): ActKind {
  if (method === "CASH") return "CASH";
  return own.find((m) => m.id === method)?.actKind ?? "CARD";
}

// ------------------------------------------------------------------ деньги клиента у сотрудника

export interface IncomingPayment {
  id: string;
  amount: number;
  at: string;
  method: string | null;
  order: { id: string; number: string; device: string | null; customer: string | null } | null;
  sale: boolean;
  takenBy: string | null;
}

export const incomingApi = {
  list: () => api.get<{ items: IncomingPayment[] }>("/salary/incoming"),
  confirm: (id: string) => api.post<{ ok: true }>(`/salary/payouts/${id}/confirm`),
  dispute: (id: string) => api.post<{ ok: true }>(`/salary/payouts/${id}/dispute`),
  resolve: (id: string, action: "received" | "cancel") => api.post<{ ok: true }>(`/salary/payouts/${id}/resolve`, { action }),
};
