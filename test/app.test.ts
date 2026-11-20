// End-to-end HTTP tests: a fake Kilo upstream, the real app mounted on an
// ephemeral Bun.serve port, and a real streaming client.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Catalog } from "../src/catalog.ts";
import { Store } from "../src/db.ts";
import { createApp } from "../src/app.ts";
import { jsonResponse, makeConfig, readJson } from "./helpers.ts";

const FREE_MODEL = "kilo-auto/free";

const UPSTREAM_MODELS = {
  data: [
    { id: FREE_MODEL, name: "Kilo Auto Free", isFree: true, context_length: 256000, architecture: { input_modalities: ["text"] } },
    { id: "vendor/paid", name: "Paid", isFree: false, pricing: { prompt: "1", completion: "1" } },
  ],
};

function sse(lines: string[]): Response {
  return new Response(lines.map((line) => `data: ${line}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

let upstream: Server<undefined>;
let gateway: Server<undefined>;
let base = "";
let store: Store;

beforeAll(async () => {
  upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/models") return jsonResponse(UPSTREAM_MODELS);

      if (url.pathname === "/v1/embeddings") {
        return jsonResponse({
          object: "list",
          authorization: req.headers.get("authorization"),
          api_key: req.headers.get("x-api-key"),
          data: [],
        });
      }

      if (url.pathname === "/v1/chat/completions") {
        const body: unknown = await req.json();
        const stream = Boolean(body && typeof body === "object" && "stream" in body && body.stream === true);
        if (stream) {
          return sse([
            JSON.stringify({ choices: [{ delta: { content: "Hel" } }] }),
            JSON.stringify({ choices: [{ delta: { content: "lo" } }] }),
            JSON.stringify({
              choices: [{ delta: {}, finish_reason: "stop" }],
              usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
            }),
            "[DONE]",
          ]);
        }
        return jsonResponse({
          id: "chat-1",
          choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
        });
      }

      if (url.pathname === "/v1/messages") {
        return new Response(
          [
            `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":9,"output_tokens":0}}}\n\n`,
            `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n`,
            `event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":4}}\n\n`,
            `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
          ].join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      }

      if (url.pathname === "/v1/fail") return jsonResponse({ error: { message: "nope" } }, 404);
      return jsonResponse({ error: { message: "not found" } }, 404);
    },
  });

  store = new Store(":memory:");
  const cfg = makeConfig({
    upstream: `http://127.0.0.1:${upstream.port}`,
    adminToken: "admin-secret",
    requireKey: false,
  });
  const catalog = new Catalog(cfg.upstream, 60_000);
  const app = createApp({ cfg, store, catalog, startedAt: Date.now() });
  gateway = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
  base = `http://127.0.0.1:${gateway.port}`;
  await catalog.load();
});

afterAll(() => {
  gateway.stop(true);
  upstream.stop(true);
  store.close();
});

const admin = { "x-admin-token": "admin-secret" };

describe("health and catalog", () => {
  test("liveness and readiness do not require auth", async () => {
    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
    expect((await readJson<{ ok: boolean }>(health)).ok).toBe(true);
    const ready = await fetch(`${base}/readyz`);
    expect(ready.status).toBe(200);
    expect((await readJson<{ catalog: { count: number } }>(ready)).catalog.count).toBe(1);
  });

  test("serves only free models to /v1/models", async () => {
    const res = await fetch(`${base}/v1/models`);
    expect(res.status).toBe(200);
    const body = await readJson<{ object: string; data: { id: string }[]; kilo_total_models: number }>(res);
    expect(body.object).toBe("list");
    expect(body.data.map((m) => m.id)).toEqual([FREE_MODEL]);
    expect(body.kilo_total_models).toBe(2);
  });

  test("answers CORS preflight", async () => {
    const res = await fetch(`${base}/v1/chat/completions`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("returns a JSON 404 for unknown paths", async () => {
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
    expect((await readJson<{ error: { type: string } }>(res)).error.type).toBe("not_found");
  });
});

describe("proxying", () => {
  test("non-stream completion is passed through and its usage recorded", async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: FREE_MODEL, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-gateway-upstream-status")).toBe("200");
    expect(res.headers.get("x-request-id")).toBeTruthy();
    const body = await readJson<{ choices: { message: { content: string } }[] }>(res);
    expect(body.choices[0].message.content).toBe("Hello");

    const rows = store.listRequests({ since: 0, limit: 10 }).rows;
    const row = rows.find((r) => r.model === FREE_MODEL && r.status === 200 && r.stream === 0);
    expect(row).toBeTruthy();
    expect(row?.prompt_tokens).toBe(3);
    expect(row?.completion_tokens).toBe(4);
    expect(row?.total_tokens).toBe(7);
    expect(row?.source).toBe("api");
  });

  test("streams SSE and records the final usage chunk", async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: FREE_MODEL, stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain('"Hel"');
    expect(text).toContain("[DONE]");

    const row = store.listRequests({ since: 0, limit: 10 }).rows.find((r) => r.stream === 1 && r.model === FREE_MODEL);
    expect(row).toBeTruthy();
    expect(row?.prompt_tokens).toBe(5);
    expect(row?.completion_tokens).toBe(2);
    expect(row?.total_tokens).toBe(7);
    expect(row?.ttft_ms).not.toBeNull();
  });

  test("parses Anthropic SSE usage", async () => {
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-ish", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    await res.text();
    const row = store.listRequests({ since: 0, limit: 10 }).rows.find((r) => r.path === "/v1/messages");
    expect(row?.prompt_tokens).toBe(9);
    expect(row?.completion_tokens).toBe(4);
  });

  test("forwards a real Kilo key but never the admin token", async () => {
    const real = await fetch(`${base}/v1/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sk-live-test" },
      body: JSON.stringify({ model: FREE_MODEL, input: "x" }),
    });
    const realBody = await readJson<{ authorization: string | null }>(real);
    expect(realBody.authorization).toBe("Bearer sk-live-test");

    const adminRes = await fetch(`${base}/v1/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", ...admin },
      body: JSON.stringify({ model: FREE_MODEL, input: "x" }),
    });
    const adminBody = await readJson<{ authorization: string | null }>(adminRes);
    expect(adminBody.authorization).toBeNull();
  });

  test("records upstream error bodies", async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "kilo-auto/free" }),
    });
    expect(res.status).toBeLessThan(500);
  });
});

describe("dashboard API", () => {
  test("requires the admin token", async () => {
    expect((await fetch(`${base}/api/overview`)).status).toBe(401);
    expect((await fetch(`${base}/api/overview`, { headers: admin })).status).toBe(200);
  });

  test("reports overview aggregates", async () => {
    const res = await fetch(`${base}/api/overview?hours=24`, { headers: admin });
    const body = await readJson<{
      totals: { requests: number; total_tokens: number };
      catalog: { count: number };
      series: unknown[];
      models: unknown[];
    }>(res);
    expect(body.totals.requests).toBeGreaterThan(0);
    expect(body.totals.total_tokens).toBeGreaterThan(0);
    expect(body.catalog.count).toBe(1);
    expect(body.series.length).toBeGreaterThan(0);
  });

  test("creates, lists and revokes a key", async () => {
    const created = await fetch(`${base}/api/keys`, {
      method: "POST",
      headers: { "content-type": "application/json", ...admin },
      body: JSON.stringify({ name: "CI key", rpm: 5, daily_limit: 100 }),
    });
    expect(created.status).toBe(201);
    const payload = await readJson<{ secret: string; key: { id: string; prefix: string; name: string } }>(created);
    expect(payload.secret.startsWith("kg_")).toBe(true);
    expect(payload.key.name).toBe("CI key");

    const list = await readJson<{ keys: { id: string; usage: { requests: number } }[] }>(
      await fetch(`${base}/api/keys`, { headers: admin }),
    );
    expect(list.keys.some((k) => k.id === payload.key.id)).toBe(true);

    const call = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${payload.secret}` },
      body: JSON.stringify({ model: FREE_MODEL, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(call.status).toBe(200);

    const detail = store.listRequests({ since: 0, limit: 5 }).rows.find((r) => r.key_id === payload.key.id);
    expect(detail?.key_name).toBe("CI key");

    const revoke = await fetch(`${base}/api/keys/${payload.key.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...admin },
      body: JSON.stringify({ revoked: true }),
    });
    expect(revoke.status).toBe(200);
    const denied = await fetch(`${base}/v1/models`, {
      headers: { authorization: `Bearer ${payload.secret}` },
    });
    expect(denied.status).toBe(401);
  });

  test("enforces per-key request limits", async () => {
    const created = await readJson<{ secret: string; key: { id: string } }>(
      await fetch(`${base}/api/keys`, {
        method: "POST",
        headers: { "content-type": "application/json", ...admin },
        body: JSON.stringify({ name: "Tiny quota", rpm: 1 }),
      }),
    );
    const call = () =>
      fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${created.secret}` },
        body: JSON.stringify({ model: FREE_MODEL, messages: [{ role: "user", content: "hi" }] }),
      });
    expect((await call()).status).toBe(200);
    const second = await call();
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBe("60");
  });

  test("filters, details and exports requests", async () => {
    const list = await fetch(`${base}/api/requests?limit=2&model=${encodeURIComponent(FREE_MODEL)}`, { headers: admin });
    const body = await readJson<{ requests: { id: string }[]; total: number; available_models: string[] }>(list);
    expect(body.requests.length).toBeLessThanOrEqual(2);
    expect(body.available_models).toContain(FREE_MODEL);

    const detail = await readJson<{ request: { id: string } }>(
      await fetch(`${base}/api/requests/${body.requests[0].id}`, { headers: admin }),
    );
    expect(detail.request.id).toBe(body.requests[0].id);

    const csv = await fetch(`${base}/api/export.csv`, { headers: admin });
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(await csv.text()).toContain("prompt_tokens");
  });

  test("exposes runtime config without secrets", async () => {
    const res = await fetch(`${base}/api/config`, { headers: admin });
    const body = await readJson<Record<string, unknown>>(res);
    expect(body.version).toBe("1.0.0");
    expect(body.admin_required).toBe(true);
    expect(JSON.stringify(body)).not.toContain("admin-secret");
  });

  test("playground proxies through the admin session", async () => {
    const body = JSON.stringify({ model: FREE_MODEL, messages: [{ role: "user", content: "hi" }] });
    const denied = await fetch(`${base}/api/play/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(denied.status).toBe(401);

    const res = await fetch(`${base}/api/play/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gateway-source": "dashboard", ...admin },
      body,
    });
    expect(res.status).toBe(200);
    const payload = await readJson<{ choices: { message: { content: string } }[] }>(res);
    expect(payload.choices[0].message.content).toBe("Hello");
    const row = store.listRequests({ since: 0, limit: 10 }).rows.find((r) => r.source === "dashboard");
    expect(row?.status).toBe(200);
    expect(row?.key_name).toBe("dashboard");
  });

  test("clears request logs", async () => {
    const res = await fetch(`${base}/api/requests`, { method: "DELETE", headers: admin });
    const body = await readJson<{ deleted: number }>(res);
    expect(body.deleted).toBeGreaterThan(0);
    const after = await readJson<{ total: number }>(
      await fetch(`${base}/api/requests?limit=1`, { headers: admin }),
    );
    expect(after.total).toBe(0);
  });
});
