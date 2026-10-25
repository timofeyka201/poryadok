#!/usr/bin/env bash
# Запускается таймером раз в минуту: если в GitHub (ветка main) есть новый код — обновляет сервер.
set -euo pipefail
cd /opt/poryadok
git fetch -q origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] && exit 0
echo "Обновляю до: $(git log -1 --format='%h %s' origin/main)"
git reset -q --hard origin/main
exec bash deploy/install.sh
