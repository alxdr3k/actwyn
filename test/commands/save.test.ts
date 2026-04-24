import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase, type DbHandle } from "../../src/db.ts";
import { migrate } from "../../src/db/migrator.ts";
import { parseSaveIntent, saveLastAttachment } from "../../src/commands/save.ts";

const MIGRATIONS = join(import.meta.dir, "..", "..", "migrations");

let workdir: string;
let db: DbHandle;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "actwyn-save-"));
  db = openDatabase({ path: join(workdir, "t.db"), busyTimeoutMs: 250 });
  migrate(db, MIGRATIONS);
  db.prepare<unknown, [string, string, string]>(
    "INSERT INTO sessions(id, chat_id, user_id) VALUES(?, ?, ?)",
  ).run("sess-1", "chat-1", "user-1");
});

afterEach(() => {
  db.close();
  rmSync(workdir, { recursive: true, force: true });
});

// ---------------------------------------------------------------
// parseSaveIntent — natural-language detection (pure, ADR-0006)
// ---------------------------------------------------------------

describe("parseSaveIntent — English", () => {
  test('"save this" → intent detected', () => {
    expect(parseSaveIntent("save this")).not.toBeNull();
  });

  test('"keep this" → intent detected', () => {
    expect(parseSaveIntent("keep this")).not.toBeNull();
  });

  test('"remember this file" → intent detected', () => {
    expect(parseSaveIntent("remember this file")).not.toBeNull();
  });

  test('"keep this for later" → intent detected', () => {
    expect(parseSaveIntent("keep this for later")).not.toBeNull();
  });

  test('"store this" → intent detected', () => {
    expect(parseSaveIntent("store this")).not.toBeNull();
  });

  test('"archive this" → intent detected', () => {
    expect(parseSaveIntent("archive this")).not.toBeNull();
  });

  test("non-save message → null (no false positive)", () => {
    expect(parseSaveIntent("what time is it")).toBeNull();
    expect(parseSaveIntent("how do I write tests")).toBeNull();
    expect(parseSaveIntent("")).toBeNull();
  });
});

describe("parseSaveIntent — Korean (ADR-0006)", () => {
  test("이 파일 저장해 → intent detected", () => {
    expect(parseSaveIntent("이 파일 저장해")).not.toBeNull();
  });

  test("저장해줘 → intent detected", () => {
    expect(parseSaveIntent("저장해줘")).not.toBeNull();
  });

  test("기억해줘 → intent detected", () => {
    expect(parseSaveIntent("기억해줘")).not.toBeNull();
  });

  test("한국어 무관 메시지 → null (false positive 없음)", () => {
    expect(parseSaveIntent("오늘 날씨 어때")).toBeNull();
    expect(parseSaveIntent("코드 짜줘")).toBeNull();
  });
});

describe("parseSaveIntent — /save_last_attachment slash command", () => {
  test("/save_last_attachment with no caption → caption null", () => {
    const r = parseSaveIntent("/save_last_attachment");
    expect(r).not.toBeNull();
    expect(r?.caption).toBeNull();
  });

  test("/save_last_attachment with caption → caption returned", () => {
    const r = parseSaveIntent("/save_last_attachment important diagram");
    expect(r).not.toBeNull();
    expect(r?.caption).toBe("important diagram");
  });
});

// ---------------------------------------------------------------
// saveLastAttachment — DB-level behavior (negative: no promotion
// without intent is enforced at the call-site; the function itself
// requires explicit invocation — no implicit trigger).
// ---------------------------------------------------------------

describe("saveLastAttachment — no attachment present → no promotion", () => {
  test("promoted=false when session has no captured attachment", () => {
    const r = saveLastAttachment({ db, newId: () => "x", session_id: "sess-1" });
    expect(r.promoted).toBe(false);
  });
});

describe("saveLastAttachment — enqueues storage_sync job (review Blocker 4)", () => {
  function seedCapturedAttachment(id: string): void {
    db.prepare<unknown, [string, string, string, string]>(
      `INSERT INTO jobs(id, status, job_type, session_id, chat_id, request_json, idempotency_key, provider)
       VALUES(?, 'succeeded', 'provider_run', ?, ?, '{}', ?, 'fake')`,
    ).run("j-sync", "sess-1", "chat-1", "ikey-sync");
    db.prepare<unknown, [string]>(
      `INSERT INTO storage_objects
         (id, storage_backend, bucket, storage_key, source_channel, source_message_id,
          source_job_id, source_external_id, artifact_type, retention_class,
          capture_status, status, captured_at)
       VALUES(?, 's3', 'b', 'objects/2026/04/23/${id}/capture.bin',
              'telegram', '1', 'j-sync', NULL, 'user_upload', 'session',
              'captured', 'pending', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
    ).run(id);
    db.prepare<unknown, [string]>(
      "INSERT INTO turns(id, session_id, job_id, role, content_redacted, redaction_applied) VALUES(?, 'sess-1', 'j-sync', 'assistant', 'hi', 1)",
    ).run(`turn-sync-${id}`);
  }

  test("promoting a captured session attachment enqueues exactly one storage_sync job", () => {
    seedCapturedAttachment("obj-sync-1");
    let n = 0;
    const newId = () => `gen-${++n}`;
    const r = saveLastAttachment({ db, newId, session_id: "sess-1" });
    expect(r.promoted).toBe(true);

    const jobs = db
      .prepare<{ id: string; idempotency_key: string; status: string }>(
        "SELECT id, idempotency_key, status FROM jobs WHERE job_type = 'storage_sync'",
      )
      .all();
    expect(jobs.length).toBe(1);
    expect(jobs[0]!.idempotency_key).toBe("sync:obj-sync-1");
    expect(jobs[0]!.status).toBe("queued");
  });

  test("duplicate /save_last_attachment on same object does not create a second storage_sync job", () => {
    seedCapturedAttachment("obj-sync-2");
    let n = 0;
    const newId = () => `gen-${++n}`;
    saveLastAttachment({ db, newId, session_id: "sess-1" });
    // Second call: same object, storage_sync idempotency_key collides and is skipped.
    saveLastAttachment({ db, newId, session_id: "sess-1" });
    const jobs = db
      .prepare<{ n: number }>(
        "SELECT COUNT(*) AS n FROM jobs WHERE job_type = 'storage_sync' AND idempotency_key = 'sync:obj-sync-2'",
      )
      .get()!;
    expect(jobs.n).toBe(1);
  });
});

describe("saveLastAttachment — promotes most-recent captured attachment", () => {
  test("promotes to long_term + creates link with user_stated provenance", () => {
    db.prepare<unknown, [string, string, string, string]>(
      `INSERT INTO jobs(id, status, job_type, session_id, chat_id, request_json, idempotency_key, provider)
       VALUES(?, 'succeeded', 'provider_run', ?, ?, '{}', ?, 'fake')`,
    ).run("j-1", "sess-1", "chat-1", "ikey-1");
    db.prepare<unknown, [string]>(
      `INSERT INTO storage_objects
         (id, storage_backend, bucket, storage_key, source_channel, source_message_id,
          source_job_id, source_external_id, artifact_type, retention_class,
          capture_status, status, captured_at)
       VALUES(?, 's3', 'b', 'objects/2026/04/23/obj-1/capture_pending.bin',
              'telegram', '1', 'j-1', NULL, 'user_upload', 'session',
              'captured', 'pending', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
    ).run("obj-1");
    db.prepare<unknown, [string]>(
      "INSERT INTO turns(id, session_id, job_id, role, content_redacted, redaction_applied) VALUES(?, 'sess-1', 'j-1', 'assistant', 'hi', 1)",
    ).run("turn-1");

    const r = saveLastAttachment({ db, newId: () => "link-1", session_id: "sess-1", caption: "test diagram" });
    expect(r.promoted).toBe(true);

    const obj = db.prepare<{ retention_class: string }, [string]>(
      "SELECT retention_class FROM storage_objects WHERE id = ?",
    ).get("obj-1")!;
    expect(obj.retention_class).toBe("long_term");

    const link = db.prepare<{ provenance: string; caption_or_summary: string | null }, [string]>(
      "SELECT provenance, caption_or_summary FROM memory_artifact_links WHERE id = ?",
    ).get("link-1")!;
    expect(link.provenance).toBe("user_stated");
    expect(link.caption_or_summary).toBe("test diagram");
  });

  test("non-captured (pending) attachment is NOT promoted (explicit intent only promotes what we hold)", () => {
    db.prepare<unknown, [string, string, string, string]>(
      `INSERT INTO jobs(id, status, job_type, session_id, chat_id, request_json, idempotency_key, provider)
       VALUES(?, 'succeeded', 'provider_run', ?, ?, '{}', ?, 'fake')`,
    ).run("j-2", "sess-1", "chat-1", "ikey-2");
    db.prepare<unknown, [string]>(
      `INSERT INTO storage_objects
         (id, storage_backend, bucket, storage_key, source_channel, source_message_id,
          source_job_id, source_external_id, artifact_type, retention_class,
          capture_status, status)
       VALUES(?, 's3', 'b', 'objects/2026/04/23/obj-2/capture_pending.bin',
              'telegram', '2', 'j-2', 'tg-file-X', 'user_upload', 'session',
              'pending', 'pending')`,
    ).run("obj-2");

    const r = saveLastAttachment({ db, newId: () => "link-2", session_id: "sess-1" });
    expect(r.promoted).toBe(false);
  });
});
