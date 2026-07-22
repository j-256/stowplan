FROM node:24.18.0-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:next && cp -R public .next/standalone/public && mkdir -p .next/standalone/.next && cp -R .next/static .next/standalone/.next/static && npm prune --omit=dev

FROM node:24.18.0-alpine
ENV NODE_ENV=production PORT=3000 STOWPLAN_SQLITE_PATH=/data/stowplan.sqlite
WORKDIR /app
COPY --from=build /app .
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 3000
USER node
CMD ["node", "scripts/node-server.mjs"]
