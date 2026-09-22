#!/bin/sh
# Кладёт фотографию на сервер и печатает ссылку на неё.
#
#   ./foto.sh ~/Downloads/IMG_2841.jpg
#   ./foto.sh *.jpg          — можно сразу несколько
#
# Имя файла заменяется на случайное. Это не украшение: папка открыта всем,
# у кого есть ссылка, и единственное, что мешает чужому её открыть, — то,
# что такое имя не подобрать. Заодно исчезает IMG_2841.jpg, по которому
# видно и камеру, и сколько у тебя снимков.
#
# Имена переменных латиницей намеренно: обычный /bin/sh спотыкается о
# кириллические, и скрипт падал бы на разных машинах по-разному.

SERVER="root@155.212.164.11"
DIR="/var/www/foto"
BASE="https://voidm.site/f"

if [ $# -eq 0 ]; then
  echo "Что загружать? Например: $0 ~/Downloads/foto.jpg"
  exit 1
fi

for src in "$@"; do
  if [ ! -f "$src" ]; then
    echo "нет такого файла: $src"
    continue
  fi

  # Расширение оставляем: по нему браузер понимает, что это картинка
  ext=$(printf '%s' "${src##*.}" | tr 'A-Z' 'a-z')
  case "$ext" in
    jpg|jpeg|png|gif|webp|heic|pdf) ;;
    *) ext="bin" ;;
  esac

  name="$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n').$ext"

  if scp -q "$src" "$SERVER:$DIR/$name"; then
    ssh "$SERVER" "chmod 644 $DIR/$name"
    echo "$BASE/$name"
  else
    echo "не удалось загрузить: $src"
  fi
done
