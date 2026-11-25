// Regression tests from the second adversarial audit (2026-11-24).
//
// The first audit's fixes introduced two defects of their own; these pin the
// behavior so the same mistake cannot return silently.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Store } from "../src/db.ts";
import { Catalog } from "../src/catalog.ts";
import { createApp } from "../src/app.ts";
import { generateKey } from "../src/security.ts";
import { loadConfig } from "../src/config.ts";
import { salvageKeys } from "../src/keypool.ts";
import { jsonResponse, makeConfig } from "../test/helpers.ts";

let upstream: Server<undefined>;
let gateway: Server<undefined>;
let base = "";
let store: Store;

beforeAll(async () => {
  upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/models") return jsonResponse({ data: [{ id: "m/free", isFree: true }] });
      if (url.pathname === "/v1/responses") return new Response("boom", { status: 502 });
      return jsonResponse({ ok: true });
    },
  });
  store = new Store(":memory:");
  const catalog = new Catalog(`http://127.0.0.1:${upstream.port}`, 60_000);
  const app = createApp({
    cfg: makeConfig({ upstream: `http://127.0.0.1:${upstream.port}`, maxBodyBytes: 2048 }),
    store,
    catalog,
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

function key(rpm: number, id: string): { secret: string; headers: Record<string, string> } {
  const generated = generateKey();
  store.createKey({ id, name: id, prefix: generated.prefix, hash: generated.hash, rpm, daily_limit: 0, upstream_key: null });
  return { secret: generated.secret, headers: { authorization: `Bearer ${generated.secret}` } };
}

/**
 * Reads the store's private reservation map. Test-only introspection: the
 * quarantine is the observable behavior, and asserting on it directly is the
 * only way to prove no slot leaked. Named const, single place, stated reason.
 */
type ReservationView = { reserved: Map<string, Set<string>> };
const reservationsOf = (target: Store): ReservationView => target as unknown as ReservationView;

function reservedCount(): number {
  return reservationsOf(store).reserved.size;
}

describe("AUD2-1: metadata and rejections must not consume quota", () => {
  test("GET /v1/models does not burn rpm slots", async () => {
    const { headers } = key(5, "k-models");
    for (let i = 0; i < 10; i++) {
      expect((await fetch(`${base}/v1/models`, { headers })).status).toBe(200);
    }
    // Listings are metadata; a billable request must still get the key tier.
    const chat = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ model: "m/free", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(chat.headers.get("x-gateway-tier")).toBe("key");
  });

  test("a 413 oversized body does not burn rpm slots", async () => {
    const { headers } = key(2, "k-413");
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ model: "m/free", pad: "x".repeat(8192) }),
      });
      expect(res.status).toBe(413);
    }
    const chat = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ model: "m/free", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(chat.headers.get("x-gateway-tier")).toBe("key");
  });

  test("reservations converge to zero after mixed traffic", async () => {
    const { headers } = key(100, "k-converge");
    for (let i = 0; i < 5; i++) {
      await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ model: "m/free", messages: [{ role: "user", content: "hi" }] }),
      });
    }
    expect(reservedCount()).toBe(0);
  });
});

describe("AUD2-2: reservation release is idempotent", () => {
  test("releasing one ticket twice cannot free another request's slot", () => {
    const g = generateKey();
    store.createKey({ id: "k-idem", name: "i", prefix: g.prefix, hash: g.hash, rpm: 5, daily_limit: 0, upstream_key: null });
    const limit = { id: "k-idem", rpm: 5, daily_limit: 0 };
    const a = store.reserveQuota(limit);
    const b = store.reserveQuota(limit);
    expect(a.exceeded).toBeNull();
    expect(b.exceeded).toBeNull();

    if (a.ticket) {
      store.releaseQuota("k-idem", a.ticket);
      store.releaseQuota("k-idem", a.ticket); // duplicate: must be a no-op
    }
    const held = reservationsOf(store).reserved.get("k-idem");
    expect(held?.size).toBe(1);

    if (b.ticket) store.releaseQuota("k-idem", b.ticket);
    expect(reservationsOf(store).reserved.get("k-idem")).toBeUndefined();
  });

  test("quota still holds under a concurrent burst", async () => {
    const { headers } = key(1, "k-burst2");
    const tiers = await Promise.all(
      Array.from({ length: 8 }, () =>
        fetch(`${base}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ model: "m/free", messages: [{ role: "user", content: "hi" }] }),
        }).then((r) => r.headers.get("x-gateway-tier")),
      ),
    );
    expect(tiers.filter((t) => t === "key").length).toBe(1);
  });
});

describe("AUD2-3: tightening a numeric limit must not widen it", () => {
  test("a body cap below the minimum clamps up to the minimum, not to the default", () => {
    expect(loadConfig({ MAX_BODY_BYTES: "512" }).maxBodyBytes).toBe(1024);
  });
  test("a timeout below the minimum clamps to the minimum", () => {
    expect(loadConfig({ UPSTREAM_TIMEOUT_MS: "500" }).upstreamTimeoutMs).toBe(1000);
  });
  test("retention beyond the maximum clamps to the maximum", () => {
    expect(loadConfig({ RETENTION_DAYS: "99999" }).retentionDays).toBe(3650);
  });
  test("PORT keeps its own rule: non-positive falls back to the default", () => {
    expect(loadConfig({ PORT: "0" }).port).toBe(8080);
    expect(loadConfig({ PORT: "-5" }).port).toBe(8080);
    expect(loadConfig({ PORT: "28457" }).port).toBe(28457);
  });
});

describe("AUD2-4: credential file salvage", () => {
  test("a truncated keys.json still yields its complete entries", () => {
    expect(salvageKeys('{"keys":["sk-was-here","sk-par')).toEqual(["sk-was-here"]);
  });
  test("a half-written value is not resurrected", () => {
    expect(salvageKeys('{"keys":["sk-complete","sk-trunc')).not.toContain("sk-trunc");
  });
  test("garbage input yields nothing and does not throw", () => {
    expect(salvageKeys("not json at all")).toEqual([]);
    expect(salvageKeys("")).toEqual([]);
  });
});

describe("AUD2-5: unknown and traversal paths never reach the upstream", () => {
  test("traversal-shaped paths are 404", async () => {
    for (const path of ["/v1/../../etc/passwd", "/v1/chat/completions/../../admin", "/v1/unknown"]) {
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(404);
    }
  });
});
