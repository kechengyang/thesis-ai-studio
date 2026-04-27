# -*- mode: python ; coding: utf-8 -*-
import sys
from pathlib import Path
from PyInstaller.utils.hooks import collect_all, collect_data_files

# SPECPATH is backend/ — parent is the project root so 'backend' package is importable
PROJECT_ROOT = str(Path(SPECPATH).parent)

datas = []
binaries = []
hiddenimports = []

# Collect all submodules and data for tricky packages
for pkg in ('uvicorn', 'fastapi', 'starlette', 'matplotlib', 'pandas', 'numpy',
            'openpyxl', 'pypdf', 'beautifulsoup4', 'openai', 'httpx', 'anyio',
            'python_multipart', 'multipart'):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

# Matplotlib font/config data
datas += collect_data_files('matplotlib')

a = Analysis(
    ['server.py'],
    pathex=[PROJECT_ROOT],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports + [
        'backend.app.main',
        'backend.app.config',
        'backend.app.analysis_skills',
        'backend.app.literature',
        'backend.app.providers',
        'backend.app.schemas',
        'uvicorn.logging',
        'uvicorn.loops',
        'uvicorn.loops.auto',
        'uvicorn.protocols',
        'uvicorn.protocols.http',
        'uvicorn.protocols.http.auto',
        'uvicorn.protocols.websockets',
        'uvicorn.protocols.websockets.auto',
        'uvicorn.lifespan',
        'uvicorn.lifespan.on',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='server',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='server',
)
