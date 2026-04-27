#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR/frontend"
NPM_CACHE_DIR="$ROOT_DIR/.runtime/npm-cache"
BACKEND_PORT="${BACKEND_PORT:-8011}"
FRONTEND_PORT="${FRONTEND_PORT:-5183}"
RUN_DIR="$ROOT_DIR/.runtime/run"
mkdir -p "$NPM_CACHE_DIR" "$RUN_DIR"
STOP_SCOPE=frontend "$ROOT_DIR/stop.sh"
if [ ! -d node_modules ]; then
  npm install --cache "$NPM_CACHE_DIR"
fi
VITE_API_BASE="http://127.0.0.1:$BACKEND_PORT/api" npm run dev -- --host 127.0.0.1 --port "$FRONTEND_PORT" --strictPort &
echo "$!" > "$RUN_DIR/frontend.pid"
wait
