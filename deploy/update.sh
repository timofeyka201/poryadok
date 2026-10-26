#!/usr/bin/env bash
# Запускается таймером раз в минуту: если в GitHub (ветка main) есть новый код — обновляет сервер.
# Если прошлая установка оборвалась (например, пропала сеть), повторяет её, пока не получится.
set -euo pipefail
cd /opt/poryadok
MARK=/etc/poryadok/installed-commit
git fetch -q origin main || echo "GitHub недоступен — проверю установленную версию"
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  echo "Обновляю до: $(git log -1 --format='%h %s' origin/main)"
  git reset -q --hard origin/main
elif [ "$(cat "$MARK" 2>/dev/null)" = "$(git rev-parse HEAD)" ] && systemctl is-active -q poryadok; then
  exit 0
else
  echo "Прошлая установка не завершилась или сервис не работает — повторяю"
fi
exec bash deploy/install.sh
