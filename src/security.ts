// Virtual-key authentication and per-key rate limits.
//
// Two credentials reach the proxy:
//   * a gateway key  (`kg_...`) — created in the dashboard, hashed at rest
//   * a real Kilo key (`sk-...` / `pk-...`) — forwarded upstream, paid models
// The admin token (ADMIN_TOKEN) also unlocks the dashboard API and /v1, so the
// built-in playground works without minting a key.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { ApiKeyRow } from "./db.ts";
import type { Config } from "./config.ts";
import type { UpstreamPool } from "./keypool.ts";
import type { Store } from "./db.ts";

export const KEY_PREFIX = "kg_";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Compare SHA-256 digests so neither content nor length leaks via timing. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

export function generateKey(): { secret: string; hash: string; prefix: string } {
  const secret = KEY_PREFIX + randomBytes(24).toString("base64url");
  return { secret, hash: hashToken(secret), prefix: secret.slice(0, 12) };
}

export function looksLikeKiloKey(value: string | null | undefined): boolean {
  if (!value) return false;
  const stripped = value.replace(/^bearer\s+/i, "").trim();
  return /^(sk-|pk-)/i.test(stripped);
}

export function presentedToken(req: Request, url?: URL): string {
  const auth = req.headers.get("authorization") || "";
  if (/^bearer\s+/i.test(auth)) return auth.slice(7).trim();
  const apiKey = req.headers.get("x-api-key");
  if (apiKey) return apiKey.trim();
  const own = req.headers.get("x-admin-token") || req.headers.get("x-gateway-token");
  if (own) return own.trim();
  return url?.searchParams.get("token")?.trim() ?? "";
}

export function isAdmin(req: Request, url: URL, cfg: Config): boolean {
  if (!cfg.adminToken) return true;
  const token = presentedToken(req, url);
  return token !== "" && constantTimeEqual(token, cfg.adminToken);
}

export interface AuthContext {
  /** "admin" and "open" requests ride keyless unless they carry a real Kilo key. */
  mode: "admin" | "open" | "key";
  key: ApiKeyRow | null;
  /** Kilo credential to send upstream, if any. */
  upstreamKey: string | null;
  /** True when `upstreamKey` came from the pooled credentials, not the caller. */
  pooled?: boolean;
  /** The quota reservation this request holds, when it authenticated as a key. */
  quotaTicket?: string;
  /**
   * The key presented is valid but past its own quota: the call is served on
   * the anonymous tier instead of failing, so an agent keeps working. Set on
   * `open`-mode contexts only.
   */
  degraded?: { reason: "rpm" | "daily"; keyName: string; retryAfter: string };
}

/**
 * Releases the quota slot a successful `authenticate()` reserved.
 *
 * Callers that answer without going through `handleProxy` (model listings,
 * oversized bodies, auth-adjacent short circuits) must call this, or the slot
 * leaks and the key is silently degraded by traffic it never generated.
 */
export function releaseQuotaFor(outcome: AuthOutcome, store: Store): void {
  if (outcome.ok && outcome.auth.key) {
    store.releaseQuota(outcome.auth.key.id, outcome.auth.quotaTicket);
  }
}

export type AuthOutcome =
  | { ok: true; auth: AuthContext }
  | { ok: false; status: number; body: Record<string, unknown>; headers: Record<string, string> };

function errorBody(message: string, type: string, code: string): Record<string, unknown> {
  return { error: { message, type, code } };
}

export function authenticate(
  req: Request,
  url: URL,
  cfg: Config,
  store: Store,
  pool?: UpstreamPool,
): AuthOutcome {
  const token = presentedToken(req, url);
  const admin = cfg.adminToken !== "" && token !== "" && constantTimeEqual(token, cfg.adminToken);

  if (token.startsWith(KEY_PREFIX)) {
    if (admin) return { ok: true, auth: { mode: "admin", key: null, upstreamKey: null } };
    const key = store.keyByHash(hashToken(token));
    if (!key) {
      return {
        ok: false,
        status: 401,
        body: errorBody("Invalid API key. Create one in the dashboard.", "authentication_error", "invalid_api_key"),
        headers: { "www-authenticate": "Bearer" },
      };
    }
    if (key.revoked_at) {
      return {
        ok: false,
        status: 401,
        body: errorBody("This API key has been revoked.", "authentication_error", "key_revoked"),
        headers: { "www-authenticate": "Bearer" },
      };
    }
    const now = Date.now();
    // Quota exhaustion is a tier boundary, not an error: the request is served
    // anonymously (WARP egress by default) so an agentic client never sees a
    // 429 it cannot act on. The response still advertises the degradation.
    //
    // The check *and* the reservation are one synchronous step, so a concurrent
    // burst cannot all observe the same pre-burst count.
    const quota = store.reserveQuota(key, now);
    if (quota.exceeded === "rpm") {
      return { ok: true, auth: degrade(key, "rpm", "60") };
    }
    if (quota.exceeded === "daily") {
      return { ok: true, auth: degrade(key, "daily", "3600") };
    }
    store.touchKey(key.id, now);
    // Client identity and upstream credential are independent: a key without
    // its own Kilo credential borrows a pooled one, so a dashboard-issued key
    // gets the pooled accounts instead of falling back to the anonymous tier.
    const borrowed = key.upstream_key ? null : (pool?.next() ?? null);
    return {
      ok: true,
      auth: {
        mode: "key",
        key,
        upstreamKey: key.upstream_key ?? borrowed,
        pooled: borrowed !== null,
        quotaTicket: quota.ticket ?? undefined,
      },
    };
  }

  if (admin) return { ok: true, auth: { mode: "admin", key: null, upstreamKey: null } };

  // A caller-supplied Kilo key is a valid passthrough credential. It is never
  // required for free models, so it is also accepted when keys are mandatory.
  if (looksLikeKiloKey(token)) {
    return { ok: true, auth: { mode: "open", key: null, upstreamKey: token } };
  }

  if (cfg.requireKey) {
    return {
      ok: false,
      status: 401,
      body: errorBody(
        "Missing API key. Send Authorization: Bearer <gateway-key> (create one in the dashboard).",
        "authentication_error",
        "missing_api_key",
      ),
      headers: { "www-authenticate": "Bearer" },
    };
  }

  // Anonymous tier. When the upstream credential pool still has a usable key,
  // borrow one so the call rides the pooled account; when every key is cooling
  // ("all logins hit quota"), this returns no upstreamKey and the request goes
  // out on the anonymous tier via WARP.
  const borrowed = pool?.next() ?? null;
  return { ok: true, auth: { mode: "open", key: null, upstreamKey: borrowed, pooled: borrowed !== null } };
}

/** The anonymous-tier context used when a valid key is past its quota. */
function degrade(key: ApiKeyRow, reason: "rpm" | "daily", retryAfter: string): AuthContext {
  return {
    mode: "open",
    key: null,
    upstreamKey: null,
    degraded: { reason, keyName: key.name, retryAfter },
  };
}

export interface CreatedKey {
  id: string;
  secret: string;
  hash: string;
  prefix: string;
}

export function newKeyId(): string {
  return randomUUID();
}
