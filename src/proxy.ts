// Transparent proxy for Kilo Gateway's wire protocols.
//
// Requests are forwarded untouched (including SSE) so the gateway is wire-
// transparent; the only local work is credential handling, usage accounting
// and one row per request for the dashboard.

import { randomUUID } from "node:crypto";
import type { Config } from "./config.ts";
import type { RequestRecord, Store } from "./db.ts";
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

function upstreamHeaders(req: Request, auth: AuthContext): Headers {
  const headers = new Headers();
  headers.set("content-type", req.headers.get("content-type") || "application/json");
  const accept = req.headers.get("accept");
  if (accept) headers.set("accept", accept);

  const anthropicVersion = req.headers.get("anthropic-version");
  if (anthropicVersion) headers.set("anthropic-version", anthropicVersion);
  const anthropicBeta = req.headers.get("anthropic-beta");
  if (anthropicBeta) headers.set("anthropic-beta", anthropicBeta);

  if (auth.upstreamKey) {
    headers.set("authorization", `Bearer ${auth.upstreamKey}`);
  } else {
    if (auth.mode === "open") {
      const raw = req.headers.get("authorization");
      if (raw && looksLikeKiloKey(raw)) headers.set("authorization", raw);
    }
    // A separate x-api-key stays usable when Authorization carries a gateway key.
    const xApiKey = req.headers.get("x-api-key");
    if (xApiKey && looksLikeKiloKey(xApiKey)) headers.set("x-api-key", xApiKey);
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
    rawBody = await req.arrayBuffer();
    if (rawBody.byteLength > cfg.maxBodyBytes) {
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
    };
    try {
      store.insertRequest(row);
    } catch (err) {
      console.error(`[kilo-gateway] failed to record request ${requestId}:`, err);
    }
  };

  // Kill the upstream fetch when the client hangs up or the upstream stalls.
  const timeout = AbortSignal.timeout(cfg.upstreamTimeoutMs);
  const signal = AbortSignal.any([req.signal, timeout]);
  const init: RequestInit = { method: req.method, headers: upstreamHeaders(req, auth), signal };
  if (rawBody) init.body = rawBody;

  let upstream: Response;
  try {
    upstream = await deps.fetchImpl(`${cfg.upstream}${path}${url.search}`, init);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    record({ status: 502, upstreamStatus: null, stream: false, error: `Upstream fetch failed: ${message}` });
    return jsonResponse(
      { error: { type: "upstream_error", message: `Upstream fetch failed: ${message}` } },
      502,
      { ...deps.cors, "x-request-id": requestId },
    );
  }

  const headers = outputHeaders(upstream, deps, requestId);
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
