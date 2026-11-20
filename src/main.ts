// kilo-gateway — Bun entrypoint.
//
//   POST /v1/chat/completions   OpenAI chat wire
//   POST /v1/messages           Anthropic messages wire
//   POST /v1/responses          OpenAI responses wire
//   GET  /v1/models             free-model catalog
//   GET  /                      dashboard
//
// Free models need no credential at all. Gateway keys (`kg_...`, created in
// the dashboard) add per-client quotas and usage attribution; a real Kilo key
// (`sk-...`) may be sent straight through for paid models.

import { VERSION, loadConfig } from "./config.ts";
import { Store } from "./db.ts";
import { Catalog } from "./catalog.ts";
import { createApp } from "./app.ts";

const cfg = loadConfig();
const store = new Store(cfg.dbPath);
const catalog = new Catalog(cfg.upstream, cfg.catalogTtlMs);
const app = createApp({ cfg, store, catalog, startedAt: Date.now() });

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

if (!cfg.adminToken) {
  console.warn(
    "[kilo-gateway] warning: the dashboard API is unauthenticated. Set ADMIN_TOKEN before exposing this port.",
  );
}

catalog
  .load()
  .then((models) => console.log(`[kilo-gateway] catalog ready: ${models.length} free models`))
  .catch((err) => console.warn(`[kilo-gateway] catalog unavailable: ${err instanceof Error ? err.message : err}`));

function purge(): void {
  if (cfg.retentionDays <= 0) return;
  const cutoff = Date.now() - cfg.retentionDays * 86_400_000;
  try {
    const deleted = store.purge(cutoff);
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
