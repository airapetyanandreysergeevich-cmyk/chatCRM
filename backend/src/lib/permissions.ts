/**
 * Права — плоский список кодов. Роль это именованный набор кодов, а не enum:
 * в живой мастерской приёмщик обычно ещё и кассир, а управляющий иногда сам чинит.
 * Пять пресетов ниже создаются автоматически вместе с мастерской, дальше владелец правит их под себя.
 */
export const PERMISSIONS = {
  ORDERS_VIEW_ALL: "orders.view.all",
  ORDERS_VIEW_ASSIGNED: "orders.view.assigned",
  ORDERS_VIEW_DELIVERY: "orders.view.delivery",
  ORDERS_CREATE: "orders.create",
  ORDERS_EDIT: "orders.edit",
  ORDERS_STATUS: "orders.status",
  ORDERS_STATUS_OWN: "orders.status.own",
  ORDERS_ISSUE: "orders.issue",
  ORDERS_DELETE: "orders.delete",
  ORDERS_CUSTOMER_CONTACTS: "orders.customer_contacts",
  ORDERS_COST: "orders.cost",

  CUSTOMERS_VIEW: "customers.view",
  CUSTOMERS_EDIT: "customers.edit",

  STOCK_VIEW: "stock.view",
  STOCK_MOVE: "stock.move",
  STOCK_WRITE_OFF_OWN: "stock.write_off.own",
  STOCK_INVENTORY: "stock.inventory",

  PURCHASES_VIEW: "purchases.view",
  PURCHASES_CREATE: "purchases.create",
  PURCHASES_APPROVE: "purchases.approve",

  FINANCE_VIEW: "finance.view",
  FINANCE_PAYMENT: "finance.payment",
  FINANCE_MANAGE: "finance.manage",

  SALARY_VIEW_ALL: "salary.view.all",
  SALARY_VIEW_OWN: "salary.view.own",
  SALARY_MANAGE: "salary.manage",

  REPORTS_VIEW: "reports.view",
  REPORTS_FINANCE: "reports.finance",

  STAFF_MANAGE: "staff.manage",
  ROLES_MANAGE: "roles.manage",
  SETTINGS_MANAGE: "settings.manage",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];
const P = PERMISSIONS;

export const ROLE_PRESETS: Array<{ code: string; name: string; permissions: Permission[] }> = [
  {
    code: "MANAGER",
    name: "Управляющий",
    permissions: [
      P.ORDERS_VIEW_ALL, P.ORDERS_CREATE, P.ORDERS_EDIT, P.ORDERS_STATUS, P.ORDERS_ISSUE,
      P.ORDERS_CUSTOMER_CONTACTS, P.ORDERS_COST,
      P.CUSTOMERS_VIEW, P.CUSTOMERS_EDIT,
      P.STOCK_VIEW, P.STOCK_MOVE, P.STOCK_INVENTORY,
      P.PURCHASES_VIEW, P.PURCHASES_CREATE, P.PURCHASES_APPROVE,
      P.FINANCE_VIEW, P.FINANCE_PAYMENT, P.FINANCE_MANAGE,
      P.SALARY_VIEW_ALL, P.SALARY_MANAGE,
      P.REPORTS_VIEW, P.REPORTS_FINANCE,
      P.STAFF_MANAGE,
    ],
  },
  {
    code: "RECEPTIONIST",
    name: "Приёмщик",
    permissions: [
      P.ORDERS_VIEW_ALL, P.ORDERS_CREATE, P.ORDERS_EDIT, P.ORDERS_STATUS, P.ORDERS_ISSUE,
      P.ORDERS_CUSTOMER_CONTACTS,
      P.CUSTOMERS_VIEW, P.CUSTOMERS_EDIT,
      P.STOCK_VIEW, P.STOCK_MOVE,
      P.PURCHASES_VIEW, P.PURCHASES_CREATE,
      P.FINANCE_PAYMENT,
      P.SALARY_VIEW_OWN,
      P.REPORTS_VIEW,
    ],
  },
  {
    code: "MASTER",
    name: "Мастер",
    permissions: [
      // видит только назначенные ему заказы и только техническую часть карточки
      P.ORDERS_VIEW_ASSIGNED, P.ORDERS_STATUS_OWN,
      P.STOCK_VIEW, P.STOCK_WRITE_OFF_OWN,
      P.PURCHASES_CREATE,
      P.SALARY_VIEW_OWN,
    ],
  },
  {
    code: "ACCOUNTANT",
    name: "Бухгалтер",
    permissions: [
      P.ORDERS_VIEW_ALL, P.ORDERS_CUSTOMER_CONTACTS, P.ORDERS_COST,
      P.CUSTOMERS_VIEW,
      P.STOCK_VIEW,
      P.PURCHASES_VIEW,
      P.FINANCE_VIEW, P.FINANCE_PAYMENT, P.FINANCE_MANAGE,
      P.SALARY_VIEW_ALL, P.SALARY_MANAGE,
      P.REPORTS_VIEW, P.REPORTS_FINANCE,
    ],
  },
  {
    code: "COURIER",
    name: "Курьер",
    permissions: [P.ORDERS_VIEW_DELIVERY, P.FINANCE_PAYMENT, P.SALARY_VIEW_OWN],
  },
];

/** Владелец мастерской: все права внутри своей мастерской. */
export const ALL_PERMISSIONS: Permission[] = Object.values(P);

/**
 * Поля заказа, которые мастер НЕ должен получать в ответе API.
 * Фильтруется на бэкенде, а не скрывается на фронте.
 */
export const MASTER_HIDDEN_ORDER_FIELDS = [
  "totalWork", "totalParts", "discount", "total", "prepayment", "estimatedCost",
] as const;
