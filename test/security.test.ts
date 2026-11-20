import { beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../src/db.ts";
import {
  authenticate,
  constantTimeEqual,
  generateKey,
  hashToken,
  isAdmin,
  looksLikeKiloKey,
} from "../src/security.ts";
import { makeConfig } from "./helpers.ts";

function request(token?: string): Request {
  const headers = new Headers();
  if (token) headers.set("authorization", `Bearer ${token}`);
  return new Request("http://localhost/v1/models", { headers });
}

function url(): URL {
  return new URL("http://localhost/v1/models");
}

let store: Store;
beforeEach(() => {
  store = new Store(":memory:");
});

describe("key material", () => {
  test("generates distinct kg_ keys and their hashes", () => {
    const a = generateKey();
    const b = generateKey();
    expect(a.secret.startsWith("kg_")).toBe(true);
    expect(a.secret).not.toBe(b.secret);
    expect(a.hash).toBe(hashToken(a.secret));
    expect(a.prefix).toBe(a.secret.slice(0, 12));
  });

  test("constant-time compare is value based", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcdef")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(false);
  });

  test("recognises real Kilo keys only", () => {
    expect(looksLikeKiloKey("sk-live-123")).toBe(true);
    expect(looksLikeKiloKey("Bearer pk-123")).toBe(true);
    expect(looksLikeKiloKey("kg_123")).toBe(false);
    expect(looksLikeKiloKey("placeholder")).toBe(false);
  });
});

describe("authentication", () => {
  test("open mode accepts requests without credentials", () => {
    const outcome = authenticate(request(), url(), makeConfig(), store);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.auth.mode).toBe("open");
  });

  test("required mode rejects anonymous requests", () => {
    const outcome = authenticate(request(), url(), makeConfig({ requireKey: true }), store);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.status).toBe(401);
      expect(outcome.body.error).toMatchObject({ code: "missing_api_key" });
    }
  });

  test("a virtual key resolves to its row", () => {
    const generated = generateKey();
    const row = store.createKey({
      id: "key-1",
      name: "Laptop",
      prefix: generated.prefix,
      hash: generated.hash,
      rpm: 0,
      daily_limit: 0,
      upstream_key: null,
    });
    const outcome = authenticate(request(generated.secret), url(), makeConfig({ requireKey: true }), store);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.auth.mode).toBe("key");
      expect(outcome.auth.key?.id).toBe(row.id);
      expect(store.keyById("key-1")?.last_used_at).not.toBeNull();
    }
  });

  test("revoked keys are rejected", () => {
    const generated = generateKey();
    store.createKey({
      id: "key-1",
      name: "Gone",
      prefix: generated.prefix,
      hash: generated.hash,
      rpm: 0,
      daily_limit: 0,
      upstream_key: null,
    });
    store.updateKey("key-1", { revoked_at: Date.now() });
    const outcome = authenticate(request(generated.secret), url(), makeConfig(), store);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(401);
  });

  test("unknown gateway keys never fall through to anonymous access", () => {
    const outcome = authenticate(request("kg_unknown"), url(), makeConfig(), store);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(401);
  });

  test("per-minute limits return 429 with Retry-After", () => {
    const generated = generateKey();
    store.createKey({
      id: "key-1",
      name: "Fast",
      prefix: generated.prefix,
      hash: generated.hash,
      rpm: 1,
      daily_limit: 0,
      upstream_key: null,
    });
    store.insertRequest({
      id: "r1",
      ts: Date.now() - 1000,
      key_id: "key-1",
      key_name: "Fast",
      method: "POST",
      path: "/v1/chat/completions",
      model: "x",
      status: 200,
      upstream_status: 200,
      stream: false,
      duration_ms: 10,
      ttft_ms: 5,
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2,
      cost_usd: null,
      client: null,
      error: null,
      source: "api",
    });
    const outcome = authenticate(request(generated.secret), url(), makeConfig(), store);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.status).toBe(429);
      expect(outcome.headers["retry-after"]).toBe("60");
    }
  });

  test("real Kilo keys pass through even when gateway keys are required", () => {
    const outcome = authenticate(request("sk-live-abc"), url(), makeConfig({ requireKey: true }), store);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.auth.mode).toBe("open");
      expect(outcome.auth.upstreamKey).toBe("sk-live-abc");
    }
  });

  test("the admin token unlocks the API", () => {
    const cfg = makeConfig({ adminToken: "admin-secret" });
    expect(isAdmin(request("admin-secret"), url(), cfg)).toBe(true);
    expect(isAdmin(request("wrong"), url(), cfg)).toBe(false);
    expect(isAdmin(request(), url(), cfg)).toBe(false);
    const outcome = authenticate(request("admin-secret"), url(), cfg, store);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.auth.mode).toBe("admin");
  });
});
