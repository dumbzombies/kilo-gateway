# kilo-gateway

Kilo Gateway's free models behind one OpenAI/Anthropic-compatible endpoint — managed `kg_` keys,
per-key quotas, request analytics, and a built-in dashboard. Single Bun process + SQLite; no
external services, no runtime npm dependencies.

## Start here

Before substantive work read `.agents/state.md`, then `.agents/memory.md`. After a large change,
update them per `.agents/README.md`.

## Commands

```sh
bun src/server.ts                                 # run on Bun or Node (npm start)
node src/server.ts                                # explicit Node (npm run start:node)
bun src/main.ts                                   # Bun-only entry: idleTimeout + body cap
bun test                                          # 98 tests, no network
bun node_modules/typescript/bin/tsc --noEmit      # typecheck (avoid a global tsc shim on Termux)
bun build --compile src/server.ts --outfile dist/kilo-gateway
cd cfwork && npx wrangler deploy                  # Cloudflare Worker, pass-through
```

## Layout

| Path | Role |
|---|---|
| `src/main.ts` | bootstrap: config, store, catalog, `Bun.serve`, retention, graceful shutdown |
| `src/app.ts` | `createApp()` — single `Request -> Response`; health, dashboard shell, routing |
| `src/api.ts` | dashboard JSON API under `/api/*` (admin-token gated) |
| `src/proxy.ts` | wire-transparent `/v1/*` forwarding, header policy, usage recording |
| `src/catalog.ts` | TTL-cached free-model catalog from `${KILO_UPSTREAM}/models` |
| `src/db.ts` | SQLite `Store`: `api_keys`, `requests`, aggregates, purge |
| `src/security.ts` | `kg_` key generation/hashing, admin auth, `authenticate()` |
| `src/usage.ts` | JSON + SSE usage parsing, model/error extraction |
| `src/ui.html` | single-file dashboard (inline CSS/JS) |
| `src/config.ts` | env-loading with safe defaults; `VERSION` |
| `test/` | bun tests against a fake upstream on an ephemeral port |

## Conventions

- ESM with explicit `.ts` import suffixes; `verbatimModuleSyntax` — use `import type`.
- Every config value has a default; the gateway must run with no environment at all.
- `createApp()` must stay dependency-injected (`fetchImpl`, `ui`, `startedAt`) so tests need no
  network or real database.
- The admin token never goes upstream; real Kilo keys (`sk-`/`pk-`) pass through untouched.
- Runtime state (`data/`, `logs/`, `.env`) is gitignored — keep it that way.
