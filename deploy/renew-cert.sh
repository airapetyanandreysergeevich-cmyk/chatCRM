#!/usr/bin/env bash
# Продление сертификата. Вызывается из cron, вручную запускать не нужно.
# Токен берётся из deploy/.env, чтобы не лежать открытым в crontab.
set -euo pipefail
cd "$(dirname "$0")/.."
PROJECT_DIR="$(pwd)"

set -a; . deploy/.env; set +a
[ -n "${DOMAIN:-}" ] || { echo "DOMAIN не задан"; exit 1; }

echo "=== $(date -Is) продление для $DOMAIN ==="

docker run --rm \
  -v "$PROJECT_DIR/deploy/acme:/acme.sh" \
  -e TW_Token="${TIMEWEB_API_TOKEN:-}" \
  neilpang/acme.sh --cron

# install-cert повторяем всегда: если продления не было, файлы просто перезапишутся теми же.
docker run --rm \
  -v "$PROJECT_DIR/deploy/acme:/acme.sh" \
  -v "$PROJECT_DIR/deploy/certbot/conf:/certs" \
  neilpang/acme.sh --install-cert -d "$DOMAIN" \
  --key-file "/certs/live/$DOMAIN/privkey.pem" \
  --fullchain-file "/certs/live/$DOMAIN/fullchain.pem"

docker compose --env-file deploy/.env exec -T nginx nginx -s reload
echo "=== готово ==="
