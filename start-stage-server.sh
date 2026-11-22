#!/usr/bin/env bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js wurde nicht gefunden. Bitte unter https://nodejs.org installieren."
  exit 1
fi
if command -v open >/dev/null 2>&1; then
  (sleep 1 && open "http://localhost:3000") &
elif command -v xdg-open >/dev/null 2>&1; then
  (sleep 1 && xdg-open "http://localhost:3000") &
fi
node server.mjs
