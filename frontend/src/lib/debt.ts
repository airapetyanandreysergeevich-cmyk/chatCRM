import { api } from "./api";

/**
 * Долги клиентов.
 *
 * Долг нигде не хранится числом — сервер считает его как итог заказа минус
 * проведённые деньги. Здесь только типы и вызовы: считать то же самое ещё раз
 * на клиенте значило бы завести вторую правду, которая рано или поздно
 * разойдётся с первой на глазах у человека, стоящего у стойки.
 */

export type PaidBy = "CASH" | "CARD";
export type PaymentMethod = PaidBy | "DEBT";

export const PAYMENT_LABEL: Record<PaymentMethod, string> = {
  CASH: "Наличные",
  CARD: "Безнал",
  DEBT: "Задолженность",
};

export interface OrderDebt {
  orderId: string;
  number: string;
  due: number;
  total: number;
  issuedAt: string | null;
  debtDueAt: string | null;
  overdue: boolean;
}

export interface CustomerDebt {
  total: number;
  orders: OrderDebt[];
}

/** Остаток к оплате по заказу — его показывает окно выдачи. */
export interface OrderBalance {
  orderId: string;
  number: string;
  total: number;
  paid: number;
  due: number;
}

export const debtApi = {
  balance: (orderId: string) => api.get<OrderBalance>(`/finance/order/${orderId}`),
  /** Без суммы гасится весь долг заказа. */
  pay: (body: { orderId: string; amount?: number; method: PaidBy }) =>
    api.post<{ paid: number; left: number }>("/finance/debt/pay", body),
};
