#!/usr/bin/env bash
# Новая миграция под изменившуюся схему, без потери данных.
#   bash deploy/db-new-migration.sh applications
#
# Отличие от db-init-migrations.sh: тот создаёт первые миграции на пустой базе,
# а этот сравнивает СХЕМУ С ЖИВОЙ БАЗОЙ и добавляет только разницу.
set -euo pipefail
cd "$(dirname "$0")/.."

NAME="${1:-}"
[ -n "$NAME" ] || { echo "Укажите имя миграции: bash deploy/db-new-migration.sh add_something"; exit 1; }
case "$NAME" in *[!a-z0-9_]*) echo "Имя миграции: строчные латинские буквы, цифры и подчёркивание"; exit 1;; esac

ENV_FILE="deploy/.env"
[ -f "$ENV_FILE" ] || { echo "Нет $ENV_FILE"; exit 1; }
set -a; . "$ENV_FILE"; set +a

docker compose --env-file "$ENV_FILE" up -d postgres >/dev/null
echo -n ">>> Жду базу"
for _ in $(seq 1 40); do
  docker compose --env-file "$ENV_FILE" exec -T postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1 \
    && { echo " — готова"; break; }
  echo -n "."; sleep 2
done

PG_ID="$(docker compose --env-file "$ENV_FILE" ps -q postgres)"
NET="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}' "$PG_ID")"
[ -n "$NET" ] || { echo "Не удалось определить сеть compose"; exit 1; }

STAMP="$(date -u +%Y%m%d%H%M%S)"

docker run --rm --network "$NET" \
  -v "$(pwd)/backend:/app" -w /app \
  -e DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}?schema=public" \
  -e STAMP="$STAMP" -e NAME="$NAME" \
  node:20-alpine sh -c '
    set -e
    echo ""
    echo ">>> [1/3] Проверяю зависимости"
    [ -d node_modules ] || npm install --no-audit --no-fund

    echo ">>> [2/3] Сравниваю схему с базой"
    DIR="prisma/migrations/${STAMP}_${NAME}"
    mkdir -p "$DIR"
    npx prisma migrate diff \
      --from-url "$DATABASE_URL" \
      --to-schema-datamodel prisma/schema.prisma \
      --script > "$DIR/migration.sql"

    if [ ! -s "$DIR/migration.sql" ] || ! grep -qv "^--" "$DIR/migration.sql"; then
      echo "    Различий нет — миграция не нужна."
      rm -rf "$DIR"
      exit 0
    fi
    echo "    строк SQL: $(wc -l < "$DIR/migration.sql")"
    echo "    ---"
    head -30 "$DIR/migration.sql" | sed "s/^/    /"
    echo "    ---"

    echo ">>> [3/3] Применяю"
    npx prisma migrate deploy
  '

echo
echo ">>> Готово. Не забудьте закоммитить backend/prisma/migrations."
