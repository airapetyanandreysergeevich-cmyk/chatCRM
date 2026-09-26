-- Зарплата: ручные начисления (оклад, премия, штраф, начальный остаток),
-- выплаты сотрудникам и снимки закрытых месяцев. Процент мастера с
-- оплаченных заказов хранить не нужно — он считается из заказов.

CREATE TYPE "SalaryEntryKind" AS ENUM ('OPENING', 'BONUS');

CREATE TABLE "SalaryEntry" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "kind" "SalaryEntryKind" NOT NULL DEFAULT 'BONUS',
    "amount" DECIMAL(12,2) NOT NULL,
    "comment" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalaryEntry_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SalaryEntry_tenantId_month_idx" ON "SalaryEntry"("tenantId", "month");
ALTER TABLE "SalaryEntry" ADD CONSTRAINT "SalaryEntry_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SalaryEntry" ADD CONSTRAINT "SalaryEntry_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SalaryEntry" ADD CONSTRAINT "SalaryEntry_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "SalaryPayout" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL,
    "month" TEXT NOT NULL,
    "comment" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "SalaryPayout_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SalaryPayout_tenantId_month_idx" ON "SalaryPayout"("tenantId", "month");
ALTER TABLE "SalaryPayout" ADD CONSTRAINT "SalaryPayout_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SalaryPayout" ADD CONSTRAINT "SalaryPayout_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SalaryPayout" ADD CONSTRAINT "SalaryPayout_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "SalaryMonth" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "closedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedById" TEXT,
    "snapshot" JSONB NOT NULL,

    CONSTRAINT "SalaryMonth_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SalaryMonth_tenantId_month_key" ON "SalaryMonth"("tenantId", "month");
ALTER TABLE "SalaryMonth" ADD CONSTRAINT "SalaryMonth_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Изоляция мастерских — здесь же, как у OrderMessage: таблица не должна
-- жить без политики до отдельного запуска rls.sql.
ALTER TABLE "SalaryEntry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SalaryEntry" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "SalaryEntry";
CREATE POLICY tenant_isolation ON "SalaryEntry"
  USING ("tenantId" = current_tenant_id() OR platform_mode())
  WITH CHECK ("tenantId" = current_tenant_id() OR platform_mode());

ALTER TABLE "SalaryPayout" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SalaryPayout" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "SalaryPayout";
CREATE POLICY tenant_isolation ON "SalaryPayout"
  USING ("tenantId" = current_tenant_id() OR platform_mode())
  WITH CHECK ("tenantId" = current_tenant_id() OR platform_mode());

ALTER TABLE "SalaryMonth" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SalaryMonth" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "SalaryMonth";
CREATE POLICY tenant_isolation ON "SalaryMonth"
  USING ("tenantId" = current_tenant_id() OR platform_mode())
  WITH CHECK ("tenantId" = current_tenant_id() OR platform_mode());
