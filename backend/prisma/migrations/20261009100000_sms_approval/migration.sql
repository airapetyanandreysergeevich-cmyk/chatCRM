-- Согласование по SMS и системные записи в истории ремонта.
ALTER TABLE "OrderMessage" ADD COLUMN "system" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "SmsApproval" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "smsId" TEXT,
    "phone" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "replyText" TEXT,
    "repliedAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SmsApproval_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SmsApproval_tenantId_orderId_idx" ON "SmsApproval"("tenantId", "orderId");
CREATE INDEX "SmsApproval_tenantId_phone_status_idx" ON "SmsApproval"("tenantId", "phone", "status");
ALTER TABLE "SmsApproval" ADD CONSTRAINT "SmsApproval_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Изоляция мастерских — как у остальных таблиц мастерской (prisma/rls.sql).
ALTER TABLE "SmsApproval" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SmsApproval" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "SmsApproval";
CREATE POLICY tenant_isolation ON "SmsApproval"
  USING ("tenantId" = current_tenant_id() OR platform_mode())
  WITH CHECK ("tenantId" = current_tenant_id() OR platform_mode());
