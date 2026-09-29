-- Марка по модели: пары «модель → марка» от Основ и модели без марки.
-- Таблицы платформы, без tenantId и без RLS — как PlatformSetting.
CREATE TABLE "PlateBoxModel" (
    "boxId" TEXT NOT NULL,
    "modelKey" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "uses" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlateBoxModel_pkey" PRIMARY KEY ("boxId","modelKey","brand")
);

CREATE INDEX "PlateBoxModel_modelKey_idx" ON "PlateBoxModel"("modelKey");

ALTER TABLE "PlateBoxModel" ADD CONSTRAINT "PlateBoxModel_boxId_fkey" FOREIGN KEY ("boxId") REFERENCES "Box"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "PlateMiss" (
    "source" TEXT NOT NULL,
    "modelKey" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "uses" INTEGER NOT NULL DEFAULT 1,
    "lastAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlateMiss_pkey" PRIMARY KEY ("source","modelKey")
);

CREATE INDEX "PlateMiss_lastAt_idx" ON "PlateMiss"("lastAt");
