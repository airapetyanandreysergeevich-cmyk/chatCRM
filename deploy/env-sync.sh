#!/usr/bin/env bash
# Добавляет в deploy/.env переменные, которые появились в .env.example,
# не трогая уже заполненные значения.
#
# Зачем: .env создаётся один раз при установке и дальше живёт своей жизнью,
# а новые настройки приезжают с обновлениями. Без этого о новой переменной
# узнаёшь только когда что-то не работает.
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE="deploy/.env"
EXAMPLE="deploy/.env.example"
[ -f "$ENV_FILE" ] || { echo "Нет $ENV_FILE — сначала deploy/install.sh"; exit 1; }
[ -f "$EXAMPLE" ] || { echo "Нет $EXAMPLE"; exit 1; }

added=0
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    ''|\#*) continue ;;
    *=*) key="${line%%=*}" ;;
    *) continue ;;
  esac
  if ! grep -q "^${key}=" "$ENV_FILE"; then
    printf '%s\n' "$line" >> "$ENV_FILE"
    echo "  + $key"
    added=$((added + 1))
  fi
done < "$EXAMPLE"

if [ "$added" -gt 0 ]; then
  echo ">>> Добавлено переменных: $added. Значения пустые — заполните нужные:"
  echo "    nano $ENV_FILE"
else
  echo ">>> Новых переменных нет, всё на месте."
fi
