#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUNTIME_DIR="$ROOT_DIR/.runtime"
LOG_DIR="$RUNTIME_DIR/logs"
VENV_DIR="$RUNTIME_DIR/python"
PIP_CACHE_DIR="$RUNTIME_DIR/pip-cache"
NPM_CACHE_DIR="$RUNTIME_DIR/npm-cache"

mkdir -p "$LOG_DIR" "$PIP_CACHE_DIR" "$NPM_CACHE_DIR"

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
}
trap cleanup EXIT INT TERM

source "$VENV_DIR/bin/activate"
cd "$ROOT_DIR"
uvicorn backend.app.main:app --reload --host 127.0.0.1 --port 8001 > "$LOG_DIR/backend.log" 2>&1 &
BACKEND_PID=$!

cd "$ROOT_DIR/frontend"
npm run dev -- --host 127.0.0.1 > "$LOG_DIR/frontend.log" 2>&1 &
FRONTEND_PID=$!

echo "后端日志：$LOG_DIR/backend.log"
echo "前端日志：$LOG_DIR/frontend.log"
echo "打开：http://127.0.0.1:5173/"
echo "按 Ctrl+C 停止。"

wait
