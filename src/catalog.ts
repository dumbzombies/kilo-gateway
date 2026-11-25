// Live free-model catalog for Kilo Gateway, cached for CATALOG_TTL_MS.
//
// Selection rule: Kilo marks free models explicitly (`isFree`). Older catalog
// snapshots only expose zero pricing, so that is kept as a fallback. A model
// qualifying either way is exposed with context/modality metadata; billing is
// always Kilo's own, the gateway never rewrites requests.

export interface CatalogModel {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  name: string;
  free: true;
  context_length: number | null;
  max_completion_tokens: number | null;
  input_modalities: string[];
  description: string;
}

interface UpstreamModel {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  isFree?: unknown;
  pricing?: Record<string, unknown> | null;
  context_length?: unknown;
  top_provider?: { context_length?: unknown; max_completion_tokens?: unknown } | null;
  architecture?: { input_modalities?: unknown } | null;
}

const zero = (v: unknown): boolean => {
  if (v === undefined || v === null || v === "") return true;
  const n = Number.parseFloat(String(v));
  return Number.isFinite(n) && n === 0;
};

export function isFreeModel(m: UpstreamModel): boolean {
  if (!m || typeof m !== "object") return false;
  const id = typeof m.id === "string" ? m.id : "";
  const name = typeof m.name === "string" ? m.name : id;
  if (m.isFree === true) return true;
  const p = m.pricing ?? {};
  return zero(p.prompt) && zero(p.completion) && /free/i.test(name);
}

function strings(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const out = value.filter((v): v is string => typeof v === "string");
  return out.length ? out : fallback;
}

function numberOrNull(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(n) ? n : null;
}

export function toCatalogModel(m: UpstreamModel): CatalogModel | null {
  if (typeof m.id !== "string" || !m.id) return null;
  const provider = m.id.split("/")[0] || "kilo";
  return {
    id: m.id,
    object: "model",
    created: 0,
    owned_by: provider,
    name: typeof m.name === "string" && m.name ? m.name : m.id,
    free: true,
    context_length: numberOrNull(m.context_length ?? m.top_provider?.context_length),
    max_completion_tokens: numberOrNull(m.top_provider?.max_completion_tokens),
    input_modalities: strings(m.architecture?.input_modalities, ["text"]),
    description: typeof m.description === "string" ? m.description : "",
  };
}

function dataArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object" && "data" in payload) {
    const data = payload.data;
    if (Array.isArray(data)) return data;
  }
  return [];
}

export class Catalog {
  private models: CatalogModel[] | null = null;
  private total = 0;
  private fetchedAt = 0;
  private lastError: string | null = null;
  private inflight: Promise<CatalogModel[]> | null = null;

  // Plain fields, assigned in the constructor: Node's type stripping rejects
  // TypeScript parameter properties, and this file must run under both runtimes.
  private readonly upstream: string;
  private readonly ttlMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(upstream: string, ttlMs: number, fetchImpl: typeof fetch = fetch) {
    this.upstream = upstream;
    this.ttlMs = ttlMs;
    this.fetchImpl = fetchImpl;
  }

  get url(): string {
    return `${this.upstream}/models`;
  }

  get loaded(): boolean {
    return this.models !== null;
  }

  get error(): string | null {
    return this.lastError;
  }

  status(): { loaded: boolean; count: number; total: number; fetched_at: number; error: string | null; age_ms: number } {
    return {
      loaded: this.models !== null,
      count: this.models?.length ?? 0,
      total: this.total,
      fetched_at: this.fetchedAt,
      error: this.lastError,
      age_ms: this.fetchedAt ? Date.now() - this.fetchedAt : 0,
    };
  }

  /** Cached list, or an empty list when the first fetch has not happened. */
  current(): CatalogModel[] {
    return this.models ?? [];
  }

  async load(force = false): Promise<CatalogModel[]> {
    if (!force && this.models && Date.now() - this.fetchedAt < this.ttlMs) return this.models;
    if (this.inflight) return this.inflight;
    this.inflight = this.fetchCatalog().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async fetchCatalog(): Promise<CatalogModel[]> {
    try {
      const res = await this.fetchImpl(this.url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`Kilo models API HTTP ${res.status}`);
      const payload: unknown = await res.json();
      const data = dataArray(payload);
      const all = data.filter((v): v is UpstreamModel => Boolean(v) && typeof v === "object");
      const free = all.filter(isFreeModel);
      const catalog = free
        .map(toCatalogModel)
        .filter((m): m is CatalogModel => m !== null)
        .sort((a, b) => a.id.localeCompare(b.id));
      this.models = catalog;
      this.total = all.length;
      this.fetchedAt = Date.now();
      this.lastError = null;
      return catalog;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      if (this.models) return this.models;
      throw err;
    }
  }
}
