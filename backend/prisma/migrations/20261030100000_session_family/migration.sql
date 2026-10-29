-- batch54 (29.10.2026): «многих выкидывает из сессии» (Андрей).
-- Старый ключ обновления, пришедший повторно, раньше гасил все входы сотрудника на всех
-- устройствах. Теперь — только цепочку одного устройства (familyId). Плюс «Запомнить меня»
-- и причина, по которой вход кончился.

ALTER TABLE "Session" ADD COLUMN "familyId" TEXT;
ALTER TABLE "Session" ADD COLUMN "remember" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Session" ADD COLUMN "endReason" TEXT;
CREATE INDEX "Session_familyId_idx" ON "Session"("familyId");
-- Уже выданные входы: каждый — своя цепочка.
UPDATE "Session" SET "familyId" = "id" WHERE "familyId" IS NULL;
