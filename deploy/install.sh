#!/usr/bin/env bash
# Первичная установка на чистый VPS. Запускать из корня проекта: bash deploy/install.sh
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE="deploy/.env"
if [ -f "$ENV_FILE" ]; then
  echo ">>> $ENV_FILE уже существует — секреты не трогаю."
else
  echo ">>> Создаю $ENV_FILE и генерирую секреты..."
  cp deploy/.env.example "$ENV_FILE"
  gen() { openssl rand -base64 36 | tr -d '\n=+/' | cut -c1-40; }
  # В строке замены sed символы & | \ имеют особый смысл: & означает «подставь найденное».
  # Без экранирования пароль с такими символами записывался бы искажённым,
  # и войти с ним было бы уже нельзя.
  set_var() {
    local escaped
    escaped=$(printf '%s' "$2" | sed -e 's/[\\&|]/\\&/g')
    sed -i "s|^$1=.*|$1=$escaped|" "$ENV_FILE"
  }

  set_var POSTGRES_PASSWORD "$(gen)"
  set_var APP_DB_PASSWORD "$(gen)"
  set_var JWT_ACCESS_SECRET "$(gen)"
  set_var JWT_REFRESH_SECRET "$(gen)"
  set_var MINIO_ROOT_PASSWORD "$(gen)"

  if command -v npx >/dev/null 2>&1; then
    VAPID_OUT="$(npx --yes web-push generate-vapid-keys --json 2>/dev/null || true)"
    if [ -n "$VAPID_OUT" ]; then
      set_var VAPID_PUBLIC_KEY "$(echo "$VAPID_OUT" | sed -n 's/.*"publicKey":"\([^"]*\)".*/\1/p')"
      set_var VAPID_PRIVATE_KEY "$(echo "$VAPID_OUT" | sed -n 's/.*"privateKey":"\([^"]*\)".*/\1/p')"
    fi
  fi

  # При вставке блока команд терминал добавляет служебные символы, и read забирает их
  # вместе с текстом. Незаметно получается адрес вида ESC[201~mail@example.com,
  # с которым потом невозможно войти. Чистим управляющие символы и проверяем формат.
  strip_control() { printf '%s' "$1" | tr -d '\000-\037\177'; }

  while :; do
    read -rp "Email собственника платформы: " OWNER_EMAIL
    OWNER_EMAIL=$(strip_control "$OWNER_EMAIL" | tr -d '[:space:]')
    case "$OWNER_EMAIL" in
      ?*@?*.?*) break ;;
      *) echo "    Не похоже на email — введите ещё раз." ;;
    esac
  done

  while :; do
    read -rsp "Пароль собственника платформы (от 8 символов): " OWNER_PASS; echo
    OWNER_PASS=$(strip_control "$OWNER_PASS")
    [ ${#OWNER_PASS} -ge 8 ] && break
    echo "    Слишком короткий — введите ещё раз."
  done
  set_var PLATFORM_OWNER_EMAIL "$OWNER_EMAIL"
  set_var PLATFORM_OWNER_PASSWORD "$OWNER_PASS"
  chmod 600 "$ENV_FILE"
fi

if [ ! -d backend/prisma/migrations ] || [ -z "$(ls -A backend/prisma/migrations 2>/dev/null)" ]; then
  echo ">>> Миграций ещё нет — создаю"
  bash deploy/db-init-migrations.sh
fi

echo ">>> Собираю и поднимаю контейнеры..."
docker compose --env-file "$ENV_FILE" up -d --build

echo
echo ">>> Готово."
echo "    Проверка:  curl -s http://localhost/api/health"
echo "    HTTPS:     bash deploy/setup-https.sh ваш-домен.ру"
echo "    Логи:      docker compose --env-file deploy/.env logs -f backend"
