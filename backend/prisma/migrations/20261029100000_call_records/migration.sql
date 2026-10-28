-- batch53 (28.10.2026): звонки клиентов и записи разговоров в истории ремонта.

ALTER TYPE "AttachmentKind" ADD VALUE IF NOT EXISTS 'CALL';

CREATE TYPE "CallDirection" AS ENUM ('IN', 'OUT', 'MISSED', 'REJECTED');

CREATE TABLE "CallRecord" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "phoneId" TEXT,
    "direction" "CallDirection" NOT NULL,
    "number" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "durationSec" INTEGER NOT NULL DEFAULT 0,
    "customerId" TEXT,
    "orderId" TEXT,
    "attachmentId" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "movedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CallRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CallRecord_attachmentId_key" ON "CallRecord"("attachmentId");
CREATE UNIQUE INDEX "CallRecord_tenantId_dedupeKey_key" ON "CallRecord"("tenantId", "dedupeKey");
CREATE INDEX "CallRecord_tenantId_orderId_idx" ON "CallRecord"("tenantId", "orderId");
CREATE INDEX "CallRecord_tenantId_customerId_startedAt_idx" ON "CallRecord"("tenantId", "customerId", "startedAt");
CREATE INDEX "CallRecord_tenantId_startedAt_idx" ON "CallRecord"("tenantId", "startedAt");

ALTER TABLE "CallRecord" ADD CONSTRAINT "CallRecord_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CallRecord" ADD CONSTRAINT "CallRecord_phoneId_fkey" FOREIGN KEY ("phoneId") REFERENCES "SmsPhone"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CallRecord" ADD CONSTRAINT "CallRecord_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CallRecord" ADD CONSTRAINT "CallRecord_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CallRecord" ADD CONSTRAINT "CallRecord_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "Attachment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Изоляция мастерских — как у всех таблиц мастерской (prisma/rls.sql).
ALTER TABLE "CallRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CallRecord" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "CallRecord";
CREATE POLICY tenant_isolation ON "CallRecord"
  USING ("tenantId" = current_tenant_id() OR platform_mode())
  WITH CHECK ("tenantId" = current_tenant_id() OR platform_mode());

-- Новое право «Прослушивает записи звонков»: владельцу — всегда (все права),
-- управляющему и приёмщику — сразу, остальным — по решению владельца.
DO $$
BEGIN
  PERFORM set_config('app.platform', 'on', true);
  UPDATE "Role"
     SET permissions = array_append(permissions, 'calls.listen')
   WHERE code IN ('MANAGER', 'RECEPTIONIST') AND NOT ('calls.listen' = ANY (permissions));
END $$;
