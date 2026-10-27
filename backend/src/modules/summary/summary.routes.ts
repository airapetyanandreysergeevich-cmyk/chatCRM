import { Router, type Request } from "express";
import { z } from "zod";
import { withTenant } from "../../lib/db";
import { ah } from "../../lib/errors";
import { PERMISSIONS } from "../../lib/permissions";
import {
  authenticate,
  currentTenantId,
  permissionsOf,
  requireTenant,
} from "../../middleware/auth";
import { enforceTenantStatus } from "../../middleware/tenantStatus";
import { seesCustomerContacts, seesMoney } from "../orders/orders.service";
import { effectiveTile, normalizeTile } from "./tile";
import { forbidden } from "../../lib/errors";
import { clientIp, writeAudit } from "../../lib/audit";
import { debtList, debts } from "../../lib/debt";
import { toLabels } from "../../lib/dictionaries";
import { contentDisposition, writeXlsx } from "../data/tableFile";
import { badRequest } from "../../lib/errors";
import { Prisma } from "@prisma/client";
import {
  debtorSortOf,
  ISSUED,
  issuedDaysOf,
  issuedSortOf,
  kindKey,
  MAX_CARDS,
  normalizePrefs,
  OVERDUE,
  prefsSchema,
  stageSortOf,
  STAGE_KEYS,
  DASHBOARD_VIEWS,
  defaultView,
  normalizeTable,
  type TablePrefs,
  type DashboardPrefs,
  type DashboardView,
  type DebtorSort,
  type StageKey,
  type StageSort,
} from "./prefs";

/**
 * Главный экран мастерской — доска заказов по стадиям.
 *
 * Это не витрина показателей, а рабочее место: человек открывает систему,
 * чтобы увидеть, что лежит на каждой стадии, и ткнуть в нужный заказ.
 * Поэтому здесь нет ни выручки, ни графиков — только заказы, разложенные
 * по колонкам, и ровно те поля, которые видны на карточке.
 *
 * Колонки заданы группой статуса, а не названием: мастерская переименовывает
 * статусы под себя, и доска от переименования разъезжаться не должна.
 *
 * Какие панели показывать, в каком порядке, как сортировать и какую технику
 * прятать — решает каждый сотрудник для себя (prefs.ts). Сортируем и
 * отсеиваем здесь, на сервере: иначе «60 первых» считались бы до фильтра, и
 * колонка с выключенными ноутбуками показывала бы пустоту при живых заказах.
 */

export const summaryRouter = Router();
summaryRouter.use(authenticate, requireTenant, enforceTenantStatus);

const tenantOf = (req: Request) => currentTenantId(req)!;
const has = (req: Request, code: string) => permissionsOf(req).includes(code);
const userOf = (req: Request) => (req.auth?.kind === "tenant" ? req.auth.userId : null);

/**
 * Сколько заказов стадии перебираем. Открытых заказов в мастерской — десятки,
 * от силы сотни; предел нужен только на случай, когда в «Выдаче» годами
 * копятся невыданные, — чтобы главная не превратилась в выгрузку базы.
 */
const STAGE_SCAN = 3000;

const cardSelect = {
  id: true,
  number: true,
  isUrgent: true,
  kind: true,
  acceptedAt: true,
  dueAt: true,
  status: { select: { id: true, name: true, group: true, color: true } },
  customer: { select: { id: true, name: true, type: true, color: true } },
  device: { select: { kind: true, brand: true, model: true } },
  assignedMaster: { select: { id: true, fullName: true } },
  // Для «Редактора панелей заказа»: неисправность и сумма — если их включат на карточке.
  complaint: true,
  // «Примечание приёмщика» — элемент карточки (Андрей, 21.10.2026).
  receptionNote: true,
  total: true,
  // Ярлыки — «Индивидуальные оповещения» (22.10.2026).
  labelMarks: { orderBy: { setAt: "asc" }, select: { labelId: true, setAt: true, setBy: { select: { fullName: true } } } },
} as const;

type CardRow = Prisma.OrderGetPayload<{ select: typeof cardSelect }>;

const time = (d: Date | null) => (d ? d.getTime() : Number.POSITIVE_INFINITY);
const numberOf = (n: string) => Number(n.replace(/\D+/g, "")) || 0;

/** Порядок карточек в колонке. Заказы без срока в сортировке по сроку — внизу. */
const STAGE_ORDER: Record<StageSort, (a: CardRow, b: CardRow) => number> = {
  urgent: (a, b) =>
    Number(b.isUrgent) - Number(a.isUrgent) ||
    time(a.dueAt) - time(b.dueAt) ||
    a.acceptedAt.getTime() - b.acceptedAt.getTime(),
  due: (a, b) => time(a.dueAt) - time(b.dueAt) || a.acceptedAt.getTime() - b.acceptedAt.getTime(),
  old: (a, b) => a.acceptedAt.getTime() - b.acceptedAt.getTime(),
  new: (a, b) => b.acceptedAt.getTime() - a.acceptedAt.getTime(),
  // Как читает человек: Р-999 раньше Р-1021.
  number: (a, b) => numberOf(a.number) - numberOf(b.number) || a.number.localeCompare(b.number),
};

/** Карточка заказа на главной: своя → мастерской → стандартная (tile.ts). */
async function tileOf(req: Request) {
  const userId = userOf(req);
  const [user, tenant] = await withTenant(tenantOf(req), (tx) =>
    Promise.all([
      userId ? tx.user.findFirst({ where: { id: userId }, select: { cardLayout: true } }) : null,
      tx.tenant.findUnique({ where: { id: tenantOf(req) }, select: { settings: true } }),
    ])
  );
  const workshop = (tenant?.settings as Record<string, unknown> | null)?.cardLayout ?? null;
  return {
    mine: normalizeTile(user?.cardLayout ?? null),
    workshop: normalizeTile(workshop),
    effective: effectiveTile(user?.cardLayout ?? null, workshop),
  };
}

/** Настройки главной этого сотрудника. У входа платформы своих нет — по умолчанию. */
async function prefsOf(req: Request): Promise<DashboardPrefs> {
  const userId = userOf(req);
  if (!userId) return normalizePrefs(null);
  const row = await withTenant(tenantOf(req), (tx) =>
    tx.user.findFirst({ where: { id: userId }, select: { dashboardPrefs: true } })
  );
  return normalizePrefs(row?.dashboardPrefs ?? null);
}

/** Виды таблицы мастерской («Сделать так у всех»), tenant.settings.tableViews. */
async function workshopTableOf(req: Request): Promise<TablePrefs | null> {
  const t = await withTenant(tenantOf(req), (tx) =>
    tx.tenant.findUnique({ where: { id: tenantOf(req) }, select: { settings: true } })
  );
  return normalizeTable((t?.settings as Record<string, unknown> | null)?.tableViews ?? null);
}

/** Вид главной у мастерской по умолчанию (tenant.settings.dashboardView). */
async function workshopViewOf(req: Request): Promise<DashboardView> {
  const t = await withTenant(tenantOf(req), (tx) =>
    tx.tenant.findUnique({ where: { id: tenantOf(req) }, select: { settings: true } })
  );
  const v = (t?.settings as Record<string, unknown> | null)?.dashboardView;
  return v === "table" ? "table" : "board";
}

/** Заказ строкой таблицы на главной: всё, что есть в столбцах. */
const tableSelect = {
  ...cardSelect,
  kind: true,
  completedAt: true,
  issuedAt: true,
  completeness: true,
  appearance: true,
  receptionNote: true,
  devicePasscode: true,
  storageLocation: true,
  outsourceNumber: true,
  diagnosis: true,
  masterComment: true,
  estimatedCost: true,
  prepayment: true,
  totalWork: true,
  totalParts: true,
  discount: true,
  acceptedBy: { select: { fullName: true } },
  customer: {
    select: { id: true, name: true, type: true, color: true, phone: true, phone2: true, email: true, address: true, source: true, isOutsource: true, _count: { select: { orders: true } } },
  },
  device: { select: { kind: true, brand: true, model: true, serial: true } },
} as const;

type TableRow = Prisma.OrderGetPayload<{ select: typeof tableSelect }>;

/**
 * Строки таблицы: все заказы в работе (четыре стадии) и — тому, кто видит
 * деньги, — выданные с долгом, для быстрого фильтра «С долгом». Фильтры,
 * поиск и сортировка — в браузере: открытых заказов десятки, от силы сотни,
 * и щелчок по фильтру не должен ждать сервер.
 */
async function tableOf(req: Request, mineWhere: Prisma.OrderWhereInput, contacts: boolean, money: boolean) {
  const tenantId = tenantOf(req);
  return withTenant(tenantId, async (tx) => {
    const active = await tx.order.findMany({
      where: { deletedAt: null, ...mineWhere, status: { group: { in: [...STAGE_KEYS] } } },
      orderBy: { acceptedAt: "desc" },
      take: STAGE_SCAN,
      select: tableSelect,
    });
    const owed = money ? await debtList(tx, tenantId) : new Map<string, { due: number; debtDueAt: Date | null }>();
    const owedRows = owed.size
      ? await tx.order.findMany({
          where: { id: { in: [...owed.keys()].slice(0, 1000) }, deletedAt: null, ...mineWhere },
          orderBy: { issuedAt: "desc" },
          select: tableSelect,
        })
      : [];
    const rows: TableRow[] = [...active, ...owedRows.filter((o) => !active.some((a) => a.id === o.id))];
    // С какого момента заказ в нынешнем статусе — для «Статус дольше нормы».
    const since = new Map<string, Date>();
    for (let i = 0; i < active.length; i += 500) {
      const part = active.slice(i, i + 500).map((o) => o.id);
      const last = await tx.orderStatusHistory.groupBy({ by: ["orderId"], where: { orderId: { in: part } }, _max: { createdAt: true } });
      for (const l of last) if (l._max.createdAt) since.set(l.orderId, l._max.createdAt);
    }
    // Оплачено по заказу и последнее сообщение истории ремонта — для столбцов
    // конфигуратора. Одним запросом на всё, а не по запросу на строку.
    const ids = rows.map((o) => o.id);
    const paid = new Map<string, number>();
    const lastMsg = new Map<string, string>();
    for (let i = 0; i < ids.length; i += 1000) {
      const part = ids.slice(i, i + 1000);
      if (money) {
        const sums = await tx.transaction.groupBy({ by: ["orderId", "direction"], where: { deletedAt: null, orderId: { in: part } }, _sum: { amount: true } });
        for (const x of sums) {
          if (!x.orderId) continue;
          const v = Number(x._sum.amount ?? 0) * (x.direction === "IN" ? 1 : -1);
          paid.set(x.orderId, Math.round(((paid.get(x.orderId) ?? 0) + v) * 100) / 100);
        }
      }
      const msgs = await tx.$queryRaw<Array<{ orderId: string; text: string }>>`
        SELECT DISTINCT ON ("orderId") "orderId", LEFT(text, 200) AS text
          FROM "OrderMessage"
         WHERE "orderId" IN (${Prisma.join(part)}) AND "deletedAt" IS NULL AND text <> ''
         ORDER BY "orderId", "createdAt" DESC`;
      for (const m of msgs) lastMsg.set(m.orderId, m.text);
    }
    const marks = await tx.orderLabelMark.findMany({
      where: { orderId: { in: ids } },
      orderBy: { setAt: "asc" },
      select: { orderId: true, labelId: true, setAt: true, setBy: { select: { fullName: true } } },
    });
    const labelsBy = new Map<string, Array<{ id: string; setAt: Date; setBy: string | null }>>();
    for (const m of marks) labelsBy.set(m.orderId, [...(labelsBy.get(m.orderId) ?? []), { id: m.labelId, setAt: m.setAt, setBy: m.setBy?.fullName ?? null }]);
    const cut = (v: string | null | undefined, n = 300) => (v ? v.slice(0, n) : null);
    const n = (v: Prisma.Decimal | null) => (v === null ? null : Number(v));

    return rows.map((o) => ({
      id: o.id,
      number: o.number,
      kind: o.kind,
      isUrgent: o.isUrgent,
      acceptedAt: o.acceptedAt,
      acceptedBy: o.acceptedBy?.fullName ?? null,
      dueAt: o.dueAt,
      completedAt: o.completedAt,
      issuedAt: o.issuedAt,
      statusSince: since.get(o.id) ?? o.acceptedAt,
      status: o.status,
      device: o.device,
      master: o.assignedMaster,
      labels: labelsBy.get(o.id) ?? [],
      customer: contacts
        ? {
            id: o.customer.id,
            type: o.customer.type,
            color: o.customer.color,
            name: o.customer.name,
            phone: o.customer.phone,
            phone2: o.customer.phone2,
            email: o.customer.email,
            address: o.customer.address,
            source: o.customer.source,
            orders: o.customer._count.orders,
          }
        : { id: o.customer.id, type: o.customer.type, color: o.customer.color },
      complaint: o.complaint.length > 300 ? o.complaint.slice(0, 300) : o.complaint,
      completeness: toLabels(o.completeness),
      appearance: toLabels(o.appearance),
      receptionNote: cut(o.receptionNote),
      passcode: o.devicePasscode,
      storage: o.storageLocation,
      outsource: o.outsourceNumber,
      // Заказ от аутсорса — для фильтра «Аутсорс ▾» (27.10.2026). Название
      // компании — тем, кто видит клиентов; остальным — только «аутсорс».
      outsourcer: o.customer.isOutsource ? { id: o.customer.id, name: contacts ? o.customer.name : null } : null,
      diagnosis: cut(o.diagnosis),
      masterComment: cut(o.masterComment),
      lastMessage: lastMsg.get(o.id) ?? null,
      ...(money
        ? {
            total: Number(o.total),
            estimate: n(o.estimatedCost),
            prepay: n(o.prepayment),
            works: n(o.totalWork),
            parts: n(o.totalParts),
            discount: n(o.discount),
            paid: paid.get(o.id) ?? 0,
            ...(owed.has(o.id) ? { debt: owed.get(o.id)!.due } : {}),
          }
        : {}),
    }));
  });
}

interface Debtor {
  customerId: string;
  number: number;
  name: string;
  phone: string;
  due: number;
  orders: number;
  since: Date;
  promised: Date | null;
  overdue: boolean;
}

/**
 * Должники: клиенты, у которых сейчас есть долг, одной строкой на клиента.
 *
 * Долг — по той же формуле, что и везде (lib/debt.ts): выданный заказ, итог
 * минус проведённые по нему деньги. Здесь она записана одним запросом, а не
 * через debts(): там перебираются последние выданные заказы, и долг двухлетней
 * давности на главную просто не попал бы — а он-то и нужен.
 *
 * Просроченные — всегда первыми: это те, кому звонить сегодня. Внутри —
 * выбранный порядок.
 */
async function debtorsOf(
  tx: Prisma.TransactionClient,
  tenantId: string,
  sort: DebtorSort
): Promise<{ rows: Debtor[]; total: number; sum: number }> {
  const rows = await tx.$queryRaw<
    Array<{
      customerId: string;
      number: number;
      name: string;
      phone: string;
      due: string;
      orders: bigint;
      since: Date;
      promised: Date | null;
      overdue: boolean;
    }>
  >`
    WITH paid AS (
      SELECT t."orderId", SUM(CASE WHEN t.direction = 'IN' THEN t.amount ELSE -t.amount END) AS paid
        FROM "Transaction" t
       WHERE t."tenantId" = ${tenantId} AND t."deletedAt" IS NULL AND t."orderId" IS NOT NULL
       GROUP BY t."orderId"
    ), due AS (
      SELECT o."customerId", o."issuedAt", o."debtDueAt",
             ROUND(o.total - COALESCE(p.paid, 0), 2) AS due
        FROM "Order" o
        LEFT JOIN paid p ON p."orderId" = o.id
       WHERE o."tenantId" = ${tenantId} AND o."deletedAt" IS NULL AND o."issuedAt" IS NOT NULL
    )
    SELECT c.id AS "customerId", c.number, c.name, c.phone,
           SUM(d.due)::text AS due, COUNT(*) AS orders,
           MIN(d."issuedAt") AS since,
           MIN(d."debtDueAt") AS promised,
           COALESCE(BOOL_OR(d."debtDueAt" <= now()), false) AS overdue
      FROM due d
      JOIN "Customer" c ON c.id = d."customerId"
     WHERE d.due > 0
     GROUP BY c.id
  `;

  const list: Debtor[] = rows.map((r) => ({
    customerId: r.customerId,
    number: r.number,
    name: r.name,
    phone: r.phone,
    due: Math.round(Number(r.due) * 100) / 100,
    orders: Number(r.orders),
    since: r.since,
    promised: r.promised,
    overdue: r.overdue,
  }));

  const inner: Record<DebtorSort, (a: Debtor, b: Debtor) => number> = {
    sum: (a, b) => b.due - a.due,
    old: (a, b) => a.since.getTime() - b.since.getTime(),
    promised: (a, b) => time(a.promised) - time(b.promised) || b.due - a.due,
  };
  list.sort((a, b) => Number(b.overdue) - Number(a.overdue) || inner[sort](a, b) || a.name.localeCompare(b.name));

  return {
    rows: list.slice(0, MAX_CARDS),
    total: list.length,
    sum: Math.round(list.reduce((s, d) => s + d.due, 0) * 100) / 100,
  };
}

summaryRouter.get(
  "/",
  ah(async (req, res) => {
    const me = userOf(req);
    const seesAll = has(req, PERMISSIONS.ORDERS_VIEW_ALL);
    const onlyMine = !seesAll && has(req, PERMISSIONS.ORDERS_VIEW_ASSIGNED) && me;
    const contacts = seesCustomerContacts(req);
    const money = seesMoney(req);
    const prefs = await prefsOf(req);
    const tile = (await tileOf(req)).effective;
    const workshopView = await workshopViewOf(req);
    const view: DashboardView = prefs.view ?? workshopView;

    // Мастер видит на доске только свои заказы — ровно то же, что и в списке.
    // Доска, не совпадающая со списком, читается как поломка.
    const mineWhere = onlyMine ? { assignedMasterId: me } : {};

    // Таблица: доску не собираем — её всё равно не видно.
    const table = view === "table" ? await tableOf(req, mineWhere, contacts, money) : null;

    const stages = await withTenant(tenantOf(req), async (tx) => {
      const out: Array<{ key: StageKey | typeof ISSUED; total: number; filtered: number; items: unknown[]; days?: number }> = [];

      for (const key of STAGE_KEYS) {
        // Выключенную колонку не считаем вовсе: её не видно, а время — идёт.
        if (prefs.hidden.includes(key) || table) {
          out.push({ key, total: 0, filtered: 0, items: [] });
          continue;
        }
        const all = await tx.order.findMany({
          where: { deletedAt: null, ...mineWhere, status: { group: key } },
          take: STAGE_SCAN,
          select: cardSelect,
        });

        const hiddenKinds = new Set(prefs.panels[key]?.hiddenKinds ?? []);
        const rows = hiddenKinds.size ? all.filter((o) => !hiddenKinds.has(kindKey(o.device?.kind))) : all;
        rows.sort(STAGE_ORDER[stageSortOf(prefs, key)]);

        out.push({
          key,
          total: rows.length,
          // Сколько спрятал фильтр — чтобы заказ не «потерялся»: число под
          // колонкой напоминает, что он есть, просто не здесь.
          filtered: all.length - rows.length,
          items: rows.slice(0, MAX_CARDS).map(card),
        });
      }

      // «Выдано» (28.10.2026): заказы, отданные клиенту за последние N дней.
      // Панель по умолчанию выключена — включают в списке панелей.
      // issuedAt сбрасывается при возврате в работу, так что вернувшийся
      // заказ отсюда уходит сам.
      const days = issuedDaysOf(prefs);
      if (prefs.hidden.includes(ISSUED) || table) {
        out.push({ key: ISSUED, total: 0, filtered: 0, items: [], days });
      } else {
        const all = await tx.order.findMany({
          where: { deletedAt: null, ...mineWhere, issuedAt: { gte: new Date(Date.now() - days * 86_400_000) } },
          orderBy: { issuedAt: "desc" },
          take: STAGE_SCAN,
          select: { ...cardSelect, issuedAt: true },
        });
        const hiddenKinds = new Set(prefs.panels[ISSUED]?.hiddenKinds ?? []);
        const rows = hiddenKinds.size ? all.filter((o) => !hiddenKinds.has(kindKey(o.device?.kind))) : all;
        if (issuedSortOf(prefs) === "number") rows.sort(STAGE_ORDER.number);
        out.push({
          key: ISSUED,
          total: rows.length,
          filtered: all.length - rows.length,
          days,
          items: rows.slice(0, MAX_CARDS).map((o) => ({ ...card(o), issuedAt: o.issuedAt })),
        });
      }

      return out;

      function card(o: CardRow) {
        return {
            id: o.id,
            number: o.number,
            isUrgent: o.isUrgent,
            kind: o.kind,
            acceptedAt: o.acceptedAt,
            dueAt: o.dueAt,
            status: o.status,
            device: o.device,
            master: o.assignedMaster,
            // Имя клиента — часть контактов: мастеру база клиентов не нужна,
            // и сервер её просто не кладёт в ответ.
            // Цветная метка — не контакт: её видят все, кто видит заказ.
            customer: contacts ? o.customer : { id: o.customer.id, type: o.customer.type, color: o.customer.color },
            complaint: o.complaint.length > 300 ? o.complaint.slice(0, 300) : o.complaint,
            note: o.receptionNote ? o.receptionNote.slice(0, 300) : null,
            labels: o.labelMarks.map((m) => ({ id: m.labelId, setAt: m.setAt, setBy: m.setBy?.fullName ?? null })),
            // Сумма — только тем, кто видит деньги заказа.
            ...(money ? { total: Number(o.total) } : {}),
        };
      }
    });

    // Просроченные долги. Полоса показывается только когда они есть: пустая
    // «Просрочка: 0» приучает не смотреть на это место, а потом её не
    // замечают и с непустой.
    //
    // Мастеру ни просрочки, ни должников не показываем — деньги не его
    // забота, а в его списке и клиентов-то нет.
    const overdue =
      contacts && !prefs.hidden.includes(OVERDUE)
        ? await withTenant(tenantOf(req), (tx) => debts(tx, { overdueOnly: true, limit: 50 }))
        : [];

    const debtors =
      contacts && !prefs.hidden.includes("DEBTORS")
        ? await withTenant(tenantOf(req), (tx) => debtorsOf(tx, tenantOf(req), debtorSortOf(prefs)))
        : null;

    res.json({
      stages,
      scope: onlyMine ? "mine" : "all",
      prefs,
      view,
      workshopView,
      // Сумма и «С долгом» в таблице — тому, кто видит деньги заказов.
      ...(table ? { table, tableMoney: money } : {}),
      // Виды таблицы: свои → мастерской → стандартный.
      tableViews: prefs.table ?? (await workshopTableOf(req)) ?? { views: [defaultView()] },
      tableViewsOwn: Boolean(prefs.table),
      tile,
      // Может ли человек вообще видеть деньги клиентов: от этого зависит,
      // есть ли в его настройках «Должники» и полоса просрочки.
      money: contacts,
      overdue: overdue.map((d) => ({
        orderId: d.orderId,
        number: d.number,
        due: d.due,
        debtDueAt: d.debtDueAt,
        customer: d.customer,
      })),
      overdueTotal: Math.round(overdue.reduce((sum, d) => sum + d.due, 0) * 100) / 100,
      debtors,
    });
  })
);

/** Настройки главной — свои, для раздела «Интерфейс». */
summaryRouter.get(
  "/prefs",
  ah(async (req, res) => {
    res.json({
      prefs: await prefsOf(req),
      money: seesCustomerContacts(req),
      personal: userOf(req) !== null,
      workshopView: await workshopViewOf(req),
      canShare: has(req, PERMISSIONS.SETTINGS_MANAGE),
    });
  })
);

/**
 * «Сделать так у всех» в конфигураторе таблицы: виды мастерской, личные
 * сбрасываются — как у редактора карточки заказа. null — у всех стандартный.
 */
summaryRouter.put(
  "/table/workshop",
  ah(async (req, res) => {
    if (!has(req, PERMISSIONS.SETTINGS_MANAGE)) throw forbidden("Таблицу у всех меняет тот, кто правит настройки мастерской");
    const body = z.object({ table: z.unknown() }).parse(req.body ?? {});
    const table = body.table === null ? null : normalizeTable(body.table);
    if (body.table !== null && !table) throw badRequest("Не похоже на настройки таблицы");
    const tenantId = tenantOf(req);
    await withTenant(tenantId, async (tx) => {
      const t = await tx.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } });
      const { tableViews: _old, ...rest } = (t?.settings as Record<string, unknown> | null) ?? {};
      await tx.tenant.update({
        where: { id: tenantId },
        data: { settings: (table ? { ...rest, tableViews: table } : rest) as unknown as Prisma.InputJsonObject },
      });
      const reset = await tx.$executeRaw`UPDATE "User" SET "dashboardPrefs" = "dashboardPrefs" - 'table' WHERE "dashboardPrefs" ? 'table'`;
      await writeAudit(tx, {
        tenantId,
        userId: userOf(req),
        entity: "Tenant",
        entityId: tenantId,
        action: "UPDATE",
        diff: { tableViews: table ? table.views.map((v) => v.name).join(", ") : "стандартная таблица", personalReset: reset },
        ip: clientIp(req),
      });
    });
    res.json({ ok: true });
  })
);

/**
 * Выгрузка вида таблицы в Excel: то, что человек видит, — его же столбцы и
 * строки (уже отфильтрованные и отформатированные интерфейсом).
 */
summaryRouter.post(
  "/table/export",
  ah(async (req, res) => {
    const body = z
      .object({
        name: z.string().max(60).default("Заказы"),
        columns: z.array(z.object({ title: z.string().max(60), width: z.number().min(4).max(80).optional() })).min(1).max(60),
        rows: z.array(z.array(z.union([z.string().max(2000), z.number(), z.null()])).max(60)).max(5000),
      })
      .parse(req.body ?? {});
    const buf = await writeXlsx([{ name: body.name || "Заказы", columns: body.columns, rows: body.rows }]);
    const file = `${(body.name || "Заказы").replace(/[\\/:*?"<>|]+/g, " ").trim() || "Заказы"} ${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", contentDisposition(file, "orders.xlsx"));
    res.send(buf);
  })
);

/** Вид главной у мастерской по умолчанию — у кого свой не выбран. */
summaryRouter.put(
  "/view/workshop",
  ah(async (req, res) => {
    if (!has(req, PERMISSIONS.SETTINGS_MANAGE)) throw forbidden("Вид по умолчанию меняет тот, кто правит настройки мастерской");
    const { view } = z.object({ view: z.enum(DASHBOARD_VIEWS) }).parse(req.body ?? {});
    const tenantId = tenantOf(req);
    await withTenant(tenantId, async (tx) => {
      const t = await tx.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } });
      const before = (t?.settings as Record<string, unknown> | null) ?? {};
      await tx.tenant.update({
        where: { id: tenantId },
        data: { settings: { ...before, dashboardView: view } as unknown as Prisma.InputJsonObject },
      });
      await writeAudit(tx, {
        tenantId,
        userId: userOf(req),
        entity: "Tenant",
        entityId: tenantId,
        action: "UPDATE",
        diff: { dashboardView: view === "table" ? "главная таблицей" : "главная доской" },
        ip: clientIp(req),
      });
    });
    res.json({ workshopView: view });
  })
);

summaryRouter.put(
  "/prefs",
  ah(async (req, res) => {
    const userId = userOf(req);
    // Вход поддержки платформы — не сотрудник: сохранять настройки некуда,
    // а записать их кому-то из мастерской было бы хуже, чем отказать.
    if (!userId) throw badRequest("Настройки главного экрана сохраняются у сотрудника мастерской");
    const body = z.object({ prefs: prefsSchema }).parse(req.body);
    const prefs = normalizePrefs(body.prefs);
    await withTenant(tenantOf(req), (tx) =>
      tx.user.updateMany({ where: { id: userId }, data: { dashboardPrefs: prefs as unknown as Prisma.InputJsonValue } })
    );
    res.json({ prefs });
  })
);

// ---------------------------------------------------------------- «Редактор панелей заказа»

summaryRouter.get(
  "/tile",
  ah(async (req, res) => {
    res.json({
      ...(await tileOf(req)),
      personal: userOf(req) !== null,
      // «Сделать так у всех» — тому, кто правит настройки мастерской.
      canShare: has(req, PERMISSIONS.SETTINGS_MANAGE),
      money: seesMoney(req),
      contacts: seesCustomerContacts(req),
    });
  })
);

/** Своя карточка. null — вернуть общую (или стандартную). */
summaryRouter.put(
  "/tile",
  ah(async (req, res) => {
    const userId = userOf(req);
    if (!userId) throw badRequest("Карточка заказа сохраняется у сотрудника мастерской");
    const body = z.object({ tile: z.unknown() }).parse(req.body ?? {});
    const tile = body.tile === null ? null : normalizeTile(body.tile);
    if (body.tile !== null && !tile) throw badRequest("Не похоже на раскладку карточки");
    await withTenant(tenantOf(req), (tx) =>
      tx.user.updateMany({
        where: { id: userId },
        data: { cardLayout: tile ? (tile as unknown as Prisma.InputJsonValue) : Prisma.DbNull },
      })
    );
    res.json(await tileOf(req));
  })
);

/**
 * «Сделать так у всех»: карточка мастерской, личные сбрасываются — иначе у
 * тех, кто когда-то правил свою, ничего бы не поменялось. null — у всех
 * стандартная.
 */
summaryRouter.put(
  "/tile/workshop",
  ah(async (req, res) => {
    if (!has(req, PERMISSIONS.SETTINGS_MANAGE)) throw forbidden("Менять карточку у всех может тот, кто правит настройки мастерской");
    const body = z.object({ tile: z.unknown() }).parse(req.body ?? {});
    const tile = body.tile === null ? null : normalizeTile(body.tile);
    if (body.tile !== null && !tile) throw badRequest("Не похоже на раскладку карточки");
    const tenantId = tenantOf(req);
    await withTenant(tenantId, async (tx) => {
      const t = await tx.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } });
      const before = (t?.settings as Record<string, unknown> | null) ?? {};
      const { cardLayout: _old, ...rest } = before;
      await tx.tenant.update({
        where: { id: tenantId },
        data: { settings: (tile ? { ...rest, cardLayout: tile } : rest) as unknown as Prisma.InputJsonObject },
      });
      const reset = await tx.user.updateMany({ where: { cardLayout: { not: Prisma.DbNull } }, data: { cardLayout: Prisma.DbNull } });
      await writeAudit(tx, {
        tenantId,
        userId: userOf(req),
        entity: "Tenant",
        entityId: tenantId,
        action: "UPDATE",
        diff: { cardLayout: tile ? "общая карточка заказа" : "стандартная карточка заказа", personalReset: reset.count },
        ip: clientIp(req),
      });
    });
    res.json(await tileOf(req));
  })
);

/**
 * Типы техники для фильтра в шестерёнке.
 *
 * Берём из всей техники мастерской, а не только с доски: мастер, который не
 * чинит ноутбуки, хочет выключить их заранее, а не ждать, пока принесут.
 * Одинаковые с точностью до регистра склеены; подпись — самое частое
 * написание. Редкие опечатки из старой базы списком в сотню строк никому не
 * помогут, поэтому показываем самые частые — плюс те, что уже выключены,
 * чтобы их можно было включить обратно.
 */
const KINDS_SHOWN = 30;

summaryRouter.get(
  "/kinds",
  ah(async (req, res) => {
    const prefs = await prefsOf(req);
    const hidden = new Set(Object.values(prefs.panels).flatMap((p) => p?.hiddenKinds ?? []));

    const { groups, noDevice } = await withTenant(tenantOf(req), async (tx) => ({
      groups: await tx.device.groupBy({ by: ["kind"], _count: { _all: true } }),
      noDevice: await tx.order.count({ where: { deletedAt: null, deviceId: null } }),
    }));

    const merged = new Map<string, { count: number; spellings: Map<string, number> }>();
    for (const g of groups) {
      const key = kindKey(g.kind);
      const entry = merged.get(key) ?? { count: 0, spellings: new Map() };
      entry.count += g._count._all;
      const spelled = g.kind.trim().replace(/\s+/g, " ");
      entry.spellings.set(spelled, (entry.spellings.get(spelled) ?? 0) + g._count._all);
      merged.set(key, entry);
    }
    if (noDevice) {
      const entry = merged.get("") ?? { count: 0, spellings: new Map() };
      entry.count += noDevice;
      merged.set("", entry);
    }

    const label = (key: string, spellings: Map<string, number>) => {
      if (!key) return "Без типа";
      const best = [...spellings.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? key;
      return best.charAt(0).toLocaleUpperCase("ru-RU") + best.slice(1);
    };

    const all = [...merged.entries()]
      .map(([key, e]) => ({ key, label: label(key, e.spellings), count: e.count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "ru"));

    const top = all.filter((k) => k.key !== "").slice(0, KINDS_SHOWN);
    const extra = all.filter((k) => k.key !== "" && !top.includes(k) && hidden.has(k.key));
    // Выключенный тип, которого в базе уже нет, всё равно показываем:
    // иначе его не включить обратно, а запись о нём останется навсегда.
    const gone = [...hidden]
      .filter((k) => k !== "" && !merged.has(k))
      .map((key) => ({ key, label: key.charAt(0).toLocaleUpperCase("ru-RU") + key.slice(1), count: 0 }));
    const none = merged.has("") || hidden.has("") ? [{ key: "", label: "Без типа", count: merged.get("")?.count ?? 0 }] : [];

    res.json({ kinds: [...top, ...extra, ...gone, ...none] });
  })
);
