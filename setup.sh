#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUNTIME_DIR="$ROOT_DIR/.runtime"
VENV_DIR="$RUNTIME_DIR/python"
PIP_CACHE_DIR="$RUNTIME_DIR/pip-cache"
NPM_CACHE_DIR="$RUNTIME_DIR/npm-cache"

mkdir -p "$PIP_CACHE_DIR" "$NPM_CACHE_DIR" "$RUNTIME_DIR/logs"

if [ ! -d "$VENV_DIR" ]; then
  python3 -m venv "$VENV_DIR"
fi

source "$VENV_DIR/bin/activate"
python -m pip install --upgrade pip
python -m pip install --cache-dir "$PIP_CACHE_DIR" -r "$ROOT_DIR/backend/requirements.txt"

cd "$ROOT_DIR/frontend"
npm install --cache "$NPM_CACHE_DIR"

echo "隔离环境已准备好：$RUNTIME_DIR"
