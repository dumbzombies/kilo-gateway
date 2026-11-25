// Device-flow auth (warm-run-cli pattern): the gateway issues a device code,
// a human approves it, the client polls for a bearer token, and that token
// unlocks the dashboard API. No passwords exist anywhere.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Catalog } from "../src/catalog.ts";
import { Store } from "../src/db.ts";
import { createApp } from "../src/app.ts";
import { CLIENT_ID, DEVICE_GRANT, canAdminister } from "../src/accounts.ts";
import { hashToken } from "../src/security.ts";
import { jsonResponse, makeConfig, readJson } from "./helpers.ts";

let upstream: Server<undefined>;
let gateway: Server<undefined>;
let base = "";
let store: Store;
let accountId = "";

const ADMIN = "admin-token-for-tests";
const ACCOUNT_EMAIL = "owner@example.test";

beforeAll(async () => {
  upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/models") {
        return jsonResponse({ data: [{ id: "kilo-auto/free", name: "Free", isFree: true }] });
      }
      return jsonResponse({ ok: true });
    },
  });
  store = new Store(":memory:");
  const catalog = new Catalog(`http://127.0.0.1:${upstream.port}`, 60_000);
  const app = createApp({
    cfg: makeConfig({ upstream: `http://127.0.0.1:${upstream.port}`, adminToken: ADMIN }),
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

function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

interface Grant {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

async function startGrant(): Promise<Grant> {
  const res = await post("/api/auth/device/code", { client_id: CLIENT_ID });
  expect(res.status).toBe(200);
  return (await res.json()) as Grant;
}

describe("device authorization", () => {
  test("status advertises the device flow and a first-run install", async () => {
    const body = await readJson<{
      auth_style: string;
      device_flow: boolean;
      setup_required: boolean;
      user: unknown;
    }>(await fetch(`${base}/api/auth/status`));
    expect(body.auth_style).toBe("device_code");
    expect(body.device_flow).toBe(true);
    expect(body.setup_required).toBe(true);
    expect(body.user).toBeNull();
  });

  test("the code grant has the RFC 8628 shape and a human-readable code", async () => {
    const grant = await startGrant();
    expect(grant.device_code.length).toBeGreaterThan(20);
    expect(grant.user_code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(grant.verification_uri_complete).toContain("user_code=");
    expect(grant.expires_in).toBe(600);
    expect(grant.interval).toBe(5);
  });

  test("polling an unapproved code returns authorization_pending", async () => {
    const grant = await startGrant();
    const res = await post("/api/auth/device/token", {
      grant_type: DEVICE_GRANT,
      device_code: grant.device_code,
      client_id: CLIENT_ID,
    });
    expect(res.status).toBe(400);
    const body = await readJson<{ error: string }>(res);
    expect(body.error).toBe("authorization_pending");
  });

  test("polling faster than the interval returns slow_down", async () => {
    const grant = await startGrant();
    const poll = () =>
      post("/api/auth/device/token", {
        grant_type: DEVICE_GRANT,
        device_code: grant.device_code,
        client_id: CLIENT_ID,
      });
    expect((await readJson<{ error: string }>(await poll())).error).toBe("authorization_pending");
    expect((await readJson<{ error: string }>(await poll())).error).toBe("slow_down");
  });

  test("the wrong grant_type is rejected", async () => {
    const grant = await startGrant();
    const res = await post("/api/auth/device/token", {
      grant_type: "authorization_code",
      device_code: grant.device_code,
    });
    expect(res.status).toBe(400);
    expect((await readJson<{ error: string }>(res)).error).toBe("unsupported_grant_type");
  });

  test("an unknown device code is invalid_grant", async () => {
    const res = await post("/api/auth/device/token", {
      grant_type: DEVICE_GRANT,
      device_code: "nope",
      client_id: CLIENT_ID,
    });
    expect((await readJson<{ error: string }>(res)).error).toBe("invalid_grant");
  });

  test("an expired code reports expired_token", async () => {
    const grant = await startGrant();
    const row = store.deviceCodeByHash(hashToken(grant.device_code));
    store.db.query("UPDATE device_codes SET expires_at = ? WHERE device_code = ?").run(Date.now() - 1, row!.device_code);
    const res = await post("/api/auth/device/token", {
      grant_type: DEVICE_GRANT,
      device_code: grant.device_code,
      client_id: CLIENT_ID,
    });
    expect((await readJson<{ error: string }>(res)).error).toBe("expired_token");
  });

  test("bootstrap approval with the admin token creates the owner, then polling yields a token", async () => {
    const grant = await startGrant();
    const approve = await post(
      "/api/auth/device/approve",
      { user_code: grant.user_code, email: ACCOUNT_EMAIL, name: "Owner" },
      { "x-admin-token": ADMIN },
    );
    expect(approve.status).toBe(200);
    const approved = await readJson<{ approved: boolean; user: { role: string; id: string } }>(approve);
    expect(approved.approved).toBe(true);
    expect(approved.user.role).toBe("owner");
    accountId = approved.user.id;
    // The approving browser is signed in, not stranded on the approval page.
    expect(approve.headers.get("set-cookie")).toContain("kg_session=");

    const poll = await post("/api/auth/device/token", {
      grant_type: DEVICE_GRANT,
      device_code: grant.device_code,
      client_id: CLIENT_ID,
    });
    expect(poll.status).toBe(200);
    const body = await readJson<{
      access_token: string;
      token_type: string;
      expires_in: number;
      user: { email: string };
      credentials: { schemaVersion: number; accessToken: string; authStyle: string; apiBaseUrl: string };
    }>(poll);
    expect(body.token_type).toBe("Bearer");
    expect(body.access_token.startsWith("kgd_")).toBe(true);
    expect(body.expires_in).toBeGreaterThan(86_400);
    expect(body.user.email).toBe("owner@example.test");
    // credentials.json shape, identical to what warm-run-cli writes.
    expect(body.credentials.schemaVersion).toBe(1);
    expect(body.credentials.authStyle).toBe("bearer");
    expect(body.credentials.accessToken).toBe(body.access_token);
    expect(body.credentials.apiBaseUrl).toBe(base);
    expect(poll.headers.get("set-cookie")).toContain("kg_session=");
  });

  test("a consumed code cannot be exchanged twice", async () => {
    const grant = await startGrant();
    await post("/api/auth/device/approve", { user_code: grant.user_code, email: ACCOUNT_EMAIL, attach_existing: true }, { "x-admin-token": ADMIN });
    await post("/api/auth/device/token", { grant_type: DEVICE_GRANT, device_code: grant.device_code, client_id: CLIENT_ID });
    const again = await post("/api/auth/device/token", {
      grant_type: DEVICE_GRANT,
      device_code: grant.device_code,
      client_id: CLIENT_ID,
    });
    expect((await readJson<{ error: string }>(again)).error).toBe("invalid_grant");
  });
});

describe("bearer token access", () => {
  let token = "";

  async function freshToken(): Promise<string> {
    const grant = await startGrant();
    await post("/api/auth/device/approve", { user_code: grant.user_code, email: ACCOUNT_EMAIL, attach_existing: true }, { "x-admin-token": ADMIN });
    const poll = await post("/api/auth/device/token", {
      grant_type: DEVICE_GRANT,
      device_code: grant.device_code,
      client_id: CLIENT_ID,
    });
    const issued = (await poll.json()) as TokenResponse;
    return issued.access_token;
  }

  test("the bearer token unlocks the dashboard API; absence does not", async () => {
    token = await freshToken();
    expect((await fetch(`${base}/api/overview`)).status).toBe(401);
    const authed = await fetch(`${base}/api/overview`, { headers: { authorization: `Bearer ${token}` } });
    expect(authed.status).toBe(200);
  });

  test("the cookie works too, so the browser needs no JS storage", async () => {
    const res = await fetch(`${base}/api/overview`, { headers: { cookie: `kg_session=${encodeURIComponent(token)}` } });
    expect(res.status).toBe(200);
  });

  test("/api/auth/me reports the account and token expiry", async () => {
    const body = await readJson<{ user: { email: string }; token_expires_at: number }>(
      await fetch(`${base}/api/auth/me`, { headers: { authorization: `Bearer ${token}` } }),
    );
    expect(body.user.email).toBe("owner@example.test");
    expect(body.token_expires_at).toBeGreaterThan(Date.now());
  });

  test("logout revokes the token server-side", async () => {
    const out = await fetch(`${base}/api/auth/logout`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(out.status).toBe(200);
    expect((await fetch(`${base}/api/overview`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
  });

  test("an expired token is refused and reaped", async () => {
    const temporary = await freshToken();
    store.db.query("UPDATE tokens SET expires_at = ? WHERE id = ?").run(Date.now() - 1, hashToken(temporary));
    expect((await fetch(`${base}/api/overview`, { headers: { authorization: `Bearer ${temporary}` } })).status).toBe(401);
    expect(store.tokenById(hashToken(temporary))).toBeNull();
  });

  test("a disabled account's token stops working", async () => {
    const temporary = await freshToken();
    store.updateUser(accountId, { disabled_at: Date.now() });
    expect((await fetch(`${base}/api/overview`, { headers: { authorization: `Bearer ${temporary}` } })).status).toBe(401);
    store.updateUser(accountId, { disabled_at: null });
  });
});

describe("approval rules", () => {
  test("approving requires a session or the admin token", async () => {
    const grant = await startGrant();
    const res = await post("/api/auth/device/approve", { user_code: grant.user_code });
    expect(res.status).toBe(401);
  });

  test("the approver's session outlives the approval, so the browser gets in", async () => {
    const grant = await startGrant();
    const approve = await post(
      "/api/auth/device/approve",
      { user_code: grant.user_code, email: ACCOUNT_EMAIL, attach_existing: true },
      { "x-admin-token": ADMIN },
    );
    const cookie = (approve.headers.get("set-cookie") || "").split(";")[0];
    expect(cookie.startsWith("kg_session=")).toBe(true);
    expect((await fetch(`${base}/api/overview`, { headers: { cookie } })).status).toBe(200);
  });

  test("a pending code can be denied, and then reports access_denied", async () => {
    const grant = await startGrant();
    const deny = await post("/api/auth/device/deny", { user_code: grant.user_code }, { "x-admin-token": ADMIN });
    expect(deny.status).toBe(200);
    const poll = await post("/api/auth/device/token", {
      grant_type: DEVICE_GRANT,
      device_code: grant.device_code,
      client_id: CLIENT_ID,
    });
    expect((await readJson<{ error: string }>(poll)).error).toBe("access_denied");
  });

  test("the pending endpoint lets the approval page look a code up", async () => {
    const grant = await startGrant();
    const body = await readJson<{ found: boolean; status: string; user_code: string }>(
      await fetch(`${base}/api/auth/device/pending?user_code=${encodeURIComponent(grant.user_code)}`),
    );
    expect(body.found).toBe(true);
    expect(body.status).toBe("pending");
    expect(body.user_code).toBe(grant.user_code);
    expect((await readJson<{ found: boolean }>(await fetch(`${base}/api/auth/device/pending?user_code=ZZZZ-ZZZZ`))).found).toBe(false);
  });

  test("the dashboard is anonymous by default and only ADMIN_TOKEN closes it", () => {
    const fresh = new Store(":memory:");
    const url = new URL("http://localhost/api/overview");
    const req = new Request(url);
    // No token configured: open, accounts or not — anonymous access is the
    // default the gateway is meant to start in.
    expect(canAdminister(req, url, makeConfig(), fresh)).toBe("open");
    const user = fresh.createUser({ id: "u1", email: "a@b.test", name: "A", role: "owner" });
    expect(canAdminister(req, url, makeConfig(), fresh)).toBe("open");
    fresh.createToken({
      id: "t1",
      user_id: user.id,
      client_id: "test",
      created_at: Date.now(),
      expires_at: Date.now() + 60_000,
      last_used_at: null,
      user_agent: null,
      client_fingerprint: null,
    });
    expect(canAdminister(req, url, makeConfig(), fresh)).toBe("open");
    // Configuring ADMIN_TOKEN is what requires a credential.
    const locked = makeConfig({ adminToken: "tok" });
    expect(canAdminister(req, url, locked, fresh)).toBeNull();
    fresh.close();
  });
});

describe("approval gate", () => {
  test("ADMIN_TOKEN is what gates approval, not token count", () => {
    const s3 = new Store(":memory:");
    const url = new URL("http://localhost/api/auth/device/approve");
    const user = s3.createUser({ id: "u1", email: "a@b.test", name: "A", role: "owner" });
    s3.createToken({
      id: "t1",
      user_id: user.id,
      client_id: "test",
      created_at: Date.now(),
      expires_at: Date.now() + 1000,
      last_used_at: null,
      user_agent: null,
      client_fingerprint: null,
    });
    // No ADMIN_TOKEN: anonymous, so approval is allowed (default posture).
    expect(canAdminister(new Request(url), url, makeConfig(), s3)).toBe("open");
    // With ADMIN_TOKEN set, a credential is required.
    expect(canAdminister(new Request(url), url, makeConfig({ adminToken: "tok" }), s3)).toBeNull();
    s3.close();
  });
});

describe("token login", () => {
  test("an access token is exchanged for a browser session", async () => {
    const grant = await startGrant();
    await post("/api/auth/device/approve", { user_code: grant.user_code, email: ACCOUNT_EMAIL, attach_existing: true }, { "x-admin-token": ADMIN });
    const poll = await post("/api/auth/device/token", {
      grant_type: DEVICE_GRANT,
      device_code: grant.device_code,
      client_id: CLIENT_ID,
    });
    const issued = (await poll.json()) as TokenResponse;

    const login = await post("/api/auth/login", { token: issued.access_token });
    expect(login.status).toBe(200);
    const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
    expect(cookie.startsWith("kg_session=")).toBe(true);
    expect((await fetch(`${base}/api/overview`, { headers: { cookie } })).status).toBe(200);
  });

  test("ADMIN_TOKEN is accepted as an install credential", async () => {
    const res = await post("/api/auth/login", { token: ADMIN });
    expect(res.status).toBe(200);
    const body = await readJson<{ kind: string }>(res);
    expect(body.kind).toBe("admin_token");
  });

  test("a garbage token is rejected", async () => {
    expect((await post("/api/auth/login", { token: "nope" })).status).toBe(401);
  });
});

describe("unclaimed install approval", () => {
  test("with ADMIN_TOKEN unset, an unauthenticated browser may approve", async () => {
    const openStore = new Store(":memory:");
    const catalog = new Catalog(`http://127.0.0.1:${upstream.port}`, 60_000);
    const openApp = createApp({
      cfg: makeConfig({ upstream: `http://127.0.0.1:${upstream.port}` }),
      store: openStore,
      catalog,
    });
    const openServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: openApp.fetch });
    const openBase = `http://127.0.0.1:${openServer.port}`;
    try {
      const startRes = await fetch(`${openBase}/api/auth/device/code`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_id: CLIENT_ID }),
      });
      const grant = (await startRes.json()) as Grant;

      // No cookie, no token: allowed because the install is unclaimed.
      const approve = await fetch(`${openBase}/api/auth/device/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user_code: grant.user_code, email: "first@example.test" }),
      });
      expect(approve.status).toBe(200);
      const approved = (await approve.json()) as { user: { role: string } };
      expect(approved.user.role).toBe("owner");

      // And the token the terminal polls for works.
      const poll = await fetch(`${openBase}/api/auth/device/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ grant_type: DEVICE_GRANT, device_code: grant.device_code, client_id: CLIENT_ID }),
      });
      expect(poll.status).toBe(200);
      const token = ((await poll.json()) as TokenResponse).access_token;
      expect((await fetch(`${openBase}/api/overview`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
    } finally {
      openServer.stop(true);
      openStore.close();
    }
  });
});
