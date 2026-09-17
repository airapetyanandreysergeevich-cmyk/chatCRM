-- CreateTable
CREATE TABLE "DeviceHint" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT '',
    "value" TEXT NOT NULL,
    "uses" INTEGER NOT NULL DEFAULT 1,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceHint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeviceHint_tenantId_field_idx" ON "DeviceHint"("tenantId", "field");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceHint_tenantId_field_scope_value_key" ON "DeviceHint"("tenantId", "field", "scope", "value");

-- AddForeignKey
ALTER TABLE "DeviceHint" ADD CONSTRAINT "DeviceHint_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

