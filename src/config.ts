// Runtime configuration. Everything has a safe default; Bun loads `.env`
// automatically, so the gateway runs with no environment at all.

export const VERSION = "1.0.0";
export const DEFAULT_UPSTREAM = "https://api.kilo.ai/api/gateway";

export interface Config {
  port: number;
  host: string;
  upstream: string;
  dataDir: string;
  dbPath: string;
  adminToken: string;
  requireKey: boolean;
  retentionDays: number;
  catalogTtlMs: number;
  upstreamTimeoutMs: number;
  maxBodyBytes: number;
  accessLog: boolean;
  corsOrigin: string;
  /** HTTP proxies (warp-minimal) tried in order; empty = direct egress. */
  egressProxies: string[];
  /**
   * Anonymous traffic (no key, or a key past its quota) egresses through the
   * WARP pool by default; `direct` opts out.
   */
  anonEgress: "warp" | "direct";
  /** Authenticated traffic: `auto` = warp when proxies exist, else direct. */
  authEgress: "auto" | "warp" | "direct";
  /** Upstream Kilo credentials from `KILO_KEYS`, pooled round-robin. */
  upstreamKeys: string[];
}

function int(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  // Clamp rather than fall back: an operator tightening a limit (a 512-byte body
  // cap, a 500 ms timeout) must not silently receive the *wider* default.
  return Math.min(max, Math.max(min, n));
}

/**
 * Port parsing, which differs from `int`: `PORT=0` means "any free port" and
 * clamping it to 1 would request a privileged bind that Android and containers
 * refuse. A non-positive or out-of-range port is therefore treated as unset.
 */
function port(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) return fallback;
  return n;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

/** Comma-separated values, trimmed and de-blanked. */
function list(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** Comma-separated proxy URLs; blank entries are dropped so a trailing comma is harmless. */
function proxies(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => /^https?:\/\//i.test(entry));
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const dataDir = (env.DATA_DIR || "./data").replace(/\/+$/, "") || ".";
  const upstream = (env.KILO_UPSTREAM || DEFAULT_UPSTREAM).replace(/\/+$/, "");
  return {
    port: port(env.PORT, 8080),
    host: env.HOST || "127.0.0.1",
    upstream,
    dataDir,
    dbPath: `${dataDir}/kilo-gateway.db`,
    adminToken: (env.ADMIN_TOKEN || "").trim(),
    requireKey: bool(env.REQUIRE_KEY, false),
    retentionDays: int(env.RETENTION_DAYS, 30, 0, 3650),
    catalogTtlMs: int(env.CATALOG_TTL_MS, 300_000, 10_000, 86_400_000),
    upstreamTimeoutMs: int(env.UPSTREAM_TIMEOUT_MS, 900_000, 1_000, 3_600_000),
    maxBodyBytes: int(env.MAX_BODY_BYTES, 32 * 1024 * 1024, 1024, 512 * 1024 * 1024),
    accessLog: bool(env.ACCESS_LOG, false),
    corsOrigin: env.CORS_ORIGIN || "*",
    egressProxies: proxies(env.EGRESS_PROXIES),
    anonEgress: env.ANON_EGRESS === "direct" ? "direct" : "warp",
    authEgress:
      env.AUTH_EGRESS === "warp" || env.AUTH_EGRESS === "direct" ? env.AUTH_EGRESS : "auto",
    upstreamKeys: list(env.KILO_KEYS),
  };
}
