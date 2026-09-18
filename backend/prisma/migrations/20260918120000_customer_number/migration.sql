-- Короткий номер клиента внутри мастерской.
--
-- Колонка добавляется пустой, заполняется для уже заведённых клиентов и
-- только потом становится обязательной: на живой базе иначе нельзя — NOT NULL
-- без значения по умолчанию упал бы на первой же существующей строке.
--
-- Нумеруем в порядке заведения, чтобы номера шли так же, как шли бы, если бы
-- счётчик существовал с самого начала.

ALTER TABLE "Tenant" ADD COLUMN "customerNumberNext" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "Customer" ADD COLUMN "number" INTEGER;

UPDATE "Customer" AS c
   SET "number" = n.seq
  FROM (
    SELECT id,
           row_number() OVER (PARTITION BY "tenantId" ORDER BY "createdAt", id) AS seq
      FROM "Customer"
  ) AS n
 WHERE c.id = n.id;

-- Счётчик мастерской встаёт за последним выданным номером. Мастерские без
-- клиентов остаются на единице — их COALESCE и прикрывает.
UPDATE "Tenant" AS t
   SET "customerNumberNext" = COALESCE(
     (SELECT MAX(c."number") + 1 FROM "Customer" c WHERE c."tenantId" = t.id),
     1
   );

ALTER TABLE "Customer" ALTER COLUMN "number" SET NOT NULL;

CREATE UNIQUE INDEX "Customer_tenantId_number_key" ON "Customer"("tenantId", "number");
