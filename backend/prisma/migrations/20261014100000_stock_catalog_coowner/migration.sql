-- Совладелец: права как у владельца.
ALTER TABLE "User" ADD COLUMN "isCoOwner" BOOLEAN NOT NULL DEFAULT false;

-- Каталог склада: дерево категорий.
CREATE TABLE "StockCategory" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "parentId" TEXT,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StockCategory_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "StockCategory_tenantId_parentId_idx" ON "StockCategory"("tenantId", "parentId");
ALTER TABLE "StockCategory" ADD CONSTRAINT "StockCategory_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockCategory" ADD CONSTRAINT "StockCategory_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "StockCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Позиция склада: категория из дерева, место, цены, поставщик, даты.
ALTER TABLE "StockItem" ADD COLUMN "categoryId" TEXT;
ALTER TABLE "StockItem" ADD COLUMN "location" TEXT;
ALTER TABLE "StockItem" ADD COLUMN "purchasePrice" DECIMAL(12,2);
ALTER TABLE "StockItem" ADD COLUMN "salePrice" DECIMAL(12,2);
ALTER TABLE "StockItem" ADD COLUMN "supplier" TEXT;
ALTER TABLE "StockItem" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "StockItem" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "StockItem" ADD CONSTRAINT "StockItem_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "StockCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "StockItem_tenantId_categoryId_idx" ON "StockItem"("tenantId", "categoryId");

-- Изоляция мастерских — как у остальных таблиц мастерской (prisma/rls.sql).
ALTER TABLE "StockCategory" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StockCategory" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "StockCategory";
CREATE POLICY tenant_isolation ON "StockCategory"
  USING ("tenantId" = current_tenant_id() OR platform_mode())
  WITH CHECK ("tenantId" = current_tenant_id() OR platform_mode());
