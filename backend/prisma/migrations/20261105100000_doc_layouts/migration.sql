-- batch56 (05.11.2026): «Редактор бланков» — свои бланки листом с элементами.

CREATE TABLE "DocLayout" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "target" TEXT NOT NULL DEFAULT 'order',
    "use" TEXT,
    "data" JSONB NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DocLayout_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DocLayout_tenantId_idx" ON "DocLayout"("tenantId");
ALTER TABLE "DocLayout" ADD CONSTRAINT "DocLayout_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "DocLayout" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DocLayout" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "DocLayout";
CREATE POLICY tenant_isolation ON "DocLayout"
  USING ("tenantId" = current_tenant_id() OR platform_mode())
  WITH CHECK ("tenantId" = current_tenant_id() OR platform_mode());
