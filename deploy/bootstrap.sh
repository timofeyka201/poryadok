#!/usr/bin/env bash
# Первичная установка на чистый сервер. Обычно её не запускают из репозитория,
# а вставляют в терминал сервера целиком (см. README, раздел «Установка на сервер»).
set -euo pipefail
REPO="${REPO:-timofeyka201/poryadok}"
export GIT_TERMINAL_PROMPT=0

apt-get update -y >/dev/null && apt-get install -y git curl >/dev/null

HTTPS_URL="https://github.com/$REPO.git"
SSH_URL="git@github.com:$REPO.git"
KEY=/root/.ssh/poryadok_deploy
URL=""
key_shown=0

while [ -z "$URL" ]; do
  if out=$(git ls-remote "$HTTPS_URL" refs/heads/main 2>/dev/null); then
    # публичный репозиторий
    if [ -n "$out" ]; then URL="$HTTPS_URL"; break; fi
    echo "Репозиторий пока пустой — жду, когда код будет загружен…"
  else
    # приватный репозиторий: нужен ключ доступа (Deploy key) только на чтение
    if [ ! -f "$KEY" ]; then
      mkdir -p /root/.ssh && chmod 700 /root/.ssh
      ssh-keygen -q -t ed25519 -N "" -C "poryadok-server" -f "$KEY"
      cat >> /root/.ssh/config <<CFG
Host github.com
  HostName ssh.github.com
  Port 443
  User git
  IdentityFile $KEY
  StrictHostKeyChecking accept-new
CFG
    fi
    if [ "$key_shown" = 0 ]; then
      echo
      echo "Репозиторий $REPO не найден или приватный."
      echo "Если он приватный: GitHub → репозиторий → Settings → Deploy keys → Add deploy key,"
      echo "вставьте эту строку и сохраните (галочку записи ставить не нужно):"
      echo
      cat "$KEY.pub"
      echo
      key_shown=1
    fi
    if out=$(git ls-remote "$SSH_URL" refs/heads/main 2>/dev/null) && [ -n "$out" ]; then URL="$SSH_URL"; break; fi
    echo "Жду доступ к репозиторию…"
  fi
  sleep 15
done

if [ ! -d /opt/poryadok/.git ]; then
  git clone -q "$URL" /opt/poryadok
fi
bash /opt/poryadok/deploy/install.sh
