-- batch49 (22.10.2026): индивидуальные оповещения (ярлыки заказов), события
-- заказа для истории ремонта, «только мои заказы» в оповещениях, право
-- «Назначает мастеров», отдельный столбец «Совладельцы» в матрице оповещений.

CREATE TABLE "OrderLabel" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "icon" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "quickFilter" BOOLEAN NOT NULL DEFAULT false,
    "notify" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderLabel_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OrderLabelMark" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "labelId" TEXT NOT NULL,
    "setById" TEXT,
    "setAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderLabelMark_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OrderEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "userId" TEXT,
    "kind" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OrderLabel_tenantId_idx" ON "OrderLabel"("tenantId");
CREATE UNIQUE INDEX "OrderLabelMark_orderId_labelId_key" ON "OrderLabelMark"("orderId", "labelId");
CREATE INDEX "OrderLabelMark_tenantId_labelId_idx" ON "OrderLabelMark"("tenantId", "labelId");
CREATE INDEX "OrderEvent_tenantId_orderId_idx" ON "OrderEvent"("tenantId", "orderId");

ALTER TABLE "OrderLabel" ADD CONSTRAINT "OrderLabel_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrderLabelMark" ADD CONSTRAINT "OrderLabelMark_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrderLabelMark" ADD CONSTRAINT "OrderLabelMark_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderLabelMark" ADD CONSTRAINT "OrderLabelMark_labelId_fkey" FOREIGN KEY ("labelId") REFERENCES "OrderLabel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderLabelMark" ADD CONSTRAINT "OrderLabelMark_setById_fkey" FOREIGN KEY ("setById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OrderEvent" ADD CONSTRAINT "OrderEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrderEvent" ADD CONSTRAINT "OrderEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderEvent" ADD CONSTRAINT "OrderEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "User" ADD COLUMN "notifyOwnOnly" BOOLEAN NOT NULL DEFAULT false;

-- Изоляция мастерских — как у всех таблиц мастерской (prisma/rls.sql).
ALTER TABLE "OrderLabel" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrderLabel" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "OrderLabel";
CREATE POLICY tenant_isolation ON "OrderLabel"
  USING ("tenantId" = current_tenant_id() OR platform_mode())
  WITH CHECK ("tenantId" = current_tenant_id() OR platform_mode());

ALTER TABLE "OrderLabelMark" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrderLabelMark" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "OrderLabelMark";
CREATE POLICY tenant_isolation ON "OrderLabelMark"
  USING ("tenantId" = current_tenant_id() OR platform_mode())
  WITH CHECK ("tenantId" = current_tenant_id() OR platform_mode());

ALTER TABLE "OrderEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrderEvent" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "OrderEvent";
CREATE POLICY tenant_isolation ON "OrderEvent"
  USING ("tenantId" = current_tenant_id() OR platform_mode())
  WITH CHECK ("tenantId" = current_tenant_id() OR platform_mode());

-- Право «Назначает мастеров» — управляющим, как в пресетах ролей. Владелец и
-- совладелец получают все права и так. Приёмщик выбирает мастера при приёме,
-- а менять потом — только с этим правом (Андрей, 22.10.2026).
DO $$
BEGIN
  PERFORM set_config('app.platform', 'on', true);
  UPDATE "Role"
     SET permissions = array_append(permissions, 'orders.assign')
   WHERE code = 'MANAGER' AND NOT ('orders.assign' = ANY (permissions));
END $$;
