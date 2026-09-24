-- Имя мастерской вместо приставки localN.
--
-- Раньше сотрудник коробочной мастерской входил на общем сайте почтой с
-- хвостом: ivan@mail.ru.local4. Хвост был служебным номером, его приходилось
-- объяснять и его забывали. Теперь владелец сам выбирает имя мастерской, и
-- логины сотрудников становятся nikita@lenina.
--
-- Приставки не переносятся: имени, которое никто не выбирал, у мастерской
-- быть не должно. До регистрации имени вход с общего сайта не работает,
-- локальная сеть не затронута.
DROP INDEX IF EXISTS "Box_tag_key";
ALTER TABLE "Box" DROP COLUMN IF EXISTS "tag";

ALTER TABLE "Box" ADD COLUMN "name" TEXT;
ALTER TABLE "Box" ADD COLUMN "previousName" TEXT;
ALTER TABLE "Box" ADD COLUMN "previousNameUntil" TIMESTAMP(3);
CREATE UNIQUE INDEX "Box_name_key" ON "Box"("name");
CREATE INDEX "Box_previousName_idx" ON "Box"("previousName");

-- Сотрудник: почта для связи и прежний логин.
ALTER TABLE "User" ADD COLUMN "contactEmail" TEXT;
ALTER TABLE "User" ADD COLUMN "previousLogin" TEXT;
