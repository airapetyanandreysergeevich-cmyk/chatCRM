-- batch55 (03.11.2026): свои бланки из Excel — шаблон .xlsx с метками {номер}, {клиент}…

CREATE TABLE "PrintTemplate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "target" TEXT NOT NULL DEFAULT 'order',
    "fileName" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "marks" JSONB NOT NULL DEFAULT '{}',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PrintTemplate_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PrintTemplate_tenantId_idx" ON "PrintTemplate"("tenantId");
ALTER TABLE "PrintTemplate" ADD CONSTRAINT "PrintTemplate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PrintTemplate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PrintTemplate" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "PrintTemplate";
CREATE POLICY tenant_isolation ON "PrintTemplate"
  USING ("tenantId" = current_tenant_id() OR platform_mode())
  WITH CHECK ("tenantId" = current_tenant_id() OR platform_mode());
