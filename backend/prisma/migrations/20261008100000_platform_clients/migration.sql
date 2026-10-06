-- Панель собственника: категории клиентов, оплата, активность, расход ресурсов.
CREATE TABLE "ClientCategory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT 'blue',
    "note" TEXT,
    "cloudPrice" INTEGER NOT NULL DEFAULT 0,
    "remotePrice" INTEGER NOT NULL DEFAULT 0,
    "trialDays" INTEGER NOT NULL DEFAULT 14,
    "maxUsers" INTEGER NOT NULL DEFAULT 10,
    "maxStorageMb" INTEGER NOT NULL DEFAULT 5000,
    "plateOcr" BOOLEAN NOT NULL DEFAULT true,
    "showAds" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ClientCategory_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ClientCategory_name_key" ON "ClientCategory"("name");

CREATE TABLE "ClientPayment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "boxId" TEXT,
    "clientName" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "months" INTEGER,
    "paidUntil" TIMESTAMP(3) NOT NULL,
    "prevPaidUntil" TIMESTAMP(3),
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClientPayment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ClientPayment_createdAt_idx" ON "ClientPayment"("createdAt");
CREATE INDEX "ClientPayment_tenantId_idx" ON "ClientPayment"("tenantId");
CREATE INDEX "ClientPayment_boxId_idx" ON "ClientPayment"("boxId");

CREATE TABLE "UsageMonth" (
    "subject" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "plateOcr" INTEGER NOT NULL DEFAULT 0,
    "relayBytes" BIGINT NOT NULL DEFAULT 0,
    "relayRequests" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "UsageMonth_pkey" PRIMARY KEY ("subject","month")
);

ALTER TABLE "Tenant" ADD COLUMN "categoryId" TEXT,
ADD COLUMN "price" INTEGER,
ADD COLUMN "customLimits" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "paidUntil" TIMESTAMP(3),
ADD COLUMN "lastSeenAt" TIMESTAMP(3);

ALTER TABLE "Box" ADD COLUMN "categoryId" TEXT,
ADD COLUMN "price" INTEGER,
ADD COLUMN "paidUntil" TIMESTAMP(3);

ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ClientCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Box" ADD CONSTRAINT "Box_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ClientCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ClientPayment" ADD CONSTRAINT "ClientPayment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ClientPayment" ADD CONSTRAINT "ClientPayment_boxId_fkey" FOREIGN KEY ("boxId") REFERENCES "Box"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Первая категория — чтобы новым клиентам было куда попадать. Условия —
-- те же, что были у всех до сих пор: 10 сотрудников, 5 ГБ, шильдики.
INSERT INTO "ClientCategory" ("id","name","color","isDefault","updatedAt")
VALUES ('cat-default','Обычные','blue',true,CURRENT_TIMESTAMP);

-- Все, кто уже есть, — в неё же. Кому лимиты меняли руками, тем они остаются своими.
UPDATE "Tenant" SET "categoryId" = 'cat-default',
  "customLimits" = ("maxUsers" <> 10 OR "maxStorageMb" <> 5000 OR "plateOcr" <> true);
UPDATE "Box" SET "categoryId" = 'cat-default';
