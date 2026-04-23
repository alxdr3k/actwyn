import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase, type DbHandle } from "../../src/db.ts";
import { migrate, discoverMigrations, appliedVersions } from "../../src/db/migrator.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");

let workdir: string;
let db: DbHandle;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "actwyn-db-schema-"));
  db = openDatabase({ path: join(workdir, "test.db"), busyTimeoutMs: 250 });
});

afterEach(() => {
  db.close();
  rmSync(workdir, { recursive: true, force: true });
});

interface TableInfo {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

function columns(h: DbHandle, table: string): TableInfo[] {
  return h
    .prepare<TableInfo, [string]>(`SELECT * FROM pragma_table_info(?)`)
    .all(table);
}

function hasIndex(h: DbHandle, name: string): boolean {
  const row = h
    .prepare<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name=?`,
    )
    .get(name);
  return (row?.n ?? 0) > 0;
}

function hasTable(h: DbHandle, name: string): boolean {
  const row = h
    .prepare<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?`,
    )
    .get(name);
  return (row?.n ?? 0) > 0;
}

// ---------------------------------------------------------------
// Runner behaviour
// ---------------------------------------------------------------

describe("migrator — discovery + application", () => {
  test("discovers 001_init + 002_artifacts in order", () => {
    const files = discoverMigrations(MIGRATIONS_DIR);
    expect(files.map((f) => f.version)).toEqual([1, 2]);
    expect(files[0]!.slug).toBe("init");
    expect(files[1]!.slug).toBe("artifacts");
  });

  test("fresh DB: applied = [1, 2], skipped = []", () => {
    const result = migrate(db, MIGRATIONS_DIR);
    expect(result.applied).toEqual([1, 2]);
    expect(result.skipped).toEqual([]);
    expect(result.total).toBe(2);
  });

  test("re-running is a no-op", () => {
    migrate(db, MIGRATIONS_DIR);
    const second = migrate(db, MIGRATIONS_DIR);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual([1, 2]);
  });

  test("appliedVersions records 001 and 002", () => {
    migrate(db, MIGRATIONS_DIR);
    const set = appliedVersions(db);
    expect(set.has(1)).toBe(true);
    expect(set.has(2)).toBe(true);
  });
});

// ---------------------------------------------------------------
// PRAGMAs applied by openDatabase
// ---------------------------------------------------------------

describe("db — PRAGMAs after open", () => {
  test("WAL journal_mode is active", () => {
    expect(db.pragma("journal_mode")).toBe("wal");
  });

  test("foreign_keys is ON", () => {
    expect(db.pragma("foreign_keys")).toBe(1);
  });

  test("busy_timeout is set", () => {
    expect(db.pragma("busy_timeout")).toBe(250);
  });
});

// ---------------------------------------------------------------
// Every Appendix D table exists after migration
// ---------------------------------------------------------------

describe("schema — Appendix D tables exist after migrate", () => {
  const TABLES = [
    "telegram_updates",
    "outbound_notifications",
    "outbound_notification_chunks",
    "jobs",
    "sessions",
    "turns",
    "provider_runs",
    "provider_raw_events",
    "memory_summaries",
    "memory_items",
    "storage_objects",
    "memory_artifact_links",
    "allowed_users",
    "settings",
  ];

  beforeEach(() => {
    migrate(db, MIGRATIONS_DIR);
  });

  for (const t of TABLES) {
    test(`table ${t} exists`, () => {
      expect(hasTable(db, t)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------
// Representative column coverage (sanity; PRD Appendix D has the
// full spec). If someone edits a migration to drop a column that
// code depends on, these tests should catch it.
// ---------------------------------------------------------------

describe("schema — representative column coverage", () => {
  beforeEach(() => {
    migrate(db, MIGRATIONS_DIR);
  });

  const CASES: Record<string, readonly string[]> = {
    telegram_updates: [
      "update_id",
      "chat_id",
      "user_id",
      "update_type",
      "status",
      "skip_reason",
      "job_id",
      "raw_update_json_redacted",
      "created_at",
      "processed_at",
    ],
    jobs: [
      "id",
      "status",
      "job_type",
      "priority",
      "scheduled_at",
      "created_at",
      "started_at",
      "finished_at",
      "attempts",
      "max_attempts",
      "provider",
      "session_id",
      "user_id",
      "chat_id",
      "request_json",
      "result_json",
      "error_json",
      "idempotency_key",
      "safe_retry",
    ],
    provider_runs: [
      "id",
      "job_id",
      "session_id",
      "provider",
      "provider_session_id",
      "context_packing_mode",
      "status",
      "argv_json_redacted",
      "cwd",
      "process_id",
      "process_group_id",
      "provider_version",
      "injected_snapshot_json",
      "usage_json",
      "parser_status",
      "error_type",
      "started_at",
      "finished_at",
    ],
    outbound_notifications: [
      "id",
      "job_id",
      "chat_id",
      "notification_type",
      "payload_hash",
      "chunk_count",
      "status",
      "telegram_message_ids_json",
      "attempt_count",
      "error_json",
      "created_at",
      "sent_at",
    ],
    outbound_notification_chunks: [
      "id",
      "outbound_notification_id",
      "chunk_index",
      "chunk_count",
      "payload_text_hash",
      "status",
      "telegram_message_id",
      "attempt_count",
      "error_json",
      "sent_at",
      "created_at",
    ],
    storage_objects: [
      "id",
      "storage_backend",
      "bucket",
      "storage_key",
      "original_filename_redacted",
      "mime_type",
      "size_bytes",
      "sha256",
      "source_channel",
      "source_turn_id",
      "source_message_id",
      "source_job_id",
      "source_external_id",
      "artifact_type",
      "retention_class",
      "visibility",
      "capture_status",
      "status",
      "created_at",
      "captured_at",
      "uploaded_at",
      "deleted_at",
      "capture_error_json",
      "error_json",
    ],
    memory_items: [
      "id",
      "session_id",
      "project_id",
      "item_type",
      "content",
      "content_json",
      "provenance",
      "confidence",
      "status",
      "supersedes_memory_id",
      "source_turn_ids",
      "created_at",
      "status_changed_at",
    ],
    memory_artifact_links: [
      "id",
      "memory_summary_id",
      "turn_id",
      "storage_object_id",
      "relation_type",
      "caption_or_summary",
      "provenance",
      "confidence",
      "created_at",
    ],
  };

  for (const [table, cols] of Object.entries(CASES)) {
    test(`${table} carries expected columns`, () => {
      const present = new Set(columns(db, table).map((c) => c.name));
      for (const c of cols) {
        expect(present.has(c), `${table}.${c} missing`).toBe(true);
      }
    });
  }
});

// ---------------------------------------------------------------
// Indices called out in HLD §5.1 / §5.3
// ---------------------------------------------------------------

describe("schema — required indices exist", () => {
  beforeEach(() => {
    migrate(db, MIGRATIONS_DIR);
  });

  const INDICES = [
    "ux_jobs_job_type_idem_key",
    "idx_jobs_status_sched",
    "ux_provider_raw_events_run_idx",
    "ux_outbound_notifications_dedupe",
    "ux_chunks_notification_index",
    "ux_storage_objects_backend_bucket_key",
    "idx_storage_objects_capture_status",
    "idx_storage_objects_retention",
    "idx_turns_session_created",
    "idx_memory_items_session_status",
  ];
  for (const ix of INDICES) {
    test(`index ${ix} exists`, () => {
      expect(hasIndex(db, ix)).toBe(true);
    });
  }
});
