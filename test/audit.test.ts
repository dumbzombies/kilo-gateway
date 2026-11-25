// Regression tests for defects found by the adversarial audit on 2026-11-24.
//
// Each test states the behavior that was broken and now holds. They failed
// against the implementation as it stood during the audit and pass after the
// fixes; keep them together so the audit trail stays visible.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Store } from "../src/db.ts";
import { Catalog } from "../src/catalog.ts";
import { createApp } from "../src/app.ts";
import { UpstreamPool, maskKey } from "../src/keypool.ts";
import { generateKey } from "../src/security.ts";
import { loadConfig } from "../src/config.ts";
import { jsonResponse, makeConfig } from "./helpers.ts";

let upstream: Server<undefined>;
/**
 * Barrier: the fake upstream holds every completion until `release` arrives, so
 * all quota checks overlap deterministically instead of racing a sleep.
 */
let arrivalCount = 0;
const arrivals = new Set<() => void>();
const RELEASE_AT = 8;
let released = false;

function holdUntilAllArrive(): Promise<void> {
  arrivalCount++;
  if (arrivalCount >= RELEASE_AT) {
    released = true;
    for (const resolve of arrivals) resolve();
    arrivals.clear();
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => arrivals.add(resolve));
}
let gateway: Server<undefined>;
let base = "";
let store: Store;
const ADMIN = "audit-admin-token";

beforeAll(async () => {
  upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/models") return jsonResponse({ data: [{ id: "m/free", isFree: true }] });
      if (released) return jsonResponse({ ok: true });
      await holdUntilAllArrive();
      return jsonResponse({ ok: true });
    },
  });
  store = new Store(":memory:");
  const catalog = new Catalog(`http://127.0.0.1:${upstream.port}`, 60_000);
  const app = createApp({
    cfg: makeConfig({ upstream: `http://127.0.0.1:${upstream.port}` }),
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

function chat(headers: Record<string, string> = {}, path = "/v1/chat/completions"): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model: "m/free", messages: [{ role: "user", content: "hi" }] }),
  });
}

describe("AUD-1: request quota is enforced under concurrency", () => {
  test("a key limited to 1 request/minute serves exactly one concurrent burst request on its own tier", async () => {
    const generated = generateKey();
    store.createKey({
      id: "k-aud1",
      name: "aud1",
      prefix: generated.prefix,
      hash: generated.hash,
      rpm: 1,
      daily_limit: 0,
      upstream_key: null,
    });

    const tiers = await Promise.all(
      Array.from({ length: 8 }, () =>
        chat({ authorization: `Bearer ${generated.secret}` }).then((r) => r.headers.get("x-gateway-tier")),
      ),
    );
    // Requests beyond the limit are still *served* (anonymous degradation by
    // design), but only one may be attributed to the key's own quota.
    expect(tiers.filter((t) => t === "key").length).toBe(1);
  });
});

describe("AUD-2: a freshly added credential is immediately usable", () => {
  test("adding a key does not bench it for ten minutes", () => {
    const pool = new UpstreamPool();
    expect(pool.add("sk-freshly-pasted-key")).toBe(true);
    expect(pool.available()).toEqual(["sk-freshly-pasted-key"]);
    expect(pool.next()).toBe("sk-freshly-pasted-key");
  });
});

describe("AUD-3: approval never silently impersonates an existing account", () => {
  let adminGateway: Server<undefined>;
  let adminBase = "";
  let adminStore: Store;

  beforeAll(async () => {
    adminStore = new Store(":memory:");
    adminStore.createUser({ id: "owner-1", email: "owner@x.test", name: "Owner", role: "owner" });
    const catalog = new Catalog(`http://127.0.0.1:${upstream.port}`, 60_000);
    const app = createApp({
      cfg: makeConfig({ upstream: `http://127.0.0.1:${upstream.port}`, adminToken: ADMIN }),
      store: adminStore,
      catalog,
    });
    adminGateway = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
    adminBase = `http://127.0.0.1:${adminGateway.port}`;
    await catalog.load();
  });

  afterAll(() => {
    adminGateway.stop(true);
    adminStore.close();
  });

  test("holding the install token does not yield the owner's dashboard session by email alone", async () => {
    const start = await fetch(`${adminBase}/api/auth/device/code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: "audit" }),
    });
    const grant = (await start.json()) as { user_code: string };

    // Email alone must not silently bind the device to the owner's account.
    const silent = await fetch(`${adminBase}/api/auth/device/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-token": ADMIN },
      body: JSON.stringify({ user_code: grant.user_code, email: "owner@x.test" }),
    });
    expect(silent.status).toBe(409);
    const body = (await silent.json()) as { code?: string };
    expect(body.code).toBe("account_exists");
    // And no session/cookie leaked from the refused attempt.
    expect(silent.headers.get("set-cookie")).toBeNull();
  });

  test("explicit attach still works, because the install token is fully privileged anyway", async () => {
    const start = await fetch(`${adminBase}/api/auth/device/code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: "audit2" }),
    });
    const grant = (await start.json()) as { user_code: string };
    const approved = await fetch(`${adminBase}/api/auth/device/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-token": ADMIN },
      body: JSON.stringify({ user_code: grant.user_code, email: "owner@x.test", attach_existing: true }),
    });
    expect(approved.status).toBe(200);
  });
});

describe("AUD-4: gateway credentials in the query string are not forwarded upstream", () => {
  let seen = "";
  let probe: Server<undefined>;

  beforeAll(() => {
    probe = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/models") return jsonResponse({ data: [{ id: "m/free", isFree: true }] });
        seen = req.url;
        return jsonResponse({ ok: true });
      },
    });
  });

  afterAll(() => probe.stop(true));

  test("?token=<credential> is stripped before the upstream call", async () => {
    const catalog = new Catalog(`http://127.0.0.1:${probe.port}`, 60_000);
    const app = createApp({ cfg: makeConfig({ upstream: `http://127.0.0.1:${probe.port}` }), store, catalog });
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
    try {
      await catalog.load();
      seen = "";
      const res = await fetch(
        `http://127.0.0.1:${server.port}/v1/chat/completions?token=super-secret-gateway-key&beta=true`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "m/free", messages: [{ role: "user", content: "hi" }] }),
        },
      );
      expect(res.status).toBe(200);
      expect(seen).not.toContain("super-secret-gateway-key");
      // Unrelated query parameters must still reach the upstream.
      expect(seen).toContain("beta=true");
    } finally {
      server.stop(true);
    }
  });
});

describe("AUD-5: keys.json survives a truncated write", () => {
  test("a partially written file does not silently discard every credential", () => {
    const dir = mkdtempSync(join(tmpdir(), "kg-aud-"));
    const file = join(dir, "keys.json");
    // A crash mid-write leaves a valid prefix and a truncated tail.
    writeFileSync(file, '{"keys":["sk-was-here","sk-par');
    const pool = UpstreamPool.fromDisk(file);
    // Silent total credential loss is the defect; recovering or refusing loudly
    // is acceptable. Empty-by-default is not.
    expect(pool.size).toBeGreaterThan(0);
  });
});

describe("AUD-6: removing a pooled key by its mask cannot delete several", () => {
  test("one remove() call deletes one credential, not every key sharing a mask", () => {
    const pool = new UpstreamPool();
    const first = "sk-bbbb11-account-one-wxyz";
    const second = "sk-bbbb11-account-two-wxyz";
    pool.add(first);
    pool.add(second);
    expect(pool.size).toBe(2);
    // The dashboard sends the masked form. When it cannot identify one key, the
    // removal must be refused rather than deleting every key that shares it.
    const outcome = pool.remove(maskKey(first));
    expect(outcome).toBe("ambiguous");
    expect(pool.size).toBe(2);

    // Removing by the exact key still works, and removes exactly one.
    expect(pool.remove(first)).toBe("removed");
    expect(pool.size).toBe(1);

    // The dashboard removes by opaque id, which is never ambiguous even when
    // two credentials share a mask.
    const pair = new UpstreamPool();
    pair.add(first);
    pair.add(second);
    const ids = pair.state().map((k) => k.id);
    expect(new Set(ids).size).toBe(2);
    expect(pair.remove(ids[0])).toBe("removed");
    expect(pair.size).toBe(1);

    // A mask that identifies a single key is accepted.
    const solo = new UpstreamPool();
    solo.add("sk-only-one-here");
    expect(solo.remove(maskKey("sk-only-one-here"))).toBe("removed");
    expect(solo.size).toBe(0);
  });
});

describe("AUD-7: PORT=0 is not silently reinterpreted as privileged port 1", () => {
  test("port zero falls back to the default instead of clamping to 1", () => {
    expect(loadConfig({ PORT: "0" }).port).toBe(8080);
  });
});
