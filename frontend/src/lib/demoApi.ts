import { api } from "./api";

/** Тестовые данные мастерской — только для владельца. */

export type DemoState =
  | { active: false; canSeed: boolean }
  | {
      active: true;
      createdAt: string;
      /** Пароль тестовых сотрудников — один на всех. */
      password: string;
      logins: string[];
      orders: number;
      customers: number;
    };

export interface DemoRemoved {
  orders: number;
  customers: number;
  stock: number;
  services: number;
  users: number;
  keptCustomers: number;
  files: number;
}

export const demoApi = {
  state: () => api.get<DemoState>("/demo"),
  seed: () => api.post<{ orders: number; customers: number; logins: string[] }>("/demo"),
  remove: () => api.del<DemoRemoved>("/demo"),
};

/**
 * После заведения и уборки меняется всё сразу — списки, сводка, касса.
 * Перечитывать каждый экран по отдельности незачем: страница открывается
 * заново, и всё на ней уже новое.
 */
export const reloadAfterDemo = () => window.location.reload();
