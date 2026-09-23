-- Имя мастерской в облаке.
--
-- Сотрудник коробочной мастерской входит на общем сайте: пишет почту с
-- хвостом — anton@repair.ru.local20 — и облако по этому хвосту отправляет
-- его в Основу своего владельца. Хвост приходится диктовать и печатать,
-- поэтому он короткий и произносимый, в отличие от кода в адресе, который
-- нарочно сделан случайным.
ALTER TABLE "Box" ADD COLUMN "tag" TEXT;

-- Уже выданным мастерским имена раздаём по порядку появления.
WITH numbered AS (
  SELECT "id", ROW_NUMBER() OVER (ORDER BY "createdAt") AS n FROM "Box"
)
UPDATE "Box" SET "tag" = 'local' || numbered.n FROM numbered WHERE "Box"."id" = numbered."id";

ALTER TABLE "Box" ALTER COLUMN "tag" SET NOT NULL;
CREATE UNIQUE INDEX "Box_tag_key" ON "Box"("tag");
