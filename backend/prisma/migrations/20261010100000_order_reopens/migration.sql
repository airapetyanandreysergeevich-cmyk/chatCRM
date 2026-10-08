-- Возвраты выданного заказа в работу и снимок первой выдачи (Акт доплаты).
ALTER TABLE "Order" ADD COLUMN "reopens" JSONB;
