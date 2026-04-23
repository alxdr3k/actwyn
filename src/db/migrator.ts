// Personal Agent P0 — forward-only migration runner.
//
// Contract (HLD §5, PRD Appendix D):
//   - Reads every `migrations/<NNN>_<slug>.sql` file in numeric
//     order and applies it inside a single SQL `exec` (so a file
//     may contain multiple statements).
//   - Records applied versions in the `settings` table under the
//     key `schema.migrations.<NNN>`. A second run skips files
//     whose version is already present → idempotent.
//   - Missing prior versions are an error: migrations are
//     forward-only; gaps are refused so we don't accidentally
//     apply 003 after 001 when 002 failed.
//
// This runner is deliberately plain: no transactions spanning
// multiple files (SQLite DDL + PRAGMAs do not mix well with a
// single big txn), and no "down" step in P0.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { DbHandle } from "~/db.ts";

export interface MigrationFile {
  readonly version: number;
  readonly slug: string;
  readonly path: string;
  readonly sql: string;
}

export interface MigrateResult {
  readonly applied: readonly number[];
  readonly skipped: readonly number[];
  readonly total: number;
}

const FILENAME_RE = /^(\d{3,})_([A-Za-z0-9_\-]+)\.sql$/;
const SETTING_PREFIX = "schema.migrations.";

export function discoverMigrations(dir: string): MigrationFile[] {
  const st = statSync(dir);
  if (!st.isDirectory()) {
    throw new Error(`migrations dir is not a directory: ${dir}`);
  }
  const out: MigrationFile[] = [];
  for (const entry of readdirSync(dir)) {
    const m = FILENAME_RE.exec(entry);
    if (!m) continue;
    const version = Number(m[1]);
    if (!Number.isInteger(version) || version <= 0) {
      throw new Error(`migration filename has non-positive version: ${entry}`);
    }
    const path = join(dir, entry);
    out.push({
      version,
      slug: m[2]!,
      path,
      sql: readFileSync(path, "utf8"),
    });
  }
  out.sort((a, b) => a.version - b.version);

  // Refuse gaps: versions must be 1, 2, 3, … contiguous from 1.
  for (let i = 0; i < out.length; i++) {
    const expected = i + 1;
    if (out[i]!.version !== expected) {
      throw new Error(
        `migration version gap: expected ${expected}, found ${out[i]!.version} at ${out[i]!.path}`,
      );
    }
  }
  return out;
}

export function ensureSettingsTable(db: DbHandle): void {
  // The canonical settings table is created by 001_init, but the
  // migrator itself needs `settings` to record its own version.
  // We create a compatible table if absent — 001_init uses
  // CREATE TABLE IF NOT EXISTS, so re-running is safe.
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ) WITHOUT ROWID;
  `);
}

export function appliedVersions(db: DbHandle): Set<number> {
  ensureSettingsTable(db);
  const rows = db
    .prepare<{ key: string }, [string]>(
      "SELECT key FROM settings WHERE key LIKE ?",
    )
    .all(`${SETTING_PREFIX}%`);
  const out = new Set<number>();
  for (const row of rows) {
    const suffix = row.key.slice(SETTING_PREFIX.length);
    const v = Number(suffix);
    if (Number.isInteger(v)) out.add(v);
  }
  return out;
}

export function migrate(db: DbHandle, dir: string): MigrateResult {
  const files = discoverMigrations(dir);
  ensureSettingsTable(db);
  const already = appliedVersions(db);
  const applied: number[] = [];
  const skipped: number[] = [];

  for (const file of files) {
    if (already.has(file.version)) {
      skipped.push(file.version);
      continue;
    }

    // DDL + PRAGMAs + CREATE INDEX in one exec. SQLite treats the
    // string as an implicit sequence; we explicitly wrap in a
    // DEFERRED txn for atomicity of the DDL group (SQLite supports
    // DDL inside txns).
    db.exec("BEGIN;");
    try {
      db.exec(file.sql);
      db.prepare<unknown, [string, string]>(
        `INSERT INTO settings(key, value, updated_at)
         VALUES(?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
      ).run(`${SETTING_PREFIX}${versionKey(file.version)}`, file.slug);
      db.exec("COMMIT;");
      applied.push(file.version);
    } catch (e) {
      try {
        db.exec("ROLLBACK;");
      } catch {
        // ignore — propagate the original error
      }
      throw new Error(
        `migration ${file.version} (${file.slug}) failed: ${(e as Error).message}`,
      );
    }
  }

  return { applied, skipped, total: files.length };
}

function versionKey(v: number): string {
  return v.toString().padStart(3, "0");
}
