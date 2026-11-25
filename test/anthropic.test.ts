// Wire fidelity on the Anthropic surface.
//
// Kilo's gateway serves `/v1/messages` natively, so the gateway must not
// translate: the request body and the Anthropic protocol headers go upstream
// byte-for-byte, and the response comes back untouched. These tests pin that
// contract so a future "helpful" translation is caught.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Store } from "../src/db.ts";
import { Catalog } from "../src/catalog.ts";
import { createApp } from "../src/app.ts";
import { jsonResponse, makeConfig } from "./helpers.ts";

const CLAUDE = "anthropic/claude-sonnet-4.5";

/** Anthropic-shaped response the fake upstream returns verbatim. */
const ANTHROPIC_BODY = {
  id: "msg_01ABC",
  type: "message",
  role: "assistant",
  model: CLAUDE,
  content: [{ type: "text", text: "hello" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 12, output_tokens: 3 },
};

const SSE = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"anthropic/claude-sonnet-4.5","content":[],"stop_reason":null,"usage":{"input_tokens":9,"output_tokens":1}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join("");

let upstream: Server<undefined>;
let store: Store;
let gateway: Server<undefined>;
let base = "";

/** Captured upstream request, to compare against what the client sent. */
let seen: { path: string; headers: Headers; body: string } | null = null;

beforeAll(async () => {
  upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/models") return jsonResponse({ data: [{ id: CLAUDE, isFree: true }] });
      seen = { path: url.pathname, headers: new Headers(req.headers), body: await req.text() };
      if (url.pathname === "/v1/messages/count_tokens") {
        return jsonResponse({ input_tokens: 12 });
      }
      const wantsStream = seen.body.includes('"stream":true');
      if (wantsStream) {
        return new Response(SSE, {
          headers: {
            "content-type": "text/event-stream",
            "request-id": "req_abc123",
            "anthropic-ratelimit-tokens-remaining": "999",
          },
        });
      }
      return Response.json(ANTHROPIC_BODY, {
        headers: { "request-id": "req_abc123", "anthropic-ratelimit-tokens-remaining": "999" },
      });
    },
  });
  store = new Store(":memory:");
  const catalog = new Catalog(`http://127.0.0.1:${upstream.port}`, 60_000);
  const app = createApp({ cfg: makeConfig({ upstream: `http://127.0.0.1:${upstream.port}` }), store, catalog });
  gateway = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
  base = `http://127.0.0.1:${gateway.port}`;
  await catalog.load();
});

afterAll(() => {
  gateway.stop(true);
  upstream.stop(true);
  store.close();
});

const BODY = {
  model: CLAUDE,
  max_tokens: 64,
  system: "be terse",
  messages: [{ role: "user", content: "hi" }],
  temperature: 0.3,
};

function anthropicCall(extraHeaders: Record<string, string> = {}, body: unknown = BODY): Promise<Response> {
  return fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": "sk-kilo-test-key",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

describe("anthropic request passthrough", () => {
  test("the body reaches the upstream byte-for-byte", async () => {
    seen = null;
    await anthropicCall();
    expect(seen).not.toBeNull();
    expect(seen!.path).toBe("/v1/messages");
    expect(seen!.body).toBe(JSON.stringify(BODY));
  });

  test("the x-api-key style is preserved, not rewritten into the body", async () => {
    seen = null;
    await anthropicCall();
    expect(seen!.headers.get("x-api-key")).toBe("sk-kilo-test-key");
    // Mirroring into Bearer is additive; the original header is still there.
    expect(seen!.headers.get("authorization")).toBe("Bearer sk-kilo-test-key");
  });

  test("anthropic-version and anthropic-beta ride through", async () => {
    seen = null;
    await anthropicCall({ "anthropic-beta": "prompt-caching-2024-07-31" });
    expect(seen!.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(seen!.headers.get("anthropic-beta")).toBe("prompt-caching-2024-07-31");
  });

  test("a model id with a provider prefix is untouched", async () => {
    seen = null;
    await anthropicCall({}, { ...BODY, model: "anthropic/claude-opus-5" });
    expect(JSON.parse(seen!.body).model).toBe("anthropic/claude-opus-5");
  });
});

describe("anthropic response passthrough", () => {
  test("the non-stream response is returned verbatim", async () => {
    const res = await anthropicCall();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual(ANTHROPIC_BODY);
  });

  test("Anthropic rate-limit and request-id headers are forwarded", async () => {
    const res = await anthropicCall();
    expect(res.headers.get("request-id")).toBe("req_abc123");
    expect(res.headers.get("anthropic-ratelimit-tokens-remaining")).toBe("999");
  });

  test("SSE streams through unchanged, event blocks intact", async () => {
    const res = await anthropicCall({}, { ...BODY, stream: true });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toContain("no-transform");
    const text = await res.text();
    expect(text).toBe(SSE);
    expect(text).toContain("event: message_start");
    expect(text).toContain('"text_delta"');
    // The final block is the message_stop event, payload intact.
    expect(text.trimEnd().endsWith('data: {"type":"message_stop"}')).toBe(true);
  });

  test("count_tokens passes through with its own body", async () => {
    seen = null;
    const res = await fetch(`${base}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": "sk-x" },
      body: JSON.stringify({ model: CLAUDE, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ input_tokens: 12 });
    expect(seen!.path).toBe("/v1/messages/count_tokens");
  });

  test("an upstream error body is passed through, not reshaped", async () => {
    const errorUpstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/models") return jsonResponse({ data: [{ id: CLAUDE, isFree: true }] });
        return Response.json(
          { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } },
          { status: 401 },
        );
      },
    });
    const store2 = new Store(":memory:");
    const catalog2 = new Catalog(`http://127.0.0.1:${errorUpstream.port}`, 60_000);
    const app2 = createApp({ cfg: makeConfig({ upstream: `http://127.0.0.1:${errorUpstream.port}` }), store: store2, catalog: catalog2 });
    const server2 = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app2.fetch });
    try {
      await catalog2.load();
      const res = await fetch(`http://127.0.0.1:${server2.port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": "sk-x" },
        body: JSON.stringify(BODY),
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        type: "error",
        error: { type: "authentication_error", message: "invalid x-api-key" },
      });
    } finally {
      server2.stop(true);
      errorUpstream.stop(true);
      store2.close();
    }
  });
});

describe("body size cap", () => {
  test("an oversized body is refused without being fully buffered", async () => {
    const store3 = new Store(":memory:");
    const catalog3 = new Catalog(`http://127.0.0.1:${upstream.port}`, 60_000);
    const app3 = createApp({
      cfg: makeConfig({ upstream: `http://127.0.0.1:${upstream.port}`, maxBodyBytes: 2048 }),
      store: store3,
      catalog: catalog3,
    });
    const server3 = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app3.fetch });
    try {
      await catalog3.load();

      // Declared length over the cap: rejected from the header alone.
      const declared = await fetch(`http://127.0.0.1:${server3.port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body: "x".repeat(4096),
      });
      expect(declared.status).toBe(413);

      // Streamed with no Content-Length: the cap is enforced while reading.
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("x".repeat(8192)));
          controller.close();
        },
      });
      const chunked = await fetch(`http://127.0.0.1:${server3.port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body: stream,
        // @ts-expect-error Bun types allow duplex; DOM types do not.
        duplex: "half",
      });
      expect(chunked.status).toBe(413);
    } finally {
      server3.stop(true);
      store3.close();
    }
  });
});
