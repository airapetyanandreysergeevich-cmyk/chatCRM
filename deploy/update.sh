#!/usr/bin/env bash
# Обновление на сервере: забрать изменения и пересобрать.
set -euo pipefail
cd "$(dirname "$0")/.."

echo ">>> git pull"
git pull --ff-only

echo ">>> Пересборка контейнеров"
docker compose --env-file deploy/.env up -d --build

echo ">>> Применяю миграции БД"
docker compose --env-file deploy/.env exec -T backend npx prisma migrate deploy

echo ">>> Готово. Текущая версия:"
git log -1 --oneline
