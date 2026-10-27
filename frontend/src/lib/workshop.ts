import type { TileLayout } from "./tile";
import { api, type Page } from "./api";
import type { OrderStatus } from "./orders";
import type { StageKey } from "./stages";

/** Склад, закупки, касса и сводка — то, чем мастерская живёт помимо заказов. */

// ------------------------------------------------------------------ сводка

/** Карточка на доске: ровно те поля, что видно на ней глазами. */
export interface BoardCard {
  id: string;
  number: string;
  isUrgent: boolean;
  /** Тип заказа: плашка «гарантия ASUS» на карточке доски. */
  kind?: "REPAIR" | "DIAGNOSTICS" | "WARRANTY" | "REPEAT" | "BRAND_WARRANTY";
  acceptedAt: string;
  dueAt: string | null;
  status: OrderStatus;
  device: { kind: string; brand: string | null; model: string | null } | null;
  master: { id: string; fullName: string } | null;
  /** Имени нет, если сотруднику не показываются контакты клиентов. */
  customer: { id: string; type: "INDIVIDUAL" | "COMPANY"; name?: string; color?: string | null };
  /** Неисправность со слов клиента (до 300 знаков) — для «Редактора панелей заказа». */
  complaint?: string;
  /** Примечание приёмщика (до 300 знаков). */
  note?: string | null;
  /** Ярлыки заказа — «Индивидуальные оповещения». */
  labels?: Array<{ id: string; setAt: string; setBy: string | null }>;
  /** Итог заказа — только тем, кто видит деньги. */
  total?: number;
}

export interface StageColumn {
  key: StageKey;
  /** Всего заказов на стадии после фильтра — items может быть обрезан. */
  total: number;
  /** Сколько заказов спрятал фильтр по технике. */
  filtered?: number;
  items: BoardCard[];
}

/** Клиент с долгом — строка панели «Должники». */
export interface Debtor {
  customerId: string;
  number: number;
  name: string;
  phone: string;
  due: number;
  orders: number;
  since: string;
  promised: string | null;
  overdue: boolean;
}

// ------------------------------------------------------- настройки главной

export type ColumnKey = StageKey | "DEBTORS";
export const OVERDUE_KEY = "OVERDUE";
export type StageSort = "urgent" | "due" | "old" | "new" | "number";
export type DebtorSort = "sum" | "old" | "promised";

export interface PanelPrefs {
  sort?: string;
  /** Пусто — «авто», по высоте экрана. */
  limit?: number | null;
  /** Выключенные типы техники в нормальном виде (см. kindKey). */
  hiddenKinds?: string[];
}

export interface DashboardPrefs {
  order: ColumnKey[];
  hidden: string[];
  panels: Partial<Record<ColumnKey, PanelPrefs>>;
  /** Свой вид главной. Нет — как у мастерской (workshopView). */
  view?: DashboardView | null;
  table?: TablePrefs;
  /** История ремонта в карточке заказа прикреплена: слева или справа. */
  historyDock?: "left" | "right";
}

export type DashboardView = "board" | "table";

/** Столбцы таблицы на главной — ключи те же, что на сервере (summary/prefs.ts); что в них — lib/tableCols. */
export type TableCol = string;
export type ColWidth = "s" | "m" | "l";
export interface TableColPrefs {
  k: TableCol;
  w?: ColWidth;
  /** Своя ширина в пикселях — потянули за край заголовка. Важнее w. */
  px?: number;
  wrap?: boolean;
}
/** Вид таблицы — вкладка над ней: свои столбцы, сортировка, плотность, «Итого». */
export interface TableViewPrefs {
  id: string;
  name: string;
  cols: TableColPrefs[];
  sort?: string;
  dense?: boolean;
  totals?: boolean;
  /** Фильтр «Аутсорс ▾»: any — только аутсорс, none — без, иначе id компании. */
  out?: string;
  /** Фильтр «Тип ▾»: платные или гарантийные. */
  okind?: "paid" | "warranty";
}
export interface TablePrefs {
  views: TableViewPrefs[];
  active?: string;
}

/** Заказ строкой таблицы на главной. */
export interface TableRow {
  id: string;
  number: string;
  isUrgent: boolean;
  acceptedAt: string;
  dueAt: string | null;
  completedAt: string | null;
  issuedAt: string | null;
  /** С какого момента в нынешнем статусе. */
  statusSince: string;
  status: OrderStatus;
  device: { kind: string; brand: string | null; model: string | null; serial: string | null } | null;
  master: { id: string; fullName: string } | null;
  customer: {
    id: string;
    type: "INDIVIDUAL" | "COMPANY";
    name?: string;
    phone?: string;
    color?: string | null;
    phone2?: string | null;
    email?: string | null;
    address?: string | null;
    source?: string | null;
    /** Сколько всего заказов у клиента. */
    orders?: number;
  };
  kind?: "REPAIR" | "DIAGNOSTICS" | "WARRANTY" | "REPEAT" | "BRAND_WARRANTY";
  acceptedBy?: string | null;
  labels?: Array<{ id: string; setAt: string; setBy: string | null }>;
  complaint: string;
  completeness: string[];
  appearance?: string[];
  receptionNote: string | null;
  passcode?: string | null;
  storage?: string | null;
  outsource?: string | null;
  /** Заказ от аутсорса: компания (имя — тем, кто видит клиентов). */
  outsourcer?: { id: string; name: string | null } | null;
  diagnosis?: string | null;
  masterComment?: string | null;
  lastMessage?: string | null;
  total?: number;
  estimate?: number | null;
  prepay?: number | null;
  works?: number | null;
  parts?: number | null;
  discount?: number | null;
  paid?: number;
  /** Долг по выданному — только у строк «С долгом». */
  debt?: number;
}

export const STAGE_SORT_LABELS: Record<StageSort, string> = {
  urgent: "Срочные сверху, потом по сроку",
  due: "По сроку",
  old: "Старые сверху",
  new: "Новые сверху",
  number: "По номеру",
};

export const DEBTOR_SORT_LABELS: Record<DebtorSort, string> = {
  sum: "По сумме долга",
  old: "Дольше всех должны — сверху",
  promised: "По обещанной дате",
};

export interface DeviceKindOption {
  key: string;
  label: string;
  count: number;
}

/** Просроченный долг на главной: заказ, по которому обещанный срок прошёл. */
export interface OverdueDebt {
  orderId: string;
  number: string;
  due: number;
  debtDueAt: string | null;
  customer: { id: string; number: number; name: string; phone: string } | null;
}

export interface Summary {
  stages: StageColumn[];
  scope: "mine" | "all";
  /** Пусто, когда просроченных нет, — и тогда панель не показывается вовсе. */
  overdue: OverdueDebt[];
  overdueTotal: number;
  prefs: DashboardPrefs;
  /** Как рисовать карточку заказа (Настройки → Интерфейс → Редактор панелей заказа). */
  tile?: TileLayout;
  /** Видит ли человек деньги клиентов — от этого есть ли у него «Должники». */
  money: boolean;
  /** Пусто, если панель выключена или человеку не положено её видеть. */
  debtors: { rows: Debtor[]; total: number; sum: number } | null;
  /** Какой вид главной сейчас: свой или мастерской. */
  view?: DashboardView;
  workshopView?: DashboardView;
  /** Строки таблицы — только когда вид «таблица». */
  table?: TableRow[];
  /** Видит ли деньги заказов: столбец «Сумма» и фильтр «С долгом». */
  tableMoney?: boolean;
  /** Виды таблицы: свои → мастерской → стандартный. */
  tableViews?: TablePrefs;
  /** Виды свои (а не мастерской). */
  tableViewsOwn?: boolean;
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
  /** Категория в дереве каталога и её путь «Матрицы/15.6». */
  categoryId?: string | null;
  categoryPath?: string | null;
  location?: string | null;
  supplier?: string | null;
  /** Примечание к позиции. */
  note?: string | null;
  salePrice?: number | null;
  updatedAt?: string;
  minQty: number;
  qty: number;
  low: boolean;
  /** Приходят только тем, кому видна себестоимость. */
  avgCost?: number;
  value?: number;
  purchasePrice?: number | null;
  places: StockPlace[];
}

/** Категория каталога склада; count — позиций прямо в ней (без подкатегорий). */
export interface StockCategory {
  id: string;
  parentId: string | null;
  name: string;
  /** Свой цвет карточки «#45C08A»; пусто — по порядку из палитры. */
  color?: string | null;
  count: number;
}

export interface StockCatalog {
  items: StockCategory[];
  uncategorized: number;
  total: number;
}

/** Подсказка со склада в «Запчастях» заказа. */
export interface StockLookupItem {
  id: string;
  name: string;
  sku: string | null;
  unit: string;
  location: string | null;
  salePrice: number | null;
  qty: number;
}

export interface StockItemInput {
  name: string;
  sku?: string;
  unit?: string;
  categoryId?: string | null;
  minQty?: number;
  location?: string;
  supplier?: string;
  note?: string;
  purchasePrice?: number | null;
  salePrice?: number | null;
}

export interface StockList {
  items: StockItem[];
  /** Счётчики по всему складу, а не по странице и не по фильтру. */
  totals: { positions: number; low: number; zero?: number; value?: number };
  /** Поиск исправил раскладку — см. lib/searchPrefs. */
  searchFixed?: string | null;
  total: number;
  page: number;
  pageSize: number;
  pages: number;
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

export type CashKind = "CASH" | "ACQUIRING" | "BANK";

export interface CashRegister {
  id: string;
  name: string;
  kind: CashKind;
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
  totals: {
    days: number;
    income: number;
    expense: number;
    todayIncome: number;
    todayExpense: number;
    /** Выемка за период: в приход и расход не входит. */
    withdrawn?: number;
    /** Каким видом касс отфильтровано; null — всеми. */
    kind?: CashKind | null;
  };
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
  prefs: () =>
    api.get<{ prefs: DashboardPrefs; money: boolean; personal: boolean; workshopView: DashboardView; canShare: boolean }>("/summary/prefs"),
  setWorkshopView: (view: DashboardView) => api.put<{ workshopView: DashboardView }>("/summary/view/workshop", { view }),
  /** «Сделать так у всех» в конфигураторе таблицы. null — у всех стандартная. */
  shareTable: (table: TablePrefs | null) => api.put<{ ok: true }>("/summary/table/workshop", { table }),
  /** Вид таблицы в Excel — то, что видно на экране. */
  exportTable: async (body: { name: string; columns: Array<{ title: string; width?: number }>; rows: Array<Array<string | number | null>> }) => {
    const { blob, fileName } = await api.download("/summary/table/export", body);
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 30_000);
  },
  savePrefs: (prefs: DashboardPrefs) => api.put<{ prefs: DashboardPrefs }>("/summary/prefs", { prefs }),
  kinds: () => api.get<{ kinds: DeviceKindOption[] }>("/summary/kinds"),
};

export const stockApi = {
  list: (
    params: {
      search?: string;
      filter?: string;
      sort?: string;
      layout?: string;
      page?: number;
      category?: string;
      supplier?: string;
      location?: string;
      /** «1» — всё отобранное одним ответом, без страниц. */
      all?: string;
    } = {}
  ) => api.get<StockList>(`/stock${qs(params)}`),
  catalog: () => api.get<StockCatalog>("/stock/categories"),
  createCategory: (name: string, parentId: string | null) =>
    api.post<{ id: string; name: string; parentId: string | null }>("/stock/categories", { name, parentId }),
  updateCategory: (id: string, body: { name?: string; parentId?: string | null; color?: string | null }) =>
    api.patch(`/stock/categories/${id}`, body),
  /** Одно действие над выбранными позициями (см. backend stock.routes.ts → /bulk). */
  bulk: (
    body:
      | { action: "move"; ids: string[]; categoryId: string | null }
      | { action: "markup"; ids: string[]; pct: number }
      | { action: "location"; ids: string[]; location: string }
      | { action: "delete"; ids: string[] }
  ) => api.post<{ ok: true; changed: number; skipped: string[] }>("/stock/bulk", body),
  /** Выбранные позиции файлом Excel — тем же листом, что «Базы → Выгрузка». */
  exportItems: async (ids: string[], name?: string) => {
    const { blob, fileName } = await api.download("/stock/export", { ids, name });
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Не сразу: иначе браузер иногда не успевает забрать файл и сохраняет его безымянным.
    setTimeout(() => URL.revokeObjectURL(href), 30_000);
  },
  deleteCategory: (id: string, moveTo?: string | null) =>
    api.del<{ ok: true; items: number; children: number }>(`/stock/categories/${id}${moveTo ? `?moveTo=${moveTo}` : ""}`),
  hints: () => api.get<{ suppliers: string[]; locations: string[] }>("/stock/hints"),
  lookup: (q: string) => api.get<{ items: StockLookupItem[] }>(`/stock/lookup${qs({ q })}`),
  warehouses: () => api.get<Array<{ id: string; name: string; isDefault: boolean }>>("/stock/warehouses"),
  createItem: (body: StockItemInput) => api.post<{ id: string; name: string }>("/stock", body),
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
  list: (params: { status?: string; orderId?: string; page?: number } = {}) =>
    api.get<Page<Purchase>>(`/purchases${qs(params)}`),
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
  list: (params: { days?: number; direction?: string; cashRegisterId?: string; kind?: CashKind } = {}) =>
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
  /** Выемка: деньги ушли из кассы в банк или владельцу. Не расход мастерской. */
  withdraw: (body: { cashRegisterId: string; amount: number; comment?: string }) =>
    api.post<{ id: string; left: number }>("/finance/withdraw", body),
  forOrder: (orderId: string) =>
    api.get<{ orderId: string; number: string; total: number; paid: number; due: number }>(
      `/finance/order/${orderId}`
    ),
};
