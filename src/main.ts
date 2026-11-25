// kilo-gateway — Bun entrypoint.
//
//   POST /v1/chat/completions   OpenAI chat wire
//   POST /v1/messages           Anthropic messages wire
//   POST /v1/responses          OpenAI responses wire
//   GET  /v1/models             free-model catalog
//   GET  /                      dashboard
//
// Prefer `src/server.ts`, which runs the same core on Bun *and* Node and is what
// `npm start` uses. This entry stays because `Bun.serve` offers two knobs the
// node:http entry cannot express: `idleTimeout` for multi-minute streams, and
// `maxRequestBodySize` for large prompts.

import { VERSION, loadConfig } from "./config.ts";
import { UpstreamPool, defaultKeysPath } from "./keypool.ts";
import { Store } from "./db.ts";
import { Catalog } from "./catalog.ts";
import { createApp } from "./app.ts";

const cfg = loadConfig();
const store = new Store(cfg.dbPath);
const catalog = new Catalog(cfg.upstream, cfg.catalogTtlMs);
const pool = UpstreamPool.fromDisk(defaultKeysPath());
for (const key of cfg.upstreamKeys) pool.add(key);
const app = createApp({ cfg, store, catalog, startedAt: Date.now(), pool });

const server = Bun.serve({
  hostname: cfg.host,
  port: cfg.port,
  // Long completions stream for minutes; keep the socket alive between chunks.
  idleTimeout: 255,
  maxRequestBodySize: cfg.maxBodyBytes,
  fetch: app.fetch,
  error(err) {
    console.error("[kilo-gateway] unhandled request error:", err);
    return Response.json(
      { error: { type: "gateway_error", message: `Gateway internal error: ${err.message}` } },
      { status: 500 },
    );
  },
});

const displayHost = cfg.host === "0.0.0.0" || cfg.host === "::" ? "localhost" : cfg.host;
console.log(`kilo-gateway ${VERSION}`);
console.log(`  listening   http://${displayHost}:${cfg.port}`);
console.log(`  dashboard   http://${displayHost}:${cfg.port}/`);
console.log(`  upstream    ${cfg.upstream}`);
console.log(`  database    ${cfg.dbPath}`);
console.log(`  admin auth  ${cfg.adminToken ? "ADMIN_TOKEN required" : "open (ADMIN_TOKEN unset)"}`);
console.log(`  client keys ${cfg.requireKey ? "required (REQUIRE_KEY=1)" : "optional"}`);

const accounts = store.countUsers();
if (accounts > 0) {
  console.log(`  accounts    ${accounts} (dashboard login required)`);
} else if (!cfg.adminToken) {
  console.warn(
    "[kilo-gateway] warning: no accounts and no ADMIN_TOKEN — the dashboard is open to anyone who can reach this port.",
  );
}
if (cfg.egressProxies.length > 0) {
  console.log(`  egress      ${cfg.egressProxies.length} rotating prox${cfg.egressProxies.length === 1 ? "y" : "ies"}`);
}

const catalogTimer = setInterval(
  () => {
    // `true` forces the refresh: the timer interval equals the TTL, so a
    // TTL-respecting call would fire while the cache is still fresh and do
    // nothing. fetchCatalog keeps the last good snapshot if the upstream fails.
    catalog.load(true).catch((err) => {
      console.warn(`[kilo-gateway] catalog refresh failed: ${err instanceof Error ? err.message : err}`);
    });
  },
  Math.max(60_000, cfg.catalogTtlMs),
);
catalogTimer.unref?.();

catalog
  .load()
  .then((models) => console.log(`[kilo-gateway] catalog ready: ${models.length} free models`))
  .catch((err) => console.warn(`[kilo-gateway] catalog unavailable: ${err instanceof Error ? err.message : err}`));

function purge(): void {
  try {
    // Expired device codes and tokens are dropped regardless of request
    // retention, so a lapsed session can never be replayed.
    store.purgeDeviceCodes();
    store.purgeTokens();
    if (cfg.retentionDays <= 0) return;
    const deleted = store.purge(Date.now() - cfg.retentionDays * 86_400_000);
    if (deleted) console.log(`[kilo-gateway] retention: removed ${deleted} old request rows`);
  } catch (err) {
    console.error("[kilo-gateway] retention purge failed:", err);
  }
}
purge();
const retentionTimer = setInterval(purge, 6 * 3_600_000);
retentionTimer.unref?.();

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearInterval(retentionTimer);
  console.log(`[kilo-gateway] ${signal} received, draining`);
  const deadline = setTimeout(() => process.exit(1), 10_000);
  deadline.unref?.();
  try {
    await server.stop();
  } catch {
    /* already stopped */
  }
  store.close();
  clearTimeout(deadline);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

process.on("unhandledRejection", (reason) => {
  console.error("[kilo-gateway] unhandled rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[kilo-gateway] uncaught exception:", err);
});
