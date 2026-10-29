-- batch54 (29.10.2026): у позиции склада — свой склад (Андрей: «у многих несколько складов»).
-- Пусто — основной склад, как было. Остатки позиции лежат на её складе.
ALTER TABLE "StockItem" ADD COLUMN "warehouseId" TEXT;
CREATE INDEX "StockItem_tenantId_warehouseId_idx" ON "StockItem"("tenantId", "warehouseId");
ALTER TABLE "StockItem" ADD CONSTRAINT "StockItem_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;
