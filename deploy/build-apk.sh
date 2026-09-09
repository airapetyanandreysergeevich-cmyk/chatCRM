#!/usr/bin/env bash
#
# Сборка APK-обёртки FineCRM для Android.
#
# Что делает:
#   1. собирает образ с Android SDK (один раз, потом берётся из кэша);
#   2. создаёт ключ подписи, если его ещё нет, и запоминает пароль в deploy/.env;
#   3. кладёт .well-known/assetlinks.json с отпечатком ключа во фронтенд;
#   4. собирает и подписывает APK.
#
# Запускать с сервера, из корня проекта:  bash deploy/build-apk.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANDROID_DIR="$ROOT/deploy/android"
ENV_FILE="$ROOT/deploy/.env"
KEYSTORE="$ANDROID_DIR/android.keystore"
ALIAS="finecrm"
IMAGE="finecrm-android-build"

step() { printf '\n\033[1m[%s/6] %s\033[0m\n' "$1" "$2"; }
die() { printf '\n\033[31mОшибка: %s\033[0m\n' "$1" >&2; exit 1; }

[ -f "$ENV_FILE" ] || die "не найден $ENV_FILE"

DOMAIN="$(grep -E '^DOMAIN=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"'"'"' \r')"
DOMAIN="${DOMAIN:-www.finecrm.ru}"

# ------------------------------------------------------------------ 1. проверки
step 1 "Проверяем, что сайт отдаётся по https"
if ! curl -fsS --max-time 20 "https://$DOMAIN/manifest.webmanifest" -o /dev/null; then
  die "https://$DOMAIN/manifest.webmanifest не открывается.
     APK — это обёртка вокруг сайта: без рабочего https он покажет адресную
     строку браузера вместо приложения, а оповещения не заработают вовсе.
     Сначала: bash deploy/setup-https.sh $DOMAIN"
fi

# ------------------------------------------------------------------ 2. пароль
step 2 "Пароль от ключа подписи"
if grep -qE '^ANDROID_KEYSTORE_PASSWORD=' "$ENV_FILE"; then
  KS_PASS="$(grep -E '^ANDROID_KEYSTORE_PASSWORD=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
  echo "  берём из deploy/.env"
else
  KS_PASS="$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 24)"
  printf '\nANDROID_KEYSTORE_PASSWORD=%s\n' "$KS_PASS" >> "$ENV_FILE"
  echo "  создан новый и записан в deploy/.env"
fi
[ -n "$KS_PASS" ] || die "пустой ANDROID_KEYSTORE_PASSWORD в deploy/.env"

# ------------------------------------------------------------------ 3. ключ
step 3 "Ключ подписи"
mkdir -p "$ANDROID_DIR"
if [ -f "$KEYSTORE" ]; then
  echo "  уже есть: $KEYSTORE"
else
  keytool -genkeypair -v \
    -keystore "$KEYSTORE" -alias "$ALIAS" \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "$KS_PASS" -keypass "$KS_PASS" \
    -dname "CN=FineCRM, O=FineCRM, C=RU" >/dev/null
  chmod 600 "$KEYSTORE"
  echo "  создан: $KEYSTORE"
  echo
  echo "  ВАЖНО: сохраните этот файл и пароль отдельно от сервера."
  echo "  Потеряете — обновить установленное приложение будет нечем,"
  echo "  сотрудникам придётся сносить старое и ставить заново."
fi

FINGERPRINT="$(keytool -list -v -keystore "$KEYSTORE" -alias "$ALIAS" -storepass "$KS_PASS" 2>/dev/null \
  | grep -i 'SHA256:' | head -1 | sed 's/.*SHA256: *//' | tr -d ' \r')"
[ -n "$FINGERPRINT" ] || die "не удалось прочитать отпечаток ключа — проверьте пароль"
echo "  отпечаток: $FINGERPRINT"

# ------------------------------------------------------------------ 4. assetlinks
step 4 "Связываем приложение с доменом"
WELL_KNOWN="$ROOT/frontend/public/.well-known"
mkdir -p "$WELL_KNOWN"
cat > "$WELL_KNOWN/assetlinks.json" <<JSON
[
  {
    "relation": ["delegate_permission/common.handle_all_urls"],
    "target": {
      "namespace": "android_app",
      "package_name": "ru.finecrm.app",
      "sha256_cert_fingerprints": ["$FINGERPRINT"]
    }
  }
]
JSON
echo "  записан frontend/public/.well-known/assetlinks.json"
echo "  без него Android покажет адресную строку поверх приложения"

# ------------------------------------------------------------------ 5. образ
step 5 "Сборочный образ (первый раз это долго — качается Android SDK)"
docker build -t "$IMAGE" "$ANDROID_DIR"

# ------------------------------------------------------------------ 6. сборка
step 6 "Собираем APK"
docker run --rm \
  -v "$ANDROID_DIR:/project" \
  -e BUBBLEWRAP_KEYSTORE_PASSWORD="$KS_PASS" \
  -e BUBBLEWRAP_KEY_PASSWORD="$KS_PASS" \
  "$IMAGE" bash -lc '
    set -e
    bubblewrap update --skipVersionUpgrade
    bubblewrap build --skipPwaValidation
  '

APK="$ANDROID_DIR/app-release-signed.apk"
[ -f "$APK" ] || die "APK не появился — смотрите вывод выше"

echo
echo "Готово: $APK"
echo
echo "Дальше:"
echo "  1. Пересоберите фронтенд, чтобы assetlinks.json попал на сайт:"
echo "     docker compose --env-file deploy/.env up -d --build frontend"
echo "  2. Заберите файл к себе:"
echo "     scp root@$(hostname -I | awk '{print $1}'):$APK ."
echo "  3. Отправьте сотрудникам. При установке Android один раз спросит"
echo "     разрешение на установку из неизвестного источника."
