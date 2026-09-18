/**
 * Проверка, что таблицу мастерской не забыли ни в одном из четырёх мест.
 *
 * Изоляция арендаторов держится на двух независимых списках: политики RLS в
 * `prisma/rls.sql` и прокси в `src/lib/db.ts`. Новая таблица с `tenantId`
 * обязана попасть в оба — иначе останется один рубеж вместо двух, и узнать об
 * этом будет неоткуда: всё работает, просто защищено наполовину.
 *
 * Третий список — порядок очистки в `services/tenant-remove.ts`. Забытая там
 * таблица не тихая: удаление мастерской упрётся в ссылку и остановится на
 * середине. Но случится это ровно один раз, у настоящего клиента.
 *
 * Поэтому списки сверяются не глазами, а здесь.
 *
 *   npx tsx test/tenant-tables.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.join(__dirname, "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

let fails = 0;
const check = (ok: boolean, msg: string) => {
  console.log((ok ? "ok    " : "БЕДА  ") + msg);
  if (!ok) fails++;
};

/**
 * Таблицы платформы, у которых есть `tenantId`, но изоляции быть не должно.
 *
 * К ним ходит только платформенный слой, и попади они под политику — перестал
 * бы работать вход: сессия ищется до того, как известно, чья она.
 */
const PLATFORM_TABLES = new Set(["Session", "TenantApplication", "Impersonation", "PlatformAuditLog"]);

// 1. Все модели с tenantId — по самой схеме, а не по нашим представлениям о ней.
const schema = read("prisma/schema.prisma");
const withTenantId = new Set<string>();
for (const block of schema.split(/\nmodel /).slice(1)) {
  const name = block.slice(0, block.indexOf(" ")).trim();
  const body = block.slice(0, block.indexOf("\n}"));
  if (/^\s*tenantId\s/m.test(body)) withTenantId.add(name);
}
const shouldBeIsolated = [...withTenantId].filter((t) => !PLATFORM_TABLES.has(t)).sort();
check(shouldBeIsolated.length > 20, `в схеме найдено ${shouldBeIsolated.length} таблиц мастерской`);

// 2. Политики RLS
const rls = read("prisma/rls.sql");
const rlsList = rls.slice(rls.indexOf("tenant_tables text[] := ARRAY["), rls.indexOf("];"));
const inRls = new Set([...rlsList.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]));

// 3. Прокси приложения. Имена делегатов Prisma — с маленькой буквы.
const db = read("src/lib/db.ts");
const delegates = db.slice(db.indexOf("TENANT_DELEGATES = new Set(["), db.indexOf("]);"));
const inProxy = new Set([...delegates.matchAll(/"([a-zA-Z]+)"/g)].map((m) => m[1]));

// 4. Порядок удаления
const remove = read("src/services/tenant-remove.ts");
const orderList = remove.slice(remove.indexOf("const ORDER"), remove.indexOf("];", remove.indexOf("const ORDER")));
const inOrder = new Set([...orderList.matchAll(/"([a-zA-Z]+)"/g)].map((m) => m[1]));

const lower = (t: string) => t[0].toLowerCase() + t.slice(1);

const missingRls = shouldBeIsolated.filter((t) => !inRls.has(t));
const missingProxy = shouldBeIsolated.filter((t) => !inProxy.has(lower(t)));
const missingOrder = shouldBeIsolated.filter((t) => !inOrder.has(lower(t)));

check(missingRls.length === 0, `все таблицы под политикой RLS${missingRls.length ? ": нет " + missingRls.join(", ") : ""}`);
check(
  missingProxy.length === 0,
  `все таблицы подставляются прокси${missingProxy.length ? ": нет " + missingProxy.join(", ") : ""}`
);
check(
  missingOrder.length === 0,
  `все таблицы очищаются при удалении${missingOrder.length ? ": нет " + missingOrder.join(", ") : ""}`
);

// Обратная сторона: лишнее в списках тоже беда — политика на несуществующей
// таблице уронит применение rls.sql целиком.
const extraRls = [...inRls].filter((t) => !shouldBeIsolated.includes(t));
const extraProxy = [...inProxy].filter((t) => !shouldBeIsolated.some((s) => lower(s) === t));
check(extraRls.length === 0, `в rls.sql нет лишних${extraRls.length ? ": " + extraRls.join(", ") : ""}`);
check(extraProxy.length === 0, `в прокси нет лишних${extraProxy.length ? ": " + extraProxy.join(", ") : ""}`);

// Порядок очистки: дети раньше родителей. Полностью это проверит только живая
// база, но самое дорогое — заказы раньше сотрудников — видно и отсюда.
const order = [...inOrder];
const before = (a: string, b: string) => order.indexOf(a) < order.indexOf(b);
check(before("order", "user"), "заказы удаляются раньше сотрудников");
check(before("attachment", "order"), "вложения раньше заказов");
check(before("orderPart", "order") && before("orderWork", "order"), "работы и запчасти раньше заказов");
check(before("user", "role") && before("user", "branch"), "сотрудники раньше ролей и филиалов");
check(before("stockMovement", "stockItem"), "движения склада раньше самих позиций");

console.log(fails === 0 ? "\nвсе проверки прошли" : `\nпровалов: ${fails}`);
process.exitCode = fails === 0 ? 0 : 1;
