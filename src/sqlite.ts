// SQLite access that runs on Bun *and* Node.
//
// `node:sqlite` ships with Node 22+ and Bun implements it, so one store works on
// both runtimes — the precondition for a single thin entry per runtime, the way
// mistral-vibe structures `src/core.js` + `src/server.js`.
//
// The wrapper keeps the `*.query()/.transaction()` surface the store already
// uses: `node:sqlite` calls it `prepare()`, and rewriting 30+ call sites to
// chase that rename buys nothing.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface Statement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): RunResult;
}

export class Database {
  readonly raw: DatabaseSync;
  private readonly statements = new Map<string, Statement>();

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    // WAL keeps readers from blocking the retention purge; it is a no-op for
    // in-memory databases.
    try {
      this.raw.exec("PRAGMA journal_mode = WAL");
    } catch {
      /* :memory: and read-only mounts reject it */
    }
  }

  /** Prepared statements are cached: SQL here is a fixed set of literals. */
  query(sql: string): Statement {
    const cached = this.statements.get(sql);
    if (cached) return cached;
    const raw = this.raw.prepare(sql);
    const statement: Statement = {
      all: (...params) => raw.all(...(params as never[])),
      // node:sqlite yields `undefined` where bun:sqlite yielded `null`; the
      // store's `?? null` handles either, but normalise so callers agree.
      get: (...params) => raw.get(...(params as never[])),
      run: (...params) => raw.run(...(params as never[])) as RunResult,
    };
    this.statements.set(sql, statement);
    return statement;
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  /** Mirrors bun:sqlite: returns a function that runs `fn` atomically. */
  transaction(fn: () => void): () => void {
    return () => {
      this.raw.exec("BEGIN");
      try {
        fn();
        this.raw.exec("COMMIT");
      } catch (err) {
        try {
          this.raw.exec("ROLLBACK");
        } catch {
          /* the transaction already aborted */
        }
        throw err;
      }
    };
  }

  close(): void {
    this.statements.clear();
    this.raw.close();
  }
}
