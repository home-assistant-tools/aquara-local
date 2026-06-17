# Build context = REPO ROOT (cần cả addon/ lẫn client/).
#   docker build -f addon/Dockerfile -t aquara-matter-addon .
# Vite bundle code server (gồm client/) → image runtime self-contained.
FROM node:20-alpine AS build
WORKDIR /src/addon
COPY addon/package.json ./
RUN npm install --no-audit --no-fund
WORKDIR /src
COPY client/ ./client/
COPY addon/ ./addon/
WORKDIR /src/addon
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=7654
COPY --from=build /src/addon/build ./build
COPY --from=build /src/addon/package.json ./
COPY --from=build /src/addon/node_modules ./node_modules
EXPOSE 7654
CMD ["npx", "remix-serve", "./build/server/index.js"]
