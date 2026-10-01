-- Печать через CRM: компьютеры с программой (PrintStation) и задания печати
-- (PrintJob). Свой принтер сотрудника — в "User"."printPrefs", общий принтер
-- мастерской — в "Tenant".settings.printing.

CREATE TYPE "PrintJobStatus" AS ENUM ('QUEUED', 'SENT', 'DONE', 'FAILED');

CREATE TABLE "PrintStation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "printers" JSONB NOT NULL DEFAULT '[]',
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrintStation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PrintStation_tenantId_deviceId_key" ON "PrintStation"("tenantId", "deviceId");
ALTER TABLE "PrintStation" ADD CONSTRAINT "PrintStation_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "PrintJob" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "printerName" TEXT NOT NULL,
    "doc" TEXT NOT NULL,
    "orderId" TEXT,
    "copies" INTEGER NOT NULL DEFAULT 1,
    "status" "PrintJobStatus" NOT NULL DEFAULT 'QUEUED',
    "error" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrintJob_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PrintJob_stationId_status_idx" ON "PrintJob"("stationId", "status");
ALTER TABLE "PrintJob" ADD CONSTRAINT "PrintJob_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PrintJob" ADD CONSTRAINT "PrintJob_stationId_fkey"
  FOREIGN KEY ("stationId") REFERENCES "PrintStation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "User" ADD COLUMN "printPrefs" JSONB;

-- Изоляция мастерских — здесь же, как у зарплаты: таблица не должна жить
-- без политики до отдельного запуска rls.sql.
ALTER TABLE "PrintStation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PrintStation" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "PrintStation";
CREATE POLICY tenant_isolation ON "PrintStation"
  USING ("tenantId" = current_tenant_id() OR platform_mode())
  WITH CHECK ("tenantId" = current_tenant_id() OR platform_mode());

ALTER TABLE "PrintJob" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PrintJob" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "PrintJob";
CREATE POLICY tenant_isolation ON "PrintJob"
  USING ("tenantId" = current_tenant_id() OR platform_mode())
  WITH CHECK ("tenantId" = current_tenant_id() OR platform_mode());
