import { api } from "./api";

/** Зарплата: ведомость за месяц, начисления руками, выплаты, закрытие месяца. */

export interface SalaryRow {
  userId: string;
  name: string;
  role: string | null;
  isActive: boolean;
  percent: number;
  start: number;
  startSet: boolean;
  accrued: number;
  bonus: number;
  paid: number;
  end: number;
  orders: number;
}

export interface SalaryOrder {
  orderId: string;
  number: string;
  at: string;
  /** Итог и запчасти — только тем, кто видит деньги заказа. */
  total?: number;
  parts?: number;
  base: number;
  share: number;
  percent: number;
  amount: number;
}

export interface SalaryDetail {
  orders: SalaryOrder[];
  ready: number;
  issued: number;
  earned: number;
}

export interface SalaryMonth {
  month: string;
  since: string;
  closed: { at: string; by: string | null } | null;
  seesAll: boolean;
  canManage: boolean;
  me: string | null;
  rows: SalaryRow[];
  details: Record<string, SalaryDetail>;
  totals: { start: number; accrued: number; paid: number; end: number } | null;
}

export interface SalaryRecords {
  entries: Array<{ id: string; kind: "OPENING" | "BONUS"; amount: number; comment: string | null; createdAt: string; by: string | null }>;
  payouts: Array<{ id: string; amount: number; paidAt: string; comment: string | null; by: string | null }>;
}

export const salaryApi = {
  month: (month?: string) => api.get<SalaryMonth>(`/salary${month ? `?month=${month}` : ""}`),
  records: (month: string, userId: string) =>
    api.get<SalaryRecords>(`/salary/records?month=${month}&userId=${userId}`),
  addEntry: (userId: string, month: string, amount: number, comment: string) =>
    api.post("/salary/entries", { userId, month, amount, comment }),
  removeEntry: (id: string) => api.del(`/salary/entries/${id}`),
  setOpening: (userId: string, month: string, amount: number | null) =>
    api.put("/salary/opening", { userId, month, amount }),
  addPayout: (userId: string, amount: number, paidAt: string | undefined, comment: string) =>
    api.post("/salary/payouts", { userId, amount, ...(paidAt ? { paidAt } : {}), comment }),
  editPayout: (id: string, patch: { amount?: number; paidAt?: string; comment?: string }) =>
    api.patch(`/salary/payouts/${id}`, patch),
  removePayout: (id: string) => api.del(`/salary/payouts/${id}`),
  close: (month: string) => api.post(`/salary/months/${month}/close`),
  reopen: (month: string) => api.del(`/salary/months/${month}/close`),
};

export const MONTHS = [
  "январь", "февраль", "март", "апрель", "май", "июнь",
  "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь",
];

export const monthTitle = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  const name = MONTHS[m - 1];
  return `${name[0].toUpperCase()}${name.slice(1)} ${y}`;
};

export const shiftMonth = (month: string, delta: number) => {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};
