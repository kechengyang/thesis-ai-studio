#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUNTIME_DIR="$ROOT_DIR/.runtime"
RUN_DIR="$RUNTIME_DIR/run"
BACKEND_PORT="${BACKEND_PORT:-8011}"
FRONTEND_PORT="${FRONTEND_PORT:-5183}"
STOP_SCOPE="${STOP_SCOPE:-all}"

stop_pid_file() {
  local pid_file="$1"
  if [ ! -f "$pid_file" ]; then
    return
  fi
  local pid
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
  fi
  rm -f "$pid_file"
}

stop_related_port() {
  local port="$1"
  local pids
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -z "$pids" ]; then
    return
  fi
  for pid in $pids; do
    local command
    command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    case "$command" in
      *"uvicorn backend.app.main:app"*|*"vite"*|*"node"*"vite"*)
        kill "$pid" 2>/dev/null || true
        ;;
    esac
  done
}

mkdir -p "$RUN_DIR"

case "$STOP_SCOPE" in
  all)
    stop_pid_file "$RUN_DIR/backend.pid"
    stop_pid_file "$RUN_DIR/frontend.pid"
    for port in "$BACKEND_PORT" "$FRONTEND_PORT" 8001 5173 5174; do
      stop_related_port "$port"
    done
    ;;
  backend)
    stop_pid_file "$RUN_DIR/backend.pid"
    for port in "$BACKEND_PORT" 8001; do
      stop_related_port "$port"
    done
    ;;
  frontend)
    stop_pid_file "$RUN_DIR/frontend.pid"
    for port in "$FRONTEND_PORT" 5173 5174; do
      stop_related_port "$port"
    done
    ;;
  *)
    echo "Unknown STOP_SCOPE: $STOP_SCOPE" >&2
    exit 2
    ;;
esac

sleep 1
