-- Свой формат номера заказа.
--
-- Владелец мастерской задаёт первый номер так, как хочет его видеть: SC01,
-- З-001, 1000 — и, по желанию, год в номере (SC-2026-01). С годом счётчик
-- каждый январь начинается заново. Пока формат не задан, номера прежние:
-- Р-2026-00001, у работающих мастерских ничего не меняется.
ALTER TABLE "Tenant" ADD COLUMN "orderNumberTemplate" TEXT;
ALTER TABLE "Tenant" ADD COLUMN "orderNumberWidth" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE "Tenant" ADD COLUMN "orderNumberStart" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Tenant" ADD COLUMN "orderNumberWithYear" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Tenant" ADD COLUMN "orderNumberYear" INTEGER;
