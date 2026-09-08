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

STAMP="$(date -u +%Y%m%d%H%M%S)"

# Миграции накатываются под владельцем схемы — у роли приложения таких прав нет и быть не должно.
docker run --rm --network "$NET" \
  -v "$(pwd)/backend:/app" -w /app \
  -e DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}?schema=public" \
  -e STAMP="$STAMP" \
  node:20-alpine sh -c '
    set -e
    echo ""
    echo ">>> [1/4] Устанавливаю зависимости"
    echo "    npm ничего не печатает, пока не закончит — это нормально."
    echo "    Пакетов около трёхсот (тянет @aws-sdk), первый раз занимает 2-5 минут."
    npm install --no-audit --no-fund

    echo ""
    echo ">>> [2/4] Генерирую SQL для таблиц"
    # migrate diff вместо migrate dev: не задаёт вопросов и не требует TTY,
    # поэтому одинаково работает и в скрипте, и в CI.
    mkdir -p "prisma/migrations/${STAMP}_init"
    npx prisma migrate diff \
      --from-empty \
      --to-schema-datamodel prisma/schema.prisma \
      --script > "prisma/migrations/${STAMP}_init/migration.sql"
    echo "    строк SQL: $(wc -l < "prisma/migrations/${STAMP}_init/migration.sql")"

    echo ""
    echo ">>> [3/4] Добавляю миграцию с политиками RLS"
    RLS_STAMP="$(date -u +%Y%m%d%H%M%S)"
    mkdir -p "prisma/migrations/${RLS_STAMP}_rls"
    cp prisma/rls.sql "prisma/migrations/${RLS_STAMP}_rls/migration.sql"

    echo ""
    echo ">>> [4/4] Применяю миграции к базе"
    npx prisma migrate deploy
  '

echo
echo ">>> Готово. Миграции лежат в backend/prisma/migrations — закоммитьте их:"
echo "    git add backend/prisma/migrations && git commit -m 'Первые миграции: таблицы и RLS' && git push"
