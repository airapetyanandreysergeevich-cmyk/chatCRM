-- batch55 (03.11.2026): свои способы оплаты, деньги клиента сразу сотруднику с подтверждением.

CREATE TABLE "PayMethod" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "actKind" TEXT NOT NULL DEFAULT 'CARD',
    "cashRegisterId" TEXT,
    "commissionPct" DECIMAL(5,2),
    "recipientIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PayMethod_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PayMethod_tenantId_idx" ON "PayMethod"("tenantId");
ALTER TABLE "PayMethod" ADD CONSTRAINT "PayMethod_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PayMethod" ADD CONSTRAINT "PayMethod_cashRegisterId_fkey" FOREIGN KEY ("cashRegisterId") REFERENCES "CashRegister"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PayMethod" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PayMethod" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "PayMethod";
CREATE POLICY tenant_isolation ON "PayMethod"
  USING ("tenantId" = current_tenant_id() OR platform_mode())
  WITH CHECK ("tenantId" = current_tenant_id() OR platform_mode());

ALTER TABLE "Transaction" ADD COLUMN "method" TEXT;
ALTER TABLE "Transaction" ADD COLUMN "payMethodId" TEXT;
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_payMethodId_fkey" FOREIGN KEY ("payMethodId") REFERENCES "PayMethod"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Order" ADD COLUMN "payMethodId" TEXT;

ALTER TABLE "SalaryPayout" ADD COLUMN "source" TEXT;
ALTER TABLE "SalaryPayout" ADD COLUMN "orderId" TEXT;
ALTER TABLE "SalaryPayout" ADD COLUMN "saleId" TEXT;
ALTER TABLE "SalaryPayout" ADD COLUMN "payMethodId" TEXT;
ALTER TABLE "SalaryPayout" ADD COLUMN "takenById" TEXT;
ALTER TABLE "SalaryPayout" ADD COLUMN "inTxId" TEXT;
ALTER TABLE "SalaryPayout" ADD COLUMN "outTxId" TEXT;
ALTER TABLE "SalaryPayout" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'CONFIRMED';
ALTER TABLE "SalaryPayout" ADD COLUMN "confirmedAt" TIMESTAMP(3);
ALTER TABLE "SalaryPayout" ADD COLUMN "disputedAt" TIMESTAMP(3);
ALTER TABLE "SalaryPayout" ADD COLUMN "remindedAt" TIMESTAMP(3);
ALTER TABLE "SalaryPayout" ADD COLUMN "resolvedAt" TIMESTAMP(3);
ALTER TABLE "SalaryPayout" ADD COLUMN "resolvedById" TEXT;
CREATE INDEX "SalaryPayout_tenantId_userId_status_idx" ON "SalaryPayout"("tenantId", "userId", "status");

-- Старым движениям — вид расчёта по кассе: наличная — CASH, остальные — CARD; приходы продаж «Перевод» — TRANSFER.
-- Таблицы под RLS: без режима платформы владелец базы не видит ни строки.
DO $$
BEGIN
  PERFORM set_config('app.platform', 'on', true);
  UPDATE "Transaction" t SET "method" = CASE WHEN r."kind" = 'CASH' THEN 'CASH' ELSE 'CARD' END
    FROM "CashRegister" r WHERE r."id" = t."cashRegisterId" AND t."method" IS NULL AND t."direction" = 'IN';
  UPDATE "Transaction" t SET "method" = 'TRANSFER'
    FROM "Sale" s WHERE s."id" = t."saleId" AND s."payment" = 'TRANSFER' AND t."direction" = 'IN';
END $$;
