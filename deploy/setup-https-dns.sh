#!/usr/bin/env bash
# Выпуск сертификата через DNS-проверку (DNS-01).
#
# Зачем не обычный setup-https.sh: HTTP-проверка требует, чтобы серверы Let's Encrypt
# из Европы и США достучались до вашего сервера по порту 80. Если входящий трафик
# из-за рубежа не проходит, эта проверка не пройдёт никогда, сколько ни повторяй.
# DNS-проверка входящих соединений не требует вовсе: владение доменом доказывается
# TXT-записью, которую ставит и убирает сам скрипт через API DNS-провайдера.
#
#   bash deploy/setup-https-dns.sh www.finecrm.ru
set -euo pipefail
cd "$(dirname "$0")/.."
PROJECT_DIR="$(pwd)"

DOMAIN="${1:-}"
[ -n "$DOMAIN" ] || { echo "Использование: bash deploy/setup-https-dns.sh www.example.ru [ещё.example.ru ...]"; exit 1; }
shift || true
ALIASES="$*"

ENV_FILE="deploy/.env"
[ -f "$ENV_FILE" ] || { echo "Нет $ENV_FILE"; exit 1; }
set -a; . "$ENV_FILE"; set +a

if [ -z "${TIMEWEB_API_TOKEN:-}" ]; then
  cat <<'TXT'
Не задан TIMEWEB_API_TOKEN.

  1. Панель Timeweb Cloud → API и токены → создать токен с доступом к DNS.
  2. Дописать в deploy/.env строку:
       TIMEWEB_API_TOKEN=ваш_токен
  3. Повторить запуск.

Токен нужен только для того, чтобы скрипт сам ставил и убирал TXT-запись
при выпуске и каждом продлении. В git он не попадает — deploy/.env в .gitignore.
TXT
  exit 1
fi

mkdir -p deploy/acme "deploy/certbot/conf/live/$DOMAIN"

DOMAIN_ARGS="-d $DOMAIN"
for a in $ALIASES; do DOMAIN_ARGS="$DOMAIN_ARGS -d $a"; done

echo ">>> Выпускаю сертификат через DNS-проверку"
echo "    Первый раз занимает пару минут: нужно дождаться, пока TXT-запись разойдётся по DNS."
# --server letsencrypt: по умолчанию acme.sh идёт в ZeroSSL, а тот требует регистрации по почте.
docker run --rm \
  -v "$PROJECT_DIR/deploy/acme:/acme.sh" \
  -e TW_Token="$TIMEWEB_API_TOKEN" \
  neilpang/acme.sh --issue --dns dns_timeweb $DOMAIN_ARGS --server letsencrypt

echo ">>> Раскладываю сертификат туда, где его ждёт nginx"
docker run --rm \
  -v "$PROJECT_DIR/deploy/acme:/acme.sh" \
  -v "$PROJECT_DIR/deploy/certbot/conf:/certs" \
  neilpang/acme.sh --install-cert -d "$DOMAIN" \
  --key-file "/certs/live/$DOMAIN/privkey.pem" \
  --fullchain-file "/certs/live/$DOMAIN/fullchain.pem"

echo ">>> Переключаю nginx на HTTPS"
sed -i "s|^DOMAIN=.*|DOMAIN=$DOMAIN|" "$ENV_FILE"
sed -i "s|^DOMAIN_ALIASES=.*|DOMAIN_ALIASES=$ALIASES|" "$ENV_FILE"
sed -i "s|^HTTPS_ENABLED=.*|HTTPS_ENABLED=1|" "$ENV_FILE"
docker compose --env-file "$ENV_FILE" up -d --force-recreate nginx

echo ">>> Настраиваю автопродление"
CRON_LINE="0 3 * * * cd $PROJECT_DIR && bash deploy/renew-cert.sh >> /var/log/repairshop-cert.log 2>&1"
if crontab -l 2>/dev/null | grep -q 'deploy/renew-cert.sh'; then
  echo "    задание уже было, оставляю как есть"
else
  { crontab -l 2>/dev/null; echo "$CRON_LINE"; } | crontab -
  echo "    добавлено в cron, проверка каждую ночь в 3:00"
fi

echo
echo ">>> Готово: https://$DOMAIN"
echo "    Проверка: curl -sI https://$DOMAIN/ | head -3"
