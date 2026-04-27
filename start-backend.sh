#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
RUNTIME_DIR="$PWD/.runtime"
VENV_DIR="$RUNTIME_DIR/python"
PIP_CACHE_DIR="$RUNTIME_DIR/pip-cache"
BACKEND_PORT="${BACKEND_PORT:-8011}"
RUN_DIR="$RUNTIME_DIR/run"
find_free_port() {
  local port="$1"
  while lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; do
    port=$((port + 1))
  done
  echo "$port"
}
mkdir -p "$PIP_CACHE_DIR" "$RUN_DIR"
STOP_SCOPE=backend "$PWD/stop.sh"
BACKEND_PORT="$(find_free_port "$BACKEND_PORT")"
if [ ! -d "$VENV_DIR" ]; then
  python3 -m venv "$VENV_DIR"
fi
source "$VENV_DIR/bin/activate"
python -m pip install --cache-dir "$PIP_CACHE_DIR" -r backend/requirements.txt
uvicorn backend.app.main:app --host 127.0.0.1 --port "$BACKEND_PORT" &
echo "$!" > "$RUN_DIR/backend.pid"
echo "后端：http://127.0.0.1:$BACKEND_PORT/"
wait
