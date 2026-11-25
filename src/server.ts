// Runtime entry: runs on Bun *and* Node, exactly like mistral-vibe's
// `src/server.js`. `node:http` + `node:sqlite` are the only runtime APIs used,
// so both work.
//
//   bun src/server.ts      node src/server.ts
//
// Nothing runtime-specific leaks into `core.ts`; this file exists to adapt a
// `node:http` request into a web `Request` and stream the response back.

import { createServer } from "node:http";
import { Readable } from "node:stream";
import { readFileSync } from "node:fs";

import { loadConfig, VERSION } from "./config.ts";
import { Store } from "./db.ts";
import { Catalog } from "./catalog.ts";
import { createHandler, type CoreEnv } from "./core.ts";
import { Egress } from "./egress.ts";
import { UpstreamPool, defaultKeysPath } from "./keypool.ts";

const cfg = loadConfig(process.env as Record<string, string | undefined>);
const store = new Store(cfg.dbPath);
const catalog = new Catalog(cfg.upstream, cfg.catalogTtlMs);

/**
 * The dashboard shell.
 *
 * Preferred path is a text import, which Bun embeds into a `--compile` binary —
 * a filesystem read fails there (`/$bunfs/root/ui.html`). Node cannot parse an
 * `.html` import, so the dynamic import throws and we fall back to reading the
 * file beside the source. The dynamic form is required: a static import would
 * fail at parse time under Node, where no catch could help.
 */
async function loadUi(): Promise<string> {
  try {
    // Bun's `.html` import type is `HTMLBundle`; the text import yields the raw
    // source string at runtime, which the declared type does not describe.
    const embedded = (await import("./ui.html", { with: { type: "text" } })) as unknown as { default: string };
    return embedded.default;
  } catch {
    return readFileSync(new URL("./ui.html", import.meta.url), "utf8");
  }
}

const ui = await loadUi();

// Upstream credentials come from KILO_KEYS plus ~/.kilo-gateway/keys.json, so
// the pool survives restarts and stays out of the repo.
const pool = UpstreamPool.fromDisk(defaultKeysPath());
for (const key of cfg.upstreamKeys) pool.add(key);

const env: CoreEnv = {
  cfg,
  store,
  catalog,
  startedAt: Date.now(),
  egress: new Egress({ proxies: cfg.egressProxies, fetchImpl: fetch }),
  pool,
  fetchImpl: fetch,
  ui,
};

const handler = createHandler(env);

const port = cfg.port;
const host = cfg.host;
const runtime = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined" ? "bun" : `node ${process.version}`;

const server = createServer(async (req, res) => {
  const init: RequestInit & { duplex?: "half" } = { method: req.method, headers: req.headers as HeadersInit };
  if (req.method !== "GET" && req.method !== "HEAD") {
    // node:stream/web and the DOM ReadableStream differ only in typing; the
    // runtime objects are interchangeable.
    init.body = Readable.toWeb(req) as unknown as ReadableStream;
    init.duplex = "half"; // Node requires this for streaming request bodies
  }

  let out: Response;
  try {
    out = await handler(new Request(`http://${req.headers.host ?? host}${req.url}`, init));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "internal_error", message } }));
    return;
  }

  const headers: Record<string, string> = {};
  out.headers.forEach((value, name) => {
    headers[name] = value;
  });
  res.writeHead(out.status, headers);
  if (!out.body) {
    res.end();
    return;
  }
  if (headers["content-type"]?.startsWith("text/event-stream")) res.flushHeaders?.();
  try {
    for await (const chunk of out.body as unknown as AsyncIterable<Uint8Array>) {
      if (!res.write(chunk)) {
        const { promise, resolve } = Promise.withResolvers<void>();
        res.once("drain", resolve);
        await promise;
      }
    }
  } catch {
    /* client went away mid-stream */
  }
  res.end();
});

const displayHost = host === "0.0.0.0" || host === "::" ? "localhost" : host;
console.log(`kilo-gateway ${VERSION} on ${host}:${port} (${runtime})`);
console.log(`  dashboard   http://${displayHost}:${port}/`);
console.log(`  upstream    ${cfg.upstream}`);
console.log(`  database    ${cfg.dbPath}`);
console.log(`  accounts    ${store.countUsers()}`);
console.log(`  client keys ${cfg.requireKey ? "required" : "optional"}`);
console.log(`  egress      ${cfg.egressProxies.length || "direct"} (anonymous: ${cfg.anonEgress})`);
console.log(`  upstream keys ${pool.size} (${defaultKeysPath()})`);

// Keep the free-model catalog warm: without a timer the "cache" only refreshes
// when a request happens to arrive after the TTL, so an idle gateway serves a
// stale list and a busy one pays the fetch on a user's request. Refreshing one
// TTL ahead means /v1/models is always served from memory.
const catalogTimer = setInterval(
  () => {
    // `true` forces the refresh: the timer interval equals the TTL, so a
    // TTL-respecting call would fire while the cache is still fresh and do
    // nothing. fetchCatalog keeps the last good snapshot if the upstream fails.
    catalog.load(true).catch((err) => {
      // The catalog keeps its last good snapshot on failure; this is expected
      // when the upstream is unreachable, so it stays a debug-level note.
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

const retentionTimer = setInterval(
  () => {
    try {
      store.purgeDeviceCodes();
      store.purgeTokens();
      if (cfg.retentionDays > 0) store.purge(Date.now() - cfg.retentionDays * 86_400_000);
    } catch (err) {
      console.error("[kilo-gateway] retention purge failed:", err);
    }
  },
  6 * 3_600_000,
);
retentionTimer.unref?.();

server.listen(port, host);

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    console.log(`[kilo-gateway] ${signal} received, draining`);
    retentionTimer.unref?.();
    catalogTimer.unref?.();
    server.close(() => {
      store.close();
      process.exit(0);
    });
    // Do not let a hung keep-alive socket block the exit.
    setTimeout(() => {
      store.close();
      process.exit(0);
    }, 5000).unref?.();
  });
}

process.on("unhandledRejection", (reason) => {
  console.error("[kilo-gateway] unhandled rejection:", reason);
});
// A synchronous throw that escaped the handler is a bug, not a request to
// ignore: log it, stop accepting work, and exit non-zero so a supervisor
// restarts a known-clean process instead of limping along in a bad state.
process.on("uncaughtException", (err) => {
  console.error("[kilo-gateway] uncaught exception, exiting:", err);
  try {
    store.close();
  } catch {
    /* best effort */
  }
  process.exit(1);
});
