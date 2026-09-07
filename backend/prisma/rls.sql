-- Row-Level Security для арендаторов.
-- Применяется миграцией: prisma migrate dev --create-only, затем содержимое вставляется в migration.sql.
-- Работает так: приложение в начале каждой транзакции делает
--   SELECT set_config('app.tenant_id', '<uuid>', true);
-- и политики ниже отсекают чужие строки на уровне PostgreSQL.

-- ВАЖНО. Роль приложения не должна быть суперпользователем и не должна владеть таблицами:
-- суперпользователь игнорирует RLS всегда, даже при FORCE, и изоляция перестаёт работать.
-- Роль создаёт deploy/postgres/01-app-role.sh при первом запуске базы.

CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION platform_mode() RETURNS boolean AS $$
  SELECT coalesce(current_setting('app.platform', true), '') = 'on';
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
    -- Вторая ветка — режим платформы: нужен собственнику для сводных цифр по всем мастерским.
    -- Включается только внутри withPlatform(), где set_config действует в пределах транзакции.
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I '
      'USING ("tenantId" = current_tenant_id() OR platform_mode()) '
      'WITH CHECK ("tenantId" = current_tenant_id() OR platform_mode())',
      t
    );
  END LOOP;
END $$;

-- Таблицы платформы (Tenant, PlatformUser, PlatformAuditLog, Impersonation, Session)
-- под RLS не попадают: к ним ходит только платформенный слой приложения под отдельной ролью.
