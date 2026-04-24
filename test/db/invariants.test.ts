import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase, type DbHandle } from "../../src/db.ts";
import { migrate } from "../../src/db/migrator.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");

let workdir: string;
let db: DbHandle;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "actwyn-db-invariants-"));
  db = openDatabase({ path: join(workdir, "test.db"), busyTimeoutMs: 250 });
  migrate(db, MIGRATIONS_DIR);
  // Seed an allowed user + session so FK inserts line up.
  db.prepare<unknown, [string, string]>(
    "INSERT INTO allowed_users(user_id, note) VALUES(?, ?)",
  ).run("user-1", "test");
  db.prepare<unknown, [string, string, string]>(
    "INSERT INTO sessions(id, chat_id, user_id) VALUES(?, ?, ?)",
  ).run("sess-1", "chat-1", "user-1");
});

afterEach(() => {
  db.close();
  rmSync(workdir, { recursive: true, force: true });
});

function insertJob(args: {
  id: string;
  job_type: "provider_run" | "summary_generation" | "storage_sync" | "notification_retry";
  idempotency_key: string;
  status?: string;
  session_id?: string | null;
  request_json?: string;
}): void {
  db.prepare<
    unknown,
    [string, string, string, string, string | null, string, string]
  >(
    `INSERT INTO jobs(id, status, job_type, idempotency_key, session_id, request_json, chat_id)
     VALUES(?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    args.id,
    args.status ?? "queued",
    args.job_type,
    args.idempotency_key,
    args.session_id ?? null,
    args.request_json ?? "{}",
    "chat-1",
  );
}

// ---------------------------------------------------------------
// §5.2 #1 — telegram_updates.update_id is unique
// ---------------------------------------------------------------

describe("invariant — telegram_updates.update_id is unique", () => {
  test("inserting the same update_id twice throws", () => {
    db.prepare<unknown, [number, string, string]>(
      "INSERT INTO telegram_updates(update_id, status, raw_update_json_redacted) VALUES(?, ?, ?)",
    ).run(1234, "received", "{}");
    expect(() =>
      db
        .prepare<unknown, [number, string, string]>(
          "INSERT INTO telegram_updates(update_id, status, raw_update_json_redacted) VALUES(?, ?, ?)",
        )
        .run(1234, "received", "{}"),
    ).toThrow();
  });
});

// ---------------------------------------------------------------
// §5.3 idempotency — unique (job_type, idempotency_key)
// ---------------------------------------------------------------

describe("invariant — jobs(job_type, idempotency_key) is globally unique", () => {
  test("same (job_type, idempotency_key) pair rejected across inserts", () => {
    insertJob({ id: "j-1", job_type: "provider_run", idempotency_key: "telegram:42" });
    expect(() =>
      insertJob({ id: "j-2", job_type: "provider_run", idempotency_key: "telegram:42" }),
    ).toThrow();
  });

  test("same idempotency_key under different job_type is allowed", () => {
    insertJob({ id: "j-3", job_type: "provider_run", idempotency_key: "telegram:99" });
    insertJob({ id: "j-4", job_type: "summary_generation", idempotency_key: "telegram:99" });
  });
});

// ---------------------------------------------------------------
// §5.2 #2 — enqueued telegram_update points to a real job with
//            idempotency_key='telegram:'||update_id
// ---------------------------------------------------------------

describe("invariant — update ↔ job link", () => {
  test("enqueued row can reference a real job by shared idempotency key", () => {
    const updateId = 7;
    insertJob({
      id: "j-5",
      job_type: "provider_run",
      idempotency_key: `telegram:${updateId}`,
    });
    db.prepare<unknown, [number, string, string, string]>(
      `INSERT INTO telegram_updates(update_id, status, raw_update_json_redacted, job_id)
       VALUES(?, ?, ?, ?)`,
    ).run(updateId, "enqueued", "{}", "j-5");

    const row = db
      .prepare<{ idempotency_key: string }, [number]>(
        `SELECT j.idempotency_key
         FROM telegram_updates tu JOIN jobs j ON j.id = tu.job_id
         WHERE tu.update_id = ?`,
      )
      .get(updateId);
    expect(row?.idempotency_key).toBe(`telegram:${updateId}`);
  });
});

// ---------------------------------------------------------------
// §5.2 #5 — memory_artifact_links with memory_summary_id requires
// storage_objects.retention_class = 'long_term' AND status = 'uploaded'.
// (The schema encodes the FK; this invariant is code-level. We
// verify the FK resolution path here so code can rely on it.)
// ---------------------------------------------------------------

describe("invariant — memory_artifact_links FK resolution", () => {
  test("link insert fails when storage_object_id is unknown", () => {
    expect(() =>
      db
        .prepare<
          unknown,
          [string, string, string, string, string]
        >(
          `INSERT INTO memory_artifact_links(id, storage_object_id, relation_type, provenance, turn_id)
           VALUES(?, ?, ?, ?, ?)`,
        )
        .run("link-1", "nonexistent", "evidence", "observed", null as unknown as string),
    ).toThrow();
  });

  test("link insert succeeds with resolved FK and at least one of summary/turn", () => {
    // Seed a captured+uploaded long_term object and a turn for FK.
    db.prepare<unknown, [string, string, string, string, string | null]>(
      `INSERT INTO turns(id, session_id, role, content_redacted, redaction_applied, job_id)
       VALUES(?, ?, ?, ?, 1, ?)`,
    ).run("turn-1", "sess-1", "assistant", "hello", null);
    db.prepare<unknown, [string, string, string]>(
      `INSERT INTO storage_objects
         (id, storage_backend, bucket, storage_key, source_channel,
          artifact_type, retention_class, capture_status, status)
       VALUES(?, 's3', ?, ?, 'telegram', 'user_upload', 'long_term', 'captured', 'uploaded')`,
    ).run("so-1", "bucket", "objects/2026/04/23/so-1/pending.bin");
    db.prepare<unknown, [string, string, string, string, string]>(
      `INSERT INTO memory_artifact_links(id, storage_object_id, relation_type, provenance, turn_id)
       VALUES(?, ?, ?, ?, ?)`,
    ).run("link-2", "so-1", "attachment", "user_stated", "turn-1");
  });

  test("link CHECK rejects NULL memory_summary_id AND NULL turn_id", () => {
    // Seed the storage object.
    db.prepare<unknown, [string, string]>(
      `INSERT INTO storage_objects
         (id, storage_backend, bucket, storage_key, source_channel,
          artifact_type, retention_class, capture_status, status)
       VALUES(?, 's3', 'bucket', ?, 'system', 'memory_snapshot', 'session', 'pending', 'pending')`,
    ).run("so-2", "objects/2026/04/23/so-2/pending.bin");
    expect(() =>
      db
        .prepare<unknown, [string, string, string, string]>(
          `INSERT INTO memory_artifact_links(id, storage_object_id, relation_type, provenance)
           VALUES(?, ?, ?, ?)`,
        )
        .run("link-3", "so-2", "attachment", "observed"),
    ).toThrow();
  });
});

// ---------------------------------------------------------------
// Enum CHECK surfaces
// ---------------------------------------------------------------

describe("invariant — enum CHECKs reject out-of-set values", () => {
  test("jobs.status rejects 'zombie'", () => {
    expect(() =>
      insertJob({
        id: "j-bad",
        job_type: "provider_run",
        idempotency_key: "x",
        status: "zombie",
      }),
    ).toThrow();
  });

  test("storage_objects.capture_status rejects 'magical'", () => {
    expect(() =>
      db
        .prepare<unknown, [string, string, string]>(
          `INSERT INTO storage_objects
             (id, storage_backend, bucket, storage_key, source_channel,
              artifact_type, retention_class, capture_status, status)
           VALUES(?, 's3', 'b', ?, 'telegram', 'user_upload', 'session', 'magical', 'pending')`,
        )
        .run("so-x", "objects/2026/04/23/so-x/capture_pending.bin", ""),
    ).toThrow();
  });

  test("storage_objects.status 'deletion_requested' is accepted", () => {
    db.prepare<unknown, [string, string]>(
      `INSERT INTO storage_objects
         (id, storage_backend, bucket, storage_key, source_channel,
          artifact_type, retention_class, capture_status, status)
       VALUES(?, 's3', 'b', ?, 'telegram', 'user_upload', 'session', 'captured', 'deletion_requested')`,
    ).run("so-del", "objects/2026/04/23/so-del/capture_pending.bin");
    const row = db
      .prepare<{ status: string }, [string]>(
        `SELECT status FROM storage_objects WHERE id = ?`,
      )
      .get("so-del");
    expect(row?.status).toBe("deletion_requested");
  });

  test("memory_items.confidence CHECK rejects 1.5", () => {
    expect(() =>
      db
        .prepare<
          unknown,
          [string, string, string, string, string, number, string, string]
        >(
          `INSERT INTO memory_items
             (id, session_id, item_type, content, provenance, confidence, status, source_turn_ids)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "mi-bad",
          "sess-1",
          "fact",
          "x",
          "user_stated",
          1.5,
          "active",
          "[]",
        ),
    ).toThrow();
  });
});

// ---------------------------------------------------------------
// outbound_notification_chunks index (per-(notification, index))
// ---------------------------------------------------------------

describe("invariant — outbound_notification_chunks unique per (notification, chunk_index)", () => {
  test("duplicate chunk index on same notification is rejected", () => {
    insertJob({ id: "j-n", job_type: "provider_run", idempotency_key: "n1" });
    db.prepare<unknown, [string, string, string, string, string, number]>(
      `INSERT INTO outbound_notifications
         (id, job_id, chat_id, notification_type, payload_hash, chunk_count, status)
       VALUES(?, ?, ?, ?, ?, ?, 'pending')`,
    ).run("n-1", "j-n", "chat-1", "job_completed", "hash-1", 2);
    db.prepare<unknown, [string, string, number, number, string]>(
      `INSERT INTO outbound_notification_chunks
         (id, outbound_notification_id, chunk_index, chunk_count, payload_text_hash, status)
       VALUES(?, ?, ?, ?, ?, 'pending')`,
    ).run("c-1", "n-1", 1, 2, "h1");
    expect(() =>
      db
        .prepare<unknown, [string, string, number, number, string]>(
          `INSERT INTO outbound_notification_chunks
             (id, outbound_notification_id, chunk_index, chunk_count, payload_text_hash, status)
           VALUES(?, ?, ?, ?, ?, 'pending')`,
        )
        .run("c-1-dup", "n-1", 1, 2, "h1dup"),
    ).toThrow();
  });
});

// ---------------------------------------------------------------
// Writer tx helper — BEGIN IMMEDIATE rolls back on throw.
// ---------------------------------------------------------------

describe("db.tx() — commits on success, rolls back on throw", () => {
  test("rollback on error", () => {
    expect(() =>
      db.tx(() => {
        insertJob({ id: "j-rb", job_type: "provider_run", idempotency_key: "rb-1" });
        throw new Error("boom");
      }),
    ).toThrow("boom");
    const row = db
      .prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM jobs WHERE id='j-rb'`)
      .get();
    expect(row?.n).toBe(0);
  });

  test("commit on success", () => {
    db.tx(() => {
      insertJob({ id: "j-ok", job_type: "provider_run", idempotency_key: "ok-1" });
    });
    const row = db
      .prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM jobs WHERE id='j-ok'`)
      .get();
    expect(row?.n).toBe(1);
  });
});
