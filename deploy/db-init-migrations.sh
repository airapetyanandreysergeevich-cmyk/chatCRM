#!/usr/bin/env bash
# Создаёт первые миграции Prisma: таблицы + политики RLS.
# Запускается один раз; результат надо закоммитить в репозиторий.
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE="deploy/.env"
[ -f "$ENV_FILE" ] || { echo "Нет $ENV_FILE — сначала запустите deploy/install.sh"; exit 1; }
set -a; . "$ENV_FILE"; set +a

if [ -d backend/prisma/migrations ] && [ -n "$(ls -A backend/prisma/migrations 2>/dev/null)" ]; then
  echo ">>> Миграции уже созданы, ничего не делаю."
  exit 0
fi

echo ">>> Поднимаю базу"
docker compose --env-file "$ENV_FILE" up -d postgres

echo -n ">>> Жду готовности базы"
for _ in $(seq 1 40); do
  if docker compose --env-file "$ENV_FILE" exec -T postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
    echo " — готова"; break
  fi
  echo -n "."; sleep 2
done

PG_ID="$(docker compose --env-file "$ENV_FILE" ps -q postgres)"
NET="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}' "$PG_ID")"
[ -n "$NET" ] || { echo "Не удалось определить сеть compose"; exit 1; }

# Миграции создаются под владельцем схемы — роль приложения на это прав не имеет и не должна.
echo ">>> Создаю миграции"
docker run --rm --network "$NET" \
  -v "$(pwd)/backend:/app" -w /app \
  -e DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}?schema=public" \
  node:20-alpine sh -c '
    set -e
    # openssl в node:20-alpine уже есть; если apk недоступен — не беда, просто идём дальше
    apk add --no-cache openssl >/dev/null 2>&1 || echo "apk недоступен, продолжаю с системным openssl"
    npm install --no-audit --no-fund
    npx prisma migrate dev --name init --skip-seed
    npx prisma migrate dev --create-only --name rls --skip-seed
    RLS_DIR="$(ls -d prisma/migrations/*_rls)"
    cat prisma/rls.sql >> "$RLS_DIR/migration.sql"
    npx prisma migrate deploy
  '

echo
echo ">>> Готово. Миграции лежат в backend/prisma/migrations — закоммитьте их:"
echo "    git add backend/prisma/migrations && git commit -m 'Первые миграции: таблицы и RLS' && git push"
