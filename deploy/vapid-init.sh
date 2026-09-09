#!/usr/bin/env bash
#
# Ключи для оповещений (VAPID). Запускается один раз при установке,
# но безопасен для повторного запуска: приводит deploy/.env в порядок.
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

read_env() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2-; }

# Записываем переменную ровно один раз: сначала убираем все прежние строки
# с этим именем, потом дописываем одну. Раньше строки просто дописывались, и
# при повторном запуске в файле оказывалось два VAPID_SUBJECT — какой из них
# в итоге читается, зависит от того, кто разбирает файл. Такие вещи потом
# ищутся часами.
set_env() {
  local key="$1" value="$2"
  grep -v "^${key}=" "$ENV_FILE" > "$ENV_FILE.tmp" || true
  mv "$ENV_FILE.tmp" "$ENV_FILE"
  printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  chmod 600 "$ENV_FILE"
}

count_of() { grep -cE "^$1=" "$ENV_FILE" || true; }

# ------------------------------------------------------------------ уборка
DUPES=0
for key in VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY VAPID_SUBJECT PUBLIC_URL; do
  n="$(count_of "$key")"
  if [ "$n" -gt 1 ]; then
    echo "Нашёл $n строк $key — оставляю последнюю (её же берёт docker compose)."
    set_env "$key" "$(read_env "$key")"
    DUPES=1
  fi
done
[ "$DUPES" = 0 ] || echo

# ------------------------------------------------------------------ ключи
DOMAIN="$(read_env DOMAIN | tr -d '"'"'"' \r')"
DOMAIN="${DOMAIN:-www.finecrm.ru}"

if [ -n "$(read_env VAPID_PRIVATE_KEY)" ]; then
  echo "Ключи уже заданы — не трогаю их."
  echo "Сменить ключи = отвязать все подписки разом, поэтому только вручную:"
  echo "удалите строки VAPID_PUBLIC_KEY и VAPID_PRIVATE_KEY и запустите снова."
else
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
  [ ${#PUB} -eq 87 ] || { echo "Публичный ключ неправильной длины (${#PUB}, ждали 87)" >&2; exit 1; }
  [ ${#PRIV} -eq 43 ] || { echo "Приватный ключ неправильной длины (${#PRIV}, ждали 43)" >&2; exit 1; }

  set_env VAPID_PUBLIC_KEY "$PUB"
  set_env VAPID_PRIVATE_KEY "$PRIV"
  echo "Ключи записаны."
fi

# ------------------------------------------------------------------ подпись
# Адрес в подписи сервис push не проверяет на существование, но требует
# правильной формы. Мусор здесь означает, что каждое оповещение будет
# отвергнуто — молча, потому что библиотека такую строку пропускает.
SUBJECT="$(read_env VAPID_SUBJECT)"
if ! printf %s "$SUBJECT" | grep -qE '^(mailto:[^[:space:]@]+@[^[:space:]@.]+\.[^[:space:]@]+|https://[^[:space:]]+)$'; then
  OWNER="$(read_env PLATFORM_OWNER_EMAIL | tr -d '"'"'"' \r' | tr -cd 'A-Za-z0-9@._+-')"
  if printf %s "$OWNER" | grep -qE '^[^@]+@[^@.]+\.[^@]+$'; then
    NEW="mailto:$OWNER"
  else
    NEW="mailto:admin@${DOMAIN#www.}"
  fi
  echo "VAPID_SUBJECT был непригоден (${SUBJECT:-пусто}) — ставлю $NEW"
  set_env VAPID_SUBJECT "$NEW"
fi

set_env PUBLIC_URL "https://$DOMAIN"

echo
echo "Итог:"
printf '  %-20s %s\n' "VAPID_SUBJECT" "$(read_env VAPID_SUBJECT)"
printf '  %-20s %s…\n' "VAPID_PUBLIC_KEY" "$(read_env VAPID_PUBLIC_KEY | cut -c1-12)"
printf '  %-20s %s\n' "VAPID_PRIVATE_KEY" "задан, не показываю"
echo
echo "Перезапустить бэкенд, чтобы он их прочитал:"
echo "  docker compose --env-file deploy/.env up -d backend"
