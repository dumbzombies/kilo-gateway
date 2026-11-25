// Web-standard core: one `handle(request, env) -> Response`, like mistral-vibe's
// `src/core.js`. Nothing here touches a runtime API, so the same code backs the
// Bun entry, the Node entry, the Cloudflare Worker, and the tests.
//
// `env` is a plain record of configuration plus two optional hooks:
//   env.UI_HTML      the dashboard shell (both servers read it from disk)
//   env.SAVE_KEYS    (unused today; kept so the shape matches the template)

import type { Config } from "./config.ts";
import { VERSION } from "./config.ts";
import type { Store } from "./db.ts";
import type { Catalog } from "./catalog.ts";
import type { Egress } from "./egress.ts";
import type { UpstreamPool } from "./keypool.ts";
import { canAdminister } from "./accounts.ts";
import { authenticate, releaseQuotaFor } from "./security.ts";
import { PROXY_PATHS, handleProxy } from "./proxy.ts";
import { handleApi } from "./api.ts";
import { handleAuth } from "./authapi.ts";

export interface CoreEnv {
  cfg: Config;
  store: Store;
  catalog: Catalog;
  startedAt: number;
  egress: Egress;
  /** Upstream Kilo credentials borrowed for anonymous traffic. */
  pool: UpstreamPool;
  fetchImpl: typeof fetch;
  ui: string;
}

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#121216"/><path d="M9 9v14M23 9v14M9 16h14" stroke="#ffdc03" stroke-width="2.5" stroke-linecap="round"/></svg>`;

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function corsHeaders(cfg: Config): Record<string, string> {
  return {
    "access-control-allow-origin": cfg.corsOrigin,
    "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers":
      "Authorization, Content-Type, X-Api-Key, Anthropic-Version, Anthropic-Beta, X-Admin-Token, X-Gateway-Source",
    "access-control-expose-headers":
      "x-request-id, x-gateway-upstream-status, x-gateway-egress, x-gateway-egress-retries, x-gateway-tier, x-gateway-degraded, x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset, retry-after",
    "access-control-max-age": "86400",
  };
}

function withHeaders(res: Response, headers: Record<string, string>): Response {
  const merged = new Headers(res.headers);
  for (const [name, value] of Object.entries(headers)) {
    if (!merged.has(name)) merged.set(name, value);
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: merged });
}

function html(body: string): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache",
      ...SECURITY_HEADERS,
    },
  });
}

/**
 * The whole HTTP surface. `?dash=0` disables the dashboard for one visit, and
 * `DASHBOARD=0` for every visit — the same escape hatch mistral-vibe documents,
 * because the UI is convenience and never a dependency of the API.
 */
export async function handle(req: Request, env: CoreEnv): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const { cfg, store, catalog } = env;
  const cors = corsHeaders(cfg);
  const startedAt = env.startedAt;

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  const proxyDeps = { cfg, store, fetchImpl: env.fetchImpl, cors, egress: env.egress, pool: env.pool };
  const apiDeps = { cfg, store, catalog, startedAt, egress: env.egress, pool: env.pool };

  // ---- landing / dashboard ---------------------------------------------------

  const dashQuery = url.searchParams.get("dash");
  const dashboardOff =
    dashQuery === "0" || (dashQuery !== "1" && String(process.env.DASHBOARD ?? "").toLowerCase() === "0");

  if ((path === "/" || path === "/index.html") && req.method === "GET") {
    if (dashboardOff) {
      return json(
        {
          ok: true,
          dashboard: "off",
          hint: "add ?dash=1 for one view, or unset DASHBOARD=0 to enable it",
          api: ["/v1/chat/completions", "/v1/messages", "/v1/models", "/health", "/api/state"],
        },
        200,
        cors,
      );
    }
    return html(env.ui);
  }

  // Device verification page: same shell, booted into the approval pane from
  // ?user_code=, matching the CLI's verification_uri.
  if (path === "/device" && req.method === "GET") return html(env.ui);

  if (path === "/favicon.svg" && req.method === "GET") {
    return new Response(FAVICON, {
      headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" },
    });
  }

  // ---- health ----------------------------------------------------------------

  if ((path === "/health" || path === "/healthz") && req.method === "GET") {
    return json(
      {
        ok: true,
        service: "kilo-gateway",
        version: VERSION,
        uptime_s: Math.round((Date.now() - startedAt) / 1000),
        mode: store.countKeys() > 0 ? "configured" : "anonymous",
        keys_configured: store.countKeys(),
        anonymous: cfg.anonEgress,
        egress: env.egress.status(),
        upstream: cfg.upstream,
      },
      200,
      cors,
    );
  }

  if (path === "/readyz" && req.method === "GET") {
    let database = true;
    try {
      store.db.query("SELECT 1").get();
    } catch {
      database = false;
    }
    const ready = database && catalog.loaded;
    return json({ ok: ready, database, catalog: catalog.status() }, ready ? 200 : 503, cors);
  }

  // ---- auth ------------------------------------------------------------------

  if (path === "/api/auth-status" && req.method === "GET") {
    return json({
      admin_required: cfg.adminToken !== "",
      key_required: cfg.requireKey,
      version: VERSION,
      account_auth: true,
    });
  }

  if (path.startsWith("/api/auth/")) {
    const handled = await handleAuth(req, url, { cfg, store });
    if (handled) return handled;
  }

  // ---- dashboard API ---------------------------------------------------------

  if (path.startsWith("/api/")) {
    // Anonymous by default; only ADMIN_TOKEN closes the dashboard.
    if (!canAdminister(req, url, cfg, store)) {
      return json(
        { error: { message: "Admin token required.", type: "authentication_error", code: "unauthorized" } },
        401,
        { "www-authenticate": 'Bearer realm="kilo-gateway"' },
      );
    }
    // The dashboard playground rides the admin session, so it works even when
    // client gateway keys are mandatory.
    if (path === "/api/play/chat/completions" && req.method === "POST") {
      const auth = { mode: "admin" as const, key: null, upstreamKey: null };
      return handleProxy(req, url, "/v1/chat/completions", auth, proxyDeps);
    }
    return handleApi(req, url, apiDeps);
  }

  // ---- model API -------------------------------------------------------------

  if (path.startsWith("/v1/")) {
    if (path === "/v1/models" && req.method === "GET") {
      const outcome = authenticate(req, url, cfg, store, env.pool);
      if (!outcome.ok) return json(outcome.body, outcome.status, outcome.headers);
      try {
        await catalog.load(url.searchParams.get("refresh") === "1");
      } catch (err) {
        // A model listing is metadata, never billable work: the slot reserved
        // while authenticating is returned on every exit path.
        releaseQuotaFor(outcome, store);
        if (!catalog.loaded) {
          const message = err instanceof Error ? err.message : String(err);
          return json({ error: { type: "upstream_error", message } }, 502);
        }
      }
      releaseQuotaFor(outcome, store);
      return json({
        object: "list",
        data: catalog.current(),
        free_count: catalog.current().length,
        kilo_total_models: catalog.status().total,
        fetched_at: catalog.status().fetched_at,
      });
    }

    if (req.method === "POST" && PROXY_PATHS[path]) {
      const outcome = authenticate(req, url, cfg, store, env.pool);
      if (!outcome.ok) return json(outcome.body, outcome.status, outcome.headers);
      try {
        return await handleProxy(req, url, path, outcome.auth, proxyDeps);
      } catch (err) {
        // A throw here bypasses `handleProxy`'s own record()/release paths, so
        // the quota slot must be returned explicitly or the key degrades
        // permanently. `releaseQuota` is idempotent per reservation.
        releaseQuotaFor(outcome, store);
        throw err;
      }
    }

    return json(
      {
        error: {
          type: "not_found",
          message: `Unsupported ${req.method} ${path}. Use GET /v1/models or POST /v1/chat/completions, /v1/messages, /v1/responses.`,
        },
      },
      404,
    );
  }

  return json({ error: { type: "not_found", message: `No route for ${req.method} ${path}.` } }, 404);
}

/** The `fetch` handler: CORS, error mapping, and optional access logging. */
export function createHandler(env: CoreEnv): (req: Request) => Promise<Response> {
  const cors = corsHeaders(env.cfg);
  return async function fetchHandler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const started = performance.now();
    let res: Response;
    try {
      res = await handle(req, env);
    } catch (err) {
      const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
      console.error(`[kilo-gateway] ${req.method} ${url.pathname} failed: ${message}`);
      res = json(
        {
          error: {
            type: "gateway_error",
            message: `Gateway internal error: ${err instanceof Error ? err.message : String(err)}`,
          },
        },
        500,
      );
    }

    const isApiSurface = url.pathname.startsWith("/v1/") || url.pathname.startsWith("/api/");
    if (isApiSurface) res = withHeaders(res, cors);

    if (env.cfg.accessLog) {
      const elapsed = (performance.now() - started).toFixed(1);
      console.log(`${req.method} ${url.pathname} ${res.status} ${elapsed}ms`);
    }
    return res;
  };
}
