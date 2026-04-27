#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR/frontend"
NPM_CACHE_DIR="$ROOT_DIR/.runtime/npm-cache"
mkdir -p "$NPM_CACHE_DIR"
if [ ! -d node_modules ]; then
  npm install --cache "$NPM_CACHE_DIR"
fi
npm run dev -- --host 127.0.0.1
