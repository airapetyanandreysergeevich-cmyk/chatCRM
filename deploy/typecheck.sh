#!/usr/bin/env bash
# Проверка типов без полной сборки образов: секунды вместо минут.
#
# node_modules переиспользуется между запусками, но переустанавливается,
# как только менялся package.json. Раньше условием было «папки нет» — и
# после добавления новой зависимости проверка месяцами показывала бы
# ошибку из устаревших пакетов, хотя настоящая сборка проходит. Проверка,
# которой нельзя верить, хуже отсутствующей.
set -euo pipefail
cd "$(dirname "$0")/.."

# Сравниваем содержимое package.json, а не даты: git checkout переписывает
# даты у всех файлов, и по ним переустановка шла бы после каждого pull.
INSTALL='
  set -e
  HASH_FILE=node_modules/.package-md5
  WANT=$(md5sum package.json | cut -d" " -f1)
  HAVE=$(cat "$HASH_FILE" 2>/dev/null || echo нет)
  if [ ! -d node_modules ] || [ "$WANT" != "$HAVE" ]; then
    echo "    зависимости изменились, ставлю…"
    npm install --no-audit --no-fund
    printf %s "$WANT" > "$HASH_FILE"
  fi
'

echo ">>> Бэкенд"
docker run --rm -v "$(pwd)/backend:/app" -w /app node:20-alpine sh -c "
  $INSTALL
  npx prisma generate >/dev/null
  npx tsc -p tsconfig.json --noEmit
" && echo "    типы сходятся"

# Изоляция арендаторов держится на двух списках таблиц плюс порядке очистки
# при удалении мастерской. Забытая в одном из них таблица не даёт ни ошибки,
# ни предупреждения — просто изоляция становится наполовину. Сверяем списки.
echo ">>> Таблицы мастерской"
docker run --rm -v "$(pwd)/backend:/app" -w /app node:20-alpine sh -c "
  $INSTALL
  npx tsx test/tenant-tables.ts
"

# Описание колонки и сборка строки для неё лежат в разных файлах: забыть
# одно при добавлении другого — дело минуты, а выгруженный файл после этого
# едет на ячейку вправо с середины, и Excel об этом не скажет.
echo ">>> Таблицы выгрузки"
docker run --rm -v "$(pwd)/backend:/app" -w /app node:20-alpine sh -c "
  $INSTALL
  npx tsx test/datasets.ts
"

# Долг нигде не хранится — он считается. Ошибка в этом счёте выглядит не как
# сбой, а как неверная сумма, которую приёмщик называет клиенту вслух.
echo ">>> Расчёт долга"
docker run --rm -v "$(pwd)/backend:/app" -w /app node:20-alpine sh -c "
  $INSTALL
  npx tsx test/debt.ts
"

echo ">>> Фронтенд"
docker run --rm -v "$(pwd)/frontend:/app" -w /app node:20-alpine sh -c "
  $INSTALL
  npx tsc --noEmit
" && echo "    типы сходятся"

# Кнопки комплектности и внешнего состояния правят ту же строку, что человек
# набирает руками. Ошибка здесь выглядит не как сбой, а как молча испорченная
# запись приёмки — та самая, которой решается спор о забытой зарядке.
echo ">>> Кнопки приёмки"
docker run --rm -v "$(pwd)/frontend:/app" -w /app node:20-alpine sh -c "
  $INSTALL
  npx tsx test/chips.ts
"

echo
echo ">>> Всё сходится. Обновить сервер: bash deploy/update.sh"
