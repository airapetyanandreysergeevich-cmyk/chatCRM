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
  set_var() { sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"; }

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

  read -rp "Email собственника платформы: " OWNER_EMAIL
  read -rsp "Пароль собственника платформы: " OWNER_PASS; echo
  set_var PLATFORM_OWNER_EMAIL "$OWNER_EMAIL"
  set_var PLATFORM_OWNER_PASSWORD "$OWNER_PASS"
  chmod 600 "$ENV_FILE"
fi

echo ">>> Собираю и поднимаю контейнеры..."
docker compose --env-file "$ENV_FILE" up -d --build

echo ">>> Готово. Дальше: bash deploy/setup-https.sh ваш-домен.ру"
