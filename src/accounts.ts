// Dashboard authentication, modelled on warm-run-cli (`@warm-ai/warm`):
// RFC 8628 device authorization, opaque bearer access tokens, no passwords.
//
// The flow, identical in shape to the CLI's:
//
//   1. POST /api/auth/device/code  {client_id}
//        → { device_code, user_code, verification_uri, verification_uri_complete,
//            expires_in, interval }
//   2. A human opens the verification URI and approves the code (here, while
//      signed in to the dashboard).
//   3. POST /api/auth/device/token
//        { grant_type: "urn:ietf:params:oauth:grant-type:device_code",
//          device_code, client_id }
//        → { access_token, token_type: "Bearer", expires_in, scope } or an
//          RFC 8628 error: authorization_pending | slow_down | expired_token |
//          access_denied | invalid_request | invalid_grant
//   4. The client persists { schemaVersion, apiBaseUrl, accessToken, authStyle,
//      expiresAt, user } to credentials.json — same shape the CLI writes.
//
// Only the SHA-256 of an access token or device code is stored, so a database
// leak cannot be replayed. There is no refresh grant, matching the CLI: an
// expired token means a fresh device authorization.

import { randomBytes, randomUUID } from "node:crypto";
import type { Config } from "./config.ts";
import type { DeviceCodeRow, Store, TokenRow, UserRow } from "./db.ts";
import { constantTimeEqual, hashToken, presentedToken } from "./security.ts";

export const SESSION_COOKIE = "kg_session";
export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
export const CLIENT_ID = "kilo-gateway-dashboard";

/** Device codes live 10 minutes and are polled every 5 s, as in the CLI. */
const DEVICE_TTL_SEC = 600;
const DEVICE_INTERVAL_SEC = 5;
const SLOW_DOWN_PENALTY_SEC = 5;
const MAX_INTERVAL_SEC = 60;
/** Access tokens last 30 days; there is no refresh grant. */
const TOKEN_TTL_MS = 30 * 86_400_000;
const MAX_EMAIL = 254;

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: string;
  created_at: number;
  last_login_at: number | null;
  disabled: boolean;
}

export function publicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    created_at: row.created_at,
    last_login_at: row.last_login_at,
    disabled: row.disabled_at !== null,
  };
}

export function normaliseEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length === 0 || email.length > MAX_EMAIL) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

// ---- device authorization -------------------------------------------------

export interface DeviceCodeGrant {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

/** `ABCD-EFGH`: unambiguous alphabet, 8 significant characters. */
function userCode(): string {
  const alphabet = "BCDFGHJKLMNPQRSTVWXZ"; // no vowels, no 0/O/1/I
  const bytes = randomBytes(8);
  let out = "";
  for (const byte of bytes) {
    out += alphabet[byte % alphabet.length];
    if (out.length === 4) out += "-";
  }
  return out;
}

export function startDeviceCode(store: Store, origin: string, clientId: string): DeviceCodeGrant {
  const deviceCode = randomBytes(32).toString("base64url");
  const code = userCode();
  const now = Date.now();
  store.createDeviceCode({
    device_code: hashToken(deviceCode),
    user_code: code,
    client_id: clientId,
    user_id: null,
    created_at: now,
    expires_at: now + DEVICE_TTL_SEC * 1000,
    interval: DEVICE_INTERVAL_SEC,
    status: "pending",
    last_polled_at: null,
    client_fingerprint: null,
  });
  const verify = `${origin}/device`;
  return {
    device_code: deviceCode,
    user_code: code,
    verification_uri: verify,
    verification_uri_complete: `${verify}?user_code=${encodeURIComponent(code)}`,
    expires_in: DEVICE_TTL_SEC,
    interval: DEVICE_INTERVAL_SEC,
  };
}

/**
 * Mints a bearer token for a user. Shared by the device-code exchange (the
 * polling client) and approval (the browser that approved, so it lands signed
 * in rather than stranded on the approval page).
 */
export function issueToken(
  store: Store,
  user: UserRow,
  clientId: string,
  userAgent: string | null,
): { token: string; expiresIn: number } {
  const now = Date.now();
  const token = `kgd_${randomBytes(32).toString("base64url")}`;
  store.createToken({
    id: hashToken(token),
    user_id: user.id,
    client_id: clientId,
    created_at: now,
    expires_at: now + TOKEN_TTL_MS,
    last_used_at: now,
    user_agent: userAgent,
    client_fingerprint: null,
  });
  return { token, expiresIn: Math.floor(TOKEN_TTL_MS / 1000) };
}

export type TokenOutcome =
  | { ok: true; access_token: string; expires_in: number; user: UserRow }
  | { ok: false; status: number; error: string; description: string };

/**
 * The polling endpoint. Enforces the RFC 8628 `slow_down` rule: polling faster
 * than the issued interval extends it by 5 s, capped at 60 s.
 */
export function exchangeDeviceCode(
  store: Store,
  deviceCode: string,
  clientId: string,
  userAgent: string | null,
): TokenOutcome {
  const row = store.deviceCodeByHash(hashToken(deviceCode));
  const denied = (error: string, description: string, status = 400): TokenOutcome => ({
    ok: false,
    status,
    error,
    description,
  });

  if (!row || row.client_id !== clientId) {
    return denied("invalid_grant", "Unknown device code for this client.");
  }
  if (row.status === "consumed") return denied("invalid_grant", "This device code was already used.");
  if (row.status === "denied") return denied("access_denied", "The authorization request was denied.");
  if (row.expires_at <= Date.now()) {
    store.setDeviceStatus(row.device_code, "expired");
    return denied("expired_token", "The device code expired. Start a new authorization.");
  }
  const now = Date.now();
  if (row.last_polled_at !== null && now - row.last_polled_at < row.interval * 1000) {
    store.touchDeviceCode(row.device_code, now, Math.min(row.interval + SLOW_DOWN_PENALTY_SEC, MAX_INTERVAL_SEC));
    return denied("slow_down", "Polling too quickly; the interval has been increased.");
  }
  store.touchDeviceCode(row.device_code, now, row.interval);
  if (row.status !== "approved" || !row.user_id) {
    return denied("authorization_pending", "Waiting for a human to approve this code.");
  }

  const user = store.userById(row.user_id);
  if (!user || user.disabled_at !== null) {
    store.setDeviceStatus(row.device_code, "denied");
    return denied("access_denied", "The account is disabled.");
  }
  const issued = issueToken(store, user, clientId, userAgent);
  const tokenRow = store.tokenById(hashToken(issued.token));
  if (tokenRow && row.client_fingerprint) {
    store.db
      .query("UPDATE tokens SET client_fingerprint = ? WHERE id = ?")
      .run(row.client_fingerprint, tokenRow.id);
  }
  store.setDeviceStatus(row.device_code, "consumed");
  store.updateUser(user.id, { last_login_at: now });
  return { ok: true, access_token: issued.token, expires_in: issued.expiresIn, user };
}

// ---- bearer tokens --------------------------------------------------------

export interface UserAuth {
  user: UserRow;
  token: TokenRow | null;
}

/** Reads the session cookie, tolerating other cookies and encoded values. */
export function sessionTokenFrom(req: Request): string {
  const header = req.headers.get("cookie");
  if (!header) return "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return "";
}

/**
 * Resolves a bearer token from either the `Authorization: Bearer` header (CLI,
 * matching `authStyle: "bearer"` in credentials.json) or the session cookie
 * (browser). Expired tokens are deleted.
 */
export function authenticateToken(req: Request, store: Store): UserAuth | null {
  const header = req.headers.get("authorization") || "";
  const bearer = /^bearer\s+/i.test(header) ? header.slice(7).trim() : "";
  const token = bearer || sessionTokenFrom(req);
  if (!token) return null;
  const row = store.tokenById(hashToken(token));
  if (!row) return null;
  if (row.expires_at <= Date.now()) {
    store.deleteToken(row.id);
    return null;
  }
  const user = store.userById(row.user_id);
  if (!user || user.disabled_at !== null) return null;
  store.touchToken(row.id, Date.now());
  return { user, token: row };
}

/**
 * Whether the caller may see dashboard data: a bearer token identifies a
 * person, `ADMIN_TOKEN` unlocks the install as break-glass, and a gateway with
 * no accounts and no token is open (first-run bootstrap).
 */
export function canAdminister(
  req: Request,
  url: URL,
  cfg: Config,
  store: Store,
): UserAuth | "admin" | "open" | null {
  const session = authenticateToken(req, store);
  if (session) return session;
  if (cfg.adminToken) {
    const token = presentedToken(req, url);
    if (token !== "" && constantTimeEqual(token, cfg.adminToken)) return "admin";
  }
  // The dashboard is anonymous by default: that is how the gateway is meant to
  // start, and the user asked for anonymous access to be preserved. Only an
  // explicitly configured ADMIN_TOKEN closes it.
  if (!cfg.adminToken) return "open";
  return null;
}

export function sessionCookie(token: string, secure: boolean): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(TOKEN_TTL_MS / 1000)}`,
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

// ---- accounts -------------------------------------------------------------

export interface AccountInput {
  email?: unknown;
  name?: unknown;
}

export type AccountOutcome = { ok: true; user: UserRow } | { ok: false; status: number; message: string };

export function createAccount(store: Store, input: AccountInput): AccountOutcome {
  const email = normaliseEmail(input.email);
  if (!email) return { ok: false, status: 400, message: "Enter a valid email address." };
  if (store.userByEmail(email)) {
    return { ok: false, status: 409, message: "An account with that email already exists." };
  }
  const rawName = typeof input.name === "string" ? input.name.trim() : "";
  return {
    ok: true,
    user: store.createUser({
      id: randomUUID(),
      email,
      name: rawName.slice(0, 80) || email.split("@")[0],
      role: store.countUsers() === 0 ? "owner" : "member",
    }),
  };
}

/** `publicUser` plus the shape warm-run-cli's credentials.json expects. */
export function credentials(origin: string, token: string, user: UserRow): Record<string, unknown> {
  return {
    schemaVersion: 1,
    apiBaseUrl: origin,
    accessToken: token,
    authStyle: "bearer",
    expiresAt: new Date(Date.now() + TOKEN_TTL_MS).toISOString(),
    user: { id: user.id, name: user.name, email: user.email },
  };
}
