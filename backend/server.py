import os
import uvicorn
from backend.app.main import app  # noqa: F401  # direct import so PyInstaller can trace it


def main():
    host = os.environ.get('BACKEND_HOST', '127.0.0.1')
    port = int(os.environ.get('BACKEND_PORT', '8011'))
    uvicorn.run(app, host=host, port=port)


if __name__ == '__main__':
    main()
