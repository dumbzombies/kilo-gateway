// SQLite persistence: virtual API keys, accounts, and one row per proxied
// request. Uses the runtime-neutral adapter in `sqlite.ts`, so the same store
// runs under Bun and Node.

import { Database } from "./sqlite.ts";
import { startOfUtcDay } from "./shared.ts";

export interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  hash: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
  rpm: number;
  daily_limit: number;
  upstream_key: string | null;
  /** `null` follows AUTH_EGRESS; otherwise pins 'direct' or 'warp'. */
  egress: "direct" | "warp" | null;
}

export interface RequestRecord {
  id: string;
  ts: number;
  key_id: string | null;
  key_name: string | null;
  method: string;
  path: string;
  model: string | null;
  status: number;
  upstream_status: number | null;
  stream: boolean;
  duration_ms: number;
  ttft_ms: number | null;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_usd: number | null;
  client: string | null;
  error: string | null;
  source: string;
  /** Exit that served the call; null when logging predates egress tracking. */
  egress?: string | null;
  egress_retries?: number;
}

export interface RequestFilters {
  limit?: number;
  offset?: number;
  since?: number;
  model?: string;
  keyId?: string;
  status?: "ok" | "error" | null;
  q?: string;
}

export interface RequestRow {
  id: string;
  ts: number;
  key_id: string | null;
  key_name: string | null;
  method: string;
  path: string;
  model: string | null;
  status: number;
  upstream_status: number | null;
  stream: number;
  duration_ms: number;
  ttft_ms: number | null;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_usd: number | null;
  client: string | null;
  error: string | null;
  source: string;
  egress: string | null;
  egress_retries: number;
}

export interface Summary {
  requests: number;
  errors: number;
  streams: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  avg_ms: number;
  p95_ms: number;
  cost_usd: number;
}

export interface SeriesBucket {
  ts: number;
  requests: number;
  errors: number;
  prompt_tokens: number;
  completion_tokens: number;
}

export interface ModelBucket {
  model: string;
  requests: number;
  errors: number;
  total_tokens: number;
  avg_ms: number;
}

export interface UserRow {
  id: string;
  email: string;
  name: string;
  role: string;
  created_at: number;
  last_login_at: number | null;
  disabled_at: number | null;
}

export type DeviceStatus = "pending" | "approved" | "denied" | "consumed" | "expired";

export interface DeviceCodeRow {
  device_code: string;
  user_code: string;
  client_id: string;
  user_id: string | null;
  created_at: number;
  expires_at: number;
  interval: number;
  status: DeviceStatus;
  last_polled_at: number | null;
  client_fingerprint: string | null;
}

export interface TokenRow {
  id: string;
  user_id: string;
  client_id: string;
  created_at: number;
  expires_at: number;
  last_used_at: number | null;
  user_agent: string | null;
  client_fingerprint: string | null;
}

export interface KeyUsage {
  requests: number;
  total_tokens: number;
  today_requests: number;
  today_tokens: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS api_keys (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  prefix        TEXT NOT NULL,
  hash          TEXT NOT NULL UNIQUE,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER,
  revoked_at    INTEGER,
  rpm           INTEGER NOT NULL DEFAULT 0,
  daily_limit   INTEGER NOT NULL DEFAULT 0,
  upstream_key  TEXT,
  -- Per-key egress: NULL = follow AUTH_EGRESS, otherwise 'direct' or 'warp'.
  egress        TEXT
);
CREATE TABLE IF NOT EXISTS requests (
  id                TEXT PRIMARY KEY,
  ts                INTEGER NOT NULL,
  key_id            TEXT,
  key_name          TEXT,
  method            TEXT NOT NULL,
  path              TEXT NOT NULL,
  model             TEXT,
  status            INTEGER NOT NULL,
  upstream_status   INTEGER,
  stream            INTEGER NOT NULL DEFAULT 0,
  duration_ms       INTEGER NOT NULL DEFAULT 0,
  ttft_ms           INTEGER,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens      INTEGER NOT NULL DEFAULT 0,
  cost_usd          REAL,
  client            TEXT,
  error             TEXT,
  source            TEXT NOT NULL DEFAULT 'api',
  egress            TEXT,
  egress_retries    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS requests_ts ON requests(ts);
CREATE INDEX IF NOT EXISTS requests_model ON requests(model);
CREATE INDEX IF NOT EXISTS requests_key ON requests(key_id, ts);
CREATE INDEX IF NOT EXISTS requests_status ON requests(status, ts);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'member',
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER,
  disabled_at   INTEGER
);
-- RFC 8628 device authorization attempts (warm-run-cli pattern).
CREATE TABLE IF NOT EXISTS device_codes (
  device_code        TEXT PRIMARY KEY,
  user_code          TEXT NOT NULL UNIQUE,
  client_id          TEXT NOT NULL,
  user_id            TEXT,
  created_at         INTEGER NOT NULL,
  expires_at         INTEGER NOT NULL,
  interval           INTEGER NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending',
  last_polled_at     INTEGER,
  client_fingerprint TEXT
);
CREATE INDEX IF NOT EXISTS device_codes_expires ON device_codes(expires_at);
-- Bearer access tokens; only the SHA-256 is stored.
CREATE TABLE IF NOT EXISTS tokens (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL,
  client_id          TEXT NOT NULL,
  created_at         INTEGER NOT NULL,
  expires_at         INTEGER NOT NULL,
  last_used_at       INTEGER,
  user_agent         TEXT,
  client_fingerprint TEXT
);
CREATE INDEX IF NOT EXISTS tokens_user ON tokens(user_id);
CREATE INDEX IF NOT EXISTS tokens_expires ON tokens(expires_at);
`;

export class Store {
  readonly db: Database;
  /**
   * In-flight quota reservations, keyed by api key id.
   *
   * The quota check used to be check-then-act across an await: eight concurrent
   * requests all counted zero rows and all passed. Reservations close that hole —
   * the check and the reservation happen in one synchronous step, and the
   * reservation is released when the request record lands (or is abandoned).
   */
  private readonly reserved = new Map<string, Set<string>>();
  private reservationSeq = 0;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    // Databases created before egress tracking lack these columns; SQLite has
    // no ADD COLUMN IF NOT EXISTS, so probe and add.
    const columns = new Set(
      (this.db.query("PRAGMA table_info(requests)").all() as { name: string }[]).map((c) => c.name),
    );
    if (!columns.has("egress")) this.db.exec("ALTER TABLE requests ADD COLUMN egress TEXT");
    const keyColumns = new Set(
      (this.db.query("PRAGMA table_info(api_keys)").all() as { name: string }[]).map((c) => c.name),
    );
    if (keyColumns.size > 0 && !keyColumns.has("egress")) {
      this.db.exec("ALTER TABLE api_keys ADD COLUMN egress TEXT");
    }
    if (!columns.has("egress_retries")) {
      this.db.exec("ALTER TABLE requests ADD COLUMN egress_retries INTEGER NOT NULL DEFAULT 0");
    }
    // An earlier build stored argon2 password hashes and cookie sessions.
    // Authentication is device-code only now, so rebuild `users` without the
    // dead column and drop `sessions` (replaced by bearer `tokens`). Existing
    // accounts are preserved; they simply re-authorize through the device flow.
    const userColumns = new Set(
      (this.db.query("PRAGMA table_info(users)").all() as { name: string }[]).map((c) => c.name),
    );
    if (userColumns.has("password_hash")) {
      this.db.transaction(() => {
        this.db.exec(`CREATE TABLE users_new (
          id            TEXT PRIMARY KEY,
          email         TEXT NOT NULL UNIQUE,
          name          TEXT NOT NULL,
          role          TEXT NOT NULL DEFAULT 'member',
          created_at    INTEGER NOT NULL,
          last_login_at INTEGER,
          disabled_at   INTEGER
        )`);
        this.db.exec(`INSERT INTO users_new (id, email, name, role, created_at, last_login_at, disabled_at)
                      SELECT id, email, name, role, created_at, last_login_at, disabled_at FROM users`);
        this.db.exec("DROP TABLE users");
        this.db.exec("ALTER TABLE users_new RENAME TO users");
        this.db.exec("DROP TABLE IF EXISTS sessions");
      })();
      console.log("[kilo-gateway] migrated users to device-code auth (password_hash dropped, sessions table removed)");
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }

  // ---- keys -------------------------------------------------------------

  createKey(
    row: Omit<ApiKeyRow, "created_at" | "last_used_at" | "revoked_at" | "egress"> & {
      egress?: "direct" | "warp" | null;
    },
  ): ApiKeyRow {
    const full: ApiKeyRow = {
      ...row,
      egress: row.egress ?? null,
      created_at: Date.now(),
      last_used_at: null,
      revoked_at: null,
    };
    this.db
      .query(
        `INSERT INTO api_keys (id, name, prefix, hash, created_at, last_used_at, revoked_at, rpm, daily_limit,
                              upstream_key, egress)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
      )
      .run(
        full.id,
        full.name,
        full.prefix,
        full.hash,
        full.created_at,
        full.rpm,
        full.daily_limit,
        full.upstream_key,
        full.egress,
      );
    return full;
  }

  /** Non-revoked keys, for the "is this install configured?" banner. */
  countKeys(): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM api_keys WHERE revoked_at IS NULL").get() as { n: number }).n;
  }

  keyByHash(hash: string): ApiKeyRow | null {
    return (this.db.query("SELECT * FROM api_keys WHERE hash = ?").get(hash) as ApiKeyRow | null) ?? null;
  }

  keyById(id: string): ApiKeyRow | null {
    return (this.db.query("SELECT * FROM api_keys WHERE id = ?").get(id) as ApiKeyRow | null) ?? null;
  }

  listKeys(): ApiKeyRow[] {
    return this.db.query("SELECT * FROM api_keys ORDER BY created_at DESC").all() as ApiKeyRow[];
  }

  touchKey(id: string, at = Date.now()): void {
    this.db.query("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(at, id);
  }

  updateKey(
    id: string,
    patch: Partial<Pick<ApiKeyRow, "name" | "rpm" | "daily_limit" | "upstream_key" | "revoked_at" | "egress">>,
  ): ApiKeyRow | null {
    const current = this.keyById(id);
    if (!current) return null;
    const next = { ...current, ...patch };
    this.db
      .query(
        `UPDATE api_keys SET name = ?, rpm = ?, daily_limit = ?, upstream_key = ?, revoked_at = ?, egress = ?
         WHERE id = ?`,
      )
      .run(next.name, next.rpm, next.daily_limit, next.upstream_key, next.revoked_at, next.egress, id);
    return next;
  }

  deleteKey(id: string): boolean {
    return this.db.query("DELETE FROM api_keys WHERE id = ?").run(id).changes > 0;
  }

  /** Requests in the last `windowMs` for a key — used by the rate limiter. */
  keyRequestsSince(keyId: string, since: number): number {
    const row = this.db
      .query("SELECT COUNT(*) AS n FROM requests WHERE key_id = ? AND ts >= ?")
      .get(keyId, since) as { n: number };
    return row.n;
  }

  /**
   * Atomically checks both quotas and, when both allow, reserves a slot.
   *
   * Synchronous on purpose: JavaScript runs this to completion, so no other
   * request can interleave between the count and the reservation.
   *
   * @returns `null` when the request may proceed on the key's own tier, else
   *          which quota was exhausted.
   */
  reserveQuota(
    key: { id: string; rpm: number; daily_limit: number },
    now = Date.now(),
  ): { exceeded: "rpm" | "daily"; ticket: null } | { exceeded: null; ticket: string } {
    const held = this.reserved.get(key.id)?.size ?? 0;
    if (key.rpm > 0) {
      const used = this.keyRequestsSince(key.id, now - 60_000) + held;
      if (used >= key.rpm) return { exceeded: "rpm", ticket: null };
    }
    if (key.daily_limit > 0) {
      const used = this.keyRequestsSince(key.id, startOfUtcDay(now)) + held;
      if (used >= key.daily_limit) return { exceeded: "daily", ticket: null };
    }
    const ticket = `r${++this.reservationSeq}`;
    const set = this.reserved.get(key.id) ?? new Set<string>();
    set.add(ticket);
    this.reserved.set(key.id, set);
    return { exceeded: null, ticket };
  }

  /**
   * Releases one reservation. Idempotent: releasing a ticket twice (or a ticket
   * that was never held) is a no-op, so a completion path and an error path can
   * both release without corrupting the count.
   */
  releaseQuota(keyId: string, ticket?: string): void {
    const set = this.reserved.get(keyId);
    if (!set) return;
    if (ticket === undefined) {
      // Untargeted release: drop the oldest outstanding reservation.
      const oldest = set.values().next();
      if (!oldest.done) set.delete(oldest.value);
    } else {
      set.delete(ticket);
    }
    if (set.size === 0) this.reserved.delete(keyId);
  }

  keyUsage(): Map<string, KeyUsage> {
    const usage = new Map<string, KeyUsage>();
    const today = startOfUtcDay();
    const overall = this.db
      .query(
        `SELECT key_id, COUNT(*) AS requests, COALESCE(SUM(total_tokens), 0) AS tokens
         FROM requests WHERE key_id IS NOT NULL GROUP BY key_id`,
      )
      .all() as { key_id: string; requests: number; tokens: number }[];
    for (const r of overall) {
      usage.set(r.key_id, { requests: r.requests, total_tokens: r.tokens, today_requests: 0, today_tokens: 0 });
    }
    const todayRows = this.db
      .query(
        `SELECT key_id, COUNT(*) AS requests, COALESCE(SUM(total_tokens), 0) AS tokens
         FROM requests WHERE key_id IS NOT NULL AND ts >= ? GROUP BY key_id`,
      )
      .all(today) as { key_id: string; requests: number; tokens: number }[];
    for (const r of todayRows) {
      const u = usage.get(r.key_id) ?? { requests: 0, total_tokens: 0, today_requests: 0, today_tokens: 0 };
      u.today_requests = r.requests;
      u.today_tokens = r.tokens;
      usage.set(r.key_id, u);
    }
    return usage;
  }

  // ---- users, device codes and tokens ------------------------------------

  createUser(row: Pick<UserRow, "id" | "email" | "name" | "role">): UserRow {
    const full: UserRow = { ...row, created_at: Date.now(), last_login_at: null, disabled_at: null };
    this.db
      .query("INSERT INTO users (id, email, name, role, created_at, last_login_at, disabled_at) VALUES (?, ?, ?, ?, ?, NULL, NULL)")
      .run(full.id, full.email, full.name, full.role, full.created_at);
    return full;
  }

  userByEmail(email: string): UserRow | null {
    return (this.db.query("SELECT * FROM users WHERE email = ?").get(email) as UserRow | null) ?? null;
  }

  userById(id: string): UserRow | null {
    return (this.db.query("SELECT * FROM users WHERE id = ?").get(id) as UserRow | null) ?? null;
  }

  listUsers(): UserRow[] {
    return this.db.query("SELECT * FROM users ORDER BY created_at ASC").all() as UserRow[];
  }

  countUsers(): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
  }

  updateUser(
    id: string,
    patch: Partial<Pick<UserRow, "name" | "role" | "last_login_at" | "disabled_at">>,
  ): UserRow | null {
    const current = this.userById(id);
    if (!current) return null;
    const next = { ...current, ...patch };
    this.db
      .query("UPDATE users SET name = ?, role = ?, last_login_at = ?, disabled_at = ? WHERE id = ?")
      .run(next.name, next.role, next.last_login_at, next.disabled_at, id);
    return next;
  }

  deleteUser(id: string): boolean {
    this.db.query("DELETE FROM tokens WHERE user_id = ?").run(id);
    this.db.query("UPDATE device_codes SET status = 'denied' WHERE user_id = ?").run(id);
    return this.db.query("DELETE FROM users WHERE id = ?").run(id).changes > 0;
  }

  createDeviceCode(row: DeviceCodeRow): void {
    this.db
      .query(
        `INSERT INTO device_codes (device_code, user_code, client_id, user_id, created_at, expires_at,
                                   interval, status, last_polled_at, client_fingerprint)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.device_code,
        row.user_code,
        row.client_id,
        row.user_id,
        row.created_at,
        row.expires_at,
        row.interval,
        row.status,
        row.last_polled_at,
        row.client_fingerprint,
      );
  }

  deviceCodeByHash(hash: string): DeviceCodeRow | null {
    return (this.db.query("SELECT * FROM device_codes WHERE device_code = ?").get(hash) as DeviceCodeRow | null) ?? null;
  }

  /** The human-facing lookup: the code typed into the verification page. */
  deviceCodeByUserCode(code: string): DeviceCodeRow | null {
    return (this.db.query("SELECT * FROM device_codes WHERE user_code = ?").get(code.toUpperCase()) as DeviceCodeRow | null) ?? null;
  }

  approveDeviceCode(code: string, userId: string): boolean {
    const row = this.deviceCodeByUserCode(code);
    if (!row || row.status !== "pending" || row.expires_at <= Date.now()) return false;
    this.db.query("UPDATE device_codes SET status = 'approved', user_id = ? WHERE device_code = ?").run(userId, row.device_code);
    return true;
  }

  denyDeviceCode(code: string): boolean {
    const row = this.deviceCodeByUserCode(code);
    if (!row || row.status !== "pending") return false;
    this.db.query("UPDATE device_codes SET status = 'denied' WHERE device_code = ?").run(row.device_code);
    return true;
  }

  setDeviceStatus(hash: string, status: DeviceStatus): void {
    this.db.query("UPDATE device_codes SET status = ? WHERE device_code = ?").run(status, hash);
  }

  touchDeviceCode(hash: string, now: number, interval: number): void {
    this.db.query("UPDATE device_codes SET last_polled_at = ?, interval = ? WHERE device_code = ?").run(now, interval, hash);
  }

  purgeDeviceCodes(now = Date.now()): number {
    return this.db.query("DELETE FROM device_codes WHERE expires_at <= ?").run(now).changes;
  }

  createToken(row: TokenRow): void {
    this.db
      .query(
        `INSERT INTO tokens (id, user_id, client_id, created_at, expires_at, last_used_at, user_agent, client_fingerprint)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.user_id,
        row.client_id,
        row.created_at,
        row.expires_at,
        row.last_used_at,
        row.user_agent,
        row.client_fingerprint,
      );
  }

  tokenById(id: string): TokenRow | null {
    return (this.db.query("SELECT * FROM tokens WHERE id = ?").get(id) as TokenRow | null) ?? null;
  }

  countTokens(): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM tokens").get() as { n: number }).n;
  }

  touchToken(id: string, now: number): void {
    this.db.query("UPDATE tokens SET last_used_at = ? WHERE id = ?").run(now, id);
  }

  deleteToken(id: string): void {
    this.db.query("DELETE FROM tokens WHERE id = ?").run(id);
  }

  purgeTokens(now = Date.now()): number {
    return this.db.query("DELETE FROM tokens WHERE expires_at <= ?").run(now).changes;
  }

  // ---- requests ---------------------------------------------------------

  insertRequest(rec: RequestRecord): void {
    this.db
      .query(
        `INSERT INTO requests
         (id, ts, key_id, key_name, method, path, model, status, upstream_status, stream,
          duration_ms, ttft_ms, prompt_tokens, completion_tokens, total_tokens, cost_usd, client, error, source,
          egress, egress_retries)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.id,
        rec.ts,
        rec.key_id,
        rec.key_name,
        rec.method,
        rec.path,
        rec.model,
        rec.status,
        rec.upstream_status,
        rec.stream ? 1 : 0,
        Math.round(rec.duration_ms),
        rec.ttft_ms == null ? null : Math.round(rec.ttft_ms),
        Math.round(rec.prompt_tokens),
        Math.round(rec.completion_tokens),
        Math.round(rec.total_tokens),
        rec.cost_usd,
        rec.client,
        rec.error,
        rec.source,
        rec.egress ?? null,
        rec.egress_retries ?? 0,
      );
  }

  private where(f: RequestFilters): { sql: string; params: (string | number)[] } {
    const clauses: string[] = ["ts >= ?"];
    const params: (string | number)[] = [f.since ?? 0];
    if (f.model) {
      clauses.push("model = ?");
      params.push(f.model);
    }
    if (f.keyId) {
      clauses.push("key_id = ?");
      params.push(f.keyId);
    }
    if (f.status === "ok") clauses.push("status < 400");
    if (f.status === "error") clauses.push("status >= 400");
    if (f.q) {
      clauses.push("(path LIKE ? OR model LIKE ? OR error LIKE ? OR key_name LIKE ?)");
      const like = `%${f.q.replace(/[%_]/g, " ")}%`;
      params.push(like, like, like, like);
    }
    return { sql: clauses.join(" AND "), params };
  }

  listRequests(f: RequestFilters): { rows: RequestRow[]; total: number } {
    const limit = Math.min(200, Math.max(1, f.limit ?? 50));
    const offset = Math.max(0, f.offset ?? 0);
    const w = this.where(f);
    // SQLite aggregate row; the query always returns exactly one column.
    const countRow = this.db.query(`SELECT COUNT(*) AS n FROM requests WHERE ${w.sql}`).get(...w.params) as {
      n: number;
    };
    const total = countRow.n;
    const rows = this.db
      .query(`SELECT * FROM requests WHERE ${w.sql} ORDER BY ts DESC, rowid DESC LIMIT ? OFFSET ?`)
      .all(...w.params, limit, offset) as RequestRow[];
    return { rows, total };
  }

  requestById(id: string): RequestRow | null {
    return (this.db.query("SELECT * FROM requests WHERE id = ?").get(id) as RequestRow | null) ?? null;
  }

  exportRequests(f: Omit<RequestFilters, "limit" | "offset">, max = 100_000): RequestRow[] {
    const w = this.where(f);
    return this.db
      .query(`SELECT * FROM requests WHERE ${w.sql} ORDER BY ts DESC LIMIT ?`)
      .all(...w.params, max) as RequestRow[];
  }

  clearRequests(since?: number): number {
    if (since == null) return this.db.query("DELETE FROM requests").run().changes;
    return this.db.query("DELETE FROM requests WHERE ts < ?").run(since).changes;
  }

  summary(since: number): Summary {
    const base = this.db
      .query(
        `SELECT COUNT(*) AS requests,
                COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END), 0) AS errors,
                COALESCE(SUM(stream), 0) AS streams,
                COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
                COALESCE(SUM(total_tokens), 0) AS total_tokens,
                COALESCE(AVG(duration_ms), 0) AS avg_ms,
                COALESCE(SUM(cost_usd), 0) AS cost_usd
         FROM requests WHERE ts >= ?`,
      )
      .get(since) as Summary;
    const count = base.requests;
    let p95 = 0;
    if (count > 0) {
      const offset = Math.max(0, Math.ceil(count * 0.95) - 1);
      const row = this.db
        .query("SELECT duration_ms FROM requests WHERE ts >= ? ORDER BY duration_ms LIMIT 1 OFFSET ?")
        .get(since, offset) as { duration_ms: number } | null;
      p95 = row?.duration_ms ?? 0;
    }
    return {
      ...base,
      requests: count,
      errors: Number(base.errors ?? 0),
      streams: Number(base.streams ?? 0),
      prompt_tokens: Number(base.prompt_tokens ?? 0),
      completion_tokens: Number(base.completion_tokens ?? 0),
      total_tokens: Number(base.total_tokens ?? 0),
      avg_ms: Math.round(Number(base.avg_ms ?? 0)),
      p95_ms: Math.round(p95),
      cost_usd: Number(base.cost_usd ?? 0),
    };
  }

  series(since: number, bucketMs: number): SeriesBucket[] {
    const rows = this.db
      .query(
        `SELECT (ts / ?) * ? AS ts,
                COUNT(*) AS requests,
                COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END), 0) AS errors,
                COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                COALESCE(SUM(completion_tokens), 0) AS completion_tokens
         FROM requests WHERE ts >= ? GROUP BY ts ORDER BY ts`,
      )
      .all(bucketMs, bucketMs, since) as SeriesBucket[];
    return rows.map((r) => ({
      ts: Number(r.ts),
      requests: Number(r.requests),
      errors: Number(r.errors),
      prompt_tokens: Number(r.prompt_tokens),
      completion_tokens: Number(r.completion_tokens),
    }));
  }

  topModels(since: number, limit = 8): ModelBucket[] {
    return this.db
      .query(
        `SELECT model, COUNT(*) AS requests,
                COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END), 0) AS errors,
                COALESCE(SUM(total_tokens), 0) AS total_tokens,
                CAST(COALESCE(AVG(duration_ms), 0) AS INTEGER) AS avg_ms
         FROM requests WHERE ts >= ? AND model IS NOT NULL
         GROUP BY model ORDER BY requests DESC LIMIT ?`,
      )
      .all(since, limit) as ModelBucket[];
  }

  modelUsage(since: number): Map<string, { requests: number; total_tokens: number; avg_ms: number }> {
    const rows = this.db
      .query(
        `SELECT model, COUNT(*) AS requests, COALESCE(SUM(total_tokens), 0) AS total_tokens,
                CAST(COALESCE(AVG(duration_ms), 0) AS INTEGER) AS avg_ms
         FROM requests WHERE ts >= ? AND model IS NOT NULL GROUP BY model`,
      )
      .all(since) as { model: string; requests: number; total_tokens: number; avg_ms: number }[];
    const map = new Map<string, { requests: number; total_tokens: number; avg_ms: number }>();
    for (const r of rows) map.set(r.model, { requests: r.requests, total_tokens: r.total_tokens, avg_ms: r.avg_ms });
    return map;
  }

  distinctModels(): string[] {
    const rows = this.db
      .query("SELECT DISTINCT model FROM requests WHERE model IS NOT NULL ORDER BY model")
      .all() as { model: string }[];
    return rows.map((r) => r.model);
  }

  /** Calls served per egress exit, for the egress panel. */
  egressUsage(since: number): { egress: string; requests: number; retries: number; errors: number }[] {
    return this.db
      .query(
        `SELECT COALESCE(egress, 'untracked') AS egress,
                COUNT(*) AS requests,
                COALESCE(SUM(egress_retries), 0) AS retries,
                COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END), 0) AS errors
         FROM requests WHERE ts >= ? GROUP BY egress ORDER BY requests DESC`,
      )
      .all(since) as { egress: string; requests: number; retries: number; errors: number }[];
  }

  purge(before: number): number {
    return this.db.query("DELETE FROM requests WHERE ts < ?").run(before).changes;
  }

  sizeBytes(): number {
    try {
      const rows = this.db.query("PRAGMA page_count").get() as { page_count: number };
      const page = this.db.query("PRAGMA page_size").get() as { page_size: number };
      return rows.page_count * page.page_size;
    } catch {
      return 0;
    }
  }
}
