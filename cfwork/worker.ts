// Cloudflare Worker entry — the third runtime, as in mistral-vibe's `cfwork/`.
//
//   cd cfwork && npx wrangler deploy
//
// Like the template, this is a pass-through: the caller's own Kilo key arrives
// per request and is forwarded upstream. There are no secrets and no dashboard
// database here (Workers have no SQLite), so the Worker exposes the model API
// only — `/v1/models`, `/v1/chat/completions`, `/v1/messages`, plus `/health`.
//
// The request/response logic lives in `src/proxy.ts` and `src/catalog.ts`, which
// are Web-standard; this file only wires them without a Store.

import { Catalog } from "../src/catalog.ts";
import { PROXY_PATHS, handleProxy } from "../src/proxy.ts";
import { looksLikeKiloKey } from "../src/security.ts";

const UPSTREAM = "https://api.kilo.ai/api/gateway";
const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "Authorization, Content-Type, anthropic-version, anthropic-beta, x-api-key",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS },
  });
}

/** A Store-shaped stub: the Worker never persists, so every write is a no-op. */
const storeStub = {
  insertRequest() {},
  touchKey() {},
  keyRequestsSince: () => 0,
};

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (path === "/health" || path === "/healthz") {
      return json({ ok: true, service: "kilo-gateway", mode: "worker-passthrough", upstream: UPSTREAM });
    }

    // Pass-through auth: the caller supplies a real Kilo key.
    const header = request.headers.get("authorization") || "";
    const token = /^bearer\s+/i.test(header) ? header.slice(7).trim() : request.headers.get("x-api-key") || "";
    if (url.pathname.startsWith("/v1/") && !looksLikeKiloKey(token)) {
      return json(
        { error: { type: "authentication_error", message: "Send Authorization: Bearer <kilo-key>." } },
        401,
      );
    }

    if (path === "/v1/models" && request.method === "GET") {
      const catalog = new Catalog(UPSTREAM, 300_000);
      try {
        const models = await catalog.load();
        return json({ object: "list", data: models, free_count: models.length });
      } catch (err) {
        return json({ error: { type: "upstream_error", message: String(err) } }, 502);
      }
    }

    if (request.method === "POST" && PROXY_PATHS[path] && path !== "/v1/embeddings") {
      const cfg = {
        upstream: UPSTREAM,
        upstreamTimeoutMs: 900_000,
        maxBodyBytes: 32 * 1024 * 1024,
        anonEgress: "direct" as const,
        authEgress: "auto" as const,
      };
      // The Worker has no proxy pool and no database; typed loosely because the
      // only members `handleProxy` touches are the ones above.
      const deps = {
        cfg,
        store: storeStub,
        fetchImpl: fetch,
        cors: CORS,
      } as unknown as Parameters<typeof handleProxy>[4];
      const auth = { mode: "open" as const, key: null, upstreamKey: token };
      return handleProxy(request, url, path, auth, deps);
    }

    return json({ error: { type: "not_found", message: `No route for ${request.method} ${path}.` } }, 404);
  },
};
