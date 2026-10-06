import { api } from "./api";

/**
 * Панель собственника платформы: клиенты, категории, оплата, расход облака.
 *
 * Клиенты двух видов: облачная мастерская (её база у нас) и локальная (база
 * у неё на компьютере, у нас — только доступ из интернета). Заказов и прочего
 * содержимого мастерских здесь нет и не будет.
 */

export type PayState = "paid" | "soon" | "overdue" | "none" | "free";
export type Activity = "online" | "day" | "week" | "month" | "long" | "never";

export interface Category {
  id: string;
  name: string;
  color: string;
  note: string | null;
  cloudPrice: number;
  remotePrice: number;
  trialDays: number;
  maxUsers: number;
  maxStorageMb: number;
  plateOcr: boolean;
  showAds: boolean;
  isDefault: boolean;
  tenantCount: number;
  boxCount: number;
}

export type CategoryInput = Omit<Category, "id" | "tenantCount" | "boxCount">;

export interface TenantRow {
  id: string;
  name: string;
  slug: string;
  status: "ACTIVE" | "READONLY" | "SUSPENDED";
  maxUsers: number;
  maxStorageMb: number;
  plateOcr: boolean;
  customLimits: boolean;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  createdAt: string;
  archivedAt: string | null;
  categoryId: string | null;
  ownPrice: number | null;
  price: number;
  paidUntil: string | null;
  pay: PayState;
  lastSeenAt: string | null;
  online: boolean;
  userCount: number;
  storageBytes: number;
  plateOcrMonth: number;
}

export interface BoxRow {
  id: string;
  code: string;
  name: string | null;
  previousName: string | null;
  email: string;
  keyHint: string;
  note: string | null;
  isActive: boolean;
  online: boolean;
  lastSeenAt: string | null;
  createdAt: string;
  categoryId: string | null;
  ownPrice: number | null;
  price: number;
  paidUntil: string | null;
  pay: PayState;
  trafficBytes: number;
  trafficRequests: number;
}

export interface Payment {
  id: string;
  tenantId: string | null;
  boxId: string | null;
  clientName: string;
  amount: number;
  months: number | null;
  paidUntil: string;
  note: string | null;
  createdAt: string;
}

interface ClientRef {
  kind: "cloud" | "local";
  id: string;
  name: string;
  sub: string;
  categoryId: string | null;
}

export interface Overview {
  months: string[];
  counts: { cloud: number; local: number; localActive: number; onlineCloud: number; onlineLocal: number; users: number };
  money: { monthly: number; income: number[]; thisMonth: number };
  pay: Record<PayState, number>;
  growth: { cloud: number[]; local: number[] };
  categories: Array<{ id: string; name: string; color: string; cloud: number; local: number }>;
  activity: Array<{ id: Activity; cloud: number; local: number }>;
  storage: {
    usedBytes: number;
    limitBytes: number;
    disk: { totalBytes: number; freeBytes: number } | null;
    top: Array<{ id: string; name: string; bytes: number; limitMb: number }>;
  };
  usage: { month: string; plateOcr: number; relayBytes: number; relayRequests: number };
  due: Array<ClientRef & { price: number; paidUntil: string | null; pay: PayState }>;
  recent: Array<ClientRef & { online: boolean; lastSeenAt: string | null }>;
}

export const platformApi = {
  overview: () => api.get<Overview>("/platform/clients/overview"),
  tenants: () => api.get<TenantRow[]>("/platform/tenants"),
  boxes: () => api.get<BoxRow[]>("/platform/boxes"),
  categories: () => api.get<Category[]>("/platform/clients/categories"),
  createCategory: (c: CategoryInput) => api.post<Category>("/platform/clients/categories", c),
  updateCategory: (id: string, c: Partial<CategoryInput>) => api.patch<Category>(`/platform/clients/categories/${id}`, c),
  removeCategory: (id: string) => api.del<{ ok: true }>(`/platform/clients/categories/${id}`),
  payments: (q: { tenantId?: string; boxId?: string }) =>
    api.get<Payment[]>(`/platform/clients/payments?${new URLSearchParams(q as Record<string, string>)}`),
  pay: (p: { tenantId?: string; boxId?: string; amount: number; months?: number; until?: string; note?: string }) =>
    api.post<Payment>("/platform/clients/payments", p),
  removePayment: (id: string) => api.del<{ ok: true; reverted: boolean }>(`/platform/clients/payments/${id}`),
  patchTenant: (id: string, body: Record<string, unknown>) => api.patch(`/platform/tenants/${id}`, body),
  patchBox: (id: string, body: Record<string, unknown>) => api.patch(`/platform/boxes/${id}`, body),
};

// ---------------------------------------------------------------- подписи

const nf = new Intl.NumberFormat("ru-RU");
export const rub = (n: number) => `${nf.format(Math.round(n))} ₽`;

/** 1,2 ГБ · 340 МБ · 12 КБ */
export function bytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(n >= 10 * 1024 ** 3 ? 0 : 1).replace(".", ",")} ГБ`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} МБ`;
  if (n >= 1024) return `${Math.round(n / 1024)} КБ`;
  return n ? `${n} Б` : "0";
}

export const mbLabel = (mb: number) => (mb <= 0 ? "без лимита" : bytes(mb * 1024 * 1024));

/** «сейчас», «12 мин назад», «вчера», «3 дня назад», «давно» */
export function seenLabel(online: boolean, at: string | null): string {
  if (online) return "в сети";
  if (!at) return "не заходила";
  const ago = Date.now() - new Date(at).getTime();
  const min = Math.round(ago / 60_000);
  if (min < 60) return `${Math.max(1, min)} мин назад`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} ч назад`;
  const d = Math.round(h / 24);
  if (d === 1) return "вчера";
  if (d < 30) return `${d} ${d % 10 === 1 && d % 100 !== 11 ? "день" : [2, 3, 4].includes(d % 10) && ![12, 13, 14].includes(d % 100) ? "дня" : "дней"} назад`;
  const m = Math.round(d / 30);
  return m < 12 ? `${m} мес назад` : "больше года назад";
}

/** Насколько давно — для окраски: свежее зелёное, давнее блёклое. */
export function activityOf(online: boolean, at: string | null): Activity {
  if (online) return "online";
  if (!at) return "never";
  const ago = Date.now() - new Date(at).getTime();
  const day = 24 * 60 * 60_000;
  if (ago < day) return "day";
  if (ago < 7 * day) return "week";
  if (ago < 30 * day) return "month";
  return "long";
}

export const ACTIVITY_LABEL: Record<Activity, string> = {
  online: "В сети",
  day: "Сегодня",
  week: "За неделю",
  month: "За месяц",
  long: "Давно",
  never: "Не заходили",
};

export const PAY_LABEL: Record<PayState, string> = {
  paid: "Оплачено",
  soon: "Скоро оплата",
  overdue: "Просрочено",
  none: "Срок не задан",
  free: "Бесплатно",
};

/** «ноя», «дек» — подписи месяцев на графиках. */
export const monthShort = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("ru-RU", { month: "short" }).replace(".", "");
};
export const monthFull = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("ru-RU", { month: "long", year: "numeric" });
};

/** «2026-12-31» для поля даты. */
export const isoDate = (v: string | Date | null) => {
  if (!v) return "";
  const d = new Date(v);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
