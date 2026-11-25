import { describe, expect, test } from "bun:test";
import { Egress } from "../src/egress.ts";

const A = "http://127.0.0.1:18789";
const B = "http://127.0.0.1:18790";

/** Fake fetch that answers per proxy, recording the order it was called in. */
function fakeFetch(byProxy: Record<string, () => Response | Error>) {
  const calls: string[] = [];
  const impl = (async (_url: string, init: RequestInit & { proxy?: string }) => {
    const via = init.proxy ?? "direct";
    calls.push(via);
    const handler = byProxy[via];
    if (!handler) throw new Error(`unexpected proxy ${via}`);
    const result = handler();
    if (result instanceof Error) throw result;
    return result;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const ok = (body = "{}") =>
  new Response(body, { status: 200, headers: { "content-type": "application/json" } });
const limited = () => new Response("rate limited", { status: 429 });

describe("egress rotation", () => {
  test("direct mode passes straight through", async () => {
    const { impl, calls } = fakeFetch({ direct: () => ok() });
    const egress = new Egress({ proxies: [], fetchImpl: impl });
    expect(egress.enabled).toBe(false);
    const result = await egress.send("https://api.kilo.ai/api/gateway/models", {});
    expect(result.via).toBe("direct");
    expect(result.upstream.status).toBe(200);
    expect(calls).toEqual(["direct"]);
  });

  test("a 429 on the first exit retries on the next and never reaches the caller", async () => {
    const { impl, calls } = fakeFetch({ [A]: limited, [B]: () => ok('{"ok":true}') });
    const egress = new Egress({ proxies: [A, B], fetchImpl: impl });
    const result = await egress.send("https://example.test/v1/chat/completions", {});
    expect(result.upstream.status).toBe(200);
    expect(calls).toEqual([A, B]);
    expect(result.via).toBe(B);
    expect(result.attempts).toEqual([
      { via: A, status: 429 },
      { via: B, status: 200 },
    ]);
  });

  test("403 rotates too", async () => {
    const { impl, calls } = fakeFetch({
      [A]: () => new Response("blocked", { status: 403 }),
      [B]: () => ok(),
    });
    const egress = new Egress({ proxies: [A, B], fetchImpl: impl });
    const result = await egress.send("https://example.test/v1/models", {});
    expect(result.upstream.status).toBe(200);
    expect(calls.length).toBe(2);
  });

  test("a proxy-side 503 rotates, since it means the tunnel is dead", async () => {
    const { impl, calls } = fakeFetch({
      [A]: () => new Response("WARP unavailable", { status: 503 }),
      [B]: () => ok(),
    });
    const egress = new Egress({ proxies: [A, B], fetchImpl: impl });
    const result = await egress.send("https://example.test/v1/models", {});
    expect(result.upstream.status).toBe(200);
    expect(calls).toEqual([A, B]);
  });

  test("a genuine 400 is returned untouched, with no rotation", async () => {
    const { impl, calls } = fakeFetch({
      [A]: () => new Response('{"error":"bad model"}', { status: 400 }),
      [B]: () => ok(),
    });
    const egress = new Egress({ proxies: [A, B], fetchImpl: impl });
    const result = await egress.send("https://example.test/v1/chat/completions", {});
    expect(result.upstream.status).toBe(400);
    expect(calls).toEqual([A]);
  });

  test("an unreachable exit falls through to the next one", async () => {
    const { impl, calls } = fakeFetch({
      [A]: () => new Error("ECONNREFUSED"),
      [B]: () => ok(),
    });
    const egress = new Egress({ proxies: [A, B], fetchImpl: impl });
    const result = await egress.send("https://example.test/v1/models", {});
    expect(result.upstream.status).toBe(200);
    expect(result.via).toBe(B);
    expect(result.attempts[0]).toEqual({ via: A, status: 0, error: "ECONNREFUSED" });
    expect(calls).toEqual([A, B]);
  });

  test("when every exit 429s the last response is still delivered", async () => {
    const { impl } = fakeFetch({ [A]: limited, [B]: limited });
    const egress = new Egress({ proxies: [A, B], fetchImpl: impl, maxAttempts: 2 });
    const result = await egress.send("https://example.test/v1/models", {});
    expect(result.upstream.status).toBe(429);
    expect(result.attempts.length).toBe(2);
  });

  test("aborts are not retried", async () => {
    const controller = new AbortController();
    let n = 0;
    const impl = (async () => {
      n++;
      controller.abort();
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }) as unknown as typeof fetch;
    const egress = new Egress({ proxies: [A, B], fetchImpl: impl });
    await expect(
      egress.send("https://example.test/v1/models", { signal: controller.signal }),
    ).rejects.toThrow("aborted");
    expect(n).toBe(1);
  });

  test("the cursor spreads calls across exits", async () => {
    const { impl, calls } = fakeFetch({ [A]: () => ok(), [B]: () => ok() });
    const egress = new Egress({ proxies: [A, B], fetchImpl: impl });
    await egress.send("https://x.test/1", {});
    await egress.send("https://x.test/2", {});
    expect(new Set(calls)).toEqual(new Set([A, B]));
  });
});

describe("runtime honesty", () => {
  test("enabled is false when the runtime ignores fetch's proxy option", async () => {
    const { proxySupported } = await import("../src/egress.ts");
    const egress = new Egress({ proxies: ["http://127.0.0.1:9"], fetchImpl: fetch });
    // Under Bun, proxy is honoured; the assertion tracks the runtime so the
    // contract (enabled === supported) is what is pinned.
    expect(egress.enabled).toBe(proxySupported());
    const status = egress.status();
    expect(status.proxy_supported).toBe(proxySupported());
    if (!proxySupported()) {
      expect(status.warning).toBeTruthy();
    }
  });
});

describe("failure decay", () => {
  test("a recovered exit returns to rotation", async () => {
    const A = "http://127.0.0.1:18789";
    const B = "http://127.0.0.1:18790";
    const { impl } = fakeFetch({ [A]: () => new Error("down"), [B]: () => ok() });
    const egress = new Egress({ proxies: [A, B], fetchImpl: impl });
    await egress.send("https://x.test/1", {}); // A fails, is scored
    // Simulate the decay window elapsing.
    (egress as unknown as { lastDecay: number }).lastDecay = Date.now() - 60_000;
    // Two halvings empty the score, so A is eligible again.
    const order = (egress as unknown as { order: () => string[] }).order();
    expect(order).toContain(A);
  });
});

describe("direct fallback", () => {
  test("every exit down falls back to direct instead of failing the request", async () => {
    const calls: string[] = [];
    const impl = (async (_url: string, init: RequestInit & { proxy?: string }) => {
      const via = init.proxy ? "proxied" : "direct";
      calls.push(via);
      if (init.proxy) throw new Error("ECONNREFUSED");
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const egress = new Egress({ proxies: ["http://127.0.0.1:9"], fetchImpl: impl });
    const result = await egress.send("https://x.test/v1/models", {});
    expect(result.upstream.status).toBe(200);
    expect(result.via).toBe("direct");
    expect(calls).toEqual(["proxied", "direct"]);
  });

  test("fallback can be disabled, preserving the transport error", async () => {
    const impl = (async (_url: string, init: RequestInit & { proxy?: string }) => {
      if (init.proxy) throw new Error("ECONNREFUSED");
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const egress = new Egress({ proxies: ["http://127.0.0.1:9"], fetchImpl: impl, directFallback: false });
    await expect(egress.send("https://x.test/v1/models", {})).rejects.toThrow("ECONNREFUSED");
  });

  test("a proxy that answers with a status is not treated as a transport failure", async () => {
    const calls: string[] = [];
    const impl = (async (_url: string, init: RequestInit & { proxy?: string }) => {
      calls.push(init.proxy ? "proxied" : "direct");
      return new Response("rate limited", { status: 429 });
    }) as unknown as typeof fetch;
    const egress = new Egress({ proxies: ["http://127.0.0.1:9"], fetchImpl: impl, maxAttempts: 1 });
    const result = await egress.send("https://x.test/v1/models", {});
    // The exit answered (429): that is a rate limit, not a dead tunnel, so the
    // caller sees the real status rather than a silent direct retry.
    expect(result.upstream.status).toBe(429);
    expect(calls).toEqual(["proxied"]);
  });
});
