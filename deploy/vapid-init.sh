#!/usr/bin/env bash
#
# Ключи для оповещений (VAPID). Запускается один раз при установке.
#
#   bash deploy/vapid-init.sh
#
# Ключи попадают в deploy/.env и больше не меняются: смена ключей отвязывает
# все подписки разом — у всех сотрудников оповещения молча перестанут приходить,
# и каждому придётся включать их заново.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/deploy/.env"

[ -f "$ENV_FILE" ] || { echo "Не найден $ENV_FILE" >&2; exit 1; }

if grep -qE '^VAPID_PRIVATE_KEY=.+' "$ENV_FILE"; then
  echo "Ключи уже заданы в deploy/.env — ничего не меняю."
  echo "Если их всё-таки надо сменить: удалите строки VAPID_* и запустите снова."
  exit 0
fi

echo "Генерируем пару ключей…"

# Пара P-256 в формате, которого ждёт Web Push: публичный — несжатая точка
# кривой в base64url, приватный — то же самое поле d из JWK.
KEYS="$(docker run --rm node:20-alpine node -e '
const { generateKeyPairSync } = require("node:crypto");
const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwk = privateKey.export({ format: "jwk" });
const pub = Buffer.concat([
  Buffer.from([4]),
  Buffer.from(jwk.x, "base64url"),
  Buffer.from(jwk.y, "base64url"),
]).toString("base64url");
process.stdout.write(pub + " " + jwk.d);
')"

PUB="${KEYS%% *}"
PRIV="${KEYS##* }"

[ ${#PUB} -eq 87 ] || { echo "Публичный ключ вышел неправильной длины (${#PUB}, ожидалось 87)" >&2; exit 1; }
[ ${#PRIV} -eq 43 ] || { echo "Приватный ключ вышел неправильной длины (${#PRIV}, ожидалось 43)" >&2; exit 1; }

DOMAIN="$(grep -E '^DOMAIN=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"'"'"' \r')"
DOMAIN="${DOMAIN:-www.finecrm.ru}"
SUBJECT="$(grep -E '^PLATFORM_OWNER_EMAIL=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"'"'"' \r')"

{
  printf '\n# Оповещения (Web Push). Менять нельзя: подписки привязаны к этой паре.\n'
  printf 'VAPID_PUBLIC_KEY=%s\n' "$PUB"
  printf 'VAPID_PRIVATE_KEY=%s\n' "$PRIV"
  printf 'VAPID_SUBJECT=mailto:%s\n' "${SUBJECT:-admin@$DOMAIN}"
  printf 'PUBLIC_URL=https://%s\n' "$DOMAIN"
} >> "$ENV_FILE"

chmod 600 "$ENV_FILE"

echo "Готово. Ключи записаны в deploy/.env."
echo
echo "Осталось перезапустить бэкенд, чтобы он их прочитал:"
echo "  docker compose --env-file deploy/.env up -d backend"
