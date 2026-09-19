-- Память видов техники: наполняем тем, что мастерская уже приняла.
--
-- Вид техники стал таким же полем с памятью, как марка и модель. Но память
-- наполняется из новых заказов, а у работающей мастерской их тысячи уже
-- позади: без этой миграции приёмщик увидел бы девять встроенных строк и ни
-- одной своей — ровно то состояние, из-за которого всё и затевалось.
--
-- Считаем без учёта регистра и берём то написание, которое встречается чаще:
-- «ноутбук» и «Ноутбук» — один вид, и в списке он должен быть один. Дальше
-- этим занимается сама программа, здесь — только разовый разбор прошлого.
--
-- Оговорка про lower(): кириллицу он приводит к нижнему регистру по правилам
-- локали базы. На кластере, поднятом с локалью C, он оставит русские буквы как
-- есть, и два написания одного вида приедут в список двумя строками. Беда
-- невелика — это список подсказок, а не данные, — и сама она сойдётся:
-- программа при записи сличает варианты без учёта регистра и дальше будет
-- наращивать счёт у того написания, которое найдёт первым.
WITH kinds AS (
  SELECT
    "tenantId",
    btrim("kind") AS value,
    count(*)      AS n
  FROM "Device"
  WHERE "kind" IS NOT NULL
    AND char_length(btrim("kind")) BETWEEN 2 AND 60
  GROUP BY "tenantId", btrim("kind")
),
ranked AS (
  SELECT
    "tenantId",
    value,
    sum(n) OVER (PARTITION BY "tenantId", lower(value))                AS uses,
    row_number() OVER (
      PARTITION BY "tenantId", lower(value)
      ORDER BY n DESC, value
    )                                                                   AS rn
  FROM kinds
)
INSERT INTO "DeviceHint" ("id", "tenantId", "field", "scope", "value", "uses", "lastUsedAt", "createdAt")
SELECT
  gen_random_uuid()::text,
  "tenantId",
  'kind',
  '',
  value,
  uses::int,
  now(),
  now()
FROM ranked
WHERE rn = 1
ON CONFLICT ("tenantId", "field", "scope", "value") DO NOTHING;
