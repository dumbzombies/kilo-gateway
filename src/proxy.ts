// Transparent proxy for Kilo Gateway's wire protocols.
//
// Requests are forwarded untouched (including SSE) so the gateway is wire-
// transparent; the only local work is credential handling, usage accounting
// and one row per request for the dashboard.

import { randomUUID } from "node:crypto";
import type { Config } from "./config.ts";
import type { RequestRecord, Store } from "./db.ts";
import type { Egress, EgressMode } from "./egress.ts";
import type { UpstreamPool } from "./keypool.ts";
import type { AuthContext } from "./security.ts";
import { looksLikeKiloKey } from "./security.ts";
import { UsageScanner, emptyUsage, extractError, extractModel, usageFromPayload } from "./usage.ts";

export const PROXY_PATHS: Record<string, true> = {
  "/v1/chat/completions": true,
  "/v1/messages": true,
  "/v1/messages/count_tokens": true,
  "/v1/responses": true,
  "/v1/completions": true,
  "/v1/embeddings": true,
};

export interface ProxyDeps {
  cfg: Config;
  store: Store;
  fetchImpl: typeof fetch;
  cors: Record<string, string>;
  egress?: Egress;
  /** Upstream credential pool; informed when a pooled key is rejected. */
  pool?: UpstreamPool;
}

function jsonResponse(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function clientAddress(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  const real = req.headers.get("x-real-ip");
  const value = forwarded?.split(",")[0]?.trim() || real?.trim() || "";
  return value.slice(0, 100);
}

function requestSource(req: Request): string {
  const value = (req.headers.get("x-gateway-source") || "").trim().toLowerCase();
  return value === "dashboard" ? "dashboard" : "api";
}

/**
 * Wire-faithful upstream headers.
 *
 * Kilo's gateway serves Anthropic's `/v1/messages` natively, so an Anthropic
 * client's headers must survive unchanged: `anthropic-version`, `anthropic-beta`,
 * and the `x-api-key` credential style. Rewriting `x-api-key` into
 * `Authorization: Bearer` would be an unverifiable transformation of a working
 * request, so the client's own auth header is forwarded *as sent* and a Bearer
 * form is added alongside it when a credential is known.
 */
/**
 * The query string to forward upstream.
 *
 * `?token=` is one of the ways a client may authenticate (see
 * `presentedToken`). It must not cross the egress boundary: forwarding it would
 * write the caller's credential into the upstream's access logs. Every other
 * parameter is passed through untouched, because some upstreams key behavior
 * off them.
 */
function forwardSearch(url: URL): string {
  if (!url.searchParams.has("token")) return url.search;
  const forwarded = new URLSearchParams(url.searchParams);
  forwarded.delete("token");
  const search = forwarded.toString();
  return search === "" ? "" : `?${search}`;
}

/**
 * Buffers a request body, giving up as soon as it exceeds `limit`.
 * Returns `null` when the body was too large.
 */
async function readCapped(req: Request, limit: number): Promise<ArrayBuffer | null> {
  if (!req.body) return new ArrayBuffer(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel("body too large").catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

function upstreamHeaders(req: Request, auth: AuthContext): Headers {
  const headers = new Headers();
  headers.set("content-type", req.headers.get("content-type") || "application/json");
  const accept = req.headers.get("accept");
  if (accept) headers.set("accept", accept);

  // Anthropic protocol headers ride through untouched.
  for (const name of ["anthropic-version", "anthropic-beta"]) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }

  // The credential to present upstream, in whichever forms the caller may use.
  const bearer = auth.upstreamKey ?? "";
  const xApiKey = req.headers.get("x-api-key") ?? "";

  if (xApiKey) {
    // Anthropic clients put the key in x-api-key; keep it exactly where it was.
    headers.set("x-api-key", auth.upstreamKey && !looksLikeKiloKey(xApiKey) ? auth.upstreamKey : xApiKey);
  }
  if (bearer) {
    headers.set("authorization", `Bearer ${bearer}`);
  } else if (xApiKey) {
    // Client presented only the Anthropic style; mirror it into Bearer too, so
    // the request works whether the gateway reads either header.
    headers.set("authorization", `Bearer ${xApiKey}`);
  } else if (auth.mode === "open") {
    const raw = req.headers.get("authorization");
    if (raw && looksLikeKiloKey(raw)) headers.set("authorization", raw);
  }
  return headers;
}

function outputHeaders(upstream: Response, deps: ProxyDeps, requestId: string): Record<string, string> {
  const out: Record<string, string> = {
    ...deps.cors,
    "x-request-id": requestId,
    "x-gateway-upstream-status": String(upstream.status),
  };
  const copy = [
    "content-type",
    "cache-control",
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-reset",
    "retry-after",
    "openai-processing-ms",
    // Anthropic wire: the SDK reads these, and they are the only place the
    // upstream exposes its own request id and token budgets.
    "request-id",
    "anthropic-ratelimit-requests-limit",
    "anthropic-ratelimit-requests-remaining",
    "anthropic-ratelimit-requests-reset",
    "anthropic-ratelimit-tokens-limit",
    "anthropic-ratelimit-tokens-remaining",
    "anthropic-ratelimit-tokens-reset",
    "anthropic-ratelimit-input-tokens-limit",
    "anthropic-ratelimit-input-tokens-remaining",
    "anthropic-ratelimit-input-tokens-reset",
    "anthropic-ratelimit-output-tokens-limit",
    "anthropic-ratelimit-output-tokens-remaining",
    "anthropic-ratelimit-output-tokens-reset",
  ];
  for (const name of copy) {
    const value = upstream.headers.get(name);
    if (value) out[name] = value;
  }
  const ctype = out["content-type"] || "";
  if (ctype.includes("text/event-stream")) {
    out["cache-control"] = "no-cache, no-transform";
    out["x-accel-buffering"] = "no";
  }
  return out;
}

export async function handleProxy(
  req: Request,
  url: URL,
  path: string,
  auth: AuthContext,
  deps: ProxyDeps,
): Promise<Response> {
  const started = performance.now();
  const requestId = randomUUID();
  const { cfg, store } = deps;

  let rawBody: ArrayBuffer | null = null;
  if (req.method === "POST") {
    // Refuse an oversized body before buffering it: the declared length is
    // advisory, so the stream is counted as it is read and abandoned the moment
    // it crosses the cap. Without this a 500 MB prompt would be fully buffered
    // before being rejected.
    const declared = Number(req.headers.get("content-length") || 0);
    if (declared > cfg.maxBodyBytes) {
      // Rejected before any upstream work: the quota slot reserved during
      // authentication must come back, or clients lose quota to bad requests.
      if (auth.key) store.releaseQuota(auth.key.id, auth.quotaTicket);
      return jsonResponse(
        {
          error: {
            type: "request_too_large",
            message: `Request body exceeds the ${cfg.maxBodyBytes} byte limit.`,
          },
        },
        413,
        { ...deps.cors, "x-request-id": requestId },
      );
    }
    rawBody = await readCapped(req, cfg.maxBodyBytes);
    if (rawBody === null) {
      if (auth.key) store.releaseQuota(auth.key.id, auth.quotaTicket);
      return jsonResponse(
        {
          error: {
            type: "request_too_large",
            message: `Request body exceeds the ${cfg.maxBodyBytes} byte limit.`,
          },
        },
        413,
        { ...deps.cors, "x-request-id": requestId },
      );
    }
  }
  const bodyText = rawBody ? new TextDecoder().decode(rawBody) : null;
  const model = extractModel(bodyText);
  const source = requestSource(req);
  const client = clientAddress(req);

  let finished = false;
  let egressVia: string | null = null;
  let egressRetries = 0;
  const record = (opts: {
    status: number;
    upstreamStatus: number | null;
    stream: boolean;
    prompt?: number;
    completion?: number;
    total?: number;
    cost?: number | null;
    ttft?: number | null;
    error?: string | null;
  }): void => {
    if (finished) return;
    finished = true;
    const row: RequestRecord = {
      id: requestId,
      ts: Date.now(),
      key_id: auth.key?.id ?? null,
      key_name: auth.key?.name ?? (auth.mode === "admin" ? "dashboard" : null),
      method: req.method,
      path,
      model,
      status: opts.status,
      upstream_status: opts.upstreamStatus,
      stream: opts.stream,
      duration_ms: performance.now() - started,
      ttft_ms: opts.ttft ?? null,
      prompt_tokens: opts.prompt ?? 0,
      completion_tokens: opts.completion ?? 0,
      total_tokens: opts.total ?? (opts.prompt ?? 0) + (opts.completion ?? 0),
      cost_usd: opts.cost ?? null,
      client,
      error: opts.error ?? null,
      source,
      egress: egressVia,
      egress_retries: egressRetries,
    };
    try {
      store.insertRequest(row);
    } catch (err) {
      console.error(`[kilo-gateway] failed to record request ${requestId}:`, err);
    } finally {
      // The row now exists, so the reservation that admitted this request is
      // superseded by the counted row. Releasing unconditionally also covers the
      // paths where nothing was reserved (anonymous/admin traffic).
      if (auth.key) store.releaseQuota(auth.key.id, auth.quotaTicket);
    }
  };

  // Kill the upstream fetch when the client hangs up or the upstream stalls.
  const timeout = AbortSignal.timeout(cfg.upstreamTimeoutMs);
  const signal = AbortSignal.any([req.signal, timeout]);
  const init: RequestInit = { method: req.method, headers: upstreamHeaders(req, auth), signal };
  if (rawBody) init.body = rawBody;

  // Egress policy. Anonymous traffic (no key, or a key past its quota) always
  // rides the WARP pool unless the operator opted out; authenticated traffic
  // may pin direct or WARP per key, else follows AUTH_EGRESS.
  const pinned = auth.key?.egress === "direct" || auth.key?.egress === "warp" ? auth.key.egress : null;
  const egressMode: EgressMode =
    auth.mode === "key" && pinned
      ? pinned
      : auth.mode === "key"
        ? cfg.authEgress === "direct"
          ? "direct"
          : "warp"
        : cfg.anonEgress === "direct" && !auth.degraded
          ? "direct"
          : "warp";

  let upstream: Response;
  try {
    if (deps.egress?.enabled && egressMode === "warp") {
      const result = await deps.egress.send(`${cfg.upstream}${path}${forwardSearch(url)}`, init);
      upstream = result.upstream;
      egressVia = result.via;
      egressRetries = Math.max(0, result.attempts.length - 1);
      if (egressRetries > 0) {
        console.warn(
          `[kilo-gateway] request ${requestId} rotated egress ${egressRetries}× → ${egressVia} ` +
            `(${result.attempts.map((a) => `${a.via}:${a.status || a.error}`).join(" → ")})`,
        );
      }
    } else {
      upstream = await deps.fetchImpl(`${cfg.upstream}${path}${forwardSearch(url)}`, init);
      egressVia = "direct";
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // `record` releases the reservation, so this path is already covered.
    record({ status: 502, upstreamStatus: null, stream: false, error: `Upstream fetch failed: ${message}` });
    return jsonResponse(
      { error: { type: "upstream_error", message: `Upstream fetch failed: ${message}` } },
      502,
      { ...deps.cors, "x-request-id": requestId },
    );
  }

  // A rejected pooled credential is benched, so the next call rotates rather
  // than re-presenting a key the upstream already refused.
  if (auth.pooled && auth.upstreamKey) deps.pool?.observe(upstream.status, auth.upstreamKey);

  const headers = outputHeaders(upstream, deps, requestId);
  if (egressVia) {
    headers["x-gateway-egress"] = egressVia;
    if (egressRetries > 0) headers["x-gateway-egress-retries"] = String(egressRetries);
  }
  headers["x-gateway-tier"] = auth.mode === "key" ? "key" : "anonymous";
  if (auth.degraded) {
    headers["x-gateway-degraded"] = auth.degraded.reason;
    headers["retry-after"] = auth.degraded.retryAfter;
  }
  const contentType = upstream.headers.get("content-type") || "";
  const isSse = contentType.includes("text/event-stream");
  const headersAt = performance.now() - started;

  if (!isSse) {
    let payload: ArrayBuffer;
    try {
      payload = await upstream.arrayBuffer();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      record({ status: 502, upstreamStatus: upstream.status, stream: false, error: message });
      return jsonResponse(
        { error: { type: "upstream_error", message: `Upstream body failed: ${message}` } },
        502,
        { ...deps.cors, "x-request-id": requestId },
      );
    }
    const text = new TextDecoder().decode(payload);
    let usage = emptyUsage();
    if (contentType.includes("json")) {
      try {
        const parsed: unknown = JSON.parse(text);
        usage = usageFromPayload(parsed) ?? usage;
      } catch {
        /* non-JSON 200 bodies are passed through untouched */
      }
    }
    record({
      status: upstream.status,
      upstreamStatus: upstream.status,
      stream: false,
      prompt: usage.prompt,
      completion: usage.completion,
      total: usage.total,
      cost: usage.cost,
      ttft: headersAt,
      error: upstream.status >= 400 ? extractError(text) : null,
    });
    return new Response(payload, { status: upstream.status, headers });
  }

  const reader = upstream.body?.getReader();
  if (!reader) {
    const text = await upstream.text().catch(() => "");
    record({
      status: upstream.status,
      upstreamStatus: upstream.status,
      stream: true,
      ttft: headersAt,
      error: upstream.status >= 400 ? extractError(text) : null,
    });
    return new Response(text, { status: upstream.status, headers });
  }

  const scanner = new UsageScanner();
  const decoder = new TextDecoder();
  let ttft: number | null = null;

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          scanner.finish();
          const u = scanner.usage;
          record({
            status: upstream.status,
            upstreamStatus: upstream.status,
            stream: true,
            prompt: u.prompt,
            completion: u.completion,
            total: u.total,
            cost: u.cost,
            ttft,
          });
          controller.close();
          return;
        }
        if (ttft === null) ttft = performance.now() - started;
        if (value) {
          try {
            scanner.push(decoder.decode(value, { stream: true }));
          } catch {
            /* usage accounting is best-effort; the stream is untouched */
          }
        }
        controller.enqueue(value);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const u = scanner.finish();
        record({
          status: 502,
          upstreamStatus: upstream.status,
          stream: true,
          prompt: u.prompt,
          completion: u.completion,
          total: u.total,
          cost: u.cost,
          ttft,
          error: `Stream interrupted: ${message}`,
        });
        controller.error(err);
      }
    },
    cancel(reason) {
      const u = scanner.finish();
      record({
        status: 499,
        upstreamStatus: upstream.status,
        stream: true,
        prompt: u.prompt,
        completion: u.completion,
        total: u.total,
        cost: u.cost,
        ttft,
        error: "client disconnected",
      });
      reader.cancel(reason).catch(() => {});
    },
  });

  return new Response(body, { status: upstream.status, headers });
}
