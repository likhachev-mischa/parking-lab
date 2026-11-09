FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY scripts/ scripts/
COPY web/ web/
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DB_PATH=/data/forum.sqlite BACKUP_DIR=/data/backups
RUN mkdir /data && chown node:node /data
COPY server/ server/
COPY --from=build /app/dist/ dist/
USER node
EXPOSE 3000
CMD ["node", "server/main.mjs"]
