#!/bin/sh
# Собирает конфиг nginx из шаблона в зависимости от того, включён ли HTTPS.
set -e
SRC=/etc/nginx/templates-src
DST=/etc/nginx/conf.d

if [ "${HTTPS_ENABLED:-0}" = "1" ] && [ -n "${DOMAIN:-}" ]; then
  TEMPLATE="$SRC/default.conf.https.template"
else
  TEMPLATE="$SRC/default.conf.http.template"
fi

export SERVER_NAMES="${DOMAIN:-_} ${DOMAIN_ALIASES:-}"
envsubst '${DOMAIN} ${SERVER_NAMES}' < "$TEMPLATE" > "$DST/default.conf"
echo "nginx: собран конфиг из $(basename "$TEMPLATE")"
