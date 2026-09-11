import { api } from "./api";

export type StatusGroup = "NEW" | "IN_PROGRESS" | "WAITING" | "DONE" | "CLOSED" | "CANCELLED";

export interface OrderStatus {
  id: string;
  name: string;
  group: StatusGroup;
  color: string;
  isInitial?: boolean;
}

export interface ChecklistItem {
  key: string;
  label: string;
  checked: boolean;
}

export interface OrderWork {
  id?: string;
  name: string;
  qty: number;
  price: number;
}

export interface OrderPart extends OrderWork {
  source: "STOCK" | "PURCHASED" | "CUSTOMER";
  cost?: number | null;
}

export interface OrderAttachment {
  id: string;
  kind: "INTAKE" | "COMPLETION" | "DOCUMENT" | "OTHER";
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
}

export interface PreviousRepair {
  id: string;
  number: string;
  completedAt: string | null;
  issuedAt: string | null;
  diagnosis: string | null;
  masterComment: string | null;
  recommendation: string | null;
  warrantyUntil: string | null;
  master: string | null;
  works: Array<{ name: string; qty: number | null }>;
  parts: Array<{ name: string; qty: number | null }>;
}

/**
 * Часть полей приходит не всегда: сервер вырезает деньги и контакты клиента
 * для тех, кому они не положены. Поэтому они необязательные — интерфейс
 * просто не рисует то, чего не пришло.
 */
export interface Order {
  id: string;
  number: string;
  kind: "REPAIR" | "DIAGNOSTICS" | "WARRANTY" | "REPEAT";
  isUrgent: boolean;
  status: OrderStatus;
  branch: { id: string; name: string } | null;

  acceptedAt: string;
  dueAt: string | null;
  completedAt: string | null;
  issuedAt: string | null;

  customer: {
    id: string;
    type: "INDIVIDUAL" | "COMPANY";
    name?: string;
    phone?: string;
    phone2?: string | null;
    email?: string | null;
    address?: string | null;
  };
  device: { id: string; kind: string; brand: string | null; model: string | null; serial: string | null } | null;

  complaint: string;
  receptionNote: string | null;
  devicePasscode: string | null;
  completeness: ChecklistItem[];
  appearance: ChecklistItem[];
  appearanceNote: string | null;
  hasOpenTraces: boolean;
  hasWaterDamage: boolean;
  storageLocation: string | null;
  approvedLimit: number | null;

  diagnosis: string | null;
  masterComment: string | null;
  internalComment: string | null;
  recommendation: string | null;
  warrantyDays: number | null;
  warrantyUntil: string | null;

  acceptedBy: { id: string; fullName: string } | null;
  assignedMaster: { id: string; fullName: string } | null;
  issuedBy: { id: string; fullName: string } | null;

  works: Array<OrderWork & { id: string }>;
  parts: Array<OrderPart & { id: string }>;
  attachments: OrderAttachment[];

  totalWork: number | null;
  totalParts: number | null;
  previousRepair: PreviousRepair | null;
  parentOrderId: string | null;

  estimatedCost?: number | null;
  prepayment?: number | null;
  discount?: number | null;
  total?: number | null;
}

export interface Reference {
  deviceKinds: string[];
  completeness: Array<{ key: string; label: string }>;
  appearance: Array<{ key: string; label: string }>;
  orderKinds: Array<{ value: Order["kind"]; label: string }>;
  statuses: OrderStatus[];
  masters: Array<{ id: string; fullName: string }>;
}

export const ORDER_KIND_LABEL: Record<Order["kind"], string> = {
  REPAIR: "Ремонт",
  DIAGNOSTICS: "Диагностика",
  WARRANTY: "Гарантийный возврат",
  REPEAT: "Повторное обращение",
};

export const PART_SOURCE_LABEL: Record<OrderPart["source"], string> = {
  STOCK: "Со склада",
  PURCHASED: "Докуплена",
  CUSTOMER: "Клиента",
};

/** Группа статуса решает, каким цветом он показан — переименование ничего не ломает. */
export const statusTone = (group: StatusGroup) =>
  ({
    NEW: "new",
    IN_PROGRESS: "progress",
    WAITING: "waiting",
    DONE: "done",
    CLOSED: "done",
    CANCELLED: "cancelled",
  })[group] as "new" | "progress" | "waiting" | "done" | "cancelled";

/**
 * Значок строки списка. В отличие от цвета выданный заказ отличается от
 * готового: в списке это разные состояния, и мастер их путать не должен.
 */
export const statusGlyphTone = (group: StatusGroup) =>
  ({
    NEW: "new",
    IN_PROGRESS: "progress",
    WAITING: "waiting",
    DONE: "done",
    CLOSED: "closed",
    CANCELLED: "cancelled",
  })[group] as "new" | "progress" | "waiting" | "done" | "closed" | "cancelled";

/**
 * Цвет текста статуса рядом со значком — тот же смысл, что и у плашки.
 * Четыре рабочие группы берут цвета стадий с главной: заказ, который на
 * доске лежит в розовой колонке, и в списке должен быть розовым.
 */
export const statusTextClass = (group: StatusGroup) =>
  ({
    NEW: "text-[#FFF993]",
    IN_PROGRESS: "text-[#FE3E7D]",
    WAITING: "text-[#FC7E68]",
    DONE: "text-[#A5F88B]",
    CLOSED: "text-ink-muted",
    CANCELLED: "text-[#EE9494]",
  })[group];

/** Найденный клиент в подсказках на приёме техники. */
export interface CustomerHit {
  id: string;
  type: "INDIVIDUAL" | "COMPANY";
  name: string;
  phone: string;
  phone2: string | null;
  email: string | null;
  address: string | null;
  source: string | null;
  orderCount: number;
}

export const money = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : `${v.toLocaleString("ru-RU")} ₽`;

export const ordersApi = {
  reference: () => api.get<Reference>("/reference"),
  list: (params: Record<string, string>) =>
    api.get<Order[]>(`/orders?${new URLSearchParams(params).toString()}`),
  get: (id: string) => api.get<Order>(`/orders/${id}`),
  create: (body: unknown) => api.post<{ id: string; number: string }>("/orders", body),
  setStatus: (id: string, statusId: string, comment?: string) =>
    api.post(`/orders/${id}/status`, { statusId, comment }),
  saveWorks: (id: string, works: OrderWork[]) => api.put(`/orders/${id}/works`, { works }),
  saveParts: (id: string, parts: OrderPart[]) => api.put(`/orders/${id}/parts`, { parts }),
  complete: (id: string, body: unknown) => api.post(`/orders/${id}/complete`, body),
  issue: (id: string, discount = 0, reason?: string) =>
    api.post(`/orders/${id}/issue`, { discount, ...(reason ? { reason } : {}) }),
  upload: (orderId: string, files: FileList | File[], kind: "INTAKE" | "COMPLETION") => {
    const form = new FormData();
    form.append("kind", kind);
    for (const f of Array.from(files)) form.append("files", f);
    return api.upload<Array<{ id: string }>>(`/orders/${orderId}/attachments`, form);
  },
  attachmentUrl: (orderId: string, attachmentId: string) =>
    api.get<{ url: string }>(`/orders/${orderId}/attachments/${attachmentId}/url`),
  /**
   * Похожие клиенты для формы приёма. Ищем и по телефону, и по имени —
   * приёмщик начинает с того, что первым назвал человек у стойки.
   */
  suggestCustomers: (by: { phone?: string; name?: string }) => {
    const p = new URLSearchParams();
    if (by.phone) p.set("phone", by.phone);
    if (by.name) p.set("name", by.name);
    return api.get<CustomerHit[]>(`/customers/suggest?${p.toString()}`);
  },
};
