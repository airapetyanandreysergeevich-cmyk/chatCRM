#!/usr/bin/env bash
# Проверка типов без полной сборки образов: секунды вместо минут.
# Использует node_modules и сгенерированный клиент Prisma, оставшиеся после db-init-migrations.sh.
set -euo pipefail
cd "$(dirname "$0")/.."

echo ">>> Бэкенд"
docker run --rm -v "$(pwd)/backend:/app" -w /app node:20-alpine sh -c '
  set -e
  [ -d node_modules ] || npm install --no-audit --no-fund
  npx prisma generate >/dev/null
  npx tsc -p tsconfig.json --noEmit
' && echo "    типы сходятся"

echo ">>> Фронтенд"
docker run --rm -v "$(pwd)/frontend:/app" -w /app node:20-alpine sh -c '
  set -e
  [ -d node_modules ] || npm install --no-audit --no-fund
  npx tsc --noEmit
' && echo "    типы сходятся"

echo
echo ">>> Всё сходится, можно собирать: bash deploy/install.sh"
