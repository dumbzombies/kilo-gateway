# kilo-gateway — Bun + SQLite, one process.
FROM oven/bun:1.4-alpine

WORKDIR /app

# No runtime dependencies; the lockfile keeps installs reproducible.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src

RUN mkdir -p /data && chown bun:bun /data
USER bun

ENV PORT=8080 HOST=0.0.0.0 DATA_DIR=/data
EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["bun", "src/main.ts"]
