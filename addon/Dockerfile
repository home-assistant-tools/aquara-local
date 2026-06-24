# Build context = REPO ROOT (cần cả addon/ lẫn client/).
#   docker build -f addon/Dockerfile -t aquara-matter-addon .
# Vite bundle code server (gồm client/) → image runtime self-contained.
FROM node:20-alpine AS build
WORKDIR /src/addon
COPY addon/package.json addon/package-lock.json ./
RUN npm ci --no-audit --no-fund
RUN ln -s /src/addon/node_modules /src/node_modules
WORKDIR /src
COPY client/ ./client/
COPY addon/ ./addon/
WORKDIR /src/addon
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=7654
COPY addon/package.json addon/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=build /src/addon/build ./build
EXPOSE 7654
# Khởi động remix-serve, rồi TỰ gọi /login một lần để KÍCH bootstrap NGAY lúc start
# (Pha A local + Pha B cloud) — KHÔNG phụ thuộc user/HA truy cập. Headless/offline vẫn dựng cầu nối.
# retry tới khi server bind (box chậm vẫn ổn), rồi wait remix-serve giữ container.
CMD ["sh", "-c", "npx remix-serve ./build/server/index.js & SRV=$!; until wget -qO- -T2 http://127.0.0.1:7654/login >/dev/null 2>&1; do sleep 2; done; echo '[entrypoint] bootstrap kicked'; wait $SRV"]
