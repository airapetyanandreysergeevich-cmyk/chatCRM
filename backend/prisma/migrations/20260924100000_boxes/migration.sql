-- Коробочные мастерские с доступом из интернета. Таблица платформенная:
-- изоляции по арендатору здесь нет, потому что арендатора у коробки нет —
-- её база стоит на компьютере мастерской.
CREATE TABLE "Box" (
    "id"         TEXT NOT NULL,
    "code"       TEXT NOT NULL,
    "name"       TEXT NOT NULL,
    "keyHash"    TEXT NOT NULL,
    "keyHint"    TEXT NOT NULL,
    "note"       TEXT,
    "isActive"   BOOLEAN NOT NULL DEFAULT true,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Box_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Box_code_key" ON "Box"("code");
CREATE INDEX "Box_keyHash_idx" ON "Box"("keyHash");
