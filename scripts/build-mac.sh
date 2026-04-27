#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "=== 1/4  Build Python backend (PyInstaller) ==="
cd backend
pip install pyinstaller --quiet
pyinstaller server.spec --noconfirm
cd "$ROOT"

echo "=== 2/4  Build frontend (Vite) ==="
cd frontend
npm ci --silent
npm run build
cd "$ROOT"

echo "=== 3/4  Copy assets into electron/ ==="
rm -rf electron/dist electron/backend
cp -r frontend/dist electron/dist
cp -r backend/dist/server electron/backend

echo "=== 4/4  Package Electron app ==="
cd electron
npm install --silent
npm run build
cd "$ROOT"

echo ""
echo "Done. DMG files are in release/"
ls release/*.dmg 2>/dev/null || true
