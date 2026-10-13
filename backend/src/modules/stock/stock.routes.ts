import type { Prisma } from "@prisma/client";
import { Router, type Request } from "express";
import { z } from "zod";
import { clientIp, writeAudit } from "../../lib/audit";
import { withTenant } from "../../lib/db";
import { ah, badRequest, conflict, notFound } from "../../lib/errors";
import { compareKeys, desc, type Key } from "../../lib/listOrder";
import { fixLayout, searchWords, truthy } from "../../lib/search";
import { pageFields } from "../../lib/paging";
import { PERMISSIONS } from "../../lib/permissions";
import {
  actorUserId,
  authenticate,
  currentTenantId,
  permissionsOf,
  requirePermission,
  requireTenant,
} from "../../middleware/auth";
import { enforceTenantStatus } from "../../middleware/tenantStatus";
import { recalcTotals } from "../orders/orders.service";
import { applyMovement, defaultWarehouse, num } from "./stock.service";
import { stockSheet } from "../data/export";
import { contentDisposition, writeXlsx } from "../data/tableFile";
import { assertCategory, ensurePath, pathOf, refreshPaths, splitPath, syncTextCategories, withDescendants } from "./catalog";

/**
 * Склад.
 *
 * Главное правило раздела: остаток нельзя изменить «просто так». Любое
 * изменение — это движение с автором, временем и причиной, а остаток лишь
 * его следствие. Иначе через месяц никто не объяснит, куда делись четыре
 * планки памяти, и складу перестанут верить — а склад, которому не верят,
 * хуже, чем его отсутствие.
 *
 * Второе правило: в минус не уходим. Списать больше, чем лежит, — это почти
 * всегда опечатка в количестве или списание не с того склада, и поймать её
 * надо в момент ввода, а не при инвентаризации через полгода.
 */

export const stockRouter = Router();
stockRouter.use(authenticate, requireTenant, enforceTenantStatus);

const tenantOf = (req: Request) => currentTenantId(req)!;
const has = (req: Request, code: string) => permissionsOf(req).includes(code);

/** Себестоимость видит не каждый: мастеру знать закупочную цену незачем. */
const seesCost = (req: Request) =>
  has(req, PERMISSIONS.ORDERS_COST) ||
  has(req, PERMISSIONS.FINANCE_VIEW) ||
  has(req, PERMISSIONS.STOCK_MOVE);

// ------------------------------------------------------------------ склады

stockRouter.get(
  "/warehouses",
  requirePermission(PERMISSIONS.STOCK_VIEW),
  ah(async (req, res) => {
    const rows = await withTenant(tenantOf(req), (tx) =>
      tx.warehouse.findMany({ orderBy: [{ isDefault: "desc" }, { name: "asc" }] })
    );
    res.json(rows.map((w) => ({ id: w.id, name: w.name, isDefault: w.isDefault })));
  })
);

// ------------------------------------------------------------ номенклатура

/**
 * Сколько позиций читаем разом, чтобы отобрать и посчитать.
 *
 * Отбор идёт по остаткам, которых в базе нет отдельным числом: они
 * складываются из строк по складам. Две тысячи позиций — это склад крупной
 * мастерской целиком, и прочитать его разом дешевле, чем городить подсчёт
 * остатков запросом ради страницы на пятьдесят строк.
 */
const MAX_SCAN = 2000;

/** Порядок склада. По названию — как было: так его отдаёт база. */
const STOCK_SORTS = ["name", "low", "qty", "category", "sku", "recent", "price", "updated"] as const;

// ------------------------------------------------------------ каталог (дерево)

stockRouter.get(
  "/categories",
  requirePermission(PERMISSIONS.STOCK_VIEW),
  ah(async (req, res) => {
    const tenantId = tenantOf(req);
    const out = await withTenant(tenantId, async (tx) => {
      // Позиции с категорией текстом (старые, из файла) — сначала разложить по дереву.
      await syncTextCategories(tx, tenantId);
      const [cats, counts, total] = await Promise.all([
        tx.stockCategory.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
        tx.stockItem.groupBy({ by: ["categoryId"], where: { isActive: true }, _count: { _all: true } }),
        tx.stockItem.count({ where: { isActive: true } }),
      ]);
      const n = new Map(counts.map((c) => [c.categoryId, c._count._all]));
      return {
        items: cats.map((c) => ({ id: c.id, parentId: c.parentId, name: c.name, color: c.color, count: n.get(c.id) ?? 0 })),
        uncategorized: n.get(null) ?? 0,
        total,
      };
    });
    res.json(out);
  })
);

/** Цвет карточки категории: «#RRGGBB»; null — снова по порядку из палитры. */
const categoryColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Цвет — в виде #45C08A").nullable().optional();

const categoryName = z.string().trim().min(1, "Назовите категорию").max(80).refine((s) => !s.includes("/"), "Без «/» в названии — это знак подкатегории");

stockRouter.post(
  "/categories",
  requirePermission(PERMISSIONS.STOCK_MOVE),
  ah(async (req, res) => {
    const body = z.object({ name: categoryName, parentId: z.string().uuid().nullable().optional() }).parse(req.body);
    const tenantId = tenantOf(req);
    const created = await withTenant(tenantId, async (tx) => {
      const parentId = await assertCategory(tx, body.parentId);
      const same = await tx.stockCategory.findFirst({
        where: { parentId, name: { equals: body.name, mode: "insensitive" } },
      });
      if (same) throw conflict(`Категория «${same.name}» здесь уже есть`);
      const c = await tx.stockCategory.create({ data: { tenantId, parentId, name: body.name } });
      await writeAudit(tx, { tenantId, userId: actorUserId(req), entity: "stockCategory", entityId: c.id, action: "CREATE", diff: { name: c.name }, ip: clientIp(req) });
      return c;
    });
    res.status(201).json({ id: created.id, name: created.name, parentId: created.parentId });
  })
);

stockRouter.patch(
  "/categories/:id",
  requirePermission(PERMISSIONS.STOCK_MOVE),
  ah(async (req, res) => {
    const body = z.object({ name: categoryName.optional(), parentId: z.string().uuid().nullable().optional(), color: categoryColor }).parse(req.body);
    const tenantId = tenantOf(req);
    await withTenant(tenantId, async (tx) => {
      const cat = await tx.stockCategory.findFirst({ where: { id: req.params.id } });
      if (!cat) throw notFound("Категория не найдена");
      let parentId = cat.parentId;
      if (body.parentId !== undefined) {
        parentId = await assertCategory(tx, body.parentId);
        const all = await tx.stockCategory.findMany({ select: { id: true, parentId: true, name: true } });
        if (parentId && withDescendants(cat.id, all).has(parentId)) {
          throw badRequest("Категорию нельзя перенести внутрь неё самой");
        }
      }
      const name = body.name ?? cat.name;
      const same = await tx.stockCategory.findFirst({
        where: { id: { not: cat.id }, parentId, name: { equals: name, mode: "insensitive" } },
      });
      if (same) throw conflict(`Категория «${same.name}» здесь уже есть`);
      await tx.stockCategory.update({ where: { id: cat.id }, data: { name, parentId, ...(body.color !== undefined ? { color: body.color } : {}) } });
      await refreshPaths(tx, cat.id);
      await writeAudit(tx, { tenantId, userId: actorUserId(req), entity: "stockCategory", entityId: cat.id, action: "UPDATE", diff: body as Record<string, unknown>, ip: clientIp(req) });
    });
    res.json({ ok: true });
  })
);

/**
 * Удалить категорию. Позиции и подкатегории уходят в moveTo (другую
 * категорию) или, если не указано, — на уровень выше. Молча не теряется ничего.
 */
stockRouter.delete(
  "/categories/:id",
  requirePermission(PERMISSIONS.STOCK_MOVE),
  ah(async (req, res) => {
    const { moveTo } = z.object({ moveTo: z.string().uuid().optional().or(z.literal("")) }).parse(req.query);
    const tenantId = tenantOf(req);
    const result = await withTenant(tenantId, async (tx) => {
      const cat = await tx.stockCategory.findFirst({ where: { id: req.params.id } });
      if (!cat) throw notFound("Категория не найдена");
      const all = await tx.stockCategory.findMany({ select: { id: true, parentId: true, name: true } });
      const target = moveTo ? await assertCategory(tx, moveTo) : cat.parentId;
      if (target && withDescendants(cat.id, all).has(target)) throw badRequest("Нельзя перенести в удаляемую категорию или её подкатегорию");
      const moved = await tx.stockItem.findMany({ where: { categoryId: cat.id }, select: { id: true } });
      const items = await tx.stockItem.updateMany({ where: { categoryId: cat.id }, data: { categoryId: target } });
      const kids = await tx.stockCategory.findMany({ where: { parentId: cat.id }, select: { id: true } });
      const children = await tx.stockCategory.updateMany({ where: { parentId: cat.id }, data: { parentId: target } });
      await tx.stockCategory.delete({ where: { id: cat.id } });
      // Пути у перенесённого — заново: в текстовом поле категории лежит путь.
      if (target) await refreshPaths(tx, target);
      else if (moved.length) await tx.stockItem.updateMany({ where: { id: { in: moved.map((m) => m.id) } }, data: { category: null } });
      for (const k of kids) await refreshPaths(tx, k.id);
      await writeAudit(tx, { tenantId, userId: actorUserId(req), entity: "stockCategory", entityId: cat.id, action: "DELETE", diff: { name: cat.name, items: items.count, children: children.count }, ip: clientIp(req) });
      return { items: items.count, children: children.count };
    });
    res.json({ ok: true, ...result });
  })
);

/** Подсказки для полей позиции: поставщики и места хранения, частые — первыми. */
stockRouter.get(
  "/hints",
  requirePermission(PERMISSIONS.STOCK_VIEW),
  ah(async (req, res) => {
    const out = await withTenant(tenantOf(req), async (tx) => {
      const [sup, loc] = await Promise.all([
        tx.stockItem.groupBy({ by: ["supplier"], where: { supplier: { not: null } }, _count: { _all: true } }),
        tx.stockItem.groupBy({ by: ["location"], where: { location: { not: null } }, _count: { _all: true } }),
      ]);
      const list = (rows: Array<{ value: string | null; n: number }>) =>
        rows
          .filter((r) => r.value && r.value.trim())
          .sort((a, b) => b.n - a.n || a.value!.localeCompare(b.value!, "ru"))
          .slice(0, 100)
          .map((r) => r.value!);
      return {
        suppliers: list(sup.map((s) => ({ value: s.supplier, n: s._count._all }))),
        locations: list(loc.map((s) => ({ value: s.location, n: s._count._all }))),
      };
    });
    res.json(out);
  })
);

/**
 * Подсказка в «Запчастях» заказа: от двух знаков, по словам в названии и
 * артикуле. Остаток — по всем складам, цена — цена продажи из карточки.
 */
stockRouter.get(
  "/lookup",
  requirePermission(PERMISSIONS.STOCK_VIEW, PERMISSIONS.ORDERS_EDIT, PERMISSIONS.ORDERS_STATUS_OWN),
  ah(async (req, res) => {
    const { q } = z.object({ q: z.string().trim().max(120).default("") }).parse(req.query);
    const words = searchWords(q);
    if (q.replace(/\s+/g, "").length < 2 || !words.length) return res.json({ items: [] });
    const rows = await withTenant(tenantOf(req), (tx) =>
      tx.stockItem.findMany({
        where: {
          isActive: true,
          AND: words.map((w) => ({
            OR: [
              { name: { contains: w, mode: "insensitive" as const } },
              { sku: { contains: w, mode: "insensitive" as const } },
            ],
          })),
        },
        take: 40,
        include: { balances: { select: { qty: true } } },
      })
    );
    const items = rows
      .map((i) => ({
        id: i.id,
        name: i.name,
        sku: i.sku,
        unit: i.unit,
        location: i.location,
        salePrice: i.salePrice === null ? null : num(i.salePrice),
        qty: i.balances.reduce((n, b) => n + num(b.qty), 0),
      }))
      // Что есть — выше; начинается с набранного — выше.
      .sort(
        (a, b) =>
          Number(b.qty > 0) - Number(a.qty > 0) ||
          Number(b.name.toLowerCase().startsWith(words[0].toLowerCase())) - Number(a.name.toLowerCase().startsWith(words[0].toLowerCase())) ||
          a.name.localeCompare(b.name, "ru")
      )
      .slice(0, 12);
    res.json({ items });
  })
);

stockRouter.get(
  "/",
  requirePermission(PERMISSIONS.STOCK_VIEW),
  ah(async (req, res) => {
    const q = z
      .object({
        search: z.string().trim().max(120).optional(),
        filter: z.enum(["all", "low", "zero", "in"]).default("all"),
        sort: z.enum(STOCK_SORTS).catch("name").default("name"),
        layout: z.string().optional(),
        /** id категории (вместе с подкатегориями) или «none» — без категории. */
        category: z.string().max(60).optional(),
        supplier: z.string().trim().max(120).optional(),
        location: z.string().trim().max(120).optional(),
        /** Всё отобранное одним ответом — склад показывает позиции по категориям, без страниц. */
        all: z.string().optional(),
        ...pageFields,
      })
      .parse(req.query);
    const tenantId = tenantOf(req);
    const cats = await withTenant(tenantId, async (tx) => {
      await syncTextCategories(tx, tenantId);
      return tx.stockCategory.findMany({ select: { id: true, parentId: true, name: true } });
    });
    const byId = new Map(cats.map((c) => [c.id, c]));
    const categoryWhere: Prisma.StockItemWhereInput =
      q.category === "none"
        ? { categoryId: null }
        : q.category && byId.has(q.category)
          ? { categoryId: { in: [...withDescendants(q.category, cats)] } }
          : {};

    const cost = seesCost(req);

    // Каждое слово — отдельным условием: «шлейф 15.6» (lib/search.ts).
    const wordWhere = (w: string): Prisma.StockItemWhereInput => ({
      OR: [
        { name: { contains: w, mode: "insensitive" as const } },
        { sku: { contains: w, mode: "insensitive" as const } },
        { category: { contains: w, mode: "insensitive" as const } },
        { location: { contains: w, mode: "insensitive" as const } },
        { supplier: { contains: w, mode: "insensitive" as const } },
        { note: { contains: w, mode: "insensitive" as const } },
      ],
    });
    let words = searchWords(q.search);
    let searchFixed: string | null = null;
    if (words.length && truthy(q.layout)) {
      const fixed = await withTenant(tenantOf(req), (tx) =>
        fixLayout(words, async (w) => (await tx.stockItem.count({ where: { isActive: true, ...wordWhere(w) }, take: 1 })) > 0)
      );
      words = fixed.words;
      searchFixed = fixed.fixed;
    }

    const rows = await withTenant(tenantOf(req), (tx) =>
      tx.stockItem.findMany({
        where: {
          isActive: true,
          AND: words.map(wordWhere),
          ...categoryWhere,
          ...(q.supplier ? { supplier: { equals: q.supplier, mode: "insensitive" as const } } : {}),
          ...(q.location ? { location: { equals: q.location, mode: "insensitive" as const } } : {}),
        },
        orderBy: { name: "asc" },
        // Постраничности на стороне базы здесь быть не может: «мало»,
        // «нет в наличии» и «есть» считаются из остатков по складам, то
        // есть уже после выборки. Поэтому читаем позиции целиком, отбираем
        // и режем на страницы здесь же — иначе «мало» на второй странице
        // означало бы «мало среди тех пятидесяти, что попались».
        take: MAX_SCAN,
        include: { balances: { include: { warehouse: { select: { id: true, name: true } } } } },
      })
    );

    const items = rows.map((i) => {
      const qty = i.balances.reduce((n, b) => n + num(b.qty), 0);
      const minQty = num(i.minQty);
      // Средняя себестоимость по всем складам, взвешенная по количеству:
      // простое среднее врало бы, когда на одном складе три штуки, а на
      // другом сорок.
      const value = i.balances.reduce((n, b) => n + num(b.qty) * num(b.avgCost), 0);
      return {
        id: i.id,
        sku: i.sku,
        name: i.name,
        unit: i.unit,
        category: i.category,
        categoryId: i.categoryId,
        categoryPath: i.categoryId ? pathOf(i.categoryId, byId) : null,
        location: i.location,
        supplier: i.supplier,
        note: i.note,
        salePrice: i.salePrice === null ? null : num(i.salePrice),
        purchasePrice: i.purchasePrice === null ? null : num(i.purchasePrice),
        updatedAt: i.updatedAt,
        minQty,
        qty,
        low: minQty > 0 && qty < minQty,
        // Деньги считаем всегда, а наружу отдаём ниже — только тому, кому
        // они положены. Условная форма объекта тут дороже, чем одно поле.
        avgCost: qty > 0 ? value / qty : 0,
        value,
        places: i.balances
          .filter((b) => num(b.qty) !== 0)
          .map((b) => ({ warehouseId: b.warehouse.id, warehouse: b.warehouse.name, qty: num(b.qty) })),
      };
    });

    const filtered =
      q.filter === "low"
        ? items.filter((i) => i.low)
        : q.filter === "zero"
          ? items.filter((i) => i.qty <= 0)
          : q.filter === "in"
            ? items.filter((i) => i.qty > 0)
            : items;

    // Порядок — по всему отобранному, а не по странице. «Недавно менявшиеся»
    // — по последнему движению: у позиции своей даты правки нет, а приход,
    // списание и перемещение и есть её жизнь.
    let lastMove = new Map<string, number>();
    if (q.sort === "recent" && filtered.length) {
      const moves = await withTenant(tenantOf(req), (tx) =>
        tx.stockMovement.groupBy({ by: ["stockItemId"], _max: { createdAt: true } })
      );
      lastMove = new Map(moves.map((m) => [m.stockItemId, m._max.createdAt?.getTime() ?? 0]));
    }
    const keyOf = (i: (typeof items)[number]): Key[] => {
      switch (q.sort) {
        case "low":
          // Сначала то, что ниже минимума, потом — чего меньше всего.
          return [i.low ? 0 : 1, i.qty, i.name];
        case "qty":
          return [desc(i.qty), i.name];
        case "category":
          return [i.category || null, i.name];
        case "sku":
          return [i.sku || null, i.name];
        case "recent":
          return [desc(lastMove.get(i.id) ?? null), i.name];
        case "price":
          return [i.salePrice ?? null, i.name];
        case "updated":
          return [desc(new Date(i.updatedAt).getTime()), i.name];
        default:
          return [i.name];
      }
    };
    const ordered = q.sort === "name" ? filtered : [...filtered].sort((a, b) => compareKeys(keyOf(a), keyOf(b)));
    const everything = truthy(q.all);
    const pageSize = everything ? Math.max(1, ordered.length) : q.pageSize;
    const pageNo = everything ? 1 : q.page;
    const page = ordered.slice((pageNo - 1) * pageSize, pageNo * pageSize);

    res.json({
      searchFixed,
      // Закупка и себестоимость — только тем, кому видна себестоимость.
      items: page.map(({ avgCost, value, purchasePrice, ...rest }) => (cost ? { ...rest, avgCost, value, purchasePrice } : rest)),
      // Счётчики — по всему складу, а не по отобранному: «мало у 12» это
      // свойство склада, и от того, какой фильтр включён, оно не меняется.
      totals: {
        positions: items.length,
        low: items.filter((i) => i.low).length,
        zero: items.filter((i) => i.qty <= 0).length,
        ...(cost ? { value: items.reduce((n, i) => n + i.value, 0) } : {}),
      },
      total: filtered.length,
      page: pageNo,
      pageSize,
      pages: Math.max(1, Math.ceil(filtered.length / pageSize)),
    });
  })
);

const money = z.coerce.number().min(0).max(10_000_000).nullable().optional();
const itemSchema = z.object({
  sku: z.string().trim().max(60).optional(),
  name: z.string().trim().min(1, "Без названия позицию не найти").max(200),
  unit: z.string().trim().min(1).max(20).default("шт"),
  /** Текстом — для старых программ: «Матрицы/15.6» разложится по дереву. */
  category: z.string().trim().max(200).optional(),
  /** Категория из дерева; null — без категории. Главнее текста. */
  categoryId: z.string().uuid().nullable().optional(),
  minQty: z.coerce.number().min(0).max(1_000_000).default(0),
  location: z.string().trim().max(120).optional(),
  supplier: z.string().trim().max(120).optional(),
  note: z.string().trim().max(2000).optional(),
  purchasePrice: money,
  salePrice: money,
});

/** Место для сравнения: пусто — «без места», без регистра и лишних пробелов. */
const placeOf = (s: string | null | undefined) => (s ?? "").trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Артикул занят — только если тот же товар лежит в том же месте. Один товар в
 * шкафу и в ящике — две позиции со своими остатками (так их и загружают из файла).
 */
async function assertSkuFree(tx: Prisma.TransactionClient, sku: string | null | undefined, location: string | null | undefined, exceptId?: string) {
  if (!sku) return;
  const same = await tx.stockItem.findMany({ where: { sku, isActive: true, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { name: true, location: true } });
  const hit = same.find((i) => placeOf(i.location) === placeOf(location));
  if (hit) {
    throw conflict(
      location?.trim()
        ? `Артикул «${sku}» в месте «${location.trim()}» уже есть — «${hit.name}». Другое место — другая позиция`
        : `Артикул «${sku}» без места уже занят позицией «${hit.name}». Укажите место — тогда это будет отдельная позиция`
    );
  }
}

/** Категория позиции: из дерева (categoryId) или текстом (category) — и путь текстом рядом. */
async function categoryData(tx: Prisma.TransactionClient, tenantId: string, body: { categoryId?: string | null; category?: string }) {
  if (body.categoryId !== undefined) {
    const id = await assertCategory(tx, body.categoryId);
    if (!id) return { categoryId: null, category: null };
    const all = await tx.stockCategory.findMany({ select: { id: true, parentId: true, name: true } });
    return { categoryId: id, category: pathOf(id, new Map(all.map((c) => [c.id, c]))) };
  }
  if (body.category !== undefined) {
    const parts = splitPath(body.category);
    if (!parts.length) return { categoryId: null, category: null };
    const all = await tx.stockCategory.findMany({ select: { id: true, parentId: true, name: true } });
    return { categoryId: await ensurePath(tx, tenantId, parts, all), category: parts.join("/") };
  }
  return {};
}

stockRouter.post(
  "/",
  requirePermission(PERMISSIONS.STOCK_MOVE),
  ah(async (req, res) => {
    const body = itemSchema.parse(req.body);
    const tenantId = tenantOf(req);

    const item = await withTenant(tenantId, async (tx) => {
      await assertSkuFree(tx, body.sku, body.location);
      const created = await tx.stockItem.create({
        data: {
          tenantId,
          sku: body.sku || null,
          name: body.name,
          unit: body.unit,
          minQty: body.minQty,
          location: body.location || null,
          supplier: body.supplier || null,
          note: body.note || null,
          purchasePrice: body.purchasePrice ?? null,
          salePrice: body.salePrice ?? null,
          ...(await categoryData(tx, tenantId, body)),
        },
      });
      await writeAudit(tx, {
        tenantId,
        userId: actorUserId(req),
        entity: "stockItem",
        entityId: created.id,
        action: "CREATE",
        diff: { name: created.name, sku: created.sku },
        ip: clientIp(req),
      });
      return created;
    });

    res.status(201).json({ id: item.id, name: item.name });
  })
);

stockRouter.patch(
  "/:id",
  requirePermission(PERMISSIONS.STOCK_MOVE),
  ah(async (req, res) => {
    const body = itemSchema.partial().parse(req.body);
    const tenantId = tenantOf(req);

    await withTenant(tenantId, async (tx) => {
      const item = await tx.stockItem.findFirst({ where: { id: req.params.id } });
      if (!item) throw notFound("Позиция не найдена");
      const sku = body.sku !== undefined ? body.sku || null : item.sku;
      const location = body.location !== undefined ? body.location || null : item.location;
      if (body.sku !== undefined || body.location !== undefined) await assertSkuFree(tx, sku, location, item.id);
      await tx.stockItem.update({
        where: { id: item.id },
        data: {
          ...(body.sku !== undefined ? { sku: body.sku || null } : {}),
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.unit !== undefined ? { unit: body.unit } : {}),
          ...(body.minQty !== undefined ? { minQty: body.minQty } : {}),
          ...(body.location !== undefined ? { location: body.location || null } : {}),
          ...(body.supplier !== undefined ? { supplier: body.supplier || null } : {}),
          ...(body.note !== undefined ? { note: body.note || null } : {}),
          ...(body.purchasePrice !== undefined ? { purchasePrice: body.purchasePrice } : {}),
          ...(body.salePrice !== undefined ? { salePrice: body.salePrice } : {}),
          ...(await categoryData(tx, tenantId, body)),
        },
      });
      await writeAudit(tx, {
        tenantId,
        userId: actorUserId(req),
        entity: "stockItem",
        entityId: item.id,
        action: "UPDATE",
        diff: body as Record<string, unknown>,
        ip: clientIp(req),
      });
    });

    res.json({ ok: true });
  })
);

// ------------------------------------------------------- сразу много позиций

/** Наценка от закупки с округлением вверх до 10 ₽ — как кнопки в карточке позиции. */
export const withMarkup = (purchase: number, pct: number) => Math.ceil((purchase * (1 + pct / 100)) / 10) * 10;

const bulkSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("move"), ids: z.array(z.string().uuid()).min(1).max(500), categoryId: z.string().uuid().nullable() }),
  z.object({ action: z.literal("markup"), ids: z.array(z.string().uuid()).min(1).max(500), pct: z.coerce.number().min(1).max(1000) }),
  z.object({ action: z.literal("location"), ids: z.array(z.string().uuid()).min(1).max(500), location: z.string().trim().max(120) }),
  z.object({ action: z.literal("delete"), ids: z.array(z.string().uuid()).min(1).max(500) }),
]);

/**
 * Одно действие над выбранными позициями: перенести в категорию, поставить
 * цену продажи наценкой от закупки, место хранения, удалить.
 *
 * Всё — одной транзакцией: либо со всеми выбранными, либо ни с одной.
 * Удаление — только того, чего на складе нет: остаток сначала списывают
 * движением (правило раздела), иначе штуки исчезли бы без следа. Удалённая
 * позиция скрывается, а не стирается: на неё ссылаются движения и заказы.
 */
stockRouter.post(
  "/bulk",
  requirePermission(PERMISSIONS.STOCK_MOVE),
  ah(async (req, res) => {
    const body = bulkSchema.parse(req.body);
    const tenantId = tenantOf(req);
    const ids = [...new Set(body.ids)];
    const out = await withTenant(tenantId, async (tx) => {
      const items = await tx.stockItem.findMany({
        where: { id: { in: ids }, isActive: true },
        include: { balances: { select: { qty: true } } },
      });
      if (items.length !== ids.length) throw notFound("Часть позиций не найдена — обновите страницу");
      let changed = 0;
      const skipped: string[] = [];
      const skippedIds = new Set<string>();
      let detail: Record<string, unknown> = {};

      if (body.action === "move") {
        const categoryId = await assertCategory(tx, body.categoryId);
        let category: string | null = null;
        if (categoryId) {
          const all = await tx.stockCategory.findMany({ select: { id: true, parentId: true, name: true } });
          category = pathOf(categoryId, new Map(all.map((c) => [c.id, c])));
        }
        changed = (await tx.stockItem.updateMany({ where: { id: { in: ids } }, data: { categoryId, category } })).count;
        detail = { categoryId, category };
      } else if (body.action === "markup") {
        for (const i of items) {
          const purchase = i.purchasePrice === null ? 0 : num(i.purchasePrice);
          if (purchase <= 0) {
            skipped.push(i.name);
            skippedIds.add(i.id);
            continue;
          }
          await tx.stockItem.update({ where: { id: i.id }, data: { salePrice: withMarkup(purchase, body.pct) } });
          changed++;
        }
        detail = { pct: body.pct, skipped: skipped.length };
      } else if (body.action === "location") {
        // Тот же товар в том же месте — одна позиция: свести две в одно место нельзя.
        const target = placeOf(body.location);
        const skus = [...new Set(items.map((i) => i.sku).filter((x): x is string => !!x))];
        if (skus.length) {
          const twins = await tx.stockItem.findMany({ where: { sku: { in: skus }, isActive: true, id: { notIn: ids } }, select: { sku: true, name: true, location: true } });
          const outside = twins.find((t) => placeOf(t.location) === target);
          const inside = skus.find((sku) => items.filter((i) => i.sku === sku).length > 1);
          if (outside || inside) {
            throw conflict(
              `Артикул «${outside?.sku ?? inside}» ${body.location.trim() ? `в месте «${body.location.trim()}»` : "без места"} уже есть — один товар в одном месте должен быть одной позицией`
            );
          }
        }
        changed = (await tx.stockItem.updateMany({ where: { id: { in: ids } }, data: { location: body.location || null } })).count;
        detail = { location: body.location || null };
      } else {
        const left = items
          .map((i) => ({ name: i.name, unit: i.unit, qty: i.balances.reduce((n, b) => n + num(b.qty), 0) }))
          .filter((i) => i.qty > 0);
        if (left.length) {
          const list = left.slice(0, 3).map((i) => `«${i.name}» — ${i.qty} ${i.unit}`).join(", ");
          throw conflict(
            `На складе ещё есть: ${list}${left.length > 3 ? ` и ещё ${left.length - 3}` : ""}. Сначала спишите остаток — потом удаляйте.`
          );
        }
        changed = (await tx.stockItem.updateMany({ where: { id: { in: ids } }, data: { isActive: false } })).count;
      }

      // Журнал — у каждой позиции свой: «кто поменял цену этой матрице» ищут по позиции.
      for (const i of items) {
        if (skippedIds.has(i.id)) continue;
        await writeAudit(tx, {
          tenantId,
          userId: actorUserId(req),
          entity: "stockItem",
          entityId: i.id,
          action: body.action === "delete" ? "DELETE" : "UPDATE",
          diff: { bulk: body.action, name: i.name, of: ids.length, ...detail },
          ip: clientIp(req),
        });
      }
      return { changed, skipped };
    });
    res.json({ ok: true, ...out });
  })
);

/**
 * Выбранные позиции — файлом Excel, тем же листом, что «Базы → Выгрузка»:
 * поправили цены в Excel — и загрузили обратно там же.
 */
stockRouter.post(
  "/export",
  requirePermission(PERMISSIONS.STOCK_MOVE),
  ah(async (req, res) => {
    const { ids, name } = z
      .object({ ids: z.array(z.string().uuid()).min(1).max(2000), name: z.string().trim().max(80).optional() })
      .parse(req.body);
    const tenantId = tenantOf(req);
    const sheet = await withTenant(tenantId, async (tx) => {
      const built = await stockSheet(tx, [...new Set(ids)]);
      await writeAudit(tx, { tenantId, userId: actorUserId(req), entity: "Data", entityId: "stock", action: "EXPORT", diff: { format: "xlsx", rows: built.rows.length, from: "stock" }, ip: clientIp(req) });
      return built;
    });
    const stamp = new Date().toISOString().slice(0, 10);
    const base = (name || "Склад").replace(/[\\/:*?"<>|]+/g, " ").trim() || "Склад";
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", contentDisposition(`${base} ${stamp}.xlsx`, `stock-${stamp}.xlsx`));
    res.send(await writeXlsx([sheet]));
  })
);

// --------------------------------------------------------------- движения

const movementSchema = z.object({
  stockItemId: z.string().uuid(),
  warehouseId: z.string().uuid().optional(),
  type: z.enum(["IN", "OUT", "WRITE_OFF", "RETURN", "INVENTORY"]),
  qty: z.coerce.number().min(0).max(1_000_000),
  price: z.coerce.number().min(0).max(10_000_000).optional(),
  /** Списание в заказ: позиция сразу попадает в калькуляцию этого заказа. */
  orderId: z.string().uuid().optional(),
  /** Цена для клиента, если позиция уходит в заказ. По умолчанию — себестоимость. */
  salePrice: z.coerce.number().min(0).max(10_000_000).optional(),
  comment: z.string().trim().max(300).optional(),
});

stockRouter.post(
  "/movements",
  requirePermission(PERMISSIONS.STOCK_MOVE, PERMISSIONS.STOCK_WRITE_OFF_OWN, PERMISSIONS.STOCK_INVENTORY),
  ah(async (req, res) => {
    const body = movementSchema.parse(req.body);
    const tenantId = tenantOf(req);
    const userId = actorUserId(req);

    // Мастеру можно только списывать в свой заказ. Приход и инвентаризация —
    // это уже распоряжение имуществом мастерской.
    const fullAccess = has(req, PERMISSIONS.STOCK_MOVE);
    if (!fullAccess) {
      if (body.type === "INVENTORY" && !has(req, PERMISSIONS.STOCK_INVENTORY)) {
        throw badRequest("Инвентаризацию проводит управляющий");
      }
      if (body.type === "IN" || body.type === "RETURN") {
        throw badRequest("Приход на склад оформляет управляющий или приёмщик");
      }
      if (body.type === "OUT" && !body.orderId) {
        throw badRequest("Списать можно только в свой заказ");
      }
    }

    if (body.type !== "INVENTORY" && body.qty <= 0) {
      throw badRequest("Количество должно быть больше нуля");
    }

    const result = await withTenant(tenantId, async (tx) => {
      const item = await tx.stockItem.findFirst({ where: { id: body.stockItemId } });
      if (!item) throw notFound("Позиция не найдена");

      const warehouse = await defaultWarehouse(tx, tenantId, body.warehouseId ?? null);

      let order: { id: string; number: string; assignedMasterId: string | null } | null = null;
      if (body.orderId) {
        order = await tx.order.findFirst({
          where: { id: body.orderId, deletedAt: null },
          select: { id: true, number: true, assignedMasterId: true },
        });
        if (!order) throw notFound("Заказ не найден");
        if (!fullAccess && order.assignedMasterId !== userId) {
          throw badRequest("Этот заказ вам не назначен");
        }
      }

      const movement = await applyMovement(tx, {
        tenantId,
        warehouseId: warehouse.id,
        stockItemId: item.id,
        type: body.type,
        qty: body.qty,
        price: body.price ?? null,
        orderId: order?.id ?? null,
        userId,
        comment: body.comment ?? null,
      });

      // Списание в заказ должно быть видно в самом заказе, иначе запчасть
      // уходит со склада, а клиент за неё не платит.
      if (order && body.type === "OUT") {
        const balance = await tx.stockBalance.findFirst({
          where: { warehouseId: warehouse.id, stockItemId: item.id },
          select: { avgCost: true },
        });
        const cost = num(balance?.avgCost);
        await tx.orderPart.create({
          data: {
            tenantId,
            orderId: order.id,
            name: item.name,
            qty: body.qty,
            // Цена клиенту: присланная, иначе цена продажи из карточки, иначе себестоимость.
            price: body.salePrice ?? (item.salePrice !== null ? num(item.salePrice) : cost),
            cost,
            source: "STOCK",
            stockItemId: item.id,
          },
        });
        await recalcTotals(tx, order.id);
      }

      await writeAudit(tx, {
        tenantId,
        userId,
        entity: "stockMovement",
        entityId: movement.id,
        action: "CREATE",
        diff: { item: item.name, type: body.type, qty: body.qty, order: order?.number ?? null },
        ip: clientIp(req),
      });

      const after = await tx.stockBalance.findFirst({
        where: { warehouseId: warehouse.id, stockItemId: item.id },
        select: { qty: true },
      });
      return { id: movement.id, qty: num(after?.qty) };
    });

    res.status(201).json(result);
  })
);

const MOVEMENT_LABEL: Record<string, string> = {
  IN: "Приход",
  OUT: "В заказ",
  WRITE_OFF: "Списание",
  RETURN: "Возврат",
  TRANSFER: "Перемещение",
  INVENTORY: "Инвентаризация",
};

stockRouter.get(
  "/movements",
  requirePermission(PERMISSIONS.STOCK_VIEW),
  ah(async (req, res) => {
    const q = z
      .object({
        stockItemId: z.string().uuid().optional(),
        orderId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(60),
      })
      .parse(req.query);

    const cost = seesCost(req);

    const rows = await withTenant(tenantOf(req), (tx) =>
      tx.stockMovement.findMany({
        where: {
          ...(q.stockItemId ? { stockItemId: q.stockItemId } : {}),
          ...(q.orderId ? { orderId: q.orderId } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: q.limit,
        include: {
          stockItem: { select: { id: true, name: true, unit: true } },
          warehouse: { select: { id: true, name: true } },
          order: { select: { id: true, number: true } },
          user: { select: { id: true, fullName: true } },
        },
      })
    );

    res.json(
      rows.map((m) => ({
        id: m.id,
        type: m.type,
        typeLabel: MOVEMENT_LABEL[m.type] ?? m.type,
        qty: num(m.qty),
        ...(cost ? { price: m.price === null ? null : num(m.price) } : {}),
        item: m.stockItem,
        warehouse: m.warehouse,
        order: m.order,
        user: m.user,
        comment: m.comment,
        createdAt: m.createdAt,
      }))
    );
  })
);
