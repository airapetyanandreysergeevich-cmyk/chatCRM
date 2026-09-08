#!/usr/bin/env bash
# Смена пароля учётной записи: bash deploy/set-password.sh user@example.com
# Пароль вводится скрыто и передаётся через стандартный ввод — в историю команд не попадает.
set -euo pipefail
cd "$(dirname "$0")/.."

EMAIL="${1:-}"
[ -n "$EMAIL" ] || { echo "Использование: bash deploy/set-password.sh user@example.com"; exit 1; }

read -rsp "Новый пароль для $EMAIL: " PASS; echo
[ -n "$PASS" ] || { echo "Пароль пустой"; exit 1; }

printf '%s' "$PASS" | docker compose --env-file deploy/.env exec -T backend node dist/cli/set-password.js "$EMAIL"
