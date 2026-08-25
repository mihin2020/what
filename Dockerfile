# Image de prod pour Railway / Fly / Render
# FORCE_REBUILD=2026-08-25T03:16-qr-fix
FROM node:22.13-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && echo "build-ok-memory-qr"

FROM node:22.13-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    WEB_BIND=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data \
    WHATSAPP_TLS_INSECURE=false \
    BUILD_MARKER=memory-qr-20260825c
RUN mkdir -p /data /app/data /app/logs
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
EXPOSE 3000
# Cree les dossiers AVANT le process (compatible meme ancienne logique /app/data).
CMD ["sh", "-c", "mkdir -p /data /app/data /app/logs && echo BUILD_MARKER=$BUILD_MARKER && node --experimental-sqlite dist/index.js"]
