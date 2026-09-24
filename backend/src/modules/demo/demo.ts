import type { Prisma } from "@prisma/client";
import { hashPassword } from "../../lib/password";
import { takePayment } from "../../lib/payment";
import { withPlatform } from "../../lib/db";
import { applyRows, temporaryPassword } from "../data/apply";
import type { DatasetKey } from "../data/dataset";
import { parseRows } from "../data/import";
import type { TableRow } from "../data/tableFile";
import {
  CUSTOMER_HEAD,
  CUSTOMERS,
  DEMO_COLORS,
  DEMO_STAFF,
  demoNumber,
  ORDER_HEAD,
  ORDERS,
  SERVICE_HEAD,
  SERVICES,
  STOCK,
  STOCK_HEAD,
  type DemoOrder,
} from "./demoData";

/**
 * Тестовые данные мастерской: завести и убрать.
 *
 * Что завели — запоминаем списком в настройках мастерской (settings.demo), а
 * не признаком в каждой таблице. Признак пришлось бы добавить в шесть таблиц
 * и помнить о нём в каждом запросе; список нужен ровно в двух местах — здесь,
 * при заведении и при уборке.
 *
 * Убирается только заведённое здесь. Настоящий заказ, принятый, пока
 * тестовые данные были в базе, остаётся — даже если его приняли на
 * тестового клиента: тогда остаётся и этот клиент.
 */

export interface DemoState {
  createdAt: string;
  /** Пароль тестовых сотрудников — один на всех, случайный. Показываем владельцу. */
  password: string;
  logins: string[];
  users: string[];
  customers: string[];
  orders: string[];
  stock: string[];
  services: string[];
  transactions: string[];
}

export const demoOf = (settings: unknown): DemoState | null => {
  const demo = (settings as { demo?: DemoState } | null)?.demo;
  return demo && Array.isArray(demo.orders) ? demo : null;
};

/** База пустая — можно заводить тестовые данные. Прайс и сотрудники не в счёт. */
export async function isEmptyBase(tx: Prisma.TransactionClient): Promise<boolean> {
  const [orders, customers, stock] = await Promise.all([
    tx.order.count(),
    tx.customer.count(),
    tx.stockItem.count(),
  ]);
  return orders + customers + stock === 0;
}

// ------------------------------------------------------------------ даты

const DAY = 24 * 60 * 60 * 1000;

/** «дд.мм.гггг чч:мм» — как в файле: загрузка разбирает именно так. */
function stamp(d: Date, withTime = true): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const date = `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
  return withTime ? `${date} ${p(d.getHours())}:${p(d.getMinutes())}` : date;
}

/** День заказа со смещением от сегодня; время приёма — рабочее, у каждого своё. */
function at(today: Date, days: number, hour = 12, minute = 0): Date {
  const d = new Date(today.getTime() + days * DAY);
  d.setHours(hour, minute, 0, 0);
  return d;
}

const table = (head: string[], rows: Array<Array<string | number>>): TableRow[] => [
  { n: 1, cells: head },
  ...rows.map((cells, i) => ({ n: i + 2, cells: cells.map((c) => (c === "" ? null : c)) })),
];

const sum = (s?: string) =>
  !s ? 0 : s.split(";").reduce((n, item) => n + Number(item.split("—").pop()!.trim().replace(/\s/g, "")), 0);

// ------------------------------------------------------------------ заведение

async function load(
  tx: Prisma.TransactionClient,
  tenantId: string,
  dataset: DatasetKey,
  rows: TableRow[],
  userId: string
): Promise<void> {
  const parsed = await parseRows(tx, dataset, rows);
  if (parsed.preview.issuesTotal) {
    // Данные наши и проверены тестом — сюда попасть можно только сломав их.
    throw new Error(`тестовые данные «${dataset}» не разобрались: ${parsed.preview.issues[0]?.message}`);
  }
  const res = await applyRows(tx, tenantId, dataset, parsed.rows, userId);
  if (res.failed.length) {
    throw new Error(`тестовые данные «${dataset}» не записались: ${res.failed[0].message}`);
  }
}

/** Логин тестового сотрудника: свободный во всей системе. */
async function freeLogin(local: string, tail: string): Promise<string> {
  for (let i = 0; i < 20; i += 1) {
    const login = `${local}${i ? `-${i + 1}` : ""}@${tail}`;
    const taken = await withPlatform(async (ptx) =>
      (await ptx.user.count({ where: { email: login } })) + (await ptx.platformUser.count({ where: { email: login } }))
    );
    if (!taken) return login;
  }
  throw new Error("не нашлось свободного логина для тестового сотрудника");
}

/**
 * Завести тестовые данные. Вызывать внутри withTenant — одной транзакцией:
 * либо мастерская получает всё, либо ничего.
 *
 * `loginDomain` — окончание логинов мастерской (у Основы с именем); пусто —
 * логины вида olga@<код мастерской>.demo: настоящей почтой их не спутать.
 */
export async function seedDemo(
  tx: Prisma.TransactionClient,
  tenantId: string,
  opts: { ownerId: string; loginDomain: string; slug: string; maxUsers: number; now?: Date }
): Promise<DemoState> {
  if (!(await isEmptyBase(tx))) throw new Error("В базе уже есть данные — тестовые заводятся только в пустую");

  const today = opts.now ?? new Date();
  const password = temporaryPassword();
  const passwordHash = await hashPassword(password);

  // ---- сотрудники
  const roles = await tx.role.findMany({ select: { id: true, code: true } });
  const roleId = (code: string) => roles.find((r) => r.code === code)?.id ?? null;
  const tail = opts.loginDomain || `${opts.slug}.demo`;
  let seats = opts.maxUsers - (await tx.user.count({ where: { deletedAt: null } }));

  const users: string[] = [];
  const logins: string[] = [];
  const staffId = new Map<number, string>();
  for (const [i, s] of DEMO_STAFF.entries()) {
    // Тариф не резиновый: сотрудников, которым не хватило места, не заводим —
    // заказы без мастера показывают программу не хуже.
    if (seats <= 0) break;
    const login = await freeLogin(s.local, tail);
    const user = await tx.user.create({
      data: {
        tenantId,
        email: login,
        passwordHash,
        fullName: s.name,
        roleId: roleId(s.role),
        workPercent: s.work,
        partPercent: s.part,
      },
    });
    users.push(user.id);
    logins.push(login);
    staffId.set(i, user.id);
    seats -= 1;
  }

  // ---- клиенты, склад, прайс — той же загрузкой, что файлы из «Баз»
  await load(tx, tenantId, "customers", table(CUSTOMER_HEAD, CUSTOMERS), opts.ownerId);
  for (const [i, color] of Object.entries(DEMO_COLORS)) {
    await tx.customer.updateMany({ where: { phone: CUSTOMERS[Number(i)][2] }, data: { color } });
  }
  await load(tx, tenantId, "stock", table(STOCK_HEAD, STOCK), opts.ownerId);

  const servicesBefore = new Set((await tx.service.findMany({ select: { id: true } })).map((s) => s.id));
  await load(tx, tenantId, "services", table(SERVICE_HEAD, SERVICES), opts.ownerId);

  // ---- заказы
  const orderRows = ORDERS.map((o) => orderRow(o, today));
  await load(tx, tenantId, "orders", table(ORDER_HEAD, orderRows), opts.ownerId);

  const orders = await tx.order.findMany({ select: { id: true, number: true, customerId: true, total: true } });
  const byNumber = new Map(orders.map((o) => [o.number, o]));

  // ---- деньги и переписка
  for (const o of ORDERS) {
    const order = byNumber.get(demoNumber(o.n));
    if (!order) continue;
    const accepted = at(today, o.acc, 10 + (o.n % 8), (o.n * 7) % 60);

    if (o.paid && o.out !== undefined) {
      const issued = at(today, o.out, 17, 30);
      if (o.paid === "DEBT") {
        // Долг — это итог минус платежи: платежа нет, заказ выдан в долг.
        await tx.order.update({
          where: { id: order.id },
          data: { paymentMethod: "DEBT", debtDueAt: at(today, o.out + (o.debtDays ?? 14), 12) },
        });
      } else {
        await tx.order.update({ where: { id: order.id }, data: { paymentMethod: o.paid } });
        await takePayment(tx, tenantId, {
          orderId: order.id,
          customerId: order.customerId,
          amount: Number(order.total),
          how: o.paid,
          userId: staffId.get(1) ?? opts.ownerId,
          at: issued,
        });
      }
    }
    if (o.prepaid) {
      // И полем заказа (его печатает квитанция), и платежом в кассе (его
      // вычитает выдача) — как должно быть у настоящей предоплаты.
      await tx.order.update({ where: { id: order.id }, data: { prepayment: o.prepaid } });
      await takePayment(tx, tenantId, {
        orderId: order.id,
        customerId: order.customerId,
        amount: o.prepaid,
        how: "CASH",
        userId: staffId.get(1) ?? opts.ownerId,
        comment: "Предоплата за запчасть",
        at: new Date(accepted.getTime() + 2 * 60 * 60 * 1000),
      });
    }
    for (const [hours, who, text] of o.chat ?? []) {
      await tx.orderMessage.create({
        data: {
          tenantId,
          orderId: order.id,
          authorId: staffId.get(who) ?? opts.ownerId,
          text,
          createdAt: new Date(accepted.getTime() + hours * 60 * 60 * 1000),
        },
      });
    }
  }

  const [customers, stock, services, transactions] = await Promise.all([
    tx.customer.findMany({ select: { id: true } }),
    tx.stockItem.findMany({ select: { id: true } }),
    tx.service.findMany({ select: { id: true } }),
    tx.transaction.findMany({ where: { orderId: { in: orders.map((o) => o.id) } }, select: { id: true } }),
  ]);

  const state: DemoState = {
    createdAt: today.toISOString(),
    password,
    logins,
    users,
    customers: customers.map((c) => c.id),
    orders: orders.map((o) => o.id),
    stock: stock.map((s) => s.id),
    services: services.map((s) => s.id).filter((id) => !servicesBefore.has(id)),
    transactions: transactions.map((t) => t.id),
  };

  const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } });
  await tx.tenant.update({
    where: { id: tenantId },
    data: { settings: { ...((tenant?.settings as object) ?? {}), demo: state } as unknown as Prisma.InputJsonValue },
  });
  return state;
}

function orderRow(o: DemoOrder, today: Date): Array<string | number> {
  const c = CUSTOMERS[o.cli];
  const discountPct = c[8];
  // Скидка клиента — только на работы, как на настоящем приёме.
  const works = sum(o.works);
  const parts = sum(o.parts);
  const discount = discountPct ? Math.round((works * discountPct) / 100) : 0;
  const day = (d?: number) => (d === undefined ? "" : stamp(at(today, d, 12), false));
  const values: Record<string, string | number> = {
    "Номер": demoNumber(o.n),
    "Принят": stamp(at(today, o.acc, 10 + (o.n % 8), (o.n * 7) % 60)),
    "Статус": o.st,
    "Тип обращения": o.kind,
    "Срочный": o.urgent ? "да" : "",
    "Клиент": c[1],
    "Телефон клиента": c[2],
    "Техника": o.tech,
    "Бренд": o.br,
    "Модель": o.mod,
    "Серийный номер": o.sn,
    "Неисправность": o.cmp,
    "Комплектность": o.kit,
    "Внешнее состояние": o.look,
    "Примечание приёмщика": o.note ?? "",
    "Диагноз": o.diag,
    "Мастер": o.m,
    "Срок готовности": day(o.due),
    "Завершён": day(o.done),
    "Выдан": o.out === undefined ? "" : stamp(at(today, o.out, 17, 30)),
    // Суммы — явно, как в выгрузке настоящей программы: со скидкой клиента
    // пересчёт из состава её бы не учёл.
    "Работы, ₽": works || "",
    "Состав работ": o.works ?? "",
    "Запчасти, ₽": parts || "",
    "Состав запчастей": o.parts ?? "",
    "Скидка, ₽": discount || "",
    "Итого, ₽": works + parts - discount || "",
    "Гарантия до": o.warr && o.out !== undefined ? day(o.out + o.warr) : "",
  };
  return ORDER_HEAD.map((h) => values[h] ?? "");
}

// ------------------------------------------------------------------ уборка

export interface DemoRemoved {
  orders: number;
  customers: number;
  stock: number;
  services: number;
  users: number;
  /** Тестовые клиенты, на которых успели принять настоящие заказы, — остались. */
  keptCustomers: number;
  /** Ключи фотографий удалённых заказов — убрать из хранилища после транзакции. */
  files: string[];
  /** Кого выкинуть со всех устройств. */
  revoke: string[];
}

export async function removeDemo(
  tx: Prisma.TransactionClient,
  tenantId: string,
  demo: DemoState
): Promise<DemoRemoved> {
  const orderIds = demo.orders;
  const out: DemoRemoved = { orders: 0, customers: 0, stock: 0, services: 0, users: 0, keptCustomers: 0, files: [], revoke: [] };

  // ---- заказы
  if (orderIds.length) {
    const photos = await tx.attachment.findMany({ where: { orderId: { in: orderIds } }, select: { objectKey: true } });
    out.files = photos.map((p) => p.objectKey);
    await tx.attachment.deleteMany({ where: { orderId: { in: orderIds } } });

    // Деньги по тестовым заказам — тоже тестовые: и заведённые здесь, и те,
    // что владелец провёл, пока пробовал выдачу. Оставить их значит оставить
    // в кассе выручку, которой не было.
    await tx.transaction.deleteMany({ where: { orderId: { in: orderIds } } });
    await tx.purchaseRequest.updateMany({ where: { orderId: { in: orderIds } }, data: { orderId: null } });
    await tx.stockMovement.updateMany({ where: { orderId: { in: orderIds } }, data: { orderId: null } });
    // Настоящий гарантийный заказ по тестовому — теряет ссылку, но остаётся.
    await tx.order.updateMany({
      where: { parentOrderId: { in: orderIds }, id: { notIn: orderIds } },
      data: { parentOrderId: null },
    });

    await tx.orderMessage.deleteMany({ where: { orderId: { in: orderIds } } });
    await tx.orderPart.deleteMany({ where: { orderId: { in: orderIds } } });
    await tx.orderWork.deleteMany({ where: { orderId: { in: orderIds } } });
    await tx.orderStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } });
    await tx.order.updateMany({ where: { id: { in: orderIds } }, data: { parentOrderId: null } });
    out.orders = (await tx.order.deleteMany({ where: { id: { in: orderIds } } })).count;
  }
  if (demo.transactions.length) {
    await tx.transaction.deleteMany({ where: { id: { in: demo.transactions } } });
  }

  // ---- клиенты: только те, на ком не осталось настоящих заказов
  if (demo.customers.length) {
    const free = await tx.customer.findMany({
      where: { id: { in: demo.customers }, orders: { none: {} } },
      select: { id: true },
    });
    const ids = free.map((c) => c.id);
    out.keptCustomers = demo.customers.length - ids.length;
    await tx.transaction.deleteMany({ where: { customerId: { in: ids } } });
    await tx.device.deleteMany({ where: { customerId: { in: ids } } });
    out.customers = (await tx.customer.deleteMany({ where: { id: { in: ids } } })).count;
  }

  // ---- склад
  if (demo.stock.length) {
    const ids = demo.stock;
    await tx.orderPart.updateMany({ where: { stockItemId: { in: ids } }, data: { stockItemId: null } });
    await tx.purchaseRequestItem.updateMany({ where: { stockItemId: { in: ids } }, data: { stockItemId: null } });
    await tx.stockMovement.deleteMany({ where: { stockItemId: { in: ids } } });
    await tx.stockBalance.deleteMany({ where: { stockItemId: { in: ids } } });
    out.stock = (await tx.stockItem.deleteMany({ where: { id: { in: ids } } })).count;
  }

  // ---- прайс
  if (demo.services.length) {
    out.services = (await tx.service.deleteMany({ where: { id: { in: demo.services } } })).count;
  }

  // ---- сотрудники: не удаляем строкой, а выключаем и освобождаем логин.
  // На них ссылается журнал, а он не правится; логин же должен освободиться —
  // настоящую Ольгу владелец заведёт как olga@…, и тестовая не должна мешать.
  for (const id of demo.users) {
    const u = await tx.user.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
    if (!u) continue;
    await tx.user.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false, email: `removed-${id}@demo.invalid` },
    });
    out.users += 1;
    out.revoke.push(id);
  }

  // Номера клиентов — снова с первого, если никого не осталось: настоящий
  // первый клиент мастерской не должен получить номер 21.
  await tx.$executeRaw`
    UPDATE "Tenant" t
       SET "customerNumberNext" = COALESCE((SELECT MAX(c."number") + 1 FROM "Customer" c WHERE c."tenantId" = t.id), 1)
     WHERE t.id = ${tenantId}
  `;

  const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } });
  const { demo: _gone, ...rest } = ((tenant?.settings as Record<string, unknown>) ?? {}) as Record<string, unknown>;
  await tx.tenant.update({ where: { id: tenantId }, data: { settings: rest as Prisma.InputJsonValue } });
  return out;
}
