// Personal Agent P0 — SQLite wrapper.
//
// Responsibilities (HLD §5, PRD Appendix D, PRD §9.5.3):
//   - Open the SQLite file via `bun:sqlite`.
//   - Enable WAL mode, set `busy_timeout`, enable foreign_keys.
//   - Expose helpers for prepared statements, transactions
//     (`BEGIN IMMEDIATE` for writers, per HLD §6.2.2), and safe
//     close-on-shutdown.
//
// No schema creation here — migrations live in
// `src/db/migrator.ts` + `migrations/*.sql`.

import { Database, type SQLQueryBindings, type Statement } from "bun:sqlite";

export interface OpenOptions {
  readonly path: string;
  /** busy_timeout in ms; default 5000. */
  readonly busyTimeoutMs?: number;
  /** Open read-only (tests/inspection). */
  readonly readonly?: boolean;
  /** Create if missing. Default true. */
  readonly create?: boolean;
}

export interface DbHandle {
  readonly raw: Database;
  prepare<
    Row = unknown,
    Params extends SQLQueryBindings[] = SQLQueryBindings[],
  >(sql: string): Statement<Row, Params>;
  exec(sql: string): void;
  /**
   * Writer transaction — uses `BEGIN IMMEDIATE` so concurrent
   * writers serialize at BEGIN time (HLD §5.3 / §6.2.2).
   * Commits on success; rolls back on throw.
   */
  tx<T>(work: () => T): T;
  close(): void;
  pragma(name: string): unknown;
}

export function openDatabase(opts: OpenOptions): DbHandle {
  const db = new Database(opts.path, {
    create: opts.create ?? true,
    readonly: opts.readonly ?? false,
    strict: true,
  });

  if (!opts.readonly) {
    // WAL: required by PRD (concurrent reads while a writer runs)
    // and by the worker-claim invariant in HLD §6.2.
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
    db.exec(`PRAGMA busy_timeout = ${Math.max(1, opts.busyTimeoutMs ?? 5000)};`);
    db.exec("PRAGMA foreign_keys = ON;");
    // Protect against accidentally loading extensions.
    db.exec("PRAGMA trusted_schema = OFF;");
  }

  return wrap(db);
}

function wrap(db: Database): DbHandle {
  return {
    raw: db,
    prepare<
      Row = unknown,
      Params extends SQLQueryBindings[] = SQLQueryBindings[],
    >(sql: string): Statement<Row, Params> {
      return db.prepare(sql) as unknown as Statement<Row, Params>;
    },
    exec(sql) {
      db.exec(sql);
    },
    tx<T>(work: () => T): T {
      db.exec("BEGIN IMMEDIATE;");
      try {
        const out = work();
        db.exec("COMMIT;");
        return out;
      } catch (e) {
        try {
          db.exec("ROLLBACK;");
        } catch {
          // ROLLBACK after BEGIN IMMEDIATE can fail if the txn was
          // already aborted by SQLite; swallow so the original
          // error propagates.
        }
        throw e;
      }
    },
    close() {
      db.close();
    },
    pragma(name: string): unknown {
      const stmt = db.prepare(`PRAGMA ${name};`);
      const row = stmt.get() as Record<string, unknown> | null;
      if (!row) return null;
      // PRAGMA returns one column named after the pragma (usually).
      const keys = Object.keys(row);
      if (keys.length === 1) return row[keys[0]!];
      return row;
    },
  };
}
