#!/usr/bin/env bash
set -euo pipefail
cd /opt/dyndns
if [ -n "$(git status --porcelain)" ]; then
  echo 'Abbruch: Checkout enthält lokale Änderungen.' >&2
  exit 1
fi
git pull --ff-only origin main
npm ci --ignore-scripts --no-fund --no-audit
npm run check
npm test
sudo systemctl restart dyndns
curl --fail --silent --show-error --max-time 10 --retry 5 --retry-connrefused --retry-delay 1 \
  -H 'X-Forwarded-Proto: https' http://127.0.0.1:3000/healthz
