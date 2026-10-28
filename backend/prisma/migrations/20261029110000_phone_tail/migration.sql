-- batch53 (28.10.2026): «89189998877 и +79189998877 — одно и то же» (Андрей).
-- Последние 10 цифр телефона — по ним приём находит уже заведённого клиента,
-- поиск находит его по любой записи номера, а звонок — его карточку.
-- Столбцы вычисляет сама база: писать в них программе не нужно и нельзя.

ALTER TABLE "Customer"
  ADD COLUMN "phoneTail" TEXT GENERATED ALWAYS AS (right(regexp_replace(COALESCE("phone", ''), '[^0-9]', '', 'g'), 10)) STORED;
ALTER TABLE "Customer"
  ADD COLUMN "phone2Tail" TEXT GENERATED ALWAYS AS (right(regexp_replace(COALESCE("phone2", ''), '[^0-9]', '', 'g'), 10)) STORED;

CREATE INDEX "Customer_tenantId_phoneTail_idx" ON "Customer"("tenantId", "phoneTail");
CREATE INDEX "Customer_tenantId_phone2Tail_idx" ON "Customer"("tenantId", "phone2Tail");
