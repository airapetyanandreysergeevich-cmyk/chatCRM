import { api } from "./api";
import type { OrderStatus } from "./orders";
import type { StageKey } from "./stages";

/** Склад, закупки, касса и сводка — то, чем мастерская живёт помимо заказов. */

// ------------------------------------------------------------------ сводка

/** Карточка на доске: ровно те поля, что видно на ней глазами. */
export interface BoardCard {
  id: string;
  number: string;
  isUrgent: boolean;
  acceptedAt: string;
  dueAt: string | null;
  status: OrderStatus;
  device: { kind: string; brand: string | null; model: string | null } | null;
  master: { id: string; fullName: string } | null;
  /** Имени нет, если сотруднику не показываются контакты клиентов. */
  customer: { id: string; type: "INDIVIDUAL" | "COMPANY"; name?: string };
}

export interface StageColumn {
  key: StageKey;
  /** Всего заказов на стадии — items может быть обрезан. */
  total: number;
  items: BoardCard[];
}

export interface Summary {
  stages: StageColumn[];
  scope: "mine" | "all";
}

// ------------------------------------------------------------------- склад

export interface StockPlace {
  warehouseId: string;
  warehouse: string;
  qty: number;
}

export interface StockItem {
  id: string;
  sku: string | null;
  name: string;
  unit: string;
  category: string | null;
  minQty: number;
  qty: number;
  low: boolean;
  /** Приходят только тем, кому видна себестоимость. */
  avgCost?: number;
  value?: number;
  places: StockPlace[];
}

export interface StockList {
  items: StockItem[];
  totals: { positions: number; low: number; value?: number };
}

export type MovementType = "IN" | "OUT" | "WRITE_OFF" | "RETURN" | "TRANSFER" | "INVENTORY";

export interface StockMovement {
  id: string;
  type: MovementType;
  typeLabel: string;
  qty: number;
  price?: number | null;
  item: { id: string; name: string; unit: string };
  warehouse: { id: string; name: string };
  order: { id: string; number: string } | null;
  user: { id: string; fullName: string } | null;
  comment: string | null;
  createdAt: string;
}

// ----------------------------------------------------------------- закупки

export type PurchaseStatus = "DRAFT" | "PENDING" | "APPROVED" | "ORDERED" | "RECEIVED" | "REJECTED";

export interface PurchaseItem {
  id: string;
  name: string;
  qty: number;
  unit: string;
  link: string | null;
  expectedPrice: number | null;
  receivedQty: number;
  note: string | null;
  stockItemId: string | null;
}

export interface Purchase {
  id: string;
  number: string;
  status: PurchaseStatus;
  statusLabel: string;
  comment: string | null;
  rejectionReason: string | null;
  createdBy: { id: string; fullName: string } | null;
  approvedBy: { id: string; fullName: string } | null;
  order: { id: string; number: string } | null;
  createdAt: string;
  approvedAt: string | null;
  items: PurchaseItem[];
  total: number;
}

// -------------------------------------------------------------------- касса

export interface CashRegister {
  id: string;
  name: string;
  kind: string;
  balance: number;
}

export interface Transaction {
  id: string;
  direction: "IN" | "OUT";
  amount: number;
  register: { id: string; name: string };
  category: { id: string; name: string } | null;
  order: { id: string; number: string } | null;
  customer: { id: string; name: string } | null;
  user: { id: string; fullName: string } | null;
  comment: string | null;
  createdAt: string;
}

export interface CashList {
  totals: { days: number; income: number; expense: number; todayIncome: number; todayExpense: number };
  items: Transaction[];
}

// --------------------------------------------------------------------- API

const qs = (params: Record<string, string | number | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

export const summaryApi = {
  get: () => api.get<Summary>("/summary"),
};

export const stockApi = {
  list: (params: { search?: string; filter?: string } = {}) =>
    api.get<StockList>(`/stock${qs(params)}`),
  warehouses: () => api.get<Array<{ id: string; name: string; isDefault: boolean }>>("/stock/warehouses"),
  createItem: (body: { sku?: string; name: string; unit?: string; category?: string; minQty?: number }) =>
    api.post<{ id: string; name: string }>("/stock", body),
  updateItem: (id: string, body: Record<string, unknown>) => api.patch(`/stock/${id}`, body),
  move: (body: {
    stockItemId: string;
    warehouseId?: string;
    type: "IN" | "OUT" | "WRITE_OFF" | "RETURN" | "INVENTORY";
    qty: number;
    price?: number;
    orderId?: string;
    salePrice?: number;
    comment?: string;
  }) => api.post<{ id: string; qty: number }>("/stock/movements", body),
  movements: (params: { stockItemId?: string; orderId?: string; limit?: number } = {}) =>
    api.get<StockMovement[]>(`/stock/movements${qs(params)}`),
};

export const purchasesApi = {
  list: (params: { status?: string; orderId?: string } = {}) =>
    api.get<Purchase[]>(`/purchases${qs(params)}`),
  create: (body: {
    orderId?: string;
    comment?: string;
    items: Array<{ name: string; qty: number; unit?: string; link?: string; expectedPrice?: number }>;
  }) => api.post<{ id: string; number: string }>("/purchases", body),
  approve: (id: string) => api.post(`/purchases/${id}/approve`),
  reject: (id: string, reason: string) => api.post(`/purchases/${id}/reject`, { reason }),
  receive: (id: string, items: Array<{ id: string; qty: number; price?: number }>, warehouseId?: string) =>
    api.post<{ status: PurchaseStatus; positions: number }>(`/purchases/${id}/receive`, {
      items,
      ...(warehouseId ? { warehouseId } : {}),
    }),
};

export const financeApi = {
  registers: () => api.get<CashRegister[]>("/finance/registers"),
  list: (params: { days?: number; direction?: string; cashRegisterId?: string } = {}) =>
    api.get<CashList>(`/finance${qs(params)}`),
  add: (body: {
    direction: "IN" | "OUT";
    amount: number;
    cashRegisterId?: string;
    category?: string;
    orderId?: string;
    comment?: string;
  }) => api.post<{ id: string; amount: number }>("/finance", body),
  reverse: (id: string, reason: string) => api.post(`/finance/${id}/reverse`, { reason }),
  forOrder: (orderId: string) =>
    api.get<{ orderId: string; number: string; total: number; paid: number; due: number }>(
      `/finance/order/${orderId}`
    ),
};
