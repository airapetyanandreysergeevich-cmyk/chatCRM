-- SMS со своего телефона: приложение «FineCRM SMS» на Android (SmsPhone) и
-- отметки, какой телефон забрал сообщение.

CREATE TABLE "SmsPhone" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Телефон',
    "pairCode" TEXT,
    "pairExpiresAt" TIMESTAMP(3),
    "tokenHash" TEXT,
    "info" JSONB NOT NULL DEFAULT '{}',
    "lastSeenAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SmsPhone_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SmsPhone_pairCode_key" ON "SmsPhone"("pairCode");
ALTER TABLE "SmsPhone" ADD CONSTRAINT "SmsPhone_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SmsMessage" ADD COLUMN "phoneId" TEXT;
ALTER TABLE "SmsMessage" ADD COLUMN "pickedAt" TIMESTAMP(3);
CREATE INDEX "SmsMessage_tenantId_status_idx" ON "SmsMessage"("tenantId", "status");

ALTER TABLE "SmsPhone" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SmsPhone" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "SmsPhone";
CREATE POLICY tenant_isolation ON "SmsPhone"
  USING ("tenantId" = current_tenant_id() OR platform_mode())
  WITH CHECK ("tenantId" = current_tenant_id() OR platform_mode());
