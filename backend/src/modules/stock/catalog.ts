import type { Prisma } from "@prisma/client";
import { badRequest, notFound } from "../../lib/errors";
import { applyMovement, homeWarehouse, num } from "./stock.service";

/**
 * Каталог склада: дерево категорий и связь склада с запчастями заказа.
 *
 * Категории — `StockCategory` с `parentId`. У позиции — `categoryId`, а в
 * старом текстовом поле `category` лежит путь «Матрицы/15.6»: его понимают
 * загрузка из файла, выгрузка и поиск, и так им ничего не нужно знать про дерево.
 * Позиции, у которых есть только текст (были до каталога или пришли из файла),
 * при первом открытии каталога сами раскладываются по дереву — `/` в тексте
 * означает подкатегорию.
 */

const clean = (s: string) => s.trim().replace(/\s+/g, " ");
export const splitPath = (text: string | null | undefined): string[] =>
  (text ?? "")
    .split("/")
    .map(clean)
    .filter(Boolean)
    .slice(0, 6)
    .map((s) => s.slice(0, 80));

type Cat = { id: string; parentId: string | null; name: string };

/** Путь категории текстом: «Матрицы/15.6». */
export function pathOf(id: string | null | undefined, byId: Map<string, Cat>): string {
  const out: string[] = [];
  const seen = new Set<string>();
  let cur = id ? byId.get(id) : undefined;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.unshift(cur.name);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return out.join("/");
}

/** Категория и все её подкатегории — для отбора «в этой категории». */
export function withDescendants(id: string, all: Cat[]): Set<string> {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of all) {
      if (c.parentId && out.has(c.parentId) && !out.has(c.id)) {
        out.add(c.id);
        grew = true;
      }
    }
  }
  return out;
}

/** Найти или завести цепочку категорий по пути. Сравнение без регистра. Вызывать под lockCatalog. */
export async function ensurePath(tx: Prisma.TransactionClient, tenantId: string, parts: string[], all: Cat[]): Promise<string | null> {
  let parentId: string | null = null;
  for (const name of parts) {
    const found: Cat | undefined = all.find(
      (c) => c.parentId === parentId && c.name.toLocaleLowerCase("ru-RU") === name.toLocaleLowerCase("ru-RU")
    );
    if (found) {
      parentId = found.id;
      continue;
    }
    const created: Cat = await tx.stockCategory.create({
      data: { tenantId, parentId, name },
      select: { id: true, parentId: true, name: true },
    });
    all.push(created);
    parentId = created.id;
  }
  return parentId;
}

/**
 * Дерево категорий меняет кто-то один за раз.
 *
 * Склад при открытии спрашивает дерево и список одновременно, и оба запроса
 * раскладывают по дереву позиции, пришедшие из файла. Без очереди каждый
 * заводил свою копию одних и тех же категорий: позиции оставались в одной,
 * вторая — пустая (16.10.2026, загрузка склада из VLAPP). Блокировка живёт до
 * конца транзакции; второй запрос дождётся первого и увидит уже готовое дерево.
 */
export async function lockCatalog(tx: Prisma.TransactionClient, tenantId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"stock-catalog:" + tenantId}))`;
}

/**
 * Склеить одинаковые категории: одно имя (без учёта регистра) под одним
 * родителем. Руками такие не заводятся — их оставила гонка выше. Остаётся та,
 * где больше позиций (при равенстве — старшая); позиции и подкатегории копий
 * переходят к ней, цвет — если у неё своего нет. Склейка родителей может
 * породить двойников среди детей — поэтому по кругу, пока есть что склеивать.
 */
export async function mergeDuplicateCategories(tx: Prisma.TransactionClient): Promise<number> {
  let merged = 0;
  for (let round = 0; round < 10; round++) {
    const cats = await tx.stockCategory.findMany({ select: { id: true, parentId: true, name: true, color: true, createdAt: true } });
    const groups = new Map<string, typeof cats>();
    for (const c of cats) {
      const k = `${c.parentId ?? ""}|${c.name.trim().toLocaleLowerCase("ru-RU")}`;
      groups.set(k, [...(groups.get(k) ?? []), c]);
    }
    const dupes = [...groups.values()].filter((g) => g.length > 1);
    if (!dupes.length) break;
    const counts = await tx.stockItem.groupBy({ by: ["categoryId"], _count: { _all: true } });
    const n = new Map(counts.map((c) => [c.categoryId, c._count._all]));
    for (const g of dupes) {
      const [keep, ...rest] = [...g].sort(
        (a, b) => (n.get(b.id) ?? 0) - (n.get(a.id) ?? 0) || a.createdAt.getTime() - b.createdAt.getTime()
      );
      const ids = rest.map((r) => r.id);
      await tx.stockItem.updateMany({ where: { categoryId: { in: ids } }, data: { categoryId: keep.id } });
      await tx.stockCategory.updateMany({ where: { parentId: { in: ids } }, data: { parentId: keep.id } });
      const color = keep.color ?? rest.find((r) => r.color)?.color ?? null;
      if (color !== keep.color) await tx.stockCategory.update({ where: { id: keep.id }, data: { color } });
      await tx.stockCategory.deleteMany({ where: { id: { in: ids } } });
      merged += ids.length;
    }
  }
  return merged;
}

/**
 * Привести каталог в порядок перед показом: разложить текстовые категории и
 * склеить двойников. Без работы блокировку не берём — склад открывают часто.
 */
export async function tidyCatalog(tx: Prisma.TransactionClient, tenantId: string) {
  const loose = await tx.stockItem.findFirst({ where: { categoryId: null, category: { not: null } }, select: { id: true } });
  const dupe = await tx.$queryRaw<Array<{ one: number }>>`
    SELECT 1 AS one FROM "StockCategory" GROUP BY "parentId", lower(btrim(name)) HAVING count(*) > 1 LIMIT 1`;
  if (!loose && !dupe.length) return;
  await lockCatalog(tx, tenantId);
  await syncTextCategories(tx, tenantId);
  if (dupe.length && (await mergeDuplicateCategories(tx))) {
    // Пути текстом у позиций — по новому дереву.
    const roots = await tx.stockCategory.findMany({ where: { parentId: null }, select: { id: true } });
    for (const r of roots) await refreshPaths(tx, r.id);
  }
}

/** Разложить по дереву позиции, у которых категория есть только текстом. Вызывать под lockCatalog. */
export async function syncTextCategories(tx: Prisma.TransactionClient, tenantId: string) {
  const loose = await tx.stockItem.findMany({
    where: { categoryId: null, category: { not: null } },
    select: { id: true, category: true },
  });
  const todo = loose.filter((i) => splitPath(i.category).length);
  if (!todo.length) return;
  const all: Cat[] = await tx.stockCategory.findMany({ select: { id: true, parentId: true, name: true } });
  const byPath = new Map<string, string[]>();
  for (const i of todo) {
    const key = splitPath(i.category).join("/");
    byPath.set(key, [...(byPath.get(key) ?? []), i.id]);
  }
  for (const [path, ids] of byPath) {
    const categoryId = await ensurePath(tx, tenantId, path.split("/"), all);
    await tx.stockItem.updateMany({ where: { id: { in: ids } }, data: { categoryId, category: path } });
  }
}

/** Переписать текстовый путь у позиций категории и её подкатегорий (после переименования или переноса). */
export async function refreshPaths(tx: Prisma.TransactionClient, rootId: string) {
  const all: Cat[] = await tx.stockCategory.findMany({ select: { id: true, parentId: true, name: true } });
  const byId = new Map(all.map((c) => [c.id, c]));
  for (const id of withDescendants(rootId, all)) {
    await tx.stockItem.updateMany({ where: { categoryId: id }, data: { category: pathOf(id, byId) || null } });
  }
}

// ------------------------------------------------- склад ↔ запчасти заказа

export type PartRow = { name: string; qty: number; source: string; stockItemId: string | null };

/**
 * Списать со склада то, что добавили в заказ, и вернуть то, что убрали.
 *
 * Считаем по позициям склада: сколько штук этой позиции было в заказе со
 * склада до сохранения и сколько стало. Прибавилось — расход «В заказ»,
 * убавилось (удалили строку, уменьшили количество, сменили «Со склада» на
 * «Докуплена») — возврат на склад по средней себестоимости, чтобы она не
 * поехала. Не хватает на складе — сохранение заказа отклоняется целиком,
 * с названием позиции: в минус склад не уходит (stock.routes.ts).
 */
export async function syncOrderStock(
  tx: Prisma.TransactionClient,
  p: { tenantId: string; order: { id: string; number: string }; before: PartRow[]; after: PartRow[]; userId: string | null }
): Promise<Array<{ name: string; qty: number; dir: "out" | "back" }>> {
  const count = (rows: PartRow[]) => {
    const m = new Map<string, number>();
    for (const r of rows) if (r.stockItemId && r.source === "STOCK") m.set(r.stockItemId, (m.get(r.stockItemId) ?? 0) + r.qty);
    return m;
  };
  const was = count(p.before);
  const now = count(p.after);
  const ids = [...new Set([...was.keys(), ...now.keys()])];
  if (!ids.length) return [];

  const items = await tx.stockItem.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, unit: true, warehouseId: true } });
  const moved: Array<{ name: string; qty: number; dir: "out" | "back" }> = [];

  for (const id of ids) {
    const item = items.find((i) => i.id === id);
    if (!item) continue;
    const delta = Math.round(((now.get(id) ?? 0) - (was.get(id) ?? 0)) * 1000) / 1000;
    if (!delta) continue;
    // Списываем и возвращаем на складе самой позиции (29.10.2026).
    const warehouse = await homeWarehouse(tx, p.tenantId, item.warehouseId);
    if (delta > 0) {
      const bal = await tx.stockBalance.findFirst({ where: { warehouseId: warehouse.id, stockItemId: id } });
      const have = num(bal?.qty);
      if (have < delta) {
        throw badRequest(
          `«${item.name}»: на складе ${have} ${item.unit}, а в заказ нужно ${delta}. Уменьшите количество, выберите «Докуплена» или оприходуйте недостающее.`
        );
      }
      await applyMovement(tx, {
        tenantId: p.tenantId,
        warehouseId: warehouse.id,
        stockItemId: id,
        type: "OUT",
        qty: delta,
        orderId: p.order.id,
        userId: p.userId,
        comment: `Заказ ${p.order.number}`,
      });
      moved.push({ name: item.name, qty: delta, dir: "out" });
    } else {
      const bal = await tx.stockBalance.findFirst({ where: { warehouseId: warehouse.id, stockItemId: id } });
      await applyMovement(tx, {
        tenantId: p.tenantId,
        warehouseId: warehouse.id,
        stockItemId: id,
        type: "RETURN",
        qty: -delta,
        price: bal ? num(bal.avgCost) : null,
        orderId: p.order.id,
        userId: p.userId,
        comment: `Возврат из заказа ${p.order.number}`,
      });
      moved.push({ name: item.name, qty: -delta, dir: "back" });
    }
  }
  return moved;
}

export async function assertCategory(tx: Prisma.TransactionClient, id: string | null | undefined) {
  if (!id) return null;
  const c = await tx.stockCategory.findFirst({ where: { id }, select: { id: true } });
  if (!c) throw notFound("Категория не найдена");
  return c.id;
}
