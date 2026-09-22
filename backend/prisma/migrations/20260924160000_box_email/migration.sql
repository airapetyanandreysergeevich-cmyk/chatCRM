-- Доступ выдаётся на почту человека, который его запросил: по ней делается
-- код в адресе, по ней же потом можно будет выслать фразу заново. Название
-- мастерской отдельным полем больше не нужно — в списке стоит почта.
ALTER TABLE "Box" ADD COLUMN "email" TEXT;
UPDATE "Box" SET "email" = COALESCE("name", '') WHERE "email" IS NULL;
ALTER TABLE "Box" ALTER COLUMN "email" SET NOT NULL;
ALTER TABLE "Box" DROP COLUMN "name";

CREATE INDEX "Box_email_idx" ON "Box"("email");
