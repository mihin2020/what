# Image de prod pour Railway / Fly / Render
# cachebust: 2026-08-25-health2
FROM node:22.13-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22.13-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    WEB_BIND=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data \
    WHATSAPP_TLS_INSECURE=false
RUN mkdir -p /data /app/logs
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
EXPOSE 3000
CMD ["node", "--experimental-sqlite", "dist/index.js"]
