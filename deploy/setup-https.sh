#!/usr/bin/env bash
# Выпуск сертификата Let's Encrypt и переключение nginx на HTTPS.
# Использование: bash deploy/setup-https.sh crm.example.ru [www.crm.example.ru ...]
set -euo pipefail
cd "$(dirname "$0")/.."

DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then echo "Укажите домен: bash deploy/setup-https.sh crm.example.ru"; exit 1; fi
shift || true
ALIASES="$*"

ENV_FILE="deploy/.env"
sed -i "s|^DOMAIN=.*|DOMAIN=$DOMAIN|" "$ENV_FILE"
sed -i "s|^DOMAIN_ALIASES=.*|DOMAIN_ALIASES=$ALIASES|" "$ENV_FILE"
sed -i "s|^HTTPS_ENABLED=.*|HTTPS_ENABLED=0|" "$ENV_FILE"

mkdir -p deploy/certbot/conf deploy/certbot/www

echo ">>> Поднимаю nginx по HTTP, чтобы пройти проверку домена"
docker compose --env-file "$ENV_FILE" up -d nginx
sleep 3

DOMAIN_ARGS="-d $DOMAIN"
for a in $ALIASES; do DOMAIN_ARGS="$DOMAIN_ARGS -d $a"; done

echo ">>> Запрашиваю сертификат"
docker run --rm \
  -v "$(pwd)/deploy/certbot/conf:/etc/letsencrypt" \
  -v "$(pwd)/deploy/certbot/www:/var/www/certbot" \
  certbot/certbot certonly --webroot -w /var/www/certbot \
  $DOMAIN_ARGS --agree-tos --register-unsafely-without-email --non-interactive

echo ">>> Переключаю nginx на HTTPS"
sed -i "s|^HTTPS_ENABLED=.*|HTTPS_ENABLED=1|" "$ENV_FILE"
docker compose --env-file "$ENV_FILE" up -d --force-recreate nginx

echo ">>> Готово: https://$DOMAIN"
echo ">>> Продление добавьте в cron:"
echo "0 3 * * * cd $(pwd) && docker run --rm -v \$(pwd)/deploy/certbot/conf:/etc/letsencrypt -v \$(pwd)/deploy/certbot/www:/var/www/certbot certbot/certbot renew --quiet && docker compose --env-file deploy/.env exec nginx nginx -s reload"
