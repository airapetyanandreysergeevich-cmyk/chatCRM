#!/usr/bin/env bash
# Применяет backend/prisma/rls.sql к живой базе.
#
# Нужен после появления новой таблицы с tenantId: миграция Prisma создаёт
# саму таблицу, но про Row-Level Security ничего не знает и политику не
# ставит. Без политики остаётся только один рубеж изоляции — прокси в
# приложении, а он защищает лишь до первой забытой строчки кода.
#
# Файл идемпотентен: CREATE OR REPLACE и DROP POLICY IF EXISTS внутри,
# поэтому запускать можно сколько угодно раз.
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE="deploy/.env"
[ -f "$ENV_FILE" ] || { echo "Нет $ENV_FILE"; exit 1; }
set -a; . "$ENV_FILE"; set +a

echo ">>> Применяю backend/prisma/rls.sql"
docker compose --env-file "$ENV_FILE" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" < backend/prisma/rls.sql

echo
echo ">>> Таблицы с политикой tenant_isolation:"
docker compose --env-file "$ENV_FILE" exec -T postgres \
  psql -tA -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "SELECT tablename FROM pg_policies WHERE policyname = 'tenant_isolation' ORDER BY tablename" \
  | tr '\n' ' '
echo
echo
echo ">>> Готово."
