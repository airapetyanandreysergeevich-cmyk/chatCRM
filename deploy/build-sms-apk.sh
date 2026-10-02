#!/usr/bin/env bash
#
# Сборка приложения «FineCRM SMS» — телефон-шлюз для SMS клиентам (android-sms/).
#
# Без gradle и без интернета внутри сборки: только инструменты Android SDK из
# того же образа, что собирает APK FineCRM (deploy/android/Dockerfile):
# aapt2 → javac → d8 → zipalign → apksigner. Библиотек в приложении нет —
# качать нечего, собирается за секунды.
#
# Подписывается тем же ключом, что и APK FineCRM (deploy/android/android.keystore,
# пароль — ANDROID_KEYSTORE_PASSWORD в deploy/.env). Готовый файл кладётся на
# сайт: https://<домен>/app/finecrm-sms.apk — по этой ссылке его скачивают из
# «Настройки → Интеграции → Подключить телефон».
#
# Запускать на сервере из корня проекта:  bash deploy/build-sms-apk.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANDROID_DIR="$ROOT/deploy/android"
ENV_FILE="$ROOT/deploy/.env"
KEYSTORE="$ANDROID_DIR/android.keystore"
SRC="$ROOT/android-sms"
IMAGE="finecrm-android-build"

step() { printf '\n\033[1m[%s/5] %s\033[0m\n' "$1" "$2"; }
die() { printf '\n\033[31mОшибка: %s\033[0m\n' "$1" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "не найден docker"
[ -f "$ENV_FILE" ] || die "не найден $ENV_FILE"
[ -f "$KEYSTORE" ] || die "нет ключа подписи $KEYSTORE.
     Он создаётся при первой сборке APK FineCRM: bash deploy/build-apk.sh"
KS_PASS="$(grep -E '^ANDROID_KEYSTORE_PASSWORD=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
[ -n "$KS_PASS" ] || die "нет ANDROID_KEYSTORE_PASSWORD в deploy/.env"

DOMAIN="$(grep -E '^DOMAIN=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"'"'"' \r')"
DOMAIN="${DOMAIN:-www.finecrm.ru}"

# ------------------------------------------------------------------ 1. версия
step 1 "Версия"
read -r VERSION_CODE VERSION_NAME < "$SRC/version.txt"
grep -q "VERSION = \"$VERSION_NAME\"" "$SRC/src/ru/finecrm/sms/BuildInfo.java" \
  || die "версия в android-sms/src/ru/finecrm/sms/BuildInfo.java не совпадает с android-sms/version.txt ($VERSION_NAME)"
echo "  $VERSION_NAME (код $VERSION_CODE)"

# ------------------------------------------------------------------ 2. образ
step 2 "Сборочный образ"
if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "  уже есть: $IMAGE"
else
  echo "  собираем (первый раз качается Android SDK, это долго)…"
  docker build -t "$IMAGE" "$ANDROID_DIR"
fi

# ------------------------------------------------------------------ 3. сборка
step 3 "Собираем и подписываем"
docker run --rm \
  -v "$SRC:/src:ro" \
  -v "$ANDROID_DIR:/work" \
  -e KSPASS="$KS_PASS" \
  -e VC="$VERSION_CODE" \
  -e VN="$VERSION_NAME" \
  "$IMAGE" bash -c '
    set -euo pipefail
    SDK="${ANDROID_HOME:-/opt/android-sdk}"
    BT="$(ls -d "$SDK"/build-tools/* | sort -V | tail -1)"
    JAR="$(ls -d "$SDK"/platforms/android-* | sort -V | tail -1)/android.jar"
    W=/tmp/sms; rm -rf "$W"; mkdir -p "$W/gen" "$W/classes" "$W/dex"
    echo "  build-tools: $(basename "$BT"), платформа: $(basename "$(dirname "$JAR")")"
    "$BT/aapt2" compile --dir /src/res -o "$W/res.zip"
    "$BT/aapt2" link -I "$JAR" --manifest /src/AndroidManifest.xml \
      --min-sdk-version 23 --target-sdk-version 34 \
      --version-code "$VC" --version-name "$VN" \
      --java "$W/gen" -o "$W/base.apk" "$W/res.zip"
    javac -Xlint:-options -nowarn -source 11 -target 11 -encoding UTF-8 -classpath "$JAR" -d "$W/classes" \
      $(find /src/src "$W/gen" -name "*.java")
    "$BT/d8" --release --min-api 23 --lib "$JAR" --output "$W/dex" $(find "$W/classes" -name "*.class")
    cp "$W/base.apk" "$W/unsigned.apk"
    (cd "$W/dex" && jar --update --no-manifest --file "$W/unsigned.apk" classes.dex)
    "$BT/zipalign" -f -p 4 "$W/unsigned.apk" "$W/aligned.apk"
    "$BT/apksigner" sign --ks /work/android.keystore --ks-key-alias finecrm \
      --ks-pass env:KSPASS --key-pass env:KSPASS --out /work/finecrm-sms.apk "$W/aligned.apk"
    "$BT/apksigner" verify /work/finecrm-sms.apk
  '
APK="$ANDROID_DIR/finecrm-sms.apk"
[ -f "$APK" ] || die "APK не появился — смотрите вывод выше"
echo "  собран: $APK ($(du -h "$APK" | cut -f1))"

# ------------------------------------------------------------------ 4. на сайт
step 4 "Выкладываем на сайт"
mkdir -p "$ROOT/frontend/public/app"
cp "$APK" "$ROOT/frontend/public/app/finecrm-sms.apk"
docker compose --env-file "$ENV_FILE" up -d --build frontend
sleep 5

# ------------------------------------------------------------------ 5. проверка
step 5 "Проверяем, что файл скачивается"
URL="https://$DOMAIN/app/finecrm-sms.apk"
TYPE="$(curl -fsSI --max-time 20 "$URL" | tr -d '\r' | awk -F': ' 'tolower($1)=="content-type"{print $2}')"
SIZE="$(curl -fsSI --max-time 20 "$URL" | tr -d '\r' | awk -F': ' 'tolower($1)=="content-length"{print $2}')"
if [ "$TYPE" = "application/vnd.android.package-archive" ] && [ "${SIZE:-0}" -gt 10000 ]; then
  echo "  проверено: $URL ($((SIZE / 1024)) КБ)"
else
  die "по адресу $URL лежит не то (тип: ${TYPE:-нет}, размер: ${SIZE:-нет})"
fi

echo
echo "Готово. «FineCRM SMS» $VERSION_NAME — $URL"
