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

# APK: файл-подтверждение, что приложение и сайт — одного хозяина (без него в APK сверху адресная строка)
if [ -f "$TMP"/*/.well-known/assetlinks.json ]; then
  mkdir -p "$SITE/.well-known"
  cp "$TMP"/*/.well-known/assetlinks.json "$SITE/.well-known/assetlinks.json"
fi
# один раз: nginx прячет всё, что с точки (.git, .env…) — для этого одного файла делаем исключение
if command -v nginx >/dev/null && [ -f "$SITE/.well-known/assetlinks.json" ]; then
  CONF="$(grep -lE 'server_name[^;]*voidm\.site' /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf 2>/dev/null | head -1 || true)"
  if [ -n "$CONF" ] && ! grep -q 'assetlinks' "$CONF"; then
    echo "→ Открываю assetlinks.json для APK в nginx…"
    REAL="$(readlink -f "$CONF")"; cp "$REAL" "$TMP/nginx.bak"
    sed -i -E '/server_name[^;]*voidm\.site/a\    location = /.well-known/assetlinks.json { allow all; default_type application/json; try_files $uri =404; }' "$REAL"
    if nginx -t 2>/dev/null; then systemctl reload nginx && echo "  ✓ готово"
    else cp "$TMP/nginx.bak" "$REAL"; echo "  ! nginx не принял настройку — вернул как было (игра всё равно обновлена)"; fi
  fi
fi

# ---- сигнальный сервер онлайна (server/server.js) ----
# Обновляем осторожно: только если сейчас запущен ровно прежний server.js из репозитория (сверка по отпечатку),
# старый кладём рядом (.bak), перезапускаем тем же, чем он запущен (pm2 или systemd), проверяем, что отвечает;
# не отвечает — возвращаем старый. Если что-то непонятно — ничего не трогаем, только пишем.
OLD_SRV_SHA="834593259b52b46d64a5027e0f8b8e5f576776cc868ea2832b68dc3b23ba4def"
NEW_SRV="$(find "$TMP" -mindepth 3 -maxdepth 3 -path '*/server/server.js' | head -1)"
SRV_PID="$( (ss -ltnpH 'sport = :3000' 2>/dev/null || true) | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2 || true)"
[ -z "$SRV_PID" ] && command -v lsof >/dev/null && SRV_PID="$(lsof -t -iTCP:3000 -sTCP:LISTEN 2>/dev/null | head -1 || true)"
if [ -n "$NEW_SRV" ] && [ -n "$SRV_PID" ] && [ -r "/proc/$SRV_PID/cmdline" ]; then
  ENVV="$(tr '\0' '\n' < "/proc/$SRV_PID/environ" 2>/dev/null || true)"
  SCRIPT="$(echo "$ENVV" | grep -m1 '^pm_exec_path=' | cut -d= -f2- || true)"
  PM_ID="$(echo "$ENVV" | grep -m1 '^pm_id=' | cut -d= -f2- || true)"
  if [ -z "$SCRIPT" ]; then
    SCRIPT="$(tr '\0' '\n' < "/proc/$SRV_PID/cmdline" | grep -m1 'server\.js$' || true)"
    case "$SCRIPT" in ""|/*) ;; *) SCRIPT="$(readlink -f "/proc/$SRV_PID/cwd")/$SCRIPT" ;; esac
  fi
  UNIT="$(grep -o '[^/]*\.service' "/proc/$SRV_PID/cgroup" 2>/dev/null | head -1 || true)"
  if [ -n "$SCRIPT" ] && [ -f "$SCRIPT" ]; then
    CUR_SHA="$(sha256sum "$SCRIPT" | cut -c1-64)"; NEW_SHA="$(sha256sum "$NEW_SRV" | cut -c1-64)"
    if [ "$CUR_SHA" = "$NEW_SHA" ]; then echo "→ Сервер онлайна уже свежий"
    elif [ "$CUR_SHA" != "$OLD_SRV_SHA" ]; then echo "! $SCRIPT отличается от известной версии — сервер онлайна не трогаю"
    else
      echo "→ Обновляю сервер онлайна ($SCRIPT)…"
      BAK="$SCRIPT.bak-$(date +%Y%m%d-%H%M%S)"; cp "$SCRIPT" "$BAK"; cp "$NEW_SRV" "$SCRIPT"
      перезапуск() {
        if [ -n "$PM_ID" ] && command -v pm2 >/dev/null; then pm2 restart "$PM_ID" >/dev/null 2>&1
        elif [ -n "$UNIT" ] && [ "$UNIT" != "user@0.service" ]; then systemctl restart "$UNIT"
        else return 1; fi
      }
      отвечает() {   # рукопожатие веб-сокета: ждём «101 Switching Protocols»
        for i in 1 2 3 4 5 6; do
          sleep 1
          curl -s -m 3 -i -N -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: SGVsbG9Cb3JvemRpbm92a2E=' http://127.0.0.1:3000/ 2>/dev/null | head -1 | grep -q ' 101' && return 0
        done
        return 1
      }
      if перезапуск; then
        if отвечает; then echo "  ✓ сервер онлайна обновлён и отвечает (старый — $BAK)"
        else echo "  ! после обновления не отвечает — возвращаю старый"; cp "$BAK" "$SCRIPT"; перезапуск || true; fi
      else
        echo "  ! не знаю, чем перезапускается сервер (не pm2 и не systemd) — новый файл положил, перезапусти сервер сам; старый — $BAK"
      fi
    fi
  else echo "! Не нашёл файл сервера онлайна — не трогаю"; fi
fi

# сам deploy — тоже свежий (со следующего раза)
NEW_DEPLOY="$(find "$TMP" -mindepth 3 -maxdepth 3 -path '*/server/deploy.sh' | head -1)"
SELF="$(readlink -f "$0" 2>/dev/null || echo "$0")"
if [ -n "$NEW_DEPLOY" ] && [ -w "$SELF" ] && ! cmp -s "$NEW_DEPLOY" "$SELF"; then cp "$NEW_DEPLOY" "$SELF" && chmod +x "$SELF" && echo "→ Команда deploy обновлена"; fi

SHA="$(curl -fsSL "https://api.github.com/repos/$REPO/commits/$BRANCH" 2>/dev/null | grep -m1 '"sha"' | cut -d'"' -f4 | cut -c1-7 || true)"
echo "✓ Готово: на сайте ${BRANCH}${SHA:+ @ $SHA}"
