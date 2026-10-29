#!/usr/bin/env bash
# Установка/обновление «Порядка» на сервере (Ubuntu 22.04/24.04). Запускать от root из /opt/poryadok.
# Безопасно запускать повторно. Настройки сервера — в /etc/poryadok/env (DOMAIN=...).
set -euo pipefail
APP=/opt/poryadok
DATA=/var/lib/poryadok
CONF=/etc/poryadok
export DEBIAN_FRONTEND=noninteractive
cd "$APP"

mkdir -p "$CONF"
touch "$CONF/env"
# shellcheck disable=SC1091
source "$CONF/env"
DOMAIN="${DOMAIN:-}"

# --- Node.js 22 ---
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  echo "→ Устанавливаю Node.js 22"
  if ! { curl -fsSL --max-time 60 https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs; }; then
    # запасной путь: готовая сборка Node.js с официального сайта или зеркала
    NODE_V=v22.22.0
    ARCH=$(uname -m | sed 's/x86_64/x64/; s/aarch64/arm64/')
    for base in https://nodejs.org/dist https://npmmirror.com/mirrors/node; do
      if curl -fsSL --max-time 300 "$base/$NODE_V/node-$NODE_V-linux-$ARCH.tar.xz" -o /tmp/node.tar.xz; then
        tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 && rm -f /tmp/node.tar.xz
        ln -sf /usr/local/bin/node /usr/bin/node
        break
      fi
    done
  fi
  node -v
fi

# --- Caddy: веб-сервер, сам получает и продлевает HTTPS-сертификат ---
if ! command -v caddy >/dev/null; then
  echo "→ Устанавливаю Caddy"
  apt-get update -y
  if ! apt-get install -y caddy; then
    apt-get install -y debian-keyring debian-archive-keyring apt-transport-https gnupg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -y && apt-get install -y caddy
  fi
fi

# --- пользователь и данные (база и видео живут отдельно от кода) ---
id poryadok >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin -d "$DATA" poryadok
mkdir -p "$DATA"
chown -R poryadok:poryadok "$DATA"
[ -f "$CONF/accounts.json" ] && chown poryadok:poryadok "$CONF/accounts.json" && chmod 600 "$CONF/accounts.json"

# зависимости ставим, только если они изменились: меньше зависимость от сети при обновлениях
LOCK_HASH=$(sha256sum package-lock.json | cut -d' ' -f1)
if [ -d node_modules/express ] && [ "$(cat "$CONF/deps-hash" 2>/dev/null)" = "$LOCK_HASH" ]; then
  echo "→ Зависимости не изменились"
else
  echo "→ Устанавливаю зависимости"
  ok=0
  for registry in https://registry.npmjs.org https://registry.npmmirror.com; do
    for attempt in 1 2; do
      if npm ci --omit=dev --no-audit --no-fund --loglevel=error --registry="$registry"; then ok=1; break 2; fi
      sleep 5
    done
  done
  [ "$ok" = 1 ] || { echo "✗ Не удалось скачать зависимости (нет связи с npm). Повторю при следующей проверке."; exit 1; }
  echo "$LOCK_HASH" > "$CONF/deps-hash"
fi

# --- службы: приложение и автообновление с GitHub раз в минуту ---
cat > /etc/systemd/system/poryadok.service <<UNIT
[Unit]
Description=Poryadok
After=network.target

[Service]
Type=simple
User=poryadok
WorkingDirectory=$APP
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=TZ=Europe/Moscow
Environment=DATA_DIR=$DATA
Environment=ACCOUNTS_FILE=$CONF/accounts.json
ExecStart=/usr/bin/node --no-warnings server/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/poryadok-update.service <<UNIT
[Unit]
Description=Poryadok: обновление с GitHub

[Service]
Type=oneshot
ExecStart=/bin/bash $APP/deploy/update.sh
UNIT

cat > /etc/systemd/system/poryadok-update.timer <<UNIT
[Unit]
Description=Poryadok: проверка обновлений каждую минуту

[Timer]
OnBootSec=1min
OnUnitActiveSec=1min

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable poryadok poryadok-update.timer >/dev/null 2>&1
systemctl restart poryadok
systemctl start poryadok-update.timer

# --- HTTPS ---
# Технический адрес вида 1-2-3-4.sslip.io работает всегда — и без своего домена,
# и как запасной (например, если провайдер блокирует домен)
IP=$(curl -4fsS --max-time 5 https://api.ipify.org || hostname -I | awk '{print $1}')
SSLIP="${IP//./-}.sslip.io"
SITES="$SSLIP"
[ -n "$DOMAIN" ] && SITES="$DOMAIN, $SSLIP"
# Каждый проект на сервере хранит свой сайт в отдельном файле /etc/caddy/sites/*.caddy,
# а главный Caddyfile только подключает их — так проекты не перезаписывают настройки друг друга
mkdir -p /etc/caddy/sites
cat > /etc/caddy/sites/poryadok.caddy <<CADDY
# «Порядок» (создано deploy/install.sh — правки здесь перезапишутся)
$SITES {
	request_body {
		max_size 4GB
	}
	reverse_proxy localhost:3000
}
CADDY
echo 'import /etc/caddy/sites/*.caddy' > /etc/caddy/Caddyfile
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
fi
systemctl enable caddy >/dev/null 2>&1
systemctl reload caddy 2>/dev/null || systemctl restart caddy

# --- проверка ---
code=000
for _ in $(seq 1 20); do
  code=$(curl -s -o /dev/null -w '%{http_code}' localhost:3000/api/me || true)
  [ "$code" = "401" ] && break
  sleep 1
done
if [ "$code" != "401" ]; then
  echo "✗ Сервис не запустился. Последние строки лога:"
  journalctl -u poryadok -n 40 --no-pager
  exit 1
fi
git -C "$APP" rev-parse HEAD > "$CONF/installed-commit"
echo "  Запасной адрес: https://$SSLIP"
echo "✓ «Порядок» работает: https://${DOMAIN:-$SSLIP}  (версия $(git -C "$APP" log -1 --format='%h %s'))"
