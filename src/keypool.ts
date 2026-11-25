// Upstream credential pool: round-robin rotation with cooldown, exactly the
// mechanic mistral-vibe uses for its `VIBE_KEYS`.
//
// Why it matters here: the gateway serves Kilo's free tier, which is throttled
// per upstream credential. One key burns out fast under an agentic client, so
// the pool spreads load and benches a key that the upstream rejects, instead of
// surfacing that rejection downstream.
//
// The pool is additive to the tier model:
//   * callers with their own `sk-…` Kilo key always win — that key is used.
//   * otherwise a pooled key is picked; when every pooled key is cooling (i.e.
//     "all logins hit quota"), the request falls through to the anonymous tier,
//     which egresses through WARP.
//
// Like the template, only auth rejections bench a key. A 429 is throughput
// pressure — benching on it disabled single-key setups for ten minutes and then
// reported "no key", which looks like a login failure.

import {
  existsSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  mkdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname } from "node:path";

const COOLDOWN_MS = 10 * 60 * 1000;
/** Statuses that mean "this credential is bad", not "this request is bad". */
const BENCH_STATUSES = new Set([401, 403]);

export interface KeyPoolState {
  key: string;
  /**
   * Stable opaque identifier (a short digest of the credential). A mask is for
   * display and can collide; this cannot, so the dashboard uses it to remove a
   * specific credential without ever handling the secret.
   */
  id: string;
  /** Seconds until the key is usable again; 0 when available. */
  cooldown_s: number;
}

/** Short, stable, non-reversible identifier for a credential. */
export function keyId(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

export class UpstreamPool {
  private keys: string[];
  private cursor = 0;
  private readonly cooldownUntil = new Map<string, number>();
  private readonly path: string | null;

  /**
   * @param keys   initial credentials (env `KILO_KEYS`, comma-separated)
   * @param path   keys file to persist to; `null` disables writes (Worker)
   */
  constructor(keys: string[] = [], path: string | null = null) {
    this.keys = [...new Set(keys.filter(Boolean))];
    this.path = path;
  }

  /** Loads `~/.kilo-gateway/keys.json`, the file the dashboard edits. */
  static fromDisk(file = defaultKeysPath()): UpstreamPool {
    const pool = new UpstreamPool([], file);
    if (existsSync(file)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
        const keys =
          typeof parsed === "object" && parsed !== null && "keys" in parsed
            ? (parsed as { keys: unknown }).keys
            : null;
        if (Array.isArray(keys)) {
          pool.keys = [...new Set(keys.filter((k): k is string => typeof k === "string" && k !== ""))];
        }
      } catch (err) {
        // A truncated file still contains recognisable keys; salvage them rather
        // than starting with none, which would silently drop every credential.
        const salvaged = salvageKeys(readFileSync(file, "utf8"));
        if (salvaged.length > 0) {
          pool.keys = salvaged;
          console.warn(
            `[kilo-gateway] ${file} was unreadable (${err instanceof Error ? err.message : err}); ` +
              `recovered ${salvaged.length} credential${salvaged.length === 1 ? "" : "s"}`,
          );
        } else {
          console.warn(`[kilo-gateway] ignoring unreadable ${file}:`, err instanceof Error ? err.message : err);
        }
      }
    }
    return pool;
  }

  get size(): number {
    return this.keys.length;
  }

  /** Keys not currently benched. */
  available(): string[] {
    const now = Date.now();
    return this.keys.filter((key) => (this.cooldownUntil.get(key) ?? 0) <= now);
  }

  /** Next usable key, or `null` when every key is cooling. */
  next(): string | null {
    const pool = this.available();
    if (pool.length === 0) return null;
    return pool[this.cursor++ % pool.length];
  }

  /** Benches a key after the upstream rejected it as a credential problem. */
  coolDown(key: string): void {
    this.cooldownUntil.set(key, Date.now() + COOLDOWN_MS);
  }

  /** Applies the template's rule: only auth rejections bench a key. */
  observe(status: number, key: string | null): void {
    if (key && BENCH_STATUSES.has(status)) this.coolDown(key);
  }

  state(): KeyPoolState[] {
    const now = Date.now();
    return this.keys.map((key) => ({
      key: maskKey(key),
      id: keyId(key),
      cooldown_s: Math.max(0, Math.round(((this.cooldownUntil.get(key) ?? 0) - now) / 1000)),
    }));
  }

  /**
   * Adds a credential. Deliberately does NOT bench it: the user just supplied
   * it and expects the next call to use it. Only an upstream rejection benches.
   */
  add(key: string): boolean {
    const trimmed = key.trim();
    if (!trimmed || this.keys.includes(trimmed)) return false;
    this.keys.push(trimmed);
    this.cooldownUntil.delete(trimmed);
    this.save();
    return true;
  }

  /**
   * Removes one credential, by full key or by the masked form the dashboard
   * shows.
   *
   * A mask is a display convenience, not an identity: two keys can share one.
   * When a mask matches several keys the removal is refused rather than
   * deleting all of them, and the caller is told to send the full key.
   *
   * @returns `"removed"`, `"not_found"`, or `"ambiguous"`.
   */
  remove(key: string): "removed" | "not_found" | "ambiguous" {
    // An opaque id identifies exactly one credential; full keys do too.
    const byId = this.keys.find((candidate) => keyId(candidate) === key);
    if (byId !== undefined) {
      this.keys = this.keys.filter((candidate) => candidate !== byId);
      this.cooldownUntil.delete(byId);
      this.save();
      return "removed";
    }
    const exact = this.keys.indexOf(key);
    if (exact >= 0) {
      this.keys.splice(exact, 1);
      this.cooldownUntil.delete(key);
      this.save();
      return "removed";
    }
    const matches = this.keys.filter((candidate) => maskKey(candidate) === key);
    if (matches.length === 0) return "not_found";
    if (matches.length > 1) return "ambiguous";
    this.keys = this.keys.filter((candidate) => candidate !== matches[0]);
    this.cooldownUntil.delete(matches[0]);
    this.save();
    return "removed";
  }

  /**
   * Writes atomically: a temp file in the same directory, then `rename`.
   *
   * A direct truncating write leaves a partial file if the process dies
   * mid-write, and this file is the only store of the credentials — losing it
   * silently is worse than failing loudly. `rename` is atomic within a
   * filesystem, so a reader sees either the old file or the new one.
   */
  private save(): void {
    if (!this.path) return; // Worker mode: no filesystem
    const temp = `${this.path}.tmp`;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(temp, `${JSON.stringify({ keys: this.keys }, null, 2)}\n`, { mode: 0o600 });
      chmodSync(temp, 0o600);
      renameSync(temp, this.path);
    } catch (err) {
      console.error("[kilo-gateway] could not persist upstream keys:", err);
      try {
        rmSync(temp, { force: true });
      } catch {
        /* the temp file is disposable */
      }
    }
  }
}

/**
 * Extracts complete credential-looking string literals from a damaged file.
 *
 * Only matches a *closed* quoted literal, so a value cut in half by a crash is
 * dropped rather than restored as a corrupt key.
 */
export function salvageKeys(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/"((?:sk|pk|kg)-[^"\\]{4,})"/g)) {
    found.add(match[1]);
  }
  return [...found];
}

/** `sk-abc…wxyz` — enough to identify a key, not enough to use it. */
export function maskKey(key: string): string {
  if (key.length <= 10) return `${key.slice(0, 3)}…`;
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

export function defaultKeysPath(): string {
  return `${homedir()}/.kilo-gateway/keys.json`;
}
