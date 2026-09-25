import { api } from "./api";

/** Перенос базы из другой программы — только владельцу. */

export interface MigratePreview {
  key: "customers" | "stock" | "orders";
  total: number;
  issuesTotal: number;
  issues: Array<{ row: number; message: string; column?: string }>;
}

export interface MigrateSummary {
  source: string;
  staff: Array<{ name: string; orders: number; lastAt: string | null }>;
  customers: number;
  stock: number;
  orders: number;
  statuses: Array<{ name: string; count: number }>;
  payments: number;
  paymentsSum: number;
  history: number;
  passcodes: number;
  lastNumber: number | null;
  notes: string[];
  previews: MigratePreview[];
}

export interface MigrateResult {
  staff: Array<{ name: string; login: string }>;
  staffSkipped: string[];
  customers: number;
  stock: number;
  orders: number;
  payments: number;
  paymentsSum: number;
  history: number;
  failed: Array<{ row: number; message: string; table: string }>;
  failedTotal: number;
  nextNumber: string | null;
  seconds: number;
}

export const migrateApi = {
  state: () => api.get<{ canMigrate: boolean; sources: string[] }>("/migrate"),
  parse: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return api.upload<{ token: string | null; empty: boolean; fileName: string; summary: MigrateSummary }>(
      "/migrate/parse",
      form
    );
  },
  apply: (token: string, continueNumbering: boolean) =>
    api.post<MigrateResult>("/migrate/apply", { token, continueNumbering }),
};
