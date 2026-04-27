#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUNTIME_DIR="$ROOT_DIR/.runtime"
LOG_DIR="$RUNTIME_DIR/logs"
RUN_DIR="$RUNTIME_DIR/run"
VENV_DIR="$RUNTIME_DIR/python"
PIP_CACHE_DIR="$RUNTIME_DIR/pip-cache"
NPM_CACHE_DIR="$RUNTIME_DIR/npm-cache"
BACKEND_PORT="${BACKEND_PORT:-8011}"
FRONTEND_PORT="${FRONTEND_PORT:-5183}"

mkdir -p "$LOG_DIR" "$RUN_DIR" "$PIP_CACHE_DIR" "$NPM_CACHE_DIR"
"$ROOT_DIR/stop.sh"

if [ ! -d "$VENV_DIR" ] || [ ! -d "$ROOT_DIR/frontend/node_modules" ]; then
  "$ROOT_DIR/setup.sh"
fi

cleanup() {
  if [ -n "${BACKEND_PID:-}" ]; then
    kill "$BACKEND_PID" 2>/dev/null || true
  fi
  if [ -n "${FRONTEND_PID:-}" ]; then
    kill "$FRONTEND_PID" 2>/dev/null || true
  fi
  rm -f "$RUN_DIR/backend.pid" "$RUN_DIR/frontend.pid"
}
trap cleanup EXIT INT TERM

source "$VENV_DIR/bin/activate"
cd "$ROOT_DIR"
uvicorn backend.app.main:app --host 127.0.0.1 --port "$BACKEND_PORT" > "$LOG_DIR/backend.log" 2>&1 &
BACKEND_PID=$!
echo "$BACKEND_PID" > "$RUN_DIR/backend.pid"

cd "$ROOT_DIR/frontend"
VITE_API_BASE="http://127.0.0.1:$BACKEND_PORT/api" npm run dev -- --host 127.0.0.1 --port "$FRONTEND_PORT" --strictPort > "$LOG_DIR/frontend.log" 2>&1 &
FRONTEND_PID=$!
echo "$FRONTEND_PID" > "$RUN_DIR/frontend.pid"

echo "后端日志：$LOG_DIR/backend.log"
echo "前端日志：$LOG_DIR/frontend.log"
echo "打开：http://127.0.0.1:$FRONTEND_PORT/"
echo "按 Ctrl+C 停止。"

wait
