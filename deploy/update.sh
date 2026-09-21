#!/usr/bin/env bash
# Обновление на сервере: забрать изменения и пересобрать.
set -euo pipefail
cd "$(dirname "$0")/.."

echo ">>> git pull"
git pull --ff-only

echo ">>> Пересборка контейнеров"
docker compose --env-file deploy/.env up -d --build

echo ">>> Применяю миграции БД"
# Под владельцем базы (MIGRATE_DATABASE_URL), а не под ролью приложения:
# у роли приложения нет права создавать таблицы, и миграция с CREATE TABLE
# падает с «permission denied for schema public». Контейнер при старте и так
# делает то же самое — здесь это повторная проверка, что всё применилось.
docker compose --env-file deploy/.env exec -T backend \
  sh -c 'DATABASE_URL="${MIGRATE_DATABASE_URL:-$DATABASE_URL}" npx prisma migrate deploy'

echo ">>> Готово. Текущая версия:"
git log -1 --oneline
