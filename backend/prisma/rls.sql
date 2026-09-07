-- Row-Level Security для арендаторов.
-- Применяется миграцией: prisma migrate dev --create-only, затем содержимое вставляется в migration.sql.
-- Работает так: приложение в начале каждой транзакции делает
--   SELECT set_config('app.tenant_id', '<uuid>', true);
-- и политики ниже отсекают чужие строки на уровне PostgreSQL.

-- Роль приложения НЕ должна быть владельцем таблиц и не должна иметь BYPASSRLS.
-- Создайте отдельную роль для бэкенда:
--   CREATE ROLE repairshop_app LOGIN PASSWORD '...';
--   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO repairshop_app;
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO repairshop_app;

CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'Branch','Role','User','Customer','Device','OrderStatus','Order',
    'OrderStatusHistory','OrderWork','OrderPart','Attachment',
    'PurchaseRequest','PurchaseRequestItem',
    'Warehouse','StockItem','StockBalance','StockMovement',
    'CashRegister','TransactionCategory','Transaction',
    'AuditLog','Notification','PushSubscription'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("tenantId" = current_tenant_id()) WITH CHECK ("tenantId" = current_tenant_id())',
      t
    );
  END LOOP;
END $$;

-- Таблицы платформы (Tenant, PlatformUser, PlatformAuditLog, Impersonation, Session)
-- под RLS не попадают: к ним ходит только платформенный слой приложения под отдельной ролью.
