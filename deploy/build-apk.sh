#!/usr/bin/env bash
#
# Сборка APK-обёртки FineCRM для Android.
#
# Что делает:
#   1. проверяет, что сайт отдаётся по https;
#   2. создаёт ключ подписи, если его ещё нет, и запоминает пароль в deploy/.env;
#   3. кладёт .well-known/assetlinks.json с отпечатком ключа во фронтенд;
#   4. собирает образ с Android SDK и подписанный APK.
#
# На сервере ничего ставить не надо: Java, Android SDK и bubblewrap живут
# внутри контейнеров. Нужен только докер.
#
# Запускать из корня проекта:  bash deploy/build-apk.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANDROID_DIR="$ROOT/deploy/android"
ENV_FILE="$ROOT/deploy/.env"
KEYSTORE="$ANDROID_DIR/android.keystore"
ALIAS="finecrm"
IMAGE="finecrm-android-build"
# Тот же образ, что и в deploy/android/Dockerfile — слой скачается один раз на двоих.
JDK_IMAGE="eclipse-temurin:17-jdk"

step() { printf '\n\033[1m[%s/6] %s\033[0m\n' "$1" "$2"; }
die() { printf '\n\033[31mОшибка: %s\033[0m\n' "$1" >&2; exit 1; }

# keytool идёт вместе с JDK, которого на сервере нет и не должно быть:
# всё остальное тут живёт в контейнерах, и ключ подписи — не исключение.
# Пароль передаём переменной окружения, а не аргументом: аргументы видно
# в списке процессов, переменную — нет.
keytool_in_docker() {
  docker run --rm -i \
    -e KSPASS="$KS_PASS" \
    -v "$ANDROID_DIR:/work" \
    -w /work \
    "$JDK_IMAGE" keytool "$@"
}

command -v docker >/dev/null 2>&1 || die "не найден docker"
docker info >/dev/null 2>&1 || die "докер не отвечает — запущен ли он?"
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
  echo "  скачиваем JDK-образ, если его ещё нет…"
  keytool_in_docker -genkeypair -v \
    -keystore android.keystore -alias "$ALIAS" \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass:env KSPASS -keypass:env KSPASS \
    -dname "CN=FineCRM, O=FineCRM, C=RU" >/dev/null
  chmod 600 "$KEYSTORE"
  echo "  создан: $KEYSTORE"
  echo
  echo "  ВАЖНО: сохраните этот файл и пароль отдельно от сервера."
  echo "  Потеряете — обновить установленное приложение будет нечем,"
  echo "  сотрудникам придётся сносить старое и ставить заново."
fi

FINGERPRINT="$(keytool_in_docker -list -v -keystore android.keystore -alias "$ALIAS" \
  -storepass:env KSPASS 2>/dev/null \
  | grep -i 'SHA256:' | head -1 | sed 's/.*SHA256: *//' | tr -d ' \r')"
[ -n "$FINGERPRINT" ] || die "не удалось прочитать отпечаток ключа — проверьте ANDROID_KEYSTORE_PASSWORD"
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
step 6 "Собираем APK (первый раз gradle тянет себя и зависимости — это долго)"
# Кэш gradle в отдельном томе: иначе каждая пересборка заново качает
# сам gradle и все зависимости плагина Android, а это сотни мегабайт.
docker volume create finecrm-gradle-cache >/dev/null
docker run --rm \
  -v "$ANDROID_DIR:/project" \
  -v finecrm-gradle-cache:/root/.gradle \
  -e BUBBLEWRAP_KEYSTORE_PASSWORD="$KS_PASS" \
  -e BUBBLEWRAP_KEY_PASSWORD="$KS_PASS" \
  "$IMAGE" bash -lc '
    set -e
    bubblewrap update --skipVersionUpgrade
    bubblewrap build --skipPwaValidation
  '

APK="$ANDROID_DIR/app-release-signed.apk"
[ -f "$APK" ] || die "APK не появился — смотрите вывод выше"

# Кладём файл туда, откуда его отдаёт сайт: сотруднику показывается кнопка
# «Скачать», рассылать файл руками не нужно.
PUBLIC_APK="$ROOT/frontend/public/app/finecrm.apk"
mkdir -p "$(dirname "$PUBLIC_APK")"
cp "$APK" "$PUBLIC_APK"

echo
echo "Готово: $APK"
echo "Для скачивания с сайта: frontend/public/app/finecrm.apk ($(du -h "$PUBLIC_APK" | cut -f1))"
echo
echo "Дальше — обязательно пересоберите фронтенд, иначе на сайт не попадут"
echo "ни сам файл, ни assetlinks.json, без которого Android покажет"
echo "адресную строку поверх приложения:"
echo
echo "  docker compose --env-file deploy/.env up -d --build frontend"
echo
echo "После этого сотрудники с Android увидят предложение установить"
echo "приложение прямо в системе — файл будет на https://$DOMAIN/app/finecrm.apk"
