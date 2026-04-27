#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
RUNTIME_DIR="$PWD/.runtime"
VENV_DIR="$RUNTIME_DIR/python"
PIP_CACHE_DIR="$RUNTIME_DIR/pip-cache"
BACKEND_PORT="${BACKEND_PORT:-8011}"
RUN_DIR="$RUNTIME_DIR/run"
mkdir -p "$PIP_CACHE_DIR" "$RUN_DIR"
STOP_SCOPE=backend "$PWD/stop.sh"
if [ ! -d "$VENV_DIR" ]; then
  python3 -m venv "$VENV_DIR"
fi
source "$VENV_DIR/bin/activate"
python -m pip install --cache-dir "$PIP_CACHE_DIR" -r backend/requirements.txt
uvicorn backend.app.main:app --host 127.0.0.1 --port "$BACKEND_PORT" &
echo "$!" > "$RUN_DIR/backend.pid"
wait
