import { chunks } from "./photos";
import { api, type Page } from "./api";
import type { PaymentMethod } from "./debt";
import type { Service } from "./services";

export type StatusGroup = "NEW" | "IN_PROGRESS" | "WAITING" | "DONE" | "CLOSED" | "CANCELLED";

export interface OrderStatus {
  id: string;
  name: string;
  group: StatusGroup;
  color: string;
  isInitial?: boolean;
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
  /** Перечисление через запятую: и отмеченное кнопками, и набранное руками. */
  completeness: string[];
  appearance: string[];
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
  /** Процент скидки клиента на работы, застывший на заказе при приёме. */
  workDiscountPercent?: number | null;
  /** Рубли этой скидки — считает сервер, чтобы копейки сходились с итогом. */
  workDiscount?: number | null;
  prepayment?: number | null;
  discount?: number | null;
  total?: number | null;
  /** Чем расплатились на выдаче. Пусто, пока заказ не выдан. */
  paymentMethod?: PaymentMethod | null;
  /** Когда клиент обещал заплатить — только у выданных в долг. */
  debtDueAt?: string | null;
}

export interface Reference {
  deviceKinds: string[];
  /** Кнопки быстрого заполнения мастерской — уже по частоте. */
  completeness: Array<{ key: string; label: string; locked?: boolean }>;
  appearance: Array<{ key: string; label: string; locked?: boolean }>;
  complaint: Array<{ key: string; label: string; locked?: boolean }>;
  /** Что включено у мастерской. */
  features: { plateOcr: boolean; plateOcrMode?: "server" | "browser" };
  orderKinds: Array<{ value: Order["kind"]; label: string }>;
  statuses: OrderStatus[];
  /** Мастера и владелец мастерской — он тоже может взяться за ремонт. */
  masters: Array<{ id: string; fullName: string; isOwner?: boolean }>;
  /** Прайс мастерской — для подсказок при наборе выполненных работ. */
  services: Service[];
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
    NEW: "text-stage-new",
    IN_PROGRESS: "text-stage-progress",
    WAITING: "text-stage-waiting",
    DONE: "text-stage-done",
    CLOSED: "text-ink-muted",
    CANCELLED: "text-state-off",
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
  discountPercent: number;
  orderCount: number;
}

export const money = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : `${v.toLocaleString("ru-RU")} ₽`;

/** Как показать мастера в списке — просто по имени, владельца тоже. */
export const masterLabel = (m: { fullName: string }) => m.fullName;

export const ordersApi = {
  reference: () => api.get<Reference>("/reference"),
  list: (params: Record<string, string>) =>
    api.get<Page<Order>>(`/orders?${new URLSearchParams(params).toString()}`),
  get: (id: string) => api.get<Order>(`/orders/${id}`),
  create: (body: unknown) => api.post<{ id: string; number: string }>("/orders", body),
  assignMaster: (id: string, masterId: string | null) => api.patch(`/orders/${id}`, { assignedMasterId: masterId }),
  setStatus: (id: string, statusId: string, comment?: string) =>
    api.post(`/orders/${id}/status`, { statusId, comment }),
  saveWorks: (id: string, works: OrderWork[]) => api.put(`/orders/${id}/works`, { works }),
  saveParts: (id: string, parts: OrderPart[]) => api.put(`/orders/${id}/parts`, { parts }),
  complete: (id: string, body: unknown) => api.post(`/orders/${id}/complete`, body),
  issue: (
    id: string,
    opts: { discount?: number; reason?: string; payment?: { method: PaymentMethod; promisedAt?: string } } = {}
  ) =>
    api.post(`/orders/${id}/issue`, {
      discount: opts.discount ?? 0,
      ...(opts.reason ? { reason: opts.reason } : {}),
      ...(opts.payment ? { payment: opts.payment } : {}),
    }),
  /** Мягкое удаление: заказ уходит из списков, но остаётся в базе и в журнале. */
  remove: (id: string, reason: string) => api.del(`/orders/${id}?reason=${encodeURIComponent(reason)}`),
  /**
   * Загрузить снимки пачками по десять: один огромный запрос с двадцатью
   * фотографиями по мобильному интернету легко обрывается целиком, а так
   * пропадёт в худшем случае последняя пачка — и прогресс видно.
   */
  upload: async (
    orderId: string,
    files: FileList | File[],
    kind: "INTAKE" | "COMPLETION",
    onProgress?: (done: number, total: number) => void
  ) => {
    const all = Array.from(files);
    const saved: Array<{ id: string }> = [];
    onProgress?.(0, all.length);
    for (const part of chunks(all)) {
      const form = new FormData();
      form.append("kind", kind);
      for (const f of part) form.append("files", f, f.name);
      saved.push(...(await api.upload<Array<{ id: string }>>(`/orders/${orderId}/attachments`, form)));
      onProgress?.(saved.length, all.length);
    }
    return saved;
  },
  removeAttachment: (orderId: string, attachmentId: string) =>
    api.del(`/orders/${orderId}/attachments/${attachmentId}`),
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
