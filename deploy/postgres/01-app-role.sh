#!/bin/bash
# Выполняется один раз при создании базы.
#
# Зачем отдельная роль. Пользователь из POSTGRES_USER — суперпользователь,
# а суперпользователь игнорирует Row-Level Security всегда, даже при FORCE.
# То есть если приложение ходит в базу под ним, вся изоляция мастерских не работает.
# Поэтому приложение подключается под обычной ролью: не суперпользователь и не владелец таблиц.
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-SQL
  DO \$\$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_DB_USER}') THEN
      CREATE ROLE ${APP_DB_USER} LOGIN PASSWORD '${APP_DB_PASSWORD}' NOBYPASSRLS;
    END IF;
  END
  \$\$;

  GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO ${APP_DB_USER};
  GRANT USAGE ON SCHEMA public TO ${APP_DB_USER};

  -- Таблицы создаст миграция уже после этого скрипта, поэтому раздаём права «на будущее».
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${APP_DB_USER};
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO ${APP_DB_USER};
SQL

echo "Роль приложения ${APP_DB_USER} создана"
