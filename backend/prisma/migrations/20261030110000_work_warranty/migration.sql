-- batch54 (29.10.2026): гарантийный срок у услуги прайса — переходит в строку работы и в акт.
ALTER TABLE "Service" ADD COLUMN "warrantyDays" INTEGER;
ALTER TABLE "OrderWork" ADD COLUMN "warrantyDays" INTEGER;
