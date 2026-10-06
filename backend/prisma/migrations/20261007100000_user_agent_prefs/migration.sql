-- Агенты сотрудника: выключенные магазины в поиске запчастей (у каждого свои).
ALTER TABLE "User" ADD COLUMN "agentPrefs" JSONB;
