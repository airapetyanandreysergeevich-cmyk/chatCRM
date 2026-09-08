#!/usr/bin/env bash
# Замена секретов, если они куда-то утекли: попали в переписку, в скриншот, в чужие руки.
#
#   bash deploy/rotate-secrets.sh          # всё сразу
#   bash deploy/rotate-secrets.sh jwt      # только ключи подписи токенов
#
# Ключи JWT — самое срочное из всего: зная их, можно подписать себе токен любого
# пользователя и обратиться к API через интернет, не имея никакого доступа к серверу.
# Пароли Postgres и MinIO наружу не опубликованы, но менять их тоже стоит.
set -euo pipefail
cd "$(dirname "$0")/.."

WHAT="${1:-all}"
ENV_FILE="deploy/.env"
[ -f "$ENV_FILE" ] || { echo "Нет $ENV_FILE"; exit 1; }

gen() { openssl rand -base64 36 | tr -d '\n=+/' | cut -c1-40; }
set_var() {
  local escaped
  escaped=$(printf '%s' "$2" | sed -e 's/[\\&|]/\\&/g')
  sed -i "s|^$1=.*|$1=$escaped|" "$ENV_FILE"
}

cp "$ENV_FILE" "$ENV_FILE.bak.$(date +%Y%m%d%H%M%S)"
echo ">>> Копия старого .env сохранена рядом"

set -a; . "$ENV_FILE"; set +a
DB_USER="$POSTGRES_USER"; DB_NAME="$POSTGRES_DB"

psql_run() { docker compose --env-file "$ENV_FILE" exec -T postgres psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" "$@"; }

if [ "$WHAT" = "all" ] || [ "$WHAT" = "jwt" ]; then
  echo ">>> Меняю ключи подписи токенов"
  set_var JWT_ACCESS_SECRET "$(gen)"
  set_var JWT_REFRESH_SECRET "$(gen)"

  # Refresh-токены — случайные строки, а не JWT: смена ключа сама по себе их не отменяет.
  # Гасим все сессии, иначе украденная кука продолжила бы выдавать новые токены.
  echo ">>> Гашу все активные сессии"
  psql_run -c 'UPDATE "Session" SET "revokedAt" = now() WHERE "revokedAt" IS NULL;' >/dev/null
  echo "    все войдут заново — это и есть смысл замены"
fi

if [ "$WHAT" = "all" ] || [ "$WHAT" = "db" ]; then
  echo ">>> Меняю пароли ролей в базе"
  NEW_APP_PASS="$(gen)"; NEW_OWNER_PASS="$(gen)"
  # Пароль роли хранится в самой базе, поэтому меняем сначала там, потом в .env.
  psql_run -c "ALTER ROLE \"$APP_DB_USER\" WITH PASSWORD '$NEW_APP_PASS';" >/dev/null
  psql_run -c "ALTER ROLE \"$DB_USER\" WITH PASSWORD '$NEW_OWNER_PASS';" >/dev/null
  set_var APP_DB_PASSWORD "$NEW_APP_PASS"
  set_var POSTGRES_PASSWORD "$NEW_OWNER_PASS"
fi

if [ "$WHAT" = "all" ] || [ "$WHAT" = "minio" ]; then
  echo ">>> Меняю пароль MinIO"
  # Учётка root у MinIO задаётся переменными окружения, а не хранится в данных,
  # поэтому достаточно поменять значение и пересоздать контейнер.
  set_var MINIO_ROOT_PASSWORD "$(gen)"
fi

echo ">>> Перезапускаю с новыми значениями"
docker compose --env-file "$ENV_FILE" up -d --force-recreate backend minio

echo
echo ">>> Готово. Проверка:"
echo "    curl -s http://localhost/api/health"
echo "    docker compose --env-file deploy/.env logs backend | tail -20"
echo
echo "Старые значения остались в резервной копии .env рядом — удалите её, когда убедитесь, что всё работает."
