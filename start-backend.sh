#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
RUNTIME_DIR="$PWD/.runtime"
VENV_DIR="$RUNTIME_DIR/python"
PIP_CACHE_DIR="$RUNTIME_DIR/pip-cache"
mkdir -p "$PIP_CACHE_DIR"
if [ ! -d "$VENV_DIR" ]; then
  python3 -m venv "$VENV_DIR"
fi
source "$VENV_DIR/bin/activate"
python -m pip install --cache-dir "$PIP_CACHE_DIR" -r backend/requirements.txt
uvicorn backend.app.main:app --reload --host 127.0.0.1 --port 8001
