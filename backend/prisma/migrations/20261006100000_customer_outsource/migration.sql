-- Клиент-аутсорс: партнёр, который сдаёт технику на ремонт. Отметка в анкете и фильтр заказов.
ALTER TABLE "Customer" ADD COLUMN "isOutsource" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "Customer_tenantId_isOutsource_idx" ON "Customer"("tenantId", "isOutsource");
