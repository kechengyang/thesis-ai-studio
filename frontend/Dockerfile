FROM node:22-bookworm-slim

WORKDIR /app/frontend

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

EXPOSE 5183

CMD ["sh", "-c", "if [ ! -d node_modules ] || [ -z \"$(ls -A node_modules 2>/dev/null)\" ]; then npm ci; fi && npm run dev -- --host 0.0.0.0 --port 5183 --strictPort"]
