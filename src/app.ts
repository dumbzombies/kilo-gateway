// Compatibility shim: `createApp` keeps its name and signature while the
// implementation lives in `core.ts` (Web-standard, runtime-neutral).
//
// Runtime entries (src/main.ts for Bun/Node, cfwork/worker.js for Cloudflare)
// build a `CoreEnv` and call `createHandler` directly. This module exists so
// existing imports and tests do not churn, and it is the one place that reads
// the dashboard shell from disk.

import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import type { Catalog } from "./catalog.ts";
import type { Egress } from "./egress.ts";
import { Egress as EgressPool } from "./egress.ts";
import { createHandler, type CoreEnv } from "./core.ts";
import { UpstreamPool } from "./keypool.ts";
import uiSource from "./ui.html" with { type: "text" };

const ui = uiSource as unknown as string;

export interface AppDeps {
  cfg: Config;
  store: Store;
  catalog: Catalog;
  fetchImpl?: typeof fetch;
  startedAt?: number;
  ui?: string;
  /** Override the egress pool (tests inject a fake); defaults to cfg.egressProxies. */
  egress?: Egress;
  /** Upstream Kilo credentials; defaults to an empty pool. */
  pool?: UpstreamPool;
}

/** Builds the `CoreEnv` shared by every runtime entry. */
export function coreEnv(deps: AppDeps): CoreEnv {
  const fetchImpl = deps.fetchImpl ?? fetch;
  return {
    cfg: deps.cfg,
    store: deps.store,
    catalog: deps.catalog,
    startedAt: deps.startedAt ?? Date.now(),
    egress: deps.egress ?? new EgressPool({ proxies: deps.cfg.egressProxies, fetchImpl }),
    pool: deps.pool ?? new UpstreamPool(),
    fetchImpl,
    ui: deps.ui ?? ui,
  };
}

export function createApp(deps: AppDeps): { fetch: (req: Request) => Promise<Response> } {
  return { fetch: createHandler(coreEnv(deps)) };
}
