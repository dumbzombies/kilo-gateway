// SQLite persistence: virtual API keys and one row per proxied request.
// bun:sqlite keeps the deployment single-file and single-process — the same
// shape as the rest of the gateway.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

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
  upstream_key  TEXT
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
  source            TEXT NOT NULL DEFAULT 'api'
);
CREATE INDEX IF NOT EXISTS requests_ts ON requests(ts);
CREATE INDEX IF NOT EXISTS requests_model ON requests(model);
CREATE INDEX IF NOT EXISTS requests_key ON requests(key_id, ts);
CREATE INDEX IF NOT EXISTS requests_status ON requests(status, ts);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export class Store {
  readonly db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }

  // ---- keys -------------------------------------------------------------

  createKey(row: Omit<ApiKeyRow, "created_at" | "last_used_at" | "revoked_at">): ApiKeyRow {
    const full: ApiKeyRow = { ...row, created_at: Date.now(), last_used_at: null, revoked_at: null };
    this.db
      .query(
        `INSERT INTO api_keys (id, name, prefix, hash, created_at, last_used_at, revoked_at, rpm, daily_limit, upstream_key)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
      )
      .run(full.id, full.name, full.prefix, full.hash, full.created_at, full.rpm, full.daily_limit, full.upstream_key);
    return full;
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
    patch: Partial<Pick<ApiKeyRow, "name" | "rpm" | "daily_limit" | "upstream_key" | "revoked_at">>,
  ): ApiKeyRow | null {
    const current = this.keyById(id);
    if (!current) return null;
    const next = { ...current, ...patch };
    this.db
      .query(
        "UPDATE api_keys SET name = ?, rpm = ?, daily_limit = ?, upstream_key = ?, revoked_at = ? WHERE id = ?",
      )
      .run(next.name, next.rpm, next.daily_limit, next.upstream_key, next.revoked_at, id);
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

  // ---- requests ---------------------------------------------------------

  insertRequest(rec: RequestRecord): void {
    this.db
      .query(
        `INSERT INTO requests
         (id, ts, key_id, key_name, method, path, model, status, upstream_status, stream,
          duration_ms, ttft_ms, prompt_tokens, completion_tokens, total_tokens, cost_usd, client, error, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

export function startOfUtcDay(now = Date.now()): number {
  return Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
}
