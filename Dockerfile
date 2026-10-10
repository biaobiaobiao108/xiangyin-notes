FROM oven/bun:1.4.3-alpine AS builder

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY app ./app
COPY server ./server
COPY shared ./shared
COPY scripts ./scripts
COPY migrations ./migrations
RUN bun run build

FROM oven/bun:1.4.3-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATABASE_PATH=/data/xiangying-notes.sqlite

RUN mkdir -p /data && chown -R bun:bun /data /app

COPY --from=builder --chown=bun:bun /app/dist ./dist
COPY --from=builder --chown=bun:bun /app/migrations ./migrations

USER bun

EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["bun", "-e", "const port = Number.parseInt(Bun.env.PORT ?? '3000', 10) || 3000; fetch('http://127.0.0.1:' + port + '/api/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["bun", "dist/server/index.js"]
