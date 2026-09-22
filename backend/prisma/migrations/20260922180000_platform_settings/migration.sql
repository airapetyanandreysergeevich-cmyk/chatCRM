-- Настройки платформы, общие для всех мастерских. Первая — словарь
-- распознавания шильдиков: марки и лишние слова, которые собственник правит
-- в панели «Мастерские», не дожидаясь обновления программы.
--
-- Таблица платформы: tenantId у неё нет, построчной защиты не нужно. Права
-- роли приложения выдаются сами (ALTER DEFAULT PRIVILEGES в 01-app-role.sh).
CREATE TABLE "PlatformSetting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformSetting_pkey" PRIMARY KEY ("key")
);
