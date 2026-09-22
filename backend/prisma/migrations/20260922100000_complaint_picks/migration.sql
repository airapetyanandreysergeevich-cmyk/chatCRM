-- Кнопки быстрого заполнения для поля «Неисправность со слов клиента».
--
-- Таблица та же, что у комплектности и внешнего состояния (QuickPick), новое
-- только значение field = 'complaint'. Схема не меняется, политика RLS на
-- таблице уже стоит.
--
-- Режим платформы — по той же причине, что в 20260921120000_quick_picks:
-- FORCE RLS действует и на владельца, и без него выборка из заказов пуста.
SELECT set_config('app.platform', 'on', false);

WITH defaults(label, ord) AS (
  VALUES
    ('Не включается', 0),
    ('Не заряжается', 1),
    ('Не загружается система', 2),
    ('Медленно работает', 3),
    ('Греется и выключается', 4),
    ('Шумит', 5),
    ('Нет изображения', 6),
    ('Разбит экран', 7),
    ('Не работает клавиатура', 8),
    ('Нет звука', 9),
    ('Не работает Wi-Fi', 10),
    ('Залит жидкостью', 11),
    ('Чистка и профилактика', 12),
    ('Установка системы и программ', 13)
),
-- Жалоба — живая речь: делим её на пункты так же, как complaintLabels() в
-- src/lib/dictionaries.ts — запятая, точка с запятой, перевод строки, ! и ?,
-- а точка — только в конце предложения. DISTINCT: одна жалоба — одно нажатие.
items AS (
  SELECT DISTINCT o."id", o."tenantId",
         lower(btrim(regexp_replace(p.piece, '\s+', ' ', 'g'))) AS key
  FROM "Order" o
  CROSS JOIN LATERAL regexp_split_to_table(o."complaint", '[,;\n!?]|\.(?=\s|$)') AS p(piece)
  WHERE o."deletedAt" IS NULL
),
counts AS (
  SELECT "tenantId", key, count(*) AS n FROM items WHERE key <> '' GROUP BY "tenantId", key
)
INSERT INTO "QuickPick" ("id", "tenantId", "field", "label", "uses", "sortOrder", "createdAt")
SELECT gen_random_uuid()::text, t."id", 'complaint', d.label, coalesce(c.n, 0)::int, d.ord, now()
FROM "Tenant" t
CROSS JOIN defaults d
LEFT JOIN counts c ON c."tenantId" = t."id" AND c.key = lower(d.label)
ON CONFLICT ("tenantId", "field", "label") DO NOTHING;

SELECT set_config('app.platform', '', false);
