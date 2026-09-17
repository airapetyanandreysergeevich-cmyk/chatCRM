-- Миниатюра боевой схемы: одна таблица арендатора и те же правила изоляции,
-- что в backend/prisma/rls.sql. Нужна, чтобы проверить локальный кластер, не
-- прогоняя все миграции.

CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS text AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '');
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION platform_mode() RETURNS boolean AS $$
  SELECT coalesce(current_setting('app.platform', true), '') = 'on';
$$ LANGUAGE sql STABLE;

DROP TABLE IF EXISTS probe;
CREATE TABLE probe (
  id       text PRIMARY KEY,
  "tenantId" text NOT NULL,
  name     text NOT NULL
);

INSERT INTO probe VALUES ('a', 't1', 'Первый'), ('b', 't2', 'Второй');

ALTER TABLE probe ENABLE ROW LEVEL SECURITY;
ALTER TABLE probe FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON probe;
CREATE POLICY tenant_isolation ON probe
  USING ("tenantId" = current_tenant_id() OR platform_mode())
  WITH CHECK ("tenantId" = current_tenant_id() OR platform_mode());
