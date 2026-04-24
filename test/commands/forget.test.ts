import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase, type DbHandle } from "../../src/db.ts";
import { migrate } from "../../src/db/migrator.ts";
import {
  forgetArtifact,
  forgetLast,
  forgetMemory,
  forgetSession,
} from "../../src/commands/forget.ts";
import { insertMemoryItem } from "../../src/memory/items.ts";

const MIGRATIONS = join(import.meta.dir, "..", "..", "migrations");

let workdir: string;
let db: DbHandle;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "actwyn-forget-"));
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

function seedArtifact(id: string, status = "uploaded"): void {
  db.prepare<unknown, [string, string, string]>(
    `INSERT INTO storage_objects
       (id, storage_backend, bucket, storage_key, source_channel, source_message_id,
        source_job_id, source_external_id, artifact_type, retention_class,
        capture_status, status)
     VALUES(?, 's3', 'b', ?, 'telegram', '0', NULL, NULL, 'user_upload', 'long_term', 'captured', ?)`,
  ).run(id, `objects/2026/04/23/${id}/capture_pending.bin`, status);
}

describe("/forget_artifact", () => {
  test("uploaded row → deletion_requested; memory_artifact_links cleaned", () => {
    seedArtifact("obj-1");
    db.prepare<unknown, [string]>(
      "INSERT INTO turns(id, session_id, role, content_redacted, redaction_applied) VALUES('t1','sess-1','assistant','hi',1)",
    ).run("t1");
    db.prepare<unknown, [string]>(
      `INSERT INTO memory_artifact_links(id, storage_object_id, turn_id, relation_type, provenance)
       VALUES('link-1', 'obj-1', 't1', 'attachment', 'user_stated')`,
    ).run("link-1");
    const r = forgetArtifact(db, "obj-1");
    expect(r.affected).toBe(1);
    const row = db
      .prepare<{ status: string }, [string]>("SELECT status FROM storage_objects WHERE id = ?")
      .get("obj-1")!;
    expect(row.status).toBe("deletion_requested");
    const links = db
      .prepare<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM memory_artifact_links WHERE storage_object_id = ?")
      .get("obj-1")!;
    expect(links.n).toBe(0);
  });

  test("already-deleted row is not re-requested", () => {
    seedArtifact("obj-d", "deleted");
    const r = forgetArtifact(db, "obj-d");
    expect(r.affected).toBe(0);
    const row = db
      .prepare<{ status: string }, [string]>("SELECT status FROM storage_objects WHERE id = ?")
      .get("obj-d")!;
    expect(row.status).toBe("deleted");
  });

  test("unknown id returns affected=0", () => {
    expect(forgetArtifact(db, "none").affected).toBe(0);
  });

  test("enqueues a storage_sync delete job (review Blocker 5)", () => {
    seedArtifact("obj-del-1");
    let n = 0;
    const newId = () => `gen-${++n}`;
    const r = forgetArtifact(db, "obj-del-1", { newId });
    expect(r.affected).toBe(1);
    const jobs = db
      .prepare<{ idempotency_key: string; status: string }>(
        "SELECT idempotency_key, status FROM jobs WHERE job_type = 'storage_sync'",
      )
      .all();
    expect(jobs.length).toBe(1);
    expect(jobs[0]!.idempotency_key).toBe("storage-delete:obj-del-1");
    expect(jobs[0]!.status).toBe("queued");
  });

  test("duplicate /forget_artifact on same id does not create a second storage_sync job", () => {
    seedArtifact("obj-del-2");
    let n = 0;
    const newId = () => `gen-${++n}`;
    forgetArtifact(db, "obj-del-2", { newId });
    // Second call: no-op because the row is already deletion_requested, so no new job.
    forgetArtifact(db, "obj-del-2", { newId });
    const jobs = db
      .prepare<{ n: number }>(
        "SELECT COUNT(*) AS n FROM jobs WHERE job_type = 'storage_sync' AND idempotency_key = 'storage-delete:obj-del-2'",
      )
      .get()!;
    expect(jobs.n).toBe(1);
  });
});

describe("/forget_memory", () => {
  test("active → revoked", () => {
    insertMemoryItem(db, "m-1", {
      session_id: "sess-1",
      item_type: "fact",
      content: "c",
      provenance: "user_stated",
      confidence: 0.8,
      source_turn_ids: [],
    });
    expect(forgetMemory(db, "m-1").affected).toBe(1);
    const row = db
      .prepare<{ status: string }, [string]>("SELECT status FROM memory_items WHERE id = ?")
      .get("m-1")!;
    expect(row.status).toBe("revoked");
  });

  test("already-revoked → affected=0", () => {
    insertMemoryItem(db, "m-1", {
      session_id: "sess-1",
      item_type: "fact",
      content: "c",
      provenance: "user_stated",
      confidence: 0.8,
      source_turn_ids: [],
    });
    forgetMemory(db, "m-1");
    expect(forgetMemory(db, "m-1").affected).toBe(0);
  });
});

describe("/forget_session", () => {
  test("revokes all active items in the session", () => {
    insertMemoryItem(db, "m-a", {
      session_id: "sess-1",
      item_type: "fact",
      content: "a",
      provenance: "user_stated",
      confidence: 0.7,
      source_turn_ids: [],
    });
    insertMemoryItem(db, "m-b", {
      session_id: "sess-1",
      item_type: "fact",
      content: "b",
      provenance: "user_stated",
      confidence: 0.7,
      source_turn_ids: [],
    });
    // Item in a different session is untouched.
    db.prepare<unknown, [string, string, string]>(
      "INSERT INTO sessions(id, chat_id, user_id) VALUES(?, ?, ?)",
    ).run("sess-other", "chat-1", "user-1");
    insertMemoryItem(db, "m-other", {
      session_id: "sess-other",
      item_type: "fact",
      content: "other",
      provenance: "user_stated",
      confidence: 0.7,
      source_turn_ids: [],
    });
    const r = forgetSession(db, "sess-1");
    expect(r.affected).toBe(2);
    expect(
      db
        .prepare<{ n: number }>(
          "SELECT COUNT(*) AS n FROM memory_items WHERE status = 'revoked'",
        )
        .get()!.n,
    ).toBe(2);
    expect(
      db
        .prepare<{ status: string }, [string]>("SELECT status FROM memory_items WHERE id = ?")
        .get("m-other")!.status,
    ).toBe("active");
  });
});

describe("/forget_last", () => {
  test("prefers the most recent memory_artifact_link in the session", () => {
    seedArtifact("obj-1");
    db.prepare<unknown, [string]>(
      "INSERT INTO turns(id, session_id, role, content_redacted, redaction_applied) VALUES(?, 'sess-1', 'assistant', 'hi', 1)",
    ).run("t1");
    db.prepare<unknown, [string]>(
      `INSERT INTO memory_artifact_links(id, storage_object_id, turn_id, relation_type, provenance, created_at)
       VALUES(?, 'obj-1', 't1', 'attachment', 'user_stated', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
    ).run("link-x");
    const r = forgetLast(db, "sess-1");
    expect(r.ids).toEqual(["link-x"]);
    expect(
      db.prepare<{ n: number }>(
        "SELECT COUNT(*) AS n FROM memory_artifact_links WHERE id = 'link-x'",
      ).get()!.n,
    ).toBe(0);
  });

  test("falls back to revoking the newest active memory_items row", () => {
    insertMemoryItem(db, "m-last", {
      session_id: "sess-1",
      item_type: "fact",
      content: "newest",
      provenance: "user_stated",
      confidence: 0.9,
      source_turn_ids: [],
    });
    const r = forgetLast(db, "sess-1");
    expect(r.ids).toEqual(["m-last"]);
    expect(
      db
        .prepare<{ status: string }, [string]>("SELECT status FROM memory_items WHERE id = ?")
        .get("m-last")!.status,
    ).toBe("revoked");
  });

  test("nothing to forget → affected=0", () => {
    expect(forgetLast(db, "sess-1").affected).toBe(0);
  });
});
