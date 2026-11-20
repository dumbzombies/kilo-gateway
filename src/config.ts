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
}

function int(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const dataDir = (env.DATA_DIR || "./data").replace(/\/+$/, "") || ".";
  const upstream = (env.KILO_UPSTREAM || DEFAULT_UPSTREAM).replace(/\/+$/, "");
  return {
    port: int(env.PORT, 8080, 1, 65535),
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
  };
}
