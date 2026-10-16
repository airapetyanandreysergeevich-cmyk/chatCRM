import { api } from "./api";

/** Продажа со склада без ремонта (backend/src/modules/sales). */

export type SalePayment = "CASH" | "CARD" | "TRANSFER";

export const PAYMENT_LABEL: Record<SalePayment, string> = {
  CASH: "Наличные",
  CARD: "Карта",
  TRANSFER: "Перевод",
};

export interface SaleItem {
  id: string;
  stockItemId: string | null;
  name: string;
  sku: string | null;
  qty: number;
  price: number;
  sum: number;
  cost?: number;
}

export interface Sale {
  id: string;
  number: string;
  createdAt: string;
  payment: SalePayment;
  subtotal: number;
  discount: number;
  total: number;
  warrantyDays: number | null;
  warrantyUntil: string | null;
  note: string | null;
  customer: { id: string; name: string; phone: string } | null;
  soldBy: { id: string; fullName: string } | null;
  returnedAt: string | null;
  returnedBy: { id: string; fullName: string } | null;
  returnReason: string | null;
  items: SaleItem[];
}

export interface SalesPage {
  rows: Sale[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
  /** Сумма непрошедших возврат продаж по отбору. */
  sum: number;
}

export interface NewSale {
  items: Array<{ stockItemId: string; qty: number; price: number }>;
  discount: number;
  payment: SalePayment;
  customerId?: string | null;
  warrantyDays?: number | null;
  note?: string;
}

const qs = (p: Record<string, string | number | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== "") s.set(k, String(v));
  const t = s.toString();
  return t ? `?${t}` : "";
};

export const salesApi = {
  list: (p: { q?: string; customerId?: string; page?: number; pageSize?: number } = {}) => api.get<SalesPage>(`/sales${qs(p)}`),
  get: (id: string) => api.get<Sale>(`/sales/${id}`),
  create: (body: NewSale) => api.post<Sale>("/sales", body),
  returnSale: (id: string, reason?: string) => api.post<Sale>(`/sales/${id}/return`, { reason: reason || undefined }),
};

/** Гарантия на проданное: варианты в окне продажи. 0 — без гарантии. */
export const WARRANTY_CHOICES = [0, 7, 14, 30, 90, 180, 365];

const WARRANTY_KEY = "finecrm.sale.warranty";
export function rememberedWarranty(): number {
  try {
    const v = Number(localStorage.getItem(WARRANTY_KEY));
    return WARRANTY_CHOICES.includes(v) && localStorage.getItem(WARRANTY_KEY) !== null ? v : 14;
  } catch {
    return 14;
  }
}
export function rememberWarranty(v: number) {
  try {
    localStorage.setItem(WARRANTY_KEY, String(v));
  } catch {
    // Не запомним — не страшно.
  }
}

export const warrantyLabel = (d: number) =>
  d === 0 ? "Без гарантии" : d % 365 === 0 ? `${d / 365} ${d === 365 ? "год" : "года"}` : d % 30 === 0 && d >= 30 ? `${d / 30} мес.` : `${d} дней`;
