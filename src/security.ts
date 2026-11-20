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
import { startOfUtcDay } from "./db.ts";
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
}

export type AuthOutcome =
  | { ok: true; auth: AuthContext }
  | { ok: false; status: number; body: Record<string, unknown>; headers: Record<string, string> };

function errorBody(message: string, type: string, code: string): Record<string, unknown> {
  return { error: { message, type, code } };
}

export function authenticate(req: Request, url: URL, cfg: Config, store: Store): AuthOutcome {
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
    if (key.rpm > 0 && store.keyRequestsSince(key.id, now - 60_000) >= key.rpm) {
      return {
        ok: false,
        status: 429,
        body: errorBody(`Rate limit exceeded (${key.rpm} requests/minute).`, "rate_limit_error", "rate_limited"),
        headers: { "retry-after": "60" },
      };
    }
    if (key.daily_limit > 0 && store.keyRequestsSince(key.id, startOfUtcDay(now)) >= key.daily_limit) {
      return {
        ok: false,
        status: 429,
        body: errorBody(
          `Daily request limit reached (${key.daily_limit}/day). Resets at 00:00 UTC.`,
          "rate_limit_error",
          "daily_limit_exceeded",
        ),
        headers: { "retry-after": "3600" },
      };
    }
    store.touchKey(key.id, now);
    return { ok: true, auth: { mode: "key", key, upstreamKey: key.upstream_key } };
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

  return { ok: true, auth: { mode: "open", key: null, upstreamKey: null } };
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
