-- Кнопки быстрого заполнения: комплектность и внешнее состояние.
--
-- Раньше это был общий для всех список в коде. Теперь у каждой мастерской
-- свой, правится шестерёнкой на бланке приёма, а кнопки стоят по частоте
-- использования.

CREATE TABLE "QuickPick" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "uses" INTEGER NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuickPick_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "QuickPick_tenantId_field_label_key" ON "QuickPick"("tenantId", "field", "label");
CREATE INDEX "QuickPick_tenantId_field_idx" ON "QuickPick"("tenantId", "field");

ALTER TABLE "QuickPick" ADD CONSTRAINT "QuickPick_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Изоляция — здесь же, а не только в rls.sql.
--
-- rls.sql применяется отдельной командой, и её легко забыть: таблица тогда
-- живёт под одним рубежом защиты вместо двух, и никто об этом не узнаёт.
-- Политика та же, что в rls.sql; повторное применение rls.sql её пересоздаст.
ALTER TABLE "QuickPick" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "QuickPick" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "QuickPick";
CREATE POLICY tenant_isolation ON "QuickPick"
  USING ("tenantId" = current_tenant_id() OR platform_mode())
  WITH CHECK ("tenantId" = current_tenant_id() OR platform_mode());

-- Наполнение: стартовые кнопки каждой мастерской и счёт по принятым заказам.
--
-- Режим платформы включаем явно. Миграции накатывает владелец схемы, а
-- построчная защита с FORCE действует и на владельца: без этого выборка из
-- заказов вернула бы пустоту, и все кнопки начали бы с нуля — ровно то, от
-- чего сортировка по частоте должна была избавить.
SELECT set_config('app.platform', 'on', false);

WITH defaults(field, label, ord) AS (
  VALUES
    ('completeness', 'Блок питания', 0),
    ('completeness', 'Кабель', 1),
    ('completeness', 'Сумка или чехол', 2),
    ('completeness', 'Батарея', 3),
    ('completeness', 'Диск (HDD/SSD)', 4),
    ('completeness', 'Оперативная память', 5),
    ('completeness', 'SIM-карта', 6),
    ('completeness', 'Карта памяти', 7),
    ('completeness', 'Стилус или мышь', 8),
    ('completeness', 'Документы и чек', 9),
    ('appearance', 'Царапины', 0),
    ('appearance', 'Сколы', 1),
    ('appearance', 'Трещины', 2),
    ('appearance', 'Вмятины', 3),
    ('appearance', 'Потёртости', 4),
    ('appearance', 'Дефекты экрана', 5),
    ('appearance', 'Отсутствуют элементы корпуса', 6),
    ('appearance', 'Следы вскрытия', 7),
    ('appearance', 'Следы влаги', 8)
),
-- Пункты каждого заказа. Старые заказы хранят чек-лист [{label, checked}],
-- новые — список строк; следы вскрытия и влаги у старых стоят флагом.
-- DISTINCT по заказу: у новых заказов пункт есть и в списке, и флагом, и
-- считать его дважды нельзя.
items AS (
  SELECT DISTINCT o."id", o."tenantId", f.field, lower(btrim(x.label)) AS key
  FROM "Order" o
  CROSS JOIN LATERAL (VALUES ('completeness', o."completeness"), ('appearance', o."appearance")) AS f(field, val)
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(f.val) = 'array' THEN f.val ELSE '[]'::jsonb END
  ) AS e(item)
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN jsonb_typeof(e.item) = 'string' THEN e.item #>> '{}'
      WHEN jsonb_typeof(e.item) = 'object' AND (e.item ->> 'checked') = 'true' THEN e.item ->> 'label'
    END AS label
  ) x
  WHERE o."deletedAt" IS NULL AND x.label IS NOT NULL
  UNION
  SELECT "id", "tenantId", 'appearance', lower('Следы вскрытия') FROM "Order"
   WHERE "hasOpenTraces" AND "deletedAt" IS NULL
  UNION
  SELECT "id", "tenantId", 'appearance', lower('Следы влаги') FROM "Order"
   WHERE "hasWaterDamage" AND "deletedAt" IS NULL
),
counts AS (
  SELECT "tenantId", field, key, count(*) AS n FROM items GROUP BY "tenantId", field, key
)
INSERT INTO "QuickPick" ("id", "tenantId", "field", "label", "uses", "sortOrder", "createdAt")
SELECT gen_random_uuid()::text, t."id", d.field, d.label, coalesce(c.n, 0)::int, d.ord, now()
FROM "Tenant" t
CROSS JOIN defaults d
LEFT JOIN counts c ON c."tenantId" = t."id" AND c.field = d.field AND c.key = lower(d.label)
ON CONFLICT ("tenantId", "field", "label") DO NOTHING;

SELECT set_config('app.platform', '', false);
