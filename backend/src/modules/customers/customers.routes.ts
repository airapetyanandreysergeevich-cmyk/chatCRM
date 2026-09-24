import { Prisma } from "@prisma/client";
import { Router, type Request } from "express";
import { z } from "zod";
import { clientIp, safeDiff, writeAudit } from "../../lib/audit";
import { withTenant } from "../../lib/db";
import { ah, notFound } from "../../lib/errors";
import { pageFields, paged, skipTake } from "../../lib/paging";
import { nextCustomerNumber } from "../../lib/customerNumber";
import { debts } from "../../lib/debt";
import { PERMISSIONS } from "../../lib/permissions";
import { actorUserId, authenticate, currentTenantId, requirePermission, requireTenant } from "../../middleware/auth";
import { enforceTenantStatus } from "../../middleware/tenantStatus";
import {
  CUSTOMER_COLORS,
  MAX_SCAN,
  colorFilterField,
  colorRank,
  customerColorWhere,
  desc,
  inOrder,
  pageIds,
  time,
  type Key,
} from "../../lib/listOrder";
import { seesMoney } from "../orders/orders.service";
import { fixLayout, searchWords, truthy } from "../../lib/search";

export const customersRouter = Router();
customersRouter.use(authenticate, requireTenant, enforceTenantStatus);

const tenantOf = (req: Request) => currentTenantId(req)!;

/**
 * Порядок списка клиентов.
 *
 * Первые три база сортирует сама. Остальные — своим правилом (цвета в порядке
 * палитры) или по суммам из других таблиц, поэтому их порядок собирается
 * здесь, по короткой выжимке всей базы (см. lib/listOrder).
 */
const CUSTOMER_SORTS = ["new", "old", "name", "orders", "color", "paid", "visit"] as const;
type CustomerSort = (typeof CUSTOMER_SORTS)[number];

const customerRow = (c: Prisma.CustomerGetPayload<{ include: { _count: { select: { orders: true; devices: true } } } }>) => ({
  id: c.id,
  number: c.number,
  type: c.type,
  name: c.name,
  phone: c.phone,
  phone2: c.phone2,
  email: c.email,
  address: c.address,
  source: c.source,
  note: c.note,
  color: c.color,
  discountPercent: Number(c.discountPercent),
  createdAt: c.createdAt,
  orderCount: c._count.orders,
  deviceCount: c._count.devices,
});

/**
 * Сколько клиент заплатил за всё время — по кассе: приход по его заказам минус
 * возвраты. То же правило, что у долга и у выдачи, — иначе «оплачено» в
 * карточке и в кассе разошлись бы, и объяснять разницу пришлось бы приёмщику.
 */
async function paidByCustomer(tx: Prisma.TransactionClient, tenantId: string, customerId?: string) {
  const rows = await tx.$queryRaw<Array<{ customerId: string; paid: Prisma.Decimal | null }>>`
    SELECT o."customerId" AS "customerId",
           SUM(CASE WHEN t.direction = 'IN' THEN t.amount ELSE -t.amount END) AS paid
    FROM "Transaction" t
    JOIN "Order" o ON o.id = t."orderId"
    WHERE t."tenantId" = ${tenantId}
      AND t."deletedAt" IS NULL
      AND o."deletedAt" IS NULL
      ${customerId ? Prisma.sql`AND o."customerId" = ${customerId}` : Prisma.empty}
    GROUP BY o."customerId"
  `;
  return new Map(rows.map((r) => [r.customerId, Math.round(Number(r.paid ?? 0) * 100) / 100]));
}

customersRouter.get(
  "/",
  requirePermission(PERMISSIONS.CUSTOMERS_VIEW),
  ah(async (req, res) => {
    const q = z
      .object({
        search: z.string().trim().max(120).optional(),
        sort: z.enum(CUSTOMER_SORTS).catch("new").default("new"),
        color: colorFilterField,
        layout: z.string().optional(),
        ...pageFields,
      })
      .parse(req.query);

    // Сортировка по деньгам — только тому, кто видит деньги: сам порядок
    // строк выдал бы, кто из клиентов заплатил больше.
    const sort: CustomerSort = q.sort === "paid" && !seesMoney(req) ? "new" : q.sort;

    // Каждое слово — отдельным условием: «Иван 912» — Иван с телефоном на 912.
    const wordWhere = (w: string): Prisma.CustomerWhereInput => ({
      OR: [
        { name: { contains: w, mode: "insensitive" as const } },
        { phone: { contains: w } },
        { phone2: { contains: w } },
        { email: { contains: w, mode: "insensitive" as const } },
        // Номер ищется, только если слово — число: иначе каждый поиск по
        // имени тащил бы за собой ещё и сравнение с номером.
        ...(/^\d{1,9}$/.test(w) ? [{ number: Number(w) }] : []),
      ],
    });
    const base: Prisma.CustomerWhereInput = { deletedAt: null, ...customerColorWhere(q.color) };
    let words = searchWords(q.search);
    let searchFixed: string | null = null;
    if (words.length && truthy(q.layout)) {
      const fixed = await withTenant(tenantOf(req), (tx) =>
        fixLayout(words, async (w) => (await tx.customer.count({ where: { AND: [base, wordWhere(w)] }, take: 1 })) > 0)
      );
      words = fixed.words;
      searchFixed = fixed.fixed;
    }

    // Условие одно на выборку и на подсчёт: разъехавшись, они дали бы
    // «страница 7 из 3», и виноватой выглядела бы навигация.
    const where: Prisma.CustomerWhereInput = { AND: [base, ...words.map(wordWhere)] };
    const include = { _count: { select: { orders: true, devices: true } } } as const;
    const tenantId = tenantOf(req);

    const [rows, total] = await withTenant(tenantId, async (tx) => {
      const count = tx.customer.count({ where });

      const byBase: Partial<Record<CustomerSort, Prisma.CustomerOrderByWithRelationInput[]>> = {
        new: [{ createdAt: "desc" }],
        old: [{ createdAt: "asc" }],
        name: [{ name: "asc" }, { createdAt: "desc" }],
        orders: [{ orders: { _count: "desc" } }, { createdAt: "desc" }],
      };
      const orderBy = byBase[sort];
      if (orderBy) {
        return Promise.all([tx.customer.findMany({ where, orderBy, ...skipTake(q), include }), count]);
      }

      const all = await tx.customer.findMany({
        where,
        select: { id: true, color: true, createdAt: true, name: true },
        take: MAX_SCAN,
      });
      let keyOf: (c: (typeof all)[number]) => Key[];
      if (sort === "color") {
        keyOf = (c) => [colorRank(c.color), c.name];
      } else if (sort === "paid") {
        const paid = await paidByCustomer(tx, tenantId);
        keyOf = (c) => [desc(paid.get(c.id) ?? 0), c.name];
      } else {
        // Последний визит — последний принятый заказ. Кто ни разу не
        // приходил с техникой, идёт в конце, а не в начале.
        const last = await tx.order.groupBy({
          by: ["customerId"],
          where: { deletedAt: null },
          _max: { acceptedAt: true },
        });
        const seen = new Map(last.map((l) => [l.customerId, l._max.acceptedAt]));
        keyOf = (c) => [desc(time(seen.get(c.id))), c.name];
      }
      const ids = pageIds(all, keyOf, q);
      const page = await tx.customer.findMany({ where: { id: { in: ids } }, include });
      return Promise.all([inOrder(ids, page), count]);
    });

    res.json({ ...paged(rows.map(customerRow), total, q), searchFixed });
  })
);

/**
 * Поиск по телефону для формы приёма: приёмщик вводит номер, и если человек
 * уже обращался, его данные подставляются, а карточка не дублируется.
 */
customersRouter.get(
  "/lookup",
  requirePermission(PERMISSIONS.CUSTOMERS_VIEW, PERMISSIONS.ORDERS_CREATE),
  ah(async (req, res) => {
    const { phone } = z.object({ phone: z.string().trim().min(4) }).parse(req.query);
    const found = await withTenant(tenantOf(req), (tx) =>
      tx.customer.findFirst({
        where: { phone: { contains: phone }, deletedAt: null },
        orderBy: { createdAt: "desc" },
      })
    );
    res.json(
      found
        ? {
            id: found.id,
            type: found.type,
            name: found.name,
            phone: found.phone,
            phone2: found.phone2,
            email: found.email,
            address: found.address,
          }
        : null
    );
  })
);

/**
 * Подсказки на приёме техники: приёмщик набирает телефон или имя, а система
 * показывает, кто из уже заведённых клиентов на это похож.
 *
 * Отдаём список, а не одну карточку: в мастерской сплошь и рядом два
 * Кузнецова и один телефон на всю семью. Выбор оставляем человеку — молча
 * подставленный не тот клиент хуже, чем лишний дубль.
 */
customersRouter.get(
  "/suggest",
  requirePermission(PERMISSIONS.CUSTOMERS_VIEW, PERMISSIONS.ORDERS_CREATE),
  ah(async (req, res) => {
    const q = z
      .object({
        phone: z.string().trim().max(40).optional(),
        name: z.string().trim().max(120).optional(),
      })
      .parse(req.query);

    const digits = (q.phone ?? "").replace(/[^0-9]/g, "");
    const name = (q.name ?? "").trim();

    // Слишком короткий запрос вернёт пол-базы — это не подсказка, а шум.
    if (digits.length < 3 && name.length < 2) return res.json([]);

    const tenantId = tenantOf(req);

    const rows = await withTenant(tenantId, async (tx) => {
      const ids = new Set<string>();

      if (digits.length >= 3) {
        // Телефоны в базе записаны как попало: «+7 921 555-00-11»,
        // «8(921)5550011», «921 555 00 11». Сравнивать их как строки
        // бесполезно, поэтому с обеих сторон оставляем одни цифры.
        // Запрос идёт внутри withTenant, значит его дополнительно режет RLS.
        const found = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "Customer"
          WHERE "tenantId" = ${tenantId}
            AND "deletedAt" IS NULL
            AND (
              regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') LIKE ${"%" + digits + "%"}
              OR regexp_replace(COALESCE(phone2, ''), '[^0-9]', '', 'g') LIKE ${"%" + digits + "%"}
            )
          LIMIT 8
        `;
        for (const f of found) ids.add(f.id);
      }

      if (name.length >= 2) {
        const found = await tx.customer.findMany({
          where: { deletedAt: null, name: { contains: name, mode: "insensitive" } },
          select: { id: true },
          take: 8,
        });
        for (const f of found) ids.add(f.id);
      }

      if (ids.size === 0) return [];

      return tx.customer.findMany({
        where: { id: { in: [...ids] }, deletedAt: null },
        orderBy: { createdAt: "desc" },
        take: 6,
        include: { _count: { select: { orders: true } } },
      });
    });

    res.json(
      rows.map((c) => ({
        id: c.id,
        number: c.number,
        type: c.type,
        name: c.name,
        phone: c.phone,
        phone2: c.phone2,
        email: c.email,
        address: c.address,
        source: c.source,
        color: c.color,
        discountPercent: Number(c.discountPercent),
        orderCount: c._count.orders,
      }))
    );
  })
);

customersRouter.get(
  "/:id",
  requirePermission(PERMISSIONS.CUSTOMERS_VIEW),
  ah(async (req, res) => {
    const data = await withTenant(tenantOf(req), async (tx) => {
      const customer = await tx.customer.findFirst({
        where: { id: req.params.id, deletedAt: null },
      });
      if (!customer) throw notFound("Клиент не найден");

      const tenantId = tenantOf(req);
      const [devices, orders, owed, paid, span] = await Promise.all([
        tx.device.findMany({ where: { customerId: customer.id }, orderBy: { createdAt: "desc" } }),
        tx.order.findMany({
          where: { customerId: customer.id, deletedAt: null },
          orderBy: { acceptedAt: "desc" },
          // Пятьсот ремонтов у одного клиента — это организация на
          // обслуживании за много лет. Больше на одной странице не читают.
          take: 500,
          include: {
            status: { select: { name: true, group: true } },
            device: { select: { kind: true, brand: true, model: true } },
          },
        }),
        debts(tx, { customerId: customer.id }),
        paidByCustomer(tx, tenantId, customer.id),
        // Счёт и даты — по всем заказам, а не по прочитанным пятистам.
        tx.order.aggregate({
          where: { customerId: customer.id, deletedAt: null },
          _count: { _all: true },
          _min: { acceptedAt: true },
          _max: { acceptedAt: true },
        }),
      ]);

      const money = seesMoney(req);
      // «В работе» — всё, что ещё у нас: принято, в ремонте, ждёт запчасть
      // или клиента, готово к выдаче. Выданное и отменённое — уже история.
      const active = orders.filter((o) => o.status.group !== "CLOSED" && o.status.group !== "CANCELLED").length;
      // Средний чек — по выданным: у незаконченного ремонта итог ещё растёт,
      // и он тянул бы среднее вниз.
      const issued = orders.filter((o) => o.issuedAt && Number(o.total) > 0);
      const average = issued.length
        ? Math.round((issued.reduce((sum, o) => sum + Number(o.total), 0) / issued.length) * 100) / 100
        : null;

      return {
        customer: {
          id: customer.id,
          number: customer.number,
          type: customer.type,
          name: customer.name,
          phone: customer.phone,
          phone2: customer.phone2,
          email: customer.email,
          address: customer.address,
          source: customer.source,
          inn: customer.inn,
          note: customer.note,
          color: customer.color,
          discountPercent: Number(customer.discountPercent),
          createdAt: customer.createdAt,
        },
        stats: {
          orders: span._count._all,
          active,
          firstVisit: span._min.acceptedAt,
          lastVisit: span._max.acceptedAt,
          // Деньги — только тому, кому их положено видеть.
          ...(money ? { paid: paid.get(customer.id) ?? 0, average } : {}),
        },
        // Суммарный долг и его разбивка по заказам. Сумма считается здесь же,
        // а не складывается на стороне интерфейса: округление до копеек должно
        // быть одно, иначе итог в карточке и сумма строк разойдутся на копейку,
        // и объяснять это клиенту придётся приёмщику.
        debt: {
          total: Math.round(owed.reduce((sum, d) => sum + d.due, 0) * 100) / 100,
          orders: owed.map((d) => ({
            orderId: d.orderId,
            number: d.number,
            due: d.due,
            total: d.total,
            issuedAt: d.issuedAt,
            debtDueAt: d.debtDueAt,
            overdue: d.overdue,
          })),
        },
        devices,
        orders: orders.map((o) => ({
          id: o.id,
          number: o.number,
          kind: o.kind,
          isUrgent: o.isUrgent,
          complaint: o.complaint,
          acceptedAt: o.acceptedAt,
          issuedAt: o.issuedAt,
          status: o.status,
          device: o.device,
          warrantyUntil: o.warrantyUntil,
          ...(money ? { total: Number(o.total) } : {}),
        })),
      };
    });
    res.json(data);
  })
);

/**
 * Цветные метки клиентов.
 *
 * Мастерская сама решает, что значит цвет: зелёный — «щедрый, всегда оставляет
 * чаевые», красный — «спорит из-за каждой копейки, всё фиксировать». Поэтому
 * здесь только набор цветов, без навязанных названий: подпись у метки —
 * название цвета, а смысл живёт в голове у тех, кто работает за стойкой.
 */
export { CUSTOMER_COLORS };

const customerSchema = z.object({
  color: z.enum(CUSTOMER_COLORS).nullable().optional().or(z.literal("")),
  type: z.enum(["INDIVIDUAL", "COMPANY"]).default("INDIVIDUAL"),
  name: z.string().trim().min(2, "Укажите имя или название"),
  phone: z.string().trim().min(6, "Укажите телефон"),
  phone2: z.string().trim().optional(),
  email: z.string().email("Похоже, это не email").optional().or(z.literal("")),
  address: z.string().trim().optional(),
  inn: z.string().trim().optional(),
  source: z.string().trim().optional(),
  note: z.string().trim().optional(),
  // Из формы число приходит строкой, поэтому coerce, а не number.
  discountPercent: z.coerce.number().min(0).max(100).optional(),
});

/**
 * Стёртое в форме поле приходит пустой строкой. В базе это должен быть null:
 * пустая строка в телефоне ломает поиск, а в email — проверку на занятость.
 */
const OPTIONAL_TEXT = ["phone2", "email", "address", "inn", "source", "note", "color"] as const;

function blankToNull(body: Record<string, unknown>): Record<string, null> {
  const out: Record<string, null> = {};
  for (const key of OPTIONAL_TEXT) {
    if (body[key] === "") out[key] = null;
  }
  return out;
}

customersRouter.post(
  "/",
  requirePermission(PERMISSIONS.CUSTOMERS_EDIT),
  ah(async (req, res) => {
    const body = customerSchema.parse(req.body);
    const tenantId = tenantOf(req);

    const created = await withTenant(tenantId, async (tx) => {
      const customer = await tx.customer.create({
        data: {
          tenantId,
          number: await nextCustomerNumber(tx, tenantId),
          ...body,
          ...blankToNull(body),
          createdById: actorUserId(req),
        },
      });
      await writeAudit(tx, {
        tenantId,
        userId: actorUserId(req),
        entity: "Customer",
        entityId: customer.id,
        action: "CREATE",
        diff: safeDiff(body as Record<string, unknown>),
        ip: clientIp(req),
      });
      return customer;
    });

    res.status(201).json({ id: created.id, name: created.name });
  })
);

customersRouter.patch(
  "/:id",
  requirePermission(PERMISSIONS.CUSTOMERS_EDIT),
  ah(async (req, res) => {
    const body = customerSchema.partial().parse(req.body);
    const tenantId = tenantOf(req);

    await withTenant(tenantId, async (tx) => {
      const customer = await tx.customer.findFirst({ where: { id: req.params.id, deletedAt: null } });
      if (!customer) throw notFound("Клиент не найден");

      await tx.customer.update({
        where: { id: customer.id },
        data: { ...body, ...blankToNull(body) },
      });
      await writeAudit(tx, {
        tenantId,
        userId: actorUserId(req),
        entity: "Customer",
        entityId: customer.id,
        action: "UPDATE",
        diff: safeDiff(body as Record<string, unknown>),
        ip: clientIp(req),
      });
    });

    res.json({ ok: true });
  })
);

customersRouter.delete(
  "/:id",
  requirePermission(PERMISSIONS.CUSTOMERS_EDIT),
  ah(async (req, res) => {
    const tenantId = tenantOf(req);

    await withTenant(tenantId, async (tx) => {
      const customer = await tx.customer.findFirst({ where: { id: req.params.id, deletedAt: null } });
      if (!customer) throw notFound("Клиент не найден");

      await tx.customer.update({
        where: { id: customer.id },
        data: { deletedAt: new Date() },
      });
      await writeAudit(tx, {
        tenantId,
        userId: actorUserId(req),
        entity: "Customer",
        entityId: customer.id,
        action: "DELETE",
        diff: {},
        ip: clientIp(req),
      });
    });

    res.json({ ok: true });
  })
);
