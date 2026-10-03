-- Наклейки на технику: задание печати помнит, на какие вещи печатать.
ALTER TABLE "PrintJob" ADD COLUMN "options" JSONB;
