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
import { seesCustomerContacts } from "../orders/orders.service";
import { debts } from "../../lib/debt";
import { badRequest } from "../../lib/errors";
import { Prisma } from "@prisma/client";
import {
  debtorSortOf,
  kindKey,
  MAX_CARDS,
  normalizePrefs,
  OVERDUE,
  prefsSchema,
  stageSortOf,
  STAGE_KEYS,
  type DashboardPrefs,
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
  acceptedAt: true,
  dueAt: true,
  status: { select: { id: true, name: true, group: true, color: true } },
  customer: { select: { id: true, name: true, type: true } },
  device: { select: { kind: true, brand: true, model: true } },
  assignedMaster: { select: { id: true, fullName: true } },
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

/** Настройки главной этого сотрудника. У входа платформы своих нет — по умолчанию. */
async function prefsOf(req: Request): Promise<DashboardPrefs> {
  const userId = userOf(req);
  if (!userId) return normalizePrefs(null);
  const row = await withTenant(tenantOf(req), (tx) =>
    tx.user.findFirst({ where: { id: userId }, select: { dashboardPrefs: true } })
  );
  return normalizePrefs(row?.dashboardPrefs ?? null);
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
    const prefs = await prefsOf(req);

    // Мастер видит на доске только свои заказы — ровно то же, что и в списке.
    // Доска, не совпадающая со списком, читается как поломка.
    const mineWhere = onlyMine ? { assignedMasterId: me } : {};

    const stages = await withTenant(tenantOf(req), async (tx) => {
      const out: Array<{ key: StageKey; total: number; filtered: number; items: unknown[] }> = [];

      for (const key of STAGE_KEYS) {
        // Выключенную колонку не считаем вовсе: её не видно, а время — идёт.
        if (prefs.hidden.includes(key)) {
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
          items: rows.slice(0, MAX_CARDS).map((o) => ({
            id: o.id,
            number: o.number,
            isUrgent: o.isUrgent,
            acceptedAt: o.acceptedAt,
            dueAt: o.dueAt,
            status: o.status,
            device: o.device,
            master: o.assignedMaster,
            // Имя клиента — часть контактов: мастеру база клиентов не нужна,
            // и сервер её просто не кладёт в ответ.
            customer: contacts ? o.customer : { id: o.customer.id, type: o.customer.type },
          })),
        });
      }

      return out;
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
    res.json({ prefs: await prefsOf(req), money: seesCustomerContacts(req), personal: userOf(req) !== null });
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
