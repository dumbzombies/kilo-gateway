# kilo-gateway

Kilo Gateway's free models behind one OpenAI/Anthropic-compatible endpoint —
with managed API keys, quotas, request analytics and a built-in dashboard.
Runs as a single Bun process with SQLite; no external services.

```sh
bun src/main.ts
# dashboard → http://127.0.0.1:8080/
# base URL  → http://127.0.0.1:8080/v1
```

Free models need **no account and no key**. The gateway is a wire-transparent
proxy plus a live free-model catalog: requests are forwarded untouched
(streaming included), while the gateway records usage and enforces optional
per-key limits.

## Features

- **Three wire formats** — OpenAI Chat Completions, Anthropic Messages
  (including `count_tokens`), OpenAI Responses, legacy completions and
  embeddings.
- **Dashboard** — traffic and token charts, live catalog, request log with
  filters and CSV export, a streaming playground, and key management.
- **Managed keys** — `kg_…` credentials hashed at rest, per-key requests/minute
  and requests/day limits, last-used tracking, revoke/delete. Keys can carry
  their own upstream Kilo key for paid models.
- **Usage accounting** — prompt/completion tokens parsed from JSON responses
  and from SSE (OpenAI, Anthropic and Responses events), latency, time to first
  byte, upstream status and provider errors per request.
- **SQLite persistence** — WAL mode, paginated history, retention purge every
  6 hours. No Redis, no Postgres, no Node runtime.
- **Ops-friendly** — `/healthz` and `/readyz`, graceful drain on
  `SIGINT`/`SIGTERM`, optional access log, CORS, configurable body/timeout
  limits, single-file binary build.

## Quick start

```sh
bun install                 # dev types only; runtime has no dependencies
ADMIN_TOKEN=$(openssl rand -hex 24) bun src/main.ts
```

Open the printed dashboard URL. If `ADMIN_TOKEN` was set, the dashboard asks
for it once and stores it in the browser. You can also open
`http://127.0.0.1:8080/?token=$ADMIN_TOKEN`; the token is moved out of the URL
and into `localStorage`.

Point any client at `http://127.0.0.1:8080/v1`:

```bash
curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"kilo-auto/free","messages":[{"role":"user","content":"hi"}]}'
```

```bash
# OpenAI-compatible client
OPENAI_BASE_URL=http://127.0.0.1:8080/v1
OPENAI_API_KEY=unused

# Anthropic-compatible client
ANTHROPIC_BASE_URL=http://127.0.0.1:8080
ANTHROPIC_AUTH_TOKEN=unused
```

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | Dashboard |
| `GET` | `/healthz` | Liveness; never touches upstream |
| `GET` | `/readyz` | 200 once the database and model catalog are ready |
| `GET` | `/v1/models` | Free-model catalog (live, 5-minute cache) |
| `POST` | `/v1/chat/completions` | OpenAI chat (stream + non-stream) |
| `POST` | `/v1/messages` | Anthropic messages (stream + non-stream) |
| `POST` | `/v1/messages/count_tokens` | Anthropic token estimate |
| `POST` | `/v1/responses` | OpenAI Responses |
| `POST` | `/v1/completions` | Legacy completions |
| `POST` | `/v1/embeddings` | Embeddings |
| `GET` | `/api/*` | Dashboard JSON API (admin token) |

`/v1/*` responses carry `x-request-id` and `x-gateway-upstream-status`;
upstream rate-limit headers (`x-ratelimit-*`, `retry-after`,
`openai-processing-ms`) pass through unchanged.

## Authentication

Three independent credentials exist:

| Credential | Format | Used for |
|---|---|---|
| Gateway key | `kg_…` | Client auth, quotas, per-key attribution |
| Kilo key | `sk-…` / `pk-…` | Forwarded upstream for paid models |
| Admin token | `ADMIN_TOKEN` | Dashboard API and `/v1` |

Default behaviour is a drop-in keyless gateway:

- Anonymous `/v1` requests ride Kilo's free tier.
- `REQUIRE_KEY=1` makes a gateway key (or a real Kilo key) mandatory on `/v1`.
- Only credentials that look like Kilo keys are forwarded upstream, so harness
  placeholder keys never break the free tier.
- The admin token is accepted on `/v1` too — that is what the dashboard
  playground uses — and is always stripped before proxying.
- Gateway keys are stored as SHA-256 hashes; the secret is shown once at
  creation.

Use a key:

```bash
curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Authorization: Bearer kg_your_key" \
  -H "Content-Type: application/json" \
  -d '{"model":"kilo-auto/free","messages":[{"role":"user","content":"hi"}]}'
```

Create and manage keys from **API keys** in the dashboard, or over the API:

```bash
curl -X POST http://127.0.0.1:8080/api/keys \
  -H "x-admin-token: $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"CI","rpm":60,"daily_limit":2000}'
```

A key limit field of `0` means unlimited. Limits reset on a UTC day boundary;
the request-per-minute window is the trailing 60 seconds.

### Security notes

- The listener binds `127.0.0.1` by default. Set `HOST=0.0.0.0` only behind a
  trusted network or a TLS reverse proxy.
- Without `ADMIN_TOKEN` the dashboard API is unauthenticated. Set it before
  exposing the port. The dashboard shell itself is public and contains no data.
- A per-key `upstream_key` is stored in plaintext in SQLite because the gateway
  must replay it upstream. Leave it empty if you only use free models.
- Gateway keys appear in request logs by name, never by secret.

## Configuration

Environment variables (Bun loads `.env` automatically):

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Listen port |
| `HOST` | `127.0.0.1` | Bind address |
| `ADMIN_TOKEN` | *(empty)* | Dashboard/API admin token; empty leaves the API open |
| `REQUIRE_KEY` | `0` | Require a gateway or Kilo key on `/v1` |
| `DATA_DIR` | `./data` | SQLite directory |
| `RETENTION_DAYS` | `30` | Delete request rows older than this; `0` keeps forever |
| `KILO_UPSTREAM` | `https://api.kilo.ai/api/gateway` | Upstream base URL |
| `CATALOG_TTL_MS` | `300000` | Model catalog cache lifetime |
| `UPSTREAM_TIMEOUT_MS` | `900000` | Upstream request/stream deadline |
| `MAX_BODY_BYTES` | `33554432` | Maximum accepted request body |
| `ACCESS_LOG` | `0` | One line per request on stdout |
| `CORS_ORIGIN` | `*` | `Access-Control-Allow-Origin` |

## Dashboard

| Page | What it shows |
|---|---|
| **Overview** | Requests, token throughput, errors, latency/p95, top models, recent calls, 1h/24h/7d/30d ranges |
| **Playground** | Streaming chat against any free model through the gateway |
| **Models** | Live catalog with context, modalities and 30-day usage; copy or test a model |
| **API keys** | Create keys, limits, per-key usage, revoke/delete |
| **Requests** | Filterable log with latency, TTFT, tokens, key, source; detail modal; CSV export |
| **Settings** | Runtime config, integration snippets, catalog refresh, export, log deletion |

Every number comes from the local SQLite database; charts are rendered as
inline SVG with no external assets.

## Free model catalog

`/v1/models` fetches Kilo's model list and keeps models Kilo marks as
`isFree`, with a zero-pricing + `free`-in-the-name fallback for older snapshots.
The catalog rotates upstream, so the endpoint is authoritative; the dashboard
shows when the snapshot was last refreshed. A failed refresh keeps serving the
last good snapshot and reports the error in the dashboard.

Known upstream quirks: free models share provider capacity, so individual
models can return `429` (`limit_rpd` or fleet capacity) at any time. Retry,
switch model, or attach your own provider key. The gateway forwards provider
errors and status codes untouched.

## Data

One SQLite database at `$DATA_DIR/kilo-gateway.db` (WAL mode):

- `api_keys` — hashed gateway keys, limits, optional upstream credential.
- `requests` — one row per proxied call: model, key, status, latency, TTFT,
  token counts, cost when reported, client, source, error.
- `meta` — reserved for migrations.

Set `RETENTION_DAYS=0` to keep history forever. Delete logs from **Settings** or
`DELETE /api/requests`. Export via **Requests → Export CSV** or
`GET /api/export.csv`.

## Production

Single binary:

```sh
bun build --compile src/main.ts --outfile dist/kilo-gateway
./dist/kilo-gateway
```

Docker:

```sh
docker build -t kilo-gateway .
docker run -p 8080:8080 -v kg-data:/data \
  -e ADMIN_TOKEN=replace-me -e REQUIRE_KEY=1 kilo-gateway
```

systemd:

```ini
[Unit]
Description=kilo-gateway
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/kilo-gateway
Environment=HOST=127.0.0.1
Environment=PORT=8080
Environment=ADMIN_TOKEN=replace-me
Environment=REQUIRE_KEY=1
Environment=DATA_DIR=/var/lib/kilo-gateway
Restart=always
RestartSec=2
TimeoutStopSec=15
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/var/lib/kilo-gateway
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

`SIGTERM` drains in-flight requests (10-second hard deadline), closes SQLite
and exits 0. Upstream fetches are bounded by `UPSTREAM_TIMEOUT_MS`, and a
thrown request handler returns a JSON 500 without stopping the process.

## Development

```sh
bun test          # unit + HTTP integration against a fake upstream
bunx tsc --noEmit # typecheck
bun run dev       # watch mode
```

The HTTP tests mount the production handler on an ephemeral `Bun.serve` port
and exercise streaming, token accounting, key auth, quotas, error passthrough,
admin auth, filtering and CSV export — no live upstream required.

## License

MIT
