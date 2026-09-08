#!/usr/bin/env bash
# Проверяет сеть внутри контейнеров. Запускать на сервере: bash deploy/doctor.sh
# Симптом, ради которого это написано: docker pull работает, а apk и npm внутри
# контейнера виснут и падают по таймауту. Так выглядит несовпадение MTU.
set -uo pipefail

ok()   { echo "  [ ок ] $*"; }
bad()  { echo "  [ !! ] $*"; }
info() { echo "  [ -- ] $*"; }

echo "=== 1. MTU ==="
IFACE="$(ip route show default 2>/dev/null | awk '{print $5; exit}')"
HOST_MTU="$(ip -o link show "$IFACE" 2>/dev/null | grep -o 'mtu [0-9]*' | awk '{print $2}')"
DOCKER_MTU="$(ip -o link show docker0 2>/dev/null | grep -o 'mtu [0-9]*' | awk '{print $2}')"
info "внешний интерфейс: ${IFACE:-не определён}, MTU ${HOST_MTU:-?}"
info "docker0: MTU ${DOCKER_MTU:-нет интерфейса}"

MTU_PROBLEM=0
if [ -n "${HOST_MTU:-}" ] && [ -n "${DOCKER_MTU:-}" ] && [ "$DOCKER_MTU" -gt "$HOST_MTU" ]; then
  bad "у контейнеров MTU больше, чем у хоста — крупные пакеты будут теряться"
  MTU_PROBLEM=1
else
  ok "MTU согласованы"
fi

echo
echo "=== 2. Проходит ли большой пакет из контейнера ==="
if docker run --rm alpine:3.20 ping -c2 -W3 -M do -s 1400 1.1.1.1 >/dev/null 2>&1; then
  ok "пакет 1400 байт проходит"
else
  bad "пакет 1400 байт НЕ проходит — почти наверняка MTU"
  MTU_PROBLEM=1
fi

echo
echo "=== 3. DNS внутри контейнера ==="
if docker run --rm alpine:3.20 nslookup registry.npmjs.org >/dev/null 2>&1; then
  ok "имена резолвятся"
else
  bad "DNS внутри контейнера не работает"
fi

echo
echo "=== 4. Реальная загрузка из контейнера ==="
for url in https://registry.npmjs.org/react https://dl-cdn.alpinelinux.org/alpine/v3.20/main/x86_64/APKINDEX.tar.gz; do
  if timeout 45 docker run --rm alpine:3.20 wget -qO /dev/null "$url" >/dev/null 2>&1; then
    ok "$url"
  else
    bad "$url — не скачалось за 45 секунд"
    MTU_PROBLEM=1
  fi
done

echo
echo "=== 5. IPv6 ==="
if docker run --rm alpine:3.20 ping -c1 -W3 2606:4700:4700::1111 >/dev/null 2>&1; then
  info "IPv6 из контейнера работает"
else
  info "IPv6 из контейнера не работает — если DNS отдаёт AAAA, клиенты будут ждать таймаут"
fi

echo
echo "=== Итог ==="
if [ "$MTU_PROBLEM" = "1" ]; then
  SUGGEST=$(( ${HOST_MTU:-1500} > 68 ? ${HOST_MTU:-1500} : 1400 ))
  cat <<TXT
  Сеть контейнеров работает не полностью: образы качаются (это делает демон
  напрямую через хост), а apk и npm внутри контейнера падают по таймауту.

  Лечится так — создайте /etc/docker/daemon.json:

    {
      "mtu": ${SUGGEST},
      "dns": ["1.1.1.1", "8.8.8.8"]
    }

  и перезапустите демон:

    systemctl restart docker

  Затем повторите: bash deploy/install.sh
TXT
else
  echo "  Явных проблем с сетью контейнеров не видно."
fi
