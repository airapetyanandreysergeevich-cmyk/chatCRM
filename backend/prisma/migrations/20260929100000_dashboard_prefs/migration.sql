-- Настройки главного экрана: у каждого сотрудника свои.
ALTER TABLE "User" ADD COLUMN "dashboardPrefs" JSONB;
