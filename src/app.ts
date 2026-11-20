// HTTP surface. One pure `Request -> Response` app: `Bun.serve` mounts it in
// production, `bun test` mounts it on an ephemeral port against a fake
// upstream. The dashboard shell is public; every byte of data behind it needs
// the admin token.

import type { Config } from "./config.ts";
import { VERSION } from "./config.ts";
import type { Store } from "./db.ts";
import type { Catalog } from "./catalog.ts";
import { handleApi } from "./api.ts";
import { PROXY_PATHS, handleProxy } from "./proxy.ts";
import { authenticate, isAdmin } from "./security.ts";
import uiHtml from "./ui.html" with { type: "text" };

export interface AppDeps {
  cfg: Config;
  store: Store;
  catalog: Catalog;
  fetchImpl?: typeof fetch;
  startedAt?: number;
  ui?: string;
}

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#121216"/><path d="M9 9v14M23 9v14M9 16h14" stroke="#8b7cf6" stroke-width="2.5" stroke-linecap="round"/></svg>`;

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
      "x-request-id, x-gateway-upstream-status, x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset, retry-after",
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

export function createApp(deps: AppDeps): { fetch: (req: Request) => Promise<Response> } {
  const { cfg, store, catalog } = deps;
  const startedAt = deps.startedAt ?? Date.now();
  const cors = corsHeaders(cfg);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const ui = deps.ui ?? uiHtml;
  const proxyDeps = { cfg, store, fetchImpl, cors };
  const apiDeps = { cfg, store, catalog, startedAt };

  async function route(req: Request, url: URL): Promise<Response> {
    const path = url.pathname;

    if (path === "/healthz" && req.method === "GET") {
      return json({ ok: true, service: "kilo-gateway", version: VERSION, uptime_ms: Date.now() - startedAt });
    }

    if (path === "/readyz" && req.method === "GET") {
      let database = true;
      try {
        store.db.query("SELECT 1").get();
      } catch {
        database = false;
      }
      const ready = database && catalog.loaded;
      return json(
        { ok: ready, database, catalog: catalog.status() },
        ready ? 200 : 503,
      );
    }

    if ((path === "/" || path === "/index.html") && req.method === "GET") {
      return new Response(ui, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-cache",
          ...SECURITY_HEADERS,
        },
      });
    }

    if (path === "/favicon.svg" && req.method === "GET") {
      return new Response(FAVICON, {
        headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" },
      });
    }

    if (path === "/api/auth-status" && req.method === "GET") {
      return json({
        admin_required: cfg.adminToken !== "",
        key_required: cfg.requireKey,
        version: VERSION,
      });
    }

    if (path.startsWith("/api/")) {
      if (!isAdmin(req, url, cfg)) {
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

    if (path.startsWith("/v1/")) {
      if (path === "/v1/models" && req.method === "GET") {
        const outcome = authenticate(req, url, cfg, store);
        if (!outcome.ok) return json(outcome.body, outcome.status, outcome.headers);
        try {
          await catalog.load(url.searchParams.get("refresh") === "1");
        } catch (err) {
          if (!catalog.loaded) {
            const message = err instanceof Error ? err.message : String(err);
            return json({ error: { type: "upstream_error", message } }, 502);
          }
        }
        return json({
          object: "list",
          data: catalog.current(),
          free_count: catalog.current().length,
          kilo_total_models: catalog.status().total,
          fetched_at: catalog.status().fetched_at,
        });
      }

      if (req.method === "POST" && PROXY_PATHS[path]) {
        const outcome = authenticate(req, url, cfg, store);
        if (!outcome.ok) return json(outcome.body, outcome.status, outcome.headers);
        return handleProxy(req, url, path, outcome.auth, proxyDeps);
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

  async function fetchHandler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const started = performance.now();
    let res: Response;
    try {
      if (req.method === "OPTIONS") {
        res = new Response(null, { status: 204, headers: cors });
      } else {
        res = await route(req, url);
      }
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

    if (cfg.accessLog) {
      const elapsed = (performance.now() - started).toFixed(1);
      console.log(`${req.method} ${url.pathname} ${res.status} ${elapsed}ms`);
    }
    return res;
  }

  return { fetch: fetchHandler };
}
