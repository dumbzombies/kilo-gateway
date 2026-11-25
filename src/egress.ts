// Egress pool: send upstream traffic through rotating WARP exits.
//
// Each configured proxy is a `warp-minimal` instance (an HTTP CONNECT proxy
// whose pool already rotates on 429/403). The gateway adds the layer that
// matters for an agent: when the chosen exit answers 429 or 403, the request is
// retried on the *next* exit before a single byte reaches the client, so a rate
// limit inside the tunnel never surfaces downstream.
//
// Bun's fetch takes a `proxy` option per request and always dials a fresh
// CONNECT tunnel — no keep-alive reuse to fight — so a retry is genuinely a new
// egress address, not a replayed request on a poisoned connection.

export interface EgressAttempt {
  /** Proxy URL, or "direct" when the request skipped the pool. */
  via: string;
  status: number;
  /** Set when the attempt failed before a usable response existed. */
  error?: string;
}

export interface EgressResponse {
  upstream: Response;
  via: string;
  attempts: EgressAttempt[];
}

/** Which path an upstream call takes. */
export type EgressMode = "warp" | "direct";

/**
 * Statuses worth another exit. 429/403 are exit-specific rate limits; 502/503/
 * 504 are what a proxy itself returns when its tunnel is dead or its pool is
 * empty. A 4xx that the request caused (400, 401, 404, 422) is never retried.
 */
const ROTATE_STATUSES = new Set([429, 403, 502, 503, 504]);

export interface EgressOptions {
  proxies: string[];
  fetchImpl: typeof fetch;
  /** Max exits tried per upstream call, including the first. */
  maxAttempts?: number;
  /**
   * When every exit fails at the transport level (proxy down, tunnel refused),
   * try once more without a proxy before giving up. Default true: an agent
   * should lose WARP, not the request.
   */
  directFallback?: boolean;
}

/**
 * Whether this runtime's `fetch` honours the non-standard `proxy` option.
 *
 * Bun does. Node's fetch (undici) has no `proxy` option and no importable
 * dispatcher, and it **silently ignores** an unknown one — so a proxy pool under
 * Node would appear configured while every request went out direct. Detecting
 * that up front is the difference between a degraded pool and a lie.
 */
export function proxySupported(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
}

export class Egress {
  private readonly proxies: string[];
  private readonly fetchImpl: typeof fetch;
  private readonly maxAttempts: number;
  /** Round-robin cursor so concurrent callers spread across exits. */
  private cursor = 0;
  /**
   * Exit failure scores. They decay by half every 30 s so one bad minute does
   * not permanently demote a healthy exit — without decay the map only ever grew
   * and a recovered exit stayed last in rotation forever.
   */
  private readonly failures = new Map<string, number>();
  private lastDecay = Date.now();
  private static readonly DECAY_MS = 30_000;

  private readonly supported: boolean;
  private readonly directFallback: boolean;

  constructor(opts: EgressOptions) {
    this.proxies = opts.proxies;
    this.fetchImpl = opts.fetchImpl;
    this.supported = proxySupported();
    this.directFallback = opts.directFallback ?? true;
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? Math.max(1, Math.min(3, opts.proxies.length + 1)));
    if (this.proxies.length > 0 && !this.supported) {
      console.warn(
        `[kilo-gateway] EGRESS_PROXIES is set but this runtime ignores fetch's "proxy" option ` +
          `(${this.proxies.length} prox${this.proxies.length === 1 ? "y" : "ies"} unused). ` +
          `Run under Bun for WARP rotation, or unset EGRESS_PROXIES to silence this.`,
      );
    }
  }

  /** False when proxies are configured but this runtime cannot use them. */
  get enabled(): boolean {
    return this.proxies.length > 0 && this.supported;
  }

  status(): {
    enabled: boolean;
    proxies: string[];
    max_attempts: number;
    proxy_supported: boolean;
    warning?: string;
  } {
    return {
      enabled: this.enabled,
      proxies: [...this.proxies],
      max_attempts: this.maxAttempts,
      proxy_supported: this.supported,
      ...(this.proxies.length > 0 && !this.supported
        ? { warning: "This runtime ignores fetch's proxy option; egress is direct." }
        : {}),
    };
  }

  /**
   * Forward one upstream call. Retries only when the failure is exit-specific
   * (429/403) or the proxy itself is unreachable — never on a 4xx/5xx that the
   * request itself caused, and never once a body has been handed to the caller.
   *
   * `mode: "direct"` bypasses the pool entirely, for callers that opted out of
   * WARP; it degrades to direct when no proxies are configured.
   */
  async send(url: string, init: RequestInit, mode: EgressMode = "warp"): Promise<EgressResponse> {
    const attempts: EgressAttempt[] = [];
    if (mode === "direct" || !this.enabled) {
      const upstream = await this.fetchImpl(url, init);
      return { upstream, via: "direct", attempts: [{ via: "direct", status: upstream.status }] };
    }

    const order = this.order();
    const limit = Math.min(this.maxAttempts, order.length);
    let lastError: unknown = null;

    for (let i = 0; i < limit; i++) {
      const via = order[i];
      let upstream: Response;
      try {
        upstream = await this.fetchImpl(url, this.withProxy(init, via));
      } catch (err) {
        if (init.signal?.aborted || (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError"))) {
          throw err;
        }
        attempts.push({ via, status: 0, error: err instanceof Error ? err.message : String(err) });
        lastError = err;
        this.failures.set(via, (this.failures.get(via) ?? 0) + 1);
        continue;
      }
      if (ROTATE_STATUSES.has(upstream.status) && i + 1 < limit) {
        // Drain the discarded body so the socket is released, then rotate.
        attempts.push({ via, status: upstream.status });
        await upstream.body?.cancel().catch(() => {});
        this.failures.set(via, (this.failures.get(via) ?? 0) + 1);
        continue;
      }
      attempts.push({ via, status: upstream.status });
      if (upstream.status < 500) this.failures.delete(via);
      return { upstream, via, attempts };
    }

    // Every exit failed before producing a response. Losing the tunnel must not
    // become a downstream error: retry once without a proxy, which is the
    // difference between "WARP restarted" and "the agent broke".
    if (this.directFallback) {
      try {
        const upstream = await this.fetchImpl(url, init);
        attempts.push({ via: "direct", status: upstream.status });
        console.warn(
          `[kilo-gateway] all ${this.proxies.length} egress exits failed; served directly ` +
            `(${attempts.map((a) => `${a.via}:${a.status || a.error}`).join(" → ")})`,
        );
        return { upstream, via: "direct", attempts };
      } catch (err) {
        attempts.push({ via: "direct", status: 0, error: err instanceof Error ? err.message : String(err) });
        lastError = err;
      }
    }

    // Direct failed too: surface the real transport error so the caller records
    // a true cause instead of a synthetic one.
    throw lastError ?? new Error("all egress exits failed");
  }

  /** Proxies in rotation order, starting at the cursor. */
  private decay(): void {
    const now = Date.now();
    const elapsed = now - this.lastDecay;
    if (elapsed < Egress.DECAY_MS) return;
    this.lastDecay = now;
    const halvings = Math.floor(elapsed / Egress.DECAY_MS);
    const factor = 0.5 ** halvings;
    for (const [proxy, score] of this.failures) {
      const next = Math.floor(score * factor);
      if (next <= 0) this.failures.delete(proxy);
      else this.failures.set(proxy, next);
    }
  }

  private order(): string[] {
    this.decay();
    const n = this.proxies.length;
    const start = this.cursor % n;
    this.cursor = (this.cursor + 1) % n;
    const ordered = [...this.proxies.slice(start), ...this.proxies.slice(0, start)];
    // Stable sort keeps the round-robin order among equally healthy exits.
    return ordered.sort((a, b) => (this.failures.get(a) ?? 0) - (this.failures.get(b) ?? 0));
  }

  private withProxy(init: RequestInit, proxy: string): RequestInit {
    // `proxy` is a Bun extension to RequestInit; the DOM type does not model it.
    return { ...init, proxy } as RequestInit;
  }
}
