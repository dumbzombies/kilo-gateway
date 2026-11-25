// Upstream credential pool: round-robin, cooldown on auth rejection, and the
// fall-through to the anonymous tier once every key is benched. This is the
// mechanic mistral-vibe uses, and it is what makes "all logins hit quota →
// anonymous" work at the credential level.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { UpstreamPool, maskKey } from "../src/keypool.ts";
import { Store } from "../src/db.ts";
import { Catalog } from "../src/catalog.ts";
import { createApp } from "../src/app.ts";
import { generateKey } from "../src/security.ts";
import { jsonResponse, makeConfig } from "./helpers.ts";

const FREE = "kilo-auto/free";

describe("pool rotation", () => {
  test("round-robins across usable keys", () => {
    const pool = new UpstreamPool(["a-key-1", "b-key-2"]);
    expect(pool.size).toBe(2);
    const picked = [pool.next(), pool.next(), pool.next()];
    expect(new Set(picked)).toEqual(new Set(["a-key-1", "b-key-2"]));
  });

  test("only auth rejections bench a key, never 429", () => {
    const pool = new UpstreamPool(["k1"]);
    pool.observe(429, "k1");
    expect(pool.available()).toEqual(["k1"]); // throughput pressure is not a bad key
    pool.observe(401, "k1");
    expect(pool.available()).toEqual([]);
    expect(pool.next()).toBeNull();
    expect(pool.state()[0].cooldown_s).toBeGreaterThan(0);
  });

  test("a benched key reports no usable credential at all", () => {
    const pool = new UpstreamPool(["k1", "k2"]);
    pool.coolDown("k1");
    pool.coolDown("k2");
    expect(pool.next()).toBeNull();
    expect(pool.state().every((s) => s.cooldown_s > 0)).toBe(true);
  });

  test("a key is masked for display", () => {
    expect(maskKey("sk-abcdefghijklmnop")).toBe("sk-abc…mnop");
    expect(maskKey("short")).toBe("sho…");
  });

  test("add/remove work by full key or masked form", () => {
    const pool = new UpstreamPool();
    expect(pool.add("first-key-123")).toBe(true);
    expect(pool.add("first-key-123")).toBe(false); // no duplicates
    expect(pool.remove(maskKey("first-key-123"))).toBe("removed");
    expect(pool.size).toBe(0);
  });
});

describe("pool in the request path", () => {
  let upstream: Server<undefined>;
  let store: Store;
  let gateway: Server<undefined>;
  let base = "";
  const seenAuth: (string | null)[] = [];

  beforeAll(async () => {
    upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/models") return jsonResponse({ data: [{ id: FREE, isFree: true }] });
        seenAuth.push(req.headers.get("authorization"));
        return jsonResponse({ choices: [{ message: { role: "assistant", content: "ok" } }] });
      },
    });
    store = new Store(":memory:");
    const catalog = new Catalog(`http://127.0.0.1:${upstream.port}`, 60_000);
    const app = createApp({
      cfg: makeConfig({ upstream: `http://127.0.0.1:${upstream.port}` }),
      store,
      catalog,
      pool: new UpstreamPool(["pooled-key-one"]),
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

  test("an anonymous request borrows a pooled credential upstream", async () => {
    seenAuth.length = 0;
    const res = await chat();
    expect(res.status).toBe(200);
    expect(seenAuth).toEqual(["Bearer pooled-key-one"]);
  });

  test("a caller's own Kilo key always wins over the pool", async () => {
    seenAuth.length = 0;
    await chat({ authorization: "Bearer sk-caller-owned-key" });
    expect(seenAuth).toEqual(["Bearer sk-caller-owned-key"]);
  });

  test("a gateway key is a client credential, not an upstream one", async () => {
    const generated = generateKey();
    store.createKey({
      id: "k1",
      name: "client",
      prefix: generated.prefix,
      hash: generated.hash,
      rpm: 0,
      daily_limit: 0,
      upstream_key: null,
    });
    seenAuth.length = 0;
    await chat({ authorization: `Bearer ${generated.secret}` });
    // No upstream key on the gateway key, so the pooled credential is borrowed.
    expect(seenAuth).toEqual(["Bearer pooled-key-one"]);
  });

  test("once every pooled key is benched, the request still succeeds anonymously", async () => {
    const pool = new UpstreamPool(["k-only"]);
    pool.coolDown("k-only");
    expect(pool.next()).toBeNull();

    const catalog = new Catalog(`http://127.0.0.1:${upstream.port}`, 60_000);
    const app = createApp({
      cfg: makeConfig({ upstream: `http://127.0.0.1:${upstream.port}` }),
      store,
      catalog,
      pool,
    });
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
    try {
      seenAuth.length = 0;
      const res = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: FREE, messages: [{ role: "user", content: "hi" }] }),
      });
      expect(res.status).toBe(200);
      // No credential upstream: the anonymous tier carries the call.
      expect(seenAuth).toEqual([null]);
    } finally {
      server.stop(true);
    }
  });

  test("the dashboard can add and remove pool keys", async () => {
    const added = await fetch(`${base}/api/upstream-keys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "add", key: "second-pool-key" }),
    });
    expect(added.status).toBe(201);
    const listed = (await (await fetch(`${base}/api/upstream-keys`)).json()) as {
      keys: { key: string }[];
      total: number;
    };
    expect(listed.total).toBe(2);
    expect(listed.keys.some((k) => k.key.startsWith("second"))).toBe(true);

    const removed = await fetch(`${base}/api/upstream-keys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "remove", key: "second-pool-key" }),
    });
    expect(removed.status).toBe(200);
  });
});
