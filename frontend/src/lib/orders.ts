import type { CallItem } from "./calls";
import { chunks } from "./photos";
import { api, type Page } from "./api";
import { fileUrl } from "./basePath";
import type { PillTone } from "../components/ui";
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
  /** Чья работа — для зарплаты. null — мастер заказа. Только у работ. */
  masterId?: string | null;
  /** Гарантия на работу, дней — из прайса или вручную; печатается в акте (29.10.2026). */
  warrantyDays?: number | null;
}

export interface OrderPart extends OrderWork {
  source: "STOCK" | "PURCHASED" | "CUSTOMER";
  cost?: number | null;
  /** Позиция склада: строка списывается со склада при сохранении заказа. */
  stockItemId?: string | null;
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
export type ExtraLine = { name: string; qty: number; price: number };
/** «Акт доплаты»: последний возврат в работу и добавленное после него. Суммы — тем, кто видит деньги. */
export interface OrderExtra {
  times: number;
  reopenedAt: string;
  reason: string;
  prevIssuedAt: string;
  works: ExtraLine[];
  parts: ExtraLine[];
  totalBefore?: number;
  amount?: number;
}

/** Ярлык мастерской: значок в цветном кружке (lib/labelIcons). */
export interface LabelDef {
  id: string;
  name: string;
  icon: string;
  color: string;
  quickFilter: boolean;
  notify: boolean;
  /** Сколько заказов в работе с ним — только в списке настроек. */
  orders?: number;
}

/** Ярлык на заказе: какой, когда и кто поставил. */
export interface LabelMark {
  id: string;
  setAt: string;
  setBy: string | null;
}

export interface Order {
  id: string;
  number: string;
  labels?: LabelMark[];
  kind: OrderKind;
  isUrgent: boolean;
  status: OrderStatus;
  branch: { id: string; name: string } | null;

  acceptedAt: string;
  dueAt: string | null;
  completedAt: string | null;
  issuedAt: string | null;
  /** Выдан, а оплачен не весь — ярлык «Задолженность». */
  inDebt?: boolean;
  /** Сколько должны — только тому, кто видит деньги. */
  debt?: number;

  customer: {
    id: string;
    type: "INDIVIDUAL" | "COMPANY";
    /** Цветная метка клиента — см. lib/customerColor. */
    color?: string | null;
    name?: string;
    phone?: string;
    phone2?: string | null;
    email?: string | null;
    address?: string | null;
    isOutsource?: boolean;
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
  /** Номер заказа в базе заказчика-аутсорса. */
  outsourceNumber?: string | null;
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
  /** Возвращали в работу после выдачи — что добавили с тех пор (backend orders/reopen.ts). */
  extra?: OrderExtra | null;
  parentOrderId: string | null;

  /**
   * Совпадение в истории ремонта — только в результатах поиска. По нему в
   * списке видно, за что заказ нашёлся, когда слов запроса нет ни в технике,
   * ни в жалобе клиента.
   */
  foundMessage?: { id: string; text: string; createdAt: string; author: string | null } | null;

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
  features: { plateOcr: boolean; plateOcrMode?: "server" | "browser"; remoteAccess?: boolean };
  orderKinds: Array<{ value: Order["kind"]; label: string }>;
  /** Бренды, у которых мастерская — авторизованный сервис: тип заказа выбирают явно. */
  authorizedBrands?: string[];
  statuses: OrderStatus[];
  /** Мастера и владелец мастерской — он тоже может взяться за ремонт. */
  masters: Array<{ id: string; fullName: string; isOwner?: boolean; isCoOwner?: boolean; active?: number }>;
  /** Ярлыки мастерской — «Индивидуальные оповещения». */
  labels?: LabelDef[];
  /** Прайс мастерской — для подсказок при наборе выполненных работ. */
  services: Service[];
  /** Категории прайса — для панели «+» в названии работы. */
  serviceCategories?: Array<{ id: string; parentId: string | null; name: string; color?: string | null }>;
}

export type OrderKind = "REPAIR" | "DIAGNOSTICS" | "WARRANTY" | "REPEAT" | "BRAND_WARRANTY";

export const ORDER_KIND_LABEL: Record<OrderKind, string> = {
  REPAIR: "Ремонт",
  DIAGNOSTICS: "Диагностика",
  WARRANTY: "Гарантийный возврат",
  REPEAT: "Повторное обращение",
  BRAND_WARRANTY: "Гарантия производителя",
};

/** Гарантийные: по гарантии производителя и наш гарантийный возврат. Остальные — платные. */
export const isWarrantyKind = (k: OrderKind | undefined | null) => k === "BRAND_WARRANTY" || k === "WARRANTY";

/** Бренд в списке авторизаций мастерской — без регистра и лишних пробелов. */
export const isAuthorizedBrand = (brand: string | null | undefined, list: string[] | undefined) => {
  const b = (brand ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase("ru-RU");
  return !!b && !!list?.some((x) => x.trim().replace(/\s+/g, " ").toLocaleLowerCase("ru-RU") === b);
};

/**
 * Плашка типа заказа в списках, таблице, на плитке и в карточке (27.10.2026).
 * Обычный ремонт — без плашки: его большинство, плашка была бы шумом.
 * Гарантия производителя — фиолетовая, с брендом: «гарантия ASUS».
 */
export function kindBadge(kind: OrderKind | undefined | null, brand?: string | null): { label: string; tone: "factory" | "warning" | "neutral"; title: string } | null {
  if (!kind || kind === "REPAIR") return null;
  if (kind === "BRAND_WARRANTY") {
    const b = (brand ?? "").trim();
    return { label: b ? `гарантия ${b}` : "гарантия производителя", tone: "factory", title: "Гарантия производителя: ремонт оплачивает бренд" };
  }
  if (kind === "WARRANTY") return { label: "гарантия", tone: "warning", title: "Гарантийный возврат: повторный ремонт по нашей гарантии" };
  return { label: ORDER_KIND_LABEL[kind].toLowerCase(), tone: "neutral", title: ORDER_KIND_LABEL[kind] };
}

export const PART_SOURCE_LABEL: Record<OrderPart["source"], string> = {
  STOCK: "Со склада",
  PURCHASED: "Докуплена",
  CUSTOMER: "Клиента",
};

/**
 * Таблетка статуса. Выданный заказ называем по итогу, а не по имени статуса:
 * «Выдан» — если был отремонтирован, «Выдан без ремонта» — если отказ или
 * выдан, не дойдя до готовности. Имена статусов мастерская может менять, а
 * итог должен читаться одинаково везде.
 */
export function statusPill(o: {
  status: { name: string; group: StatusGroup };
  issuedAt?: string | null;
  completedAt?: string | null;
}): { tone: PillTone; label: string } {
  if (o.issuedAt) {
    return o.status.group === "CANCELLED" || !o.completedAt
      ? { tone: "refused", label: "Выдан без ремонта" }
      : { tone: "issued", label: "Выдан" };
  }
  const tone = (
    { NEW: "new", IN_PROGRESS: "progress", WAITING: "waiting", DONE: "done", CLOSED: "issued", CANCELLED: "cancelled" } as const
  )[o.status.group];
  return { tone, label: o.status.name };
}

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


/** Строка истории ремонта, кроме сообщений. */
export interface OrderEventRow {
  id: string;
  at: string;
  kind: "CREATED" | "STATUS" | "MASTER" | "LABEL_SET" | "LABEL_UNSET" | string;
  from?: { name: string; group: StatusGroup } | null;
  to?: { name: string; group: StatusGroup };
  comment?: string | null;
  data?: { name?: string; icon?: string; color?: string; from?: string | null; to?: string | null };
  who: { name: string; position: string | null } | null;
  /** kind === "CALL": звонок клиента (28.10.2026). */
  call?: CallItem;
}

export const labelsApi = {
  list: () => api.get<{ items: LabelDef[]; canManage: boolean }>("/order-labels"),
  create: (body: Omit<LabelDef, "id" | "orders">) => api.post<LabelDef>("/order-labels", body),
  update: (id: string, body: Partial<Omit<LabelDef, "id" | "orders">>) => api.patch<LabelDef>(`/order-labels/${id}`, body),
  remove: (id: string) => api.del<{ ok: true; marks: number }>(`/order-labels/${id}`),
  reorder: (ids: string[]) => api.put("/order-labels/order", { ids }),
};

/** Найденный клиент в подсказках на приёме техники. */
export interface CustomerHit {
  id: string;
  /** Есть выданный и не оплаченный заказ — приёмщик должен увидеть сразу. */
  inDebt?: boolean;
  debt?: number;
  type: "INDIVIDUAL" | "COMPANY";
  name: string;
  phone: string;
  phone2: string | null;
  email: string | null;
  address: string | null;
  source: string | null;
  color?: string | null;
  /** Клиент-аутсорс: на приёме спрашиваем номер заказа в его базе. */
  isOutsource?: boolean;
  discountPercent: number;
  orderCount: number;
}

export const money = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : `${v.toLocaleString("ru-RU")} ₽`;

/** Как показать мастера в списке — просто по имени, владельца тоже. */
export const masterLabel = (m: { fullName: string }) => m.fullName;

/** Строка истории техники и прошлых заказов клиента (backend orders/history.ts). */
export interface HistoryRow {
  id: string;
  number: string;
  kind: Order["kind"];
  acceptedAt: string;
  completedAt: string | null;
  issuedAt: string | null;
  status: { name: string; group: StatusGroup; color: string | null };
  outcome: "ok" | "no" | "work";
  complaint: string;
  diagnosis: string;
  master: string | null;
  device: { id: string; kind: string; brand: string | null; model: string | null; serial: string | null } | null;
  /** Только в истории техники: тот же экземпляр (а не только серийный) и чужой клиент. */
  sameDevice?: boolean;
  otherCustomer?: boolean;
}

/** Техника клиента с её заказами — для приёма. */
export interface CustomerDevice {
  device: HistoryRow["device"];
  orders: HistoryRow[];
  last: string;
}

/** Заказ для просмотра окном поверх (из истории): canOpen — можно ли перейти в сам заказ. */
export type PeekOrder = Order & { canOpen: boolean };

export const ordersApi = {
  reference: () => api.get<Reference>("/reference"),
  deviceHistory: (id: string) => api.get<{ items: HistoryRow[] }>(`/orders/${id}/device-history`),
  peek: (id: string) => api.get<PeekOrder>(`/orders/${id}/peek`),
  customerDevices: (customerId: string) => api.get<{ items: CustomerDevice[] }>(`/customers/${customerId}/devices`),
  list: (params: Record<string, string>) =>
    api.get<Page<Order> & { debtTotal?: number }>(`/orders?${new URLSearchParams(params).toString()}`),
  get: (id: string) => api.get<Order>(`/orders/${id}`),
  create: (body: unknown) => api.post<{ id: string; number: string }>("/orders", body),
  /** Правка карточки: шлём только изменённые поля. */
  update: (id: string, patch: Record<string, unknown>) => api.patch(`/orders/${id}`, patch),
  assignMaster: (id: string, masterId: string | null) => api.patch(`/orders/${id}`, { assignedMasterId: masterId }),
  /** Поставить или снять ярлык. */
  setLabel: (id: string, labelId: string, on: boolean) => api.post<{ ok: true; changed: boolean }>(`/orders/${id}/labels`, { labelId, on }),
  /** Служебные строки истории ремонта: приём, статусы, мастер, ярлыки. */
  events: (id: string) => api.get<{ items: OrderEventRow[] }>(`/orders/${id}/messages/events`),
  setStatus: (id: string, statusId: string, comment?: string) =>
    api.post(`/orders/${id}/status`, { statusId, comment }),
  saveWorks: (id: string, works: OrderWork[]) => api.put(`/orders/${id}/works`, { works }),
  /** sync: склад сверяется с заказом — новое списывается, убранное возвращается (stock/catalog.ts). */
  saveParts: (id: string, parts: OrderPart[]) =>
    api.put<{ ok: true; stock?: Array<{ name: string; qty: number; dir: "out" | "back" }> }>(`/orders/${id}/parts`, {
      parts: parts.map((p) => ({ name: p.name, qty: p.qty, price: p.price, source: p.source, stockItemId: p.stockItemId ?? null })),
      sync: true,
    }),
  complete: (id: string, body: unknown) => api.post(`/orders/${id}/complete`, body),
  /** Итог ремонта без смены статуса: диагноз, комментарий, рекомендации, гарантия. */
  saveFinish: (
    id: string,
    body: { diagnosis: string; masterComment?: string; recommendation?: string; warrantyDays?: number | null }
  ) => api.put(`/orders/${id}/finish`, body),
  /** Выданный заказ — снова в работу. Без statusId — первый статус стадии «Ремонт». */
  reopen: (id: string, reason: string, statusId?: string) =>
    api.post<{ ok: true }>(`/orders/${id}/reopen`, { reason, ...(statusId ? { statusId } : {}) }),
  issue: (
    id: string,
    opts: { discount?: number; reason?: string; withoutRepair?: boolean; payment?: { method: PaymentMethod; promisedAt?: string } } = {}
  ) =>
    api.post<{ ok: true; extra?: { amount: number } }>(`/orders/${id}/issue`, {
      discount: opts.discount ?? 0,
      ...(opts.reason ? { reason: opts.reason } : {}),
      ...(opts.withoutRepair ? { withoutRepair: true } : {}),
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
    api
      .get<{ url: string }>(`/orders/${orderId}/attachments/${attachmentId}/url`)
      .then((r) => ({ url: fileUrl(r.url) })),
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
