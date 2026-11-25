// Dashboard JSON API. Every route here is behind the admin token when one is
// configured (see app.ts); responses contain no secrets except a newly created
// virtual key, which is returned exactly once.

import type { Config } from "./config.ts";
import { VERSION } from "./config.ts";
import type { ApiKeyRow, RequestFilters, Store, UserRow } from "./db.ts";
import type { Catalog } from "./catalog.ts";
import type { Egress } from "./egress.ts";
import type { UpstreamPool } from "./keypool.ts";
import { generateKey, newKeyId } from "./security.ts";
import { createAccount, publicUser } from "./accounts.ts";
import { isRecord } from "./json.ts";

export interface ApiDeps {
  cfg: Config;
  store: Store;
  catalog: Catalog;
  startedAt: number;
  egress?: Egress;
  /** Upstream credential pool, editable from the dashboard. */
  pool?: UpstreamPool;
}

const LIMITS = { maxName: 60, maxRpm: 1_000_000, maxDaily: 1_000_000, maxUpstreamKey: 500 } as const;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

/** `null`/absent follows AUTH_EGRESS; explicit values pin the path. */
function asEgress(value: unknown): "direct" | "warp" | null {
  return value === "direct" || value === "warp" ? value : null;
}

function publicKey(row: ApiKeyRow, usage?: { requests: number; total_tokens: number; today_requests: number; today_tokens: number }) {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    revoked_at: row.revoked_at,
    revoked: row.revoked_at !== null,
    rpm: row.rpm,
    daily_limit: row.daily_limit,
    has_upstream_key: Boolean(row.upstream_key),
    egress: row.egress,
    usage: usage ?? { requests: 0, total_tokens: 0, today_requests: 0, today_tokens: 0 },
  };
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  const text = await req.text();
  if (!text) return {};
  if (text.length > 100_000) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function asInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function sinceFrom(url: URL): number {
  const raw = url.searchParams.get("hours");
  if (raw === null || raw === "" || raw === "all") return 0;
  return Date.now() - asInt(raw, 24, 1, 720) * 3_600_000;
}

function bucketFor(hours: number): number {
  if (hours <= 2) return 300_000;
  if (hours <= 48) return 3_600_000;
  if (hours <= 168) return 6 * 3_600_000;
  return 86_400_000;
}

function filtersFrom(url: URL, withPaging: boolean): RequestFilters {
  const status = url.searchParams.get("status");
  return {
    since: sinceFrom(url),
    model: url.searchParams.get("model") || undefined,
    keyId: url.searchParams.get("key_id") || undefined,
    status: status === "ok" || status === "error" ? status : null,
    q: (url.searchParams.get("q") || "").trim().slice(0, 100) || undefined,
    ...(withPaging
      ? {
          limit: asInt(url.searchParams.get("limit"), 50, 1, 200),
          offset: asInt(url.searchParams.get("offset"), 0, 0, 10_000_000),
        }
      : {}),
  };
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function exportCsv(store: Store, filters: RequestFilters): string {
  const rows = store.exportRequests(filters);
  const header = [
    "id",
    "timestamp",
    "datetime",
    "key",
    "model",
    "path",
    "method",
    "status",
    "upstream_status",
    "stream",
    "duration_ms",
    "ttft_ms",
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    "cost_usd",
    "source",
    "egress",
    "egress_retries",
    "error",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.id,
        r.ts,
        new Date(r.ts).toISOString(),
        r.key_name ?? "",
        r.model ?? "",
        r.path,
        r.method,
        r.status,
        r.upstream_status ?? "",
        r.stream,
        r.duration_ms,
        r.ttft_ms ?? "",
        r.prompt_tokens,
        r.completion_tokens,
        r.total_tokens,
        r.cost_usd ?? "",
        r.source,
        r.egress ?? "",
        r.egress_retries,
        r.error ?? "",
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\n") + "\n";
}

function dashboardSeries(raw: { ts: number; requests: number; errors: number; prompt_tokens: number; completion_tokens: number }[], since: number, bucketMs: number) {
  const byTs = new Map(raw.map((r) => [r.ts, r]));
  const first = Math.floor(since / bucketMs) * bucketMs;
  const last = Math.floor(Date.now() / bucketMs) * bucketMs;
  const out: { ts: number; requests: number; errors: number; prompt_tokens: number; completion_tokens: number }[] = [];
  for (let ts = first; ts <= last; ts += bucketMs) {
    out.push(byTs.get(ts) ?? { ts, requests: 0, errors: 0, prompt_tokens: 0, completion_tokens: 0 });
  }
  return out;
}

export async function handleApi(req: Request, url: URL, deps: ApiDeps): Promise<Response> {
  const { cfg, store, catalog } = deps;
  const path = url.pathname;

  if (path === "/api/overview" && req.method === "GET") {
    const hours = asInt(url.searchParams.get("hours"), 24, 1, 720);
    const since = Date.now() - hours * 3_600_000;
    const bucketMs = bucketFor(hours);
    const totals = store.summary(since);
    const series = dashboardSeries(store.series(since, bucketMs), since, bucketMs);
    const keys = store.listKeys();
    void catalog.load().catch(() => {});
    return json({
      range: { hours, since, bucket_ms: bucketMs },
      totals,
      series,
      models: store.topModels(since, 8),
      recent: store.listRequests({ since, limit: 10 }).rows,
      catalog: catalog.status(),
      keys: { total: keys.length, active: keys.filter((k) => !k.revoked_at).length },
      server: {
        version: VERSION,
        upstream: cfg.upstream,
        uptime_ms: Date.now() - deps.startedAt,
        started_at: deps.startedAt,
        require_key: cfg.requireKey,
        admin_required: cfg.adminToken !== "",
      },
    });
  }

  if (path === "/api/models" && req.method === "GET") {
    let models = catalog.current();
    let error: string | null = null;
    try {
      models = await catalog.load(url.searchParams.get("refresh") === "1");
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      models = catalog.current();
    }
    const usage = store.modelUsage(Date.now() - 30 * 86_400_000);
    return json({
      object: "list",
      data: models.map((m) => ({ ...m, usage: usage.get(m.id) ?? { requests: 0, total_tokens: 0, avg_ms: 0 } })),
      free_count: models.length,
      kilo_total: catalog.status().total,
      fetched_at: catalog.status().fetched_at,
      error,
    });
  }

  if (path === "/api/keys" && req.method === "GET") {
    const usage = store.keyUsage();
    const keys = store.listKeys().map((k) => publicKey(k, usage.get(k.id)));
    return json({ keys });
  }

  if (path === "/api/keys" && req.method === "POST") {
    const body = await readJson(req);
    if (!body) return json({ error: "Invalid JSON body." }, 400);
    const name = (typeof body.name === "string" ? body.name.trim() : "").slice(0, LIMITS.maxName) || "API key";
    const rpm = asInt(body.rpm, 0, 0, LIMITS.maxRpm);
    const dailyLimit = asInt(body.daily_limit, 0, 0, LIMITS.maxDaily);
    let upstreamKey: string | null = null;
    if (typeof body.upstream_key === "string" && body.upstream_key.trim()) {
      upstreamKey = body.upstream_key.trim().slice(0, LIMITS.maxUpstreamKey);
    }
    const generated = generateKey();
    const row = store.createKey({
      id: newKeyId(),
      name,
      prefix: generated.prefix,
      hash: generated.hash,
      rpm,
      daily_limit: dailyLimit,
      upstream_key: upstreamKey,
      egress: asEgress(body.egress),
    });
    return json({ key: publicKey(row), secret: generated.secret }, 201);
  }

  const keyMatch = /^\/api\/keys\/([A-Za-z0-9-]+)$/.exec(path);
  if (keyMatch) {
    const id = keyMatch[1];
    if (req.method === "PATCH") {
      const body = await readJson(req);
      if (!body) return json({ error: "Invalid JSON body." }, 400);
      const patch: Partial<
        Pick<ApiKeyRow, "name" | "rpm" | "daily_limit" | "upstream_key" | "revoked_at" | "egress">
      > = {};
      if (body.egress !== undefined) patch.egress = asEgress(body.egress);
      if (typeof body.name === "string") patch.name = body.name.trim().slice(0, LIMITS.maxName) || "API key";
      if (body.rpm !== undefined) patch.rpm = asInt(body.rpm, 0, 0, LIMITS.maxRpm);
      if (body.daily_limit !== undefined) patch.daily_limit = asInt(body.daily_limit, 0, 0, LIMITS.maxDaily);
      if (body.upstream_key !== undefined) {
        patch.upstream_key =
          typeof body.upstream_key === "string" && body.upstream_key.trim()
            ? body.upstream_key.trim().slice(0, LIMITS.maxUpstreamKey)
            : null;
      }
      if (body.revoked !== undefined) patch.revoked_at = body.revoked ? Date.now() : null;
      const row = store.updateKey(id, patch);
      if (!row) return json({ error: "Key not found." }, 404);
      const usage = store.keyUsage().get(id);
      return json({ key: publicKey(row, usage) });
    }
    if (req.method === "DELETE") {
      if (!store.deleteKey(id)) return json({ error: "Key not found." }, 404);
      return json({ ok: true });
    }
  }

  if (path === "/api/requests" && req.method === "GET") {
    const filters = filtersFrom(url, true);
    const { rows, total } = store.listRequests(filters);
    return json({
      requests: rows,
      total,
      limit: filters.limit ?? 50,
      offset: filters.offset ?? 0,
      available_models: store.distinctModels(),
    });
  }

  if (path === "/api/requests" && req.method === "DELETE") {
    const beforeRaw = url.searchParams.get("before");
    const before = beforeRaw ? Number(beforeRaw) : undefined;
    if (before !== undefined && !Number.isFinite(before)) {
      return json({ error: "Invalid before timestamp." }, 400);
    }
    const deleted = store.clearRequests(before);
    return json({ ok: true, deleted });
  }

  const requestMatch = /^\/api\/requests\/([A-Za-z0-9-]+)$/.exec(path);
  if (requestMatch && req.method === "GET") {
    const row = store.requestById(requestMatch[1]);
    if (!row) return json({ error: "Request not found." }, 404);
    return json({ request: row });
  }

  if (path === "/api/export.csv" && req.method === "GET") {
    const csv = exportCsv(store, filtersFrom(url, false));
    const stamp = new Date().toISOString().slice(0, 10);
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="kilo-gateway-requests-${stamp}.csv"`,
        "cache-control": "no-store",
      },
    });
  }

  if (path === "/api/config" && req.method === "GET") {
    return json({
      version: VERSION,
      upstream: cfg.upstream,
      models_url: catalog.url,
      host: cfg.host,
      port: cfg.port,
      data_dir: cfg.dataDir,
      require_key: cfg.requireKey,
      admin_required: cfg.adminToken !== "",
      retention_days: cfg.retentionDays,
      egress: deps.egress?.status() ?? { enabled: false, proxies: [], max_attempts: 1 },
      egress_policy: { anonymous: cfg.anonEgress, authenticated: cfg.authEgress },
      catalog_ttl_ms: cfg.catalogTtlMs,
      upstream_timeout_ms: cfg.upstreamTimeoutMs,
      max_body_bytes: cfg.maxBodyBytes,
      cors_origin: cfg.corsOrigin,
      started_at: deps.startedAt,
      uptime_ms: Date.now() - deps.startedAt,
      database_bytes: store.sizeBytes(),
    });
  }

  if (path === "/api/health" && req.method === "GET") {
    const keys = store.listKeys();
    return json({
      ok: true,
      version: VERSION,
      uptime_ms: Date.now() - deps.startedAt,
      catalog: catalog.status(),
      keys: { total: keys.length, active: keys.filter((k) => !k.revoked_at).length },
      requests: store.summary(Date.now() - 86_400_000),
      database_bytes: store.sizeBytes(),
      admin_required: cfg.adminToken !== "",
      require_key: cfg.requireKey,
      accounts: store.countUsers(),
      egress: deps.egress?.status() ?? { enabled: false, proxies: [], max_attempts: 1 },
    });
  }

  if (path === "/api/users" && req.method === "GET") {
    return json({
      users: store.listUsers().map((u) => ({
        ...publicUser(u),
        sessions: 0,
      })),
    });
  }

  if (path === "/api/users" && req.method === "POST") {
    const body = await readJson(req);
    if (!body) return json({ error: "Invalid JSON body." }, 400);
    const outcome = createAccount(store, body);
    if (!outcome.ok) return json({ error: outcome.message }, outcome.status);
    return json({ user: publicUser(outcome.user) }, 201);
  }

  const userMatch = /^\/api\/users\/([A-Za-z0-9-]+)$/.exec(path);
  if (userMatch) {
    const id = userMatch[1];
    if (req.method === "PATCH") {
      const body = await readJson(req);
      if (!body) return json({ error: "Invalid JSON body." }, 400);
      const patch: Partial<Pick<UserRow, "name" | "role" | "disabled_at">> = {};
      if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim().slice(0, 80);
      if (body.role === "owner" || body.role === "member") patch.role = body.role;
      if (body.disabled !== undefined) patch.disabled_at = body.disabled ? Date.now() : null;
      const row = store.updateUser(id, patch);
      if (!row) return json({ error: "Account not found." }, 404);
      return json({ user: publicUser(row) });
    }
    if (req.method === "DELETE") {
      if (!store.deleteUser(id)) return json({ error: "Account not found." }, 404);
      return json({ ok: true });
    }
  }

  // Upstream credential pool: same shape the template's /api/state exposes.
  if (path === "/api/upstream-keys" && req.method === "GET") {
    return json({
      keys: deps.pool?.state() ?? [],
      available: deps.pool?.available().length ?? 0,
      total: deps.pool?.size ?? 0,
    });
  }

  if (path === "/api/upstream-keys" && req.method === "POST") {
    const body = await readJson(req);
    if (!body) return json({ error: "Invalid JSON body." }, 400);
    const action = body.action;
    const key = typeof body.key === "string" ? body.key.trim() : "";
    if (!deps.pool) return json({ error: "This runtime has no credential pool." }, 501);
    if (action === "add") {
      if (!key) return json({ error: "Empty key." }, 400);
      const added = deps.pool.add(key);
      return json({ added, keys: deps.pool.state() }, added ? 201 : 200);
    }
    if (action === "remove") {
      if (!key) return json({ error: "Empty key." }, 400);
      const outcome = deps.pool.remove(key);
      if (outcome === "ambiguous") {
        // The masked label matched more than one credential; deleting all of
        // them would be data loss, so the caller must identify the exact key.
        return json(
          {
            error:
              "That shortened key matches more than one credential. Send the full key to remove exactly one.",
            keys: deps.pool.state(),
          },
          409,
        );
      }
      return json({ removed: outcome === "removed", keys: deps.pool.state() }, outcome === "removed" ? 200 : 404);
    }
    return json({ error: 'Expected {"action":"add"|"remove","key":"…"}.' }, 400);
  }

  if (path === "/api/egress" && req.method === "GET") {
    const status = deps.egress?.status() ?? { enabled: false, proxies: [], max_attempts: 1 };
    return json({
      ...status,
      policy: { anonymous: cfg.anonEgress, authenticated: cfg.authEgress },
      // Per-exit totals for the current retention window.
      usage: store.egressUsage(sinceFrom(url)),
    });
  }

  return json({ error: "Not found." }, 404);
}
