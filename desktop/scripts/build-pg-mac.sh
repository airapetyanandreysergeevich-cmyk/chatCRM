#!/usr/bin/env bash
#
# PostgreSQL для программы на Mac — собираем из исходников.
#
#   bash desktop/scripts/build-pg-mac.sh 16.15 desktop/vendor/pgsql
#
# На Windows бинарники берутся готовыми у EnterpriseDB. Для Mac готового
# переносимого набора нет: Homebrew и Postgres.app ставят базу в свои
# системные папки, а нам нужна папка, которая едет внутри программы и
# работает, куда бы её ни положили. Поэтому собираем сами — это минут пять
# на сборочной машине GitHub (.github/workflows/mac.yml).
#
# Что важно:
# 1. Версия — та же, что у Windows (16.x): копия базы с одного компьютера
#    должна восстанавливаться на другом.
# 2. С ICU: база создаётся с русской сортировкой через ICU (postgres.js →
#    initdb), без неё initdb откажется. Библиотеки ICU кладём рядом, в lib/.
# 3. Переносимость. Собранные файлы ссылаются на библиотеки полными путями
#    сборочной машины. Переписываем ссылки на @rpath и прописываем, где его
#    искать относительно самого файла, — тогда папка работает где угодно.
# 4. Подпись. На Mac с процессором Apple файл без подписи не запустится
#    вовсе, а правка ссылок подпись ломает. Поэтому в конце каждый файл
#    подписываем заново — «своей» подписью (ad-hoc), платной не нужно.
#
set -euo pipefail

VERSION="${1:?версия PostgreSQL, например 16.15}"
TARGET="${2:?куда положить, например desktop/vendor/pgsql}"
mkdir -p "$(dirname "$TARGET")"
OUT="$(cd "$(dirname "$TARGET")" && pwd)/$(basename "$TARGET")"
WORK="${TMPDIR:-/tmp}/finecrm-pg-build"

echo "== PostgreSQL $VERSION для $(uname -m) → $OUT"

# ICU — из Homebrew. Только для сборки: сами библиотеки скопируем в lib/.
brew list icu4c >/dev/null 2>&1 || brew install icu4c
ICU_PREFIX="$(brew --prefix icu4c)"
export PKG_CONFIG_PATH="$ICU_PREFIX/lib/pkgconfig"

rm -rf "$WORK" "$OUT"
mkdir -p "$WORK"
cd "$WORK"
curl -fsSL "https://ftp.postgresql.org/pub/source/v$VERSION/postgresql-$VERSION.tar.bz2" -o pg.tar.bz2
tar xjf pg.tar.bz2
cd "postgresql-$VERSION"

# Без OpenSSL и readline: к базе подключаемся только с этого же компьютера
# по 127.0.0.1, а psql нужен программе для команд, не человеку.
./configure \
  --prefix="$OUT" \
  --with-icu \
  --without-readline \
  --without-openssl \
  --without-ldap \
  --without-perl --without-python --without-tcl \
  LDFLAGS="-Wl,-headerpad_max_install_names" \
  >/dev/null

make -j"$(sysctl -n hw.ncpu)" >/dev/null
make install >/dev/null

# Лишнее не везём: заголовки и статические библиотеки нужны только сборке.
rm -rf "$OUT/include" "$OUT"/lib/*.a "$OUT/lib/pkgconfig" "$OUT/lib/pgxs"

# ------------------------------------------------------------ переносимость

# Ссылки-ярлыки на библиотеки (libpq.5.dylib → libpq.5.16.dylib) заменяем
# самими файлами: при упаковке программы ярлыки могут не доехать.
while IFS= read -r -d '' l; do
  cp -L "$l" "$l.tmp" && rm "$l" && mv "$l.tmp" "$l"
done < <(find "$OUT/lib" -type l -print0)

is_macho() { file -b "$1" | grep -q "Mach-O"; }
# Внешние ссылки — всё, что не системное.
deps_of() { otool -L "$1" | tail -n +2 | awk '{print $1}' | grep -v -E '^(/usr/lib/|/System/|@)' || true; }
# Ссылки «на соседа»: ICU 78 из Homebrew ссылается на свои же части так —
# @loader_path/libicudata.78.dylib. Сама ссылка переносимая, но соседа надо
# привезти: без него initdb падает ещё до старта («Library not loaded»).
near_deps_of() { otool -L "$1" | tail -n +2 | awk '{print $1}' | grep -E '^@(loader_path|rpath)/' || true; }

# Где искать соседей: папки, откуда брали библиотеки.
SRC_DIRS=("$ICU_PREFIX/lib")
find_lib() {
  local d
  for d in "${SRC_DIRS[@]}"; do
    if [ -f "$d/$1" ]; then echo "$d/$1"; return 0; fi
  done
  return 0
}
take() { # take <откуда> <имя>
  cp -L "$1" "$OUT/lib/$2"
  chmod u+w "$OUT/lib/$2"
  SRC_DIRS+=("$(cd "$(dirname "$1")" && pwd -P)")
  echo "   + $2"
}

# Копируем внешние библиотеки (ICU, libpq из папки сборки) в lib/ до тех
# пор, пока новых не останется: ICU ссылается сама на себя.
changed=1
while [ "$changed" = 1 ]; do
  changed=0
  while IFS= read -r -d '' f; do
    is_macho "$f" || continue
    for dep in $(deps_of "$f"); do
      name="$(basename "$dep")"
      if [ ! -f "$OUT/lib/$name" ]; then
        take "$dep" "$name"
        changed=1
      fi
    done
    for dep in $(near_deps_of "$f"); do
      name="$(basename "$dep")"
      if [ ! -f "$OUT/lib/$name" ] && [ ! -f "$(dirname "$f")/$name" ]; then
        src="$(find_lib "$name")"
        if [ -z "$src" ]; then
          echo "Не нашлась $name — на неё ссылается $f (искали в: ${SRC_DIRS[*]})" >&2
          exit 1
        fi
        take "$src" "$name"
        changed=1
      fi
    done
  done < <(find "$OUT/bin" "$OUT/lib" -type f -print0)
done

# Ссылки — на @rpath, и где искать @rpath: от bin/ — в ../lib, от lib/ —
# рядом, от lib/postgresql/ (модули сервера) — уровнем выше.
while IFS= read -r -d '' f; do
  is_macho "$f" || continue
  case "$f" in
    "$OUT"/bin/*) rpath="@loader_path/../lib" ;;
    "$OUT"/lib/postgresql/*) rpath="@loader_path/.." ;;
    *) rpath="@loader_path" ;;
  esac
  if [[ "$f" == *.dylib && "$f" != "$OUT"/lib/postgresql/* ]]; then
    install_name_tool -id "@rpath/$(basename "$f")" "$f"
  fi
  for dep in $(deps_of "$f"); do
    install_name_tool -change "$dep" "@rpath/$(basename "$dep")" "$f"
  done
  # Такой путь уже прописан — не ошибка; всё остальное — ошибка.
  if ! install_name_tool -add_rpath "$rpath" "$f" 2>"$WORK/rpath.err"; then
    grep -q "would duplicate path" "$WORK/rpath.err" || { cat "$WORK/rpath.err" >&2; exit 1; }
  fi
done < <(find "$OUT/bin" "$OUT/lib" -type f -print0)

# Подпись после всех правок.
while IFS= read -r -d '' f; do
  is_macho "$f" || continue
  if ! codesign --force --sign - "$f" >"$WORK/sign.log" 2>&1; then
    echo "Не подписался $f:" >&2
    cat "$WORK/sign.log" >&2
    exit 1
  fi
done < <(find "$OUT/bin" "$OUT/lib" -type f -print0)

# ------------------------------------------------------------ проверка

# Ни одной ссылки на папку сборки или Homebrew не осталось.
left=""
while IFS= read -r -d '' f; do
  is_macho "$f" || continue
  d="$(deps_of "$f")"
  [ -n "$d" ] && left="$left\n$f: $d"
done < <(find "$OUT/bin" "$OUT/lib" -type f -print0)
if [ -n "$left" ]; then
  echo -e "Остались внешние ссылки:$left" >&2
  exit 1
fi

# И каждая ссылка на соседа находит файл: @rpath у нас всегда ведёт в lib/,
# @loader_path — в папку самого файла.
missing=""
while IFS= read -r -d '' f; do
  is_macho "$f" || continue
  for dep in $(near_deps_of "$f"); do
    case "$dep" in
      @rpath/*) want="$OUT/lib/${dep#@rpath/}" ;;
      @loader_path/*) want="$(dirname "$f")/${dep#@loader_path/}" ;;
    esac
    [ -f "$want" ] || missing="$missing\n$f → $dep"
  done
done < <(find "$OUT/bin" "$OUT/lib" -type f -print0)
if [ -n "$missing" ]; then
  echo -e "Ссылки ведут в пустоту:$missing" >&2
  exit 1
fi
echo "== Библиотеки в lib/: $(cd "$OUT/lib" && ls *.dylib | tr '\n' ' ')"

# База создаётся и запускается из ПЕРЕНЕСЁННОЙ папки — ровно как в программе.
MOVED="$WORK/moved/pgsql"
mkdir -p "$(dirname "$MOVED")"
cp -R "$OUT" "$MOVED"
"$MOVED/bin/initdb" -D "$WORK/data" -U postgres --auth=trust --encoding=UTF8 \
  --locale-provider=icu --icu-locale=ru-RU --locale=C >/dev/null
echo "unix_socket_directories = ''" >> "$WORK/data/postgresql.conf"
"$MOVED/bin/pg_ctl" -D "$WORK/data" -o "-p 54329 -c listen_addresses=127.0.0.1" -w start >/dev/null
"$MOVED/bin/psql" -h 127.0.0.1 -p 54329 -U postgres -tAc \
  "select string_agg(x, ',' order by x) from unnest(array['Борщ','арбуз','Яблоко','ель']) x" | tee "$WORK/sort.txt"
"$MOVED/bin/pg_dump" -h 127.0.0.1 -p 54329 -U postgres -Fc postgres -f "$WORK/dump.bin"
"$MOVED/bin/pg_restore" --list "$WORK/dump.bin" >/dev/null
"$MOVED/bin/pg_isready" -h 127.0.0.1 -p 54329 >/dev/null
"$MOVED/bin/pg_ctl" -D "$WORK/data" -w stop >/dev/null
# По байтам было бы «Борщ,Яблоко,арбуз,ель» — заглавные раньше строчных.
grep -q "арбуз,Борщ,ель,Яблоко" "$WORK/sort.txt" || { echo "Русская сортировка (ICU) не работает" >&2; exit 1; }

echo "== Готово: $(du -sh "$OUT" | cut -f1), проверено из другой папки"
