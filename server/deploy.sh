#!/usr/bin/env bash
# Деплой игры «Бороздиновский» на voidm.site одной командой.
#   deploy          — ветка по умолчанию
#   deploy main     — другая ветка
# Ставится на сервер так:
#   curl -fsSL https://raw.githubusercontent.com/vesninvladislav1-web/Void/claude/greeting-g1tz7b/server/deploy.sh -o /usr/local/bin/deploy && chmod +x /usr/local/bin/deploy
# Сначала качает и проверяет архив во временной папке; файлы сайта трогает,
# только если всё скачалось. Новые файлы ложатся поверх старых — игра не пропадает.
set -euo pipefail

BRANCH="${1:-claude/greeting-g1tz7b}"
REPO="vesninvladislav1-web/Void"
SITE="${SITE:-/var/www/voidm.site}"
GZIP_CONF="/etc/nginx/conf.d/brzd-gzip.conf"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "→ Качаю ветку $BRANCH с GitHub…"
curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH" -o "$TMP/a.tgz"
tar -xzf "$TMP/a.tgz" -C "$TMP"
SRC="$(find "$TMP" -mindepth 2 -maxdepth 2 -type d -name brzd-rstv)"
if [ -z "$SRC" ] || ! grep -q "<title>Бороздиновский</title>" "$SRC/index.html"; then
  echo "✗ В архиве нет игры — сайт не трогаю"; exit 1
fi

echo "→ Кладу игру на сайт…"
mkdir -p "$SITE/brzd-rstv"
cp -a "$SRC/." "$SITE/brzd-rstv/"

# один раз: nginx сжимает и скрипты (модели людей — вдвое меньше качать)
if [ -d /etc/nginx/conf.d ] && [ ! -f "$GZIP_CONF" ] && command -v nginx >/dev/null; then
  echo "→ Включаю сжатие скриптов в nginx…"
  echo 'gzip_types text/css application/javascript text/javascript application/json image/svg+xml;' > "$GZIP_CONF"
  if nginx -t 2>/dev/null; then systemctl reload nginx && echo "  ✓ сжатие включено"
  else rm -f "$GZIP_CONF"; echo "  ! nginx не принял настройку — оставил как было (игра всё равно обновлена)"; fi
fi

SHA="$(curl -fsSL "https://api.github.com/repos/$REPO/commits/$BRANCH" 2>/dev/null | grep -m1 '"sha"' | cut -d'"' -f4 | cut -c1-7 || true)"
echo "✓ Готово: на сайте ${BRANCH}${SHA:+ @ $SHA}"
