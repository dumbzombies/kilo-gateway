// Device-flow auth endpoints, mirroring warm-run-cli's RFC 8628 shape.
//
//   GET  /api/auth/status                     installation + session state
//   POST /api/auth/device/code                start an authorization
//   POST /api/auth/device/token               poll for a token (grant_type device_code)
//   GET  /api/auth/device/pending?user_code=  what the approval page shows
//   POST /api/auth/device/approve             approve while signed in
//   POST /api/auth/device/deny                deny a pending code
//   POST /api/auth/logout                     revoke the presented token/cookie
//   GET  /api/auth/me                         current user + credential shape
//
// Everything that returns dashboard data stays behind `canAdminister()` in app.ts.

import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import {
  CLIENT_ID,
  DEVICE_GRANT,
  authenticateToken,
  canAdminister,
  clearSessionCookie,
  createAccount,
  credentials,
  exchangeDeviceCode,
  publicUser,
  normaliseEmail,
  sessionCookie,
  startDeviceCode,
  issueToken,
} from "./accounts.ts";
import { isRecord } from "./json.ts";
import { hashToken } from "./security.ts";

export interface AuthApiDeps {
  cfg: Config;
  store: Store;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  const text = await req.text();
  if (!text) return {};
  if (text.length > 10_000) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isSecure(req: Request): boolean {
  if (new URL(req.url).protocol === "https:") return true;
  return (req.headers.get("x-forwarded-proto") || "").toLowerCase() === "https";
}

/**
 * The approver also gets a token: they are the authorized human, and without
 * this a browser that approved a code would be stranded on the approval page
 * with no way in (the bootstrap window closes as soon as a token exists).
 */
function approveResponse(req: Request, store: Store, userId: string): Response {
  const user = store.userById(userId);
  if (!user) return json({ error: "Account not found." }, 404);
  const issued = issueToken(store, user, "dashboard", req.headers.get("user-agent"));
  return json({ approved: true, user: publicUser(user) }, 200, {
    "set-cookie": sessionCookie(issued.token, isSecure(req)),
  });
}

/** RFC 8628 §3.2 error body, plus the dashboard's own `error_description`. */
function oauthError(error: string, description: string, status = 400): Response {
  return json({ error, error_description: description }, status, { "cache-control": "no-store" });
}

export async function handleAuth(req: Request, url: URL, deps: AuthApiDeps): Promise<Response | null> {
  const { store } = deps;
  const path = url.pathname;
  const origin = url.origin;

  if (path === "/api/auth/status" && req.method === "GET") {
    const session = authenticateToken(req, store);
    const users = store.countUsers();
    return json(
      {
        auth_style: "device_code",
        device_flow: true,
        client_id: CLIENT_ID,
        grant_type: DEVICE_GRANT,
        admin_required: deps.cfg.adminToken !== "",
        key_required: deps.cfg.requireKey,
        setup_required: users === 0,
        user_count: users,
        user: session ? publicUser(session.user) : null,
      },
      200,
      { "cache-control": "no-store" },
    );
  }

  if (path === "/api/auth/device/code" && req.method === "POST") {
    const body = (await readJson(req)) ?? {};
    const clientId = typeof body.client_id === "string" ? body.client_id.slice(0, 80) : CLIENT_ID;
    const grant = startDeviceCode(store, origin, clientId || CLIENT_ID);
    return json(
      {
        ...grant,
        // Non-standard extras keep the CLI-compatible fields intact.
        client_id: clientId || CLIENT_ID,
        auth_style: "bearer",
      },
      200,
      { "cache-control": "no-store" },
    );
  }

  if (path === "/api/auth/device/token" && req.method === "POST") {
    const body = await readJson(req);
    if (!body) return oauthError("invalid_request", "Malformed JSON body.");
    if (body.grant_type !== DEVICE_GRANT) {
      return oauthError("unsupported_grant_type", `Expected grant_type ${DEVICE_GRANT}.`);
    }
    const deviceCode = typeof body.device_code === "string" ? body.device_code : "";
    const clientId = typeof body.client_id === "string" ? body.client_id : CLIENT_ID;
    if (!deviceCode) return oauthError("invalid_request", "device_code is required.");

    const outcome = exchangeDeviceCode(store, deviceCode, clientId, req.headers.get("user-agent"));
    if (!outcome.ok) return oauthError(outcome.error, outcome.description, outcome.status);
    const token = outcome.access_token;
    const tokenRow = store.tokenById(hashToken(token));
    return json(
      {
        access_token: token,
        token_type: "Bearer",
        expires_in: outcome.expires_in,
        scope: "dashboard",
        client_fingerprint: tokenRow?.client_fingerprint ?? undefined,
        user: publicUser(outcome.user),
        // The exact file shape warm-run-cli writes, ready to save as credentials.json.
        credentials: credentials(origin, token, outcome.user),
      },
      200,
      {
        "cache-control": "no-store",
        "set-cookie": sessionCookie(token, isSecure(req)),
      },
    );
  }

  if (path === "/api/auth/device/pending" && req.method === "GET") {
    const code = (url.searchParams.get("user_code") || "").toUpperCase();
    if (!code) return json({ error: "user_code is required." }, 400);
    const row = store.deviceCodeByUserCode(code);
    if (!row) return json({ found: false });
    return json({
      found: true,
      user_code: row.user_code,
      client_id: row.client_id,
      status: row.status,
      expires_at: row.expires_at,
      expired: row.expires_at <= Date.now(),
    });
  }

  if (path === "/api/auth/device/approve" && req.method === "POST") {
    const body = await readJson(req);
    if (!body) return json({ error: "Malformed JSON body." }, 400);
    const code = typeof body.user_code === "string" ? body.user_code.toUpperCase() : "";
    if (!code) return json({ error: "user_code is required." }, 400);

    // Approval speaks for the install, so it follows the same rule as the rest
    // of the dashboard: a session or the admin token authorizes it, and an
    // install with no ADMIN_TOKEN is unclaimed — anyone who can reach the port
    // may approve. Gating on "no tokens issued yet" instead would deadlock: the
    // token needed to sign in is minted *by* approval.
    const approver = canAdminister(req, url, deps.cfg, store);
    if (!approver) {
      return json(
        { error: "This gateway requires ADMIN_TOKEN. Sign in with it before approving a device." },
        401,
      );
    }
    const userId = approver && typeof approver !== "string" ? approver.user.id : null;
    if (!userId) {
      // The install token has no person attached. It may *create* an account,
      // but it must never attach a device to an account that already exists:
      // that would let anyone holding the shared install token mint a session
      // for any account — including an owner — just by naming its email.
      const email = normaliseEmail(body.email);
      if (!email) return json({ error: "email is required when approving with the admin token." }, 400);
      const existing = store.userByEmail(email);
      if (existing) {
        // Attaching a device to an *existing* account impersonates that person,
        // so it is never implied by an email alone: the caller must say so, and
        // the action is logged with the account it affected. This keeps lockout
        // recovery (the install token is by definition fully privileged) while
        // removing the silent, invisible version of it.
        if (body.attach_existing !== true) {
          return json(
            {
              error:
                `"${email}" already has an account. Sign in as that account to approve this device, ` +
                `or resend with "attach_existing": true (recorded in the log) to attach it anyway.`,
              code: "account_exists",
            },
            409,
          );
        }
        if (existing.disabled_at !== null) return json({ error: "That account is disabled." }, 403);
        if (!store.approveDeviceCode(code, existing.id)) {
          const row = store.deviceCodeByUserCode(code);
          if (!row) return json({ error: "Unknown code." }, 404);
          if (row.expires_at <= Date.now()) return json({ error: "That code expired." }, 409);
          return json({ error: `That code is ${row.status}.` }, 409);
        }
        console.warn(
          `[kilo-gateway] install token attached device code ${code} to existing account ${email} ` +
            `(role ${existing.role}) via attach_existing`,
        );
        return approveResponse(req, store, existing.id);
      }
      const created = createAccount(store, { email, name: body.name });
      if (!created.ok) return json({ error: created.message }, created.status);
      if (!store.approveDeviceCode(code, created.user.id)) {
        const row = store.deviceCodeByUserCode(code);
        if (!row) return json({ error: "Unknown code." }, 404);
        if (row.expires_at <= Date.now()) return json({ error: "That code expired." }, 409);
        return json({ error: `That code is ${row.status}.` }, 409);
      }
      return approveResponse(req, store, created.user.id);
    }
    if (!store.approveDeviceCode(code, userId)) {
      const row = store.deviceCodeByUserCode(code);
      if (!row) return json({ error: "Unknown code." }, 404);
      if (row.expires_at <= Date.now()) return json({ error: "That code expired." }, 409);
      return json({ error: `That code is ${row.status}.` }, 409);
    }
    return approveResponse(req, store, userId);
  }

  if (path === "/api/auth/device/deny" && req.method === "POST") {
    const body = await readJson(req);
    const code = typeof body?.user_code === "string" ? body.user_code.toUpperCase() : "";
    if (!code) return json({ error: "user_code is required." }, 400);
    if (!store.denyDeviceCode(code)) return json({ error: "That code is not pending." }, 409);
    return json({ denied: true });
  }

  // Token login: exchanges an access token (`kgd_...`, e.g. from credentials.json)
  // or ADMIN_TOKEN for a browser cookie. This is the recovery path when the
  // browser has no session and no device code is pending.
  if (path === "/api/auth/login" && req.method === "POST") {
    const body = await readJson(req);
    if (!body) return json({ error: "Malformed JSON body." }, 400);
    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (!token) return json({ error: "A token is required." }, 400);

    const presented = store.tokenById(hashToken(token));
    if (presented && presented.expires_at > Date.now()) {
      const user = store.userById(presented.user_id);
      if (!user || user.disabled_at !== null) return json({ error: "That account is unavailable." }, 403);
      store.touchToken(presented.id, Date.now());
      store.updateUser(user.id, { last_login_at: Date.now() });
      return json({ user: publicUser(user), kind: "access_token" }, 200, {
        "set-cookie": sessionCookie(token, isSecure(req)),
        "cache-control": "no-store",
      });
    }
    if (deps.cfg.adminToken && token === deps.cfg.adminToken) {
      return json({ user: null, kind: "admin_token" }, 200, { "cache-control": "no-store" });
    }
    return json({ error: "That token was rejected." }, 401, { "cache-control": "no-store" });
  }

  if (path === "/api/auth/logout" && req.method === "POST") {
    const session = authenticateToken(req, store);
    if (session?.token) store.deleteToken(session.token.id);
    return json({ ok: true }, 200, { "set-cookie": clearSessionCookie() });
  }

  if (path === "/api/auth/me" && req.method === "GET") {
    const session = authenticateToken(req, store);
    if (!session) return json({ error: "Not signed in." }, 401);
    return json({ user: publicUser(session.user), token_expires_at: session.token?.expires_at ?? null });
  }

  return null;
}
