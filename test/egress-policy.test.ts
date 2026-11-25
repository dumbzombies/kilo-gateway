// Egress policy: anonymous traffic always rides WARP, authenticated traffic may
// go direct or through the pool, and a key past its quota degrades into the
// anonymous (WARP) tier instead of failing.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Catalog } from "../src/catalog.ts";
import { Store } from "../src/db.ts";
import { createApp } from "../src/app.ts";
import { Egress } from "../src/egress.ts";
import { generateKey } from "../src/security.ts";
import { jsonResponse, makeConfig, readJson } from "./helpers.ts";

const FREE = "kilo-auto/free";
const WARP = "http://127.0.0.1:9"; // never dialled: the fake fetch intercepts

let upstream: Server<undefined>;
let store: Store;
let gateway: Server<undefined>;
let base = "";

/** Records which path each upstream call took, without touching the network. */
const calls: string[] = [];

beforeAll(async () => {
  upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/models") return jsonResponse({ data: [{ id: FREE, name: "Free", isFree: true }] });
      return jsonResponse({ id: "chatcmpl", choices: [{ message: { role: "assistant", content: "hi" } }] });
    },
  });
  store = new Store(":memory:");
  const catalog = new Catalog(`http://127.0.0.1:${upstream.port}`, 60_000);

  // A fetch that answers locally and records the egress mode it was asked for.
  const fakeFetch = (async (_url: string, init: RequestInit & { proxy?: string }) => {
    calls.push(init.proxy ? `warp:${init.proxy}` : "direct");
    return jsonResponse({ id: "chatcmpl", choices: [{ message: { role: "assistant", content: "hi" } }] });
  }) as unknown as typeof fetch;

  const app = createApp({
    cfg: makeConfig({ upstream: `http://127.0.0.1:${upstream.port}`, egressProxies: [WARP], anonEgress: "warp" }),
    store,
    catalog,
    fetchImpl: fakeFetch,
    egress: new Egress({ proxies: [WARP], fetchImpl: fakeFetch }),
  });
  gateway = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
  base = `http://127.0.0.1:${gateway.port}`;
  await catalog.load();
});

afterAll(() => {
  gateway.stop(true);
  upstream.stop(true);
  store.close();
});

function chat(headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model: FREE, messages: [{ role: "user", content: "hi" }] }),
  });
}

function makeKey(overrides: { rpm?: number; daily_limit?: number; egress?: "direct" | "warp" | null } = {}) {
  const generated = generateKey();
  store.createKey({
    id: `key-${Math.random().toString(36).slice(2)}`,
    name: "Policy key",
    prefix: generated.prefix,
    hash: generated.hash,
    rpm: overrides.rpm ?? 0,
    daily_limit: overrides.daily_limit ?? 0,
    upstream_key: null,
    egress: overrides.egress ?? null,
  });
  return generated.secret;
}

describe("anonymous egress", () => {
  test("a keyless request rides the WARP pool even with keys required", async () => {
    calls.length = 0;
    const res = await chat();
    expect(res.status).toBe(200);
    expect(calls).toEqual([`warp:${WARP}`]);
    expect(res.headers.get("x-gateway-tier")).toBe("anonymous");
    expect(res.headers.get("x-gateway-egress")).toBe(WARP);
  });

  test("ANON_EGRESS=direct opts anonymous traffic out of the pool", async () => {
    const catalog = new Catalog(`http://127.0.0.1:${upstream.port}`, 60_000);
    const fakeFetch = (async (_url: string, init: RequestInit & { proxy?: string }) => {
      calls.push(init.proxy ? `warp:${init.proxy}` : "direct");
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;
    const app = createApp({
      cfg: makeConfig({
        upstream: `http://127.0.0.1:${upstream.port}`,
        egressProxies: [WARP],
        anonEgress: "direct",
        requireKey: false,
      }),
      store,
      catalog,
      fetchImpl: fakeFetch,
      egress: new Egress({ proxies: [WARP], fetchImpl: fakeFetch }),
    });
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
    try {
      calls.length = 0;
      const res = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: FREE, messages: [{ role: "user", content: "hi" }] }),
      });
      expect(res.status).toBe(200);
      expect(calls).toEqual(["direct"]);
    } finally {
      server.stop(true);
    }
  });
});

describe("authenticated egress", () => {
  test("a key follows AUTH_EGRESS (warp when the pool exists)", async () => {
    const secret = makeKey();
    calls.length = 0;
    const res = await chat({ authorization: `Bearer ${secret}` });
    expect(res.status).toBe(200);
    expect(calls).toEqual([`warp:${WARP}`]);
    expect(res.headers.get("x-gateway-tier")).toBe("key");
  });

  test("a key pinned to direct bypasses the pool, even though anonymous uses it", async () => {
    const secret = makeKey({ egress: "direct" });
    calls.length = 0;
    const res = await chat({ authorization: `Bearer ${secret}` });
    expect(res.status).toBe(200);
    expect(calls).toEqual(["direct"]);
    expect(res.headers.get("x-gateway-egress")).toBe("direct");
  });

  test("AUTH_EGRESS=direct sends unpinned keys direct", async () => {
    const secret = makeKey();
    const catalog = new Catalog(`http://127.0.0.1:${upstream.port}`, 60_000);
    const fakeFetch = (async (_url: string, init: RequestInit & { proxy?: string }) => {
      calls.push(init.proxy ? `warp:${init.proxy}` : "direct");
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;
    const app = createApp({
      cfg: makeConfig({
        upstream: `http://127.0.0.1:${upstream.port}`,
        egressProxies: [WARP],
        authEgress: "direct",
      }),
      store,
      catalog,
      fetchImpl: fakeFetch,
      egress: new Egress({ proxies: [WARP], fetchImpl: fakeFetch }),
    });
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
    try {
      calls.length = 0;
      const res = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
        body: JSON.stringify({ model: FREE, messages: [{ role: "user", content: "hi" }] }),
      });
      expect(res.status).toBe(200);
      expect(calls).toEqual(["direct"]);
    } finally {
      server.stop(true);
    }
  });
});

describe("quota fallback", () => {
  test("a key past its quota is served anonymously, through WARP", async () => {
    const secret = makeKey({ rpm: 1, egress: "direct" });
    calls.length = 0;

    const first = await chat({ authorization: `Bearer ${secret}` });
    expect(first.status).toBe(200);
    expect(calls).toEqual(["direct"]); // its own pin, honoured while in quota

    // Over quota → anonymous tier, which always uses the pool regardless of pin.
    const second = await chat({ authorization: `Bearer ${secret}` });
    expect(second.status).toBe(200);
    expect(calls).toEqual(["direct", `warp:${WARP}`]);
    expect(second.headers.get("x-gateway-tier")).toBe("anonymous");
    expect(second.headers.get("x-gateway-degraded")).toBe("rpm");
  });

  test("the degraded call is attributed to no key, so the quota cannot drift", async () => {
    const rows = store.listRequests({ since: 0, limit: 50 }).rows;
    const anonymous = rows.filter((r) => r.key_id === null && r.path === "/v1/chat/completions");
    expect(anonymous.length).toBeGreaterThan(0);
  });

  test("the daily limit degrades the same way", async () => {
    const secret = makeKey({ daily_limit: 1 });
    expect((await chat({ authorization: `Bearer ${secret}` })).status).toBe(200);
    const second = await chat({ authorization: `Bearer ${secret}` });
    expect(second.status).toBe(200);
    expect(second.headers.get("x-gateway-degraded")).toBe("daily");
    expect(second.headers.get("retry-after")).toBe("3600");
  });
});

describe("key egress in the dashboard API", () => {
  test("keys round-trip their egress pin", async () => {
    const created = await readJson<{ secret: string; key: { id: string; egress: string | null } }>(
      await fetch(`${base}/api/keys`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Pinned", egress: "direct" }),
      }),
    );
    expect(created.key.egress).toBe("direct");

    const patched = await readJson<{ key: { egress: string | null } }>(
      await fetch(`${base}/api/keys/${created.key.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ egress: null }),
      }),
    );
    expect(patched.key.egress).toBeNull();
  });
});
