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

# Let's Encrypt ограничивает число неудачных проверок, поэтому сначала убеждаемся,
# что файлы проверки вообще отдаются. Иначе можно исчерпать лимит на пустом месте.
echo ">>> Самопроверка: отдаются ли файлы .well-known"
TOKEN="selftest-$(date +%s)"
mkdir -p deploy/certbot/www/.well-known/acme-challenge
printf '%s' "$TOKEN" > "deploy/certbot/www/.well-known/acme-challenge/$TOKEN"
sleep 1

LOCAL="$(curl -s --max-time 10 -H "Host: $DOMAIN" "http://localhost/.well-known/acme-challenge/$TOKEN" || true)"
if [ "$LOCAL" != "$TOKEN" ]; then
  rm -f "deploy/certbot/www/.well-known/acme-challenge/$TOKEN"
  echo
  echo "    Файл не отдаётся даже локально — до certbot дело не дойдёт."
  echo "    Смотрите, поднялся ли nginx и что у него в логах:"
  echo "      docker compose --env-file deploy/.env ps nginx"
  echo "      docker compose --env-file deploy/.env logs nginx | tail -20"
  exit 1
fi
echo "    локально — отдаётся"

PUBLIC="$(curl -s --max-time 15 "http://$DOMAIN/.well-known/acme-challenge/$TOKEN" || true)"
rm -f "deploy/certbot/www/.well-known/acme-challenge/$TOKEN"
if [ "$PUBLIC" = "$TOKEN" ]; then
  echo "    снаружи — отдаётся"
else
  # Некоторые провайдеры не дают серверу достучаться до собственного внешнего адреса,
  # поэтому это не повод останавливаться — только предупреждение.
  echo "    снаружи — не проверилось. Это бывает и при рабочей настройке."
  echo "    Если certbot не пройдёт, проверьте DNS: getent ahosts $DOMAIN"
  sleep 3
fi

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

# Сертификат живёт 90 дней. Продление ставим сразу: забытый cron — это упавший
# через три месяца сайт, причём в самый неудобный момент.
echo ">>> Настраиваю автопродление"
PROJECT_DIR="$(pwd)"
CRON_LINE="0 3 * * * cd $PROJECT_DIR && docker run --rm -v $PROJECT_DIR/deploy/certbot/conf:/etc/letsencrypt -v $PROJECT_DIR/deploy/certbot/www:/var/www/certbot certbot/certbot renew --quiet && docker compose --env-file deploy/.env exec -T nginx nginx -s reload"
if crontab -l 2>/dev/null | grep -q 'certbot/certbot renew'; then
  echo "    задание уже было, оставляю как есть"
else
  { crontab -l 2>/dev/null; echo "$CRON_LINE"; } | crontab -
  echo "    добавлено в cron, проверка каждую ночь в 3:00"
fi

echo
echo ">>> Готово: https://$DOMAIN"
echo "    Проверка: curl -sI https://$DOMAIN/ | head -3"
