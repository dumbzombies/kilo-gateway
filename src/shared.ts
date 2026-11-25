// Small helpers shared by modules that must stay runtime-neutral.
//
// `security.ts` needs the UTC day boundary for daily quotas, and the Cloudflare
// Worker imports `security.ts`. Keeping the helper here means the Worker never
// pulls in `db.ts` (and therefore `node:sqlite`) just for arithmetic.

/** Milliseconds since the epoch at 00:00 UTC on the day containing `now`. */
export function startOfUtcDay(now = Date.now()): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}
