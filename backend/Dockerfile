FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    MPLBACKEND=Agg \
    UV_LINK_MODE=copy

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
        gdebi-core \
    && QUARTO_VERSION=1.6.42 \
    && ARCH=$(dpkg --print-architecture) \
    && curl -fsSL "https://github.com/quarto-dev/quarto-cli/releases/download/v${QUARTO_VERSION}/quarto-${QUARTO_VERSION}-linux-${ARCH}.deb" -o /tmp/quarto.deb \
    && gdebi --non-interactive /tmp/quarto.deb \
    && rm /tmp/quarto.deb \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir uv

COPY backend/requirements.txt /tmp/backend-requirements.txt
RUN uv pip install --system -r /tmp/backend-requirements.txt

RUN mkdir -p /app/.runtime/projects

EXPOSE 8011

CMD ["sh", "-c", "uv pip install --system -r backend/requirements.txt && python -m uvicorn backend.app.main:app --host 0.0.0.0 --port 8011 --reload"]
