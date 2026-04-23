import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase, type DbHandle } from "../../src/db.ts";
import { migrate } from "../../src/db/migrator.ts";
import {
  createNotificationAndChunks,
  sendNotification,
  StubOutboundTransport,
} from "../../src/telegram/outbound.ts";

const MIGRATIONS = join(import.meta.dir, "..", "..", "migrations");

let workdir: string;
let db: DbHandle;
let n = 0;
const newId = () => `id-${(++n).toString().padStart(5, "0")}`;

beforeEach(() => {
  n = 0;
  workdir = mkdtempSync(join(tmpdir(), "actwyn-nf-sm-"));
  db = openDatabase({ path: join(workdir, "t.db"), busyTimeoutMs: 250 });
  migrate(db, MIGRATIONS);
  db.prepare<unknown, [string, string, string]>(
    "INSERT INTO sessions(id, chat_id, user_id) VALUES(?, ?, ?)",
  ).run("sess-1", "chat-1", "user-1");
  db.prepare<unknown, [string, string]>(
    `INSERT INTO jobs(id, status, job_type, chat_id, request_json, idempotency_key, provider)
     VALUES('job-1', 'succeeded', 'provider_run', ?, '{}', ?, 'fake')`,
  ).run("chat-1", "ikey-1");
});

afterEach(() => {
  db.close();
  rmSync(workdir, { recursive: true, force: true });
});

function parentStatus(id: string): string {
  return db
    .prepare<{ status: string }, [string]>("SELECT status FROM outbound_notifications WHERE id = ?")
    .get(id)!.status;
}

function chunkStatuses(id: string): string[] {
  return db
    .prepare<{ status: string }, [string]>(
      "SELECT status FROM outbound_notification_chunks WHERE outbound_notification_id = ? ORDER BY chunk_index ASC",
    )
    .all(id)
    .map((r) => r.status);
}

describe("state machine — pending → sent", () => {
  test("single-chunk happy path", async () => {
    const created = createNotificationAndChunks({
      db,
      newId,
      args: { job_id: "job-1", chat_id: "chat-1", notification_type: "job_completed", text: "hi" },
    });
    expect(created.created).toBe(true);
    expect(created.chunks.length).toBe(1);
    expect(parentStatus(created.notification_id)).toBe("pending");

    const transport = new StubOutboundTransport();
    const res = await sendNotification(
      { db, transport },
      created.notification_id,
      created.chunks,
    );
    expect(res.roll_up_status).toBe("sent");
    expect(res.sent).toBe(1);
    expect(parentStatus(created.notification_id)).toBe("sent");
    const ids = db
      .prepare<{ telegram_message_ids_json: string | null }, [string]>(
        "SELECT telegram_message_ids_json FROM outbound_notifications WHERE id = ?",
      )
      .get(created.notification_id)!.telegram_message_ids_json;
    expect(ids).toContain("tg-1");
  });
});

describe("state machine — pending → failed (transient) → pending → sent", () => {
  test("retryable failure keeps chunk pending; next send succeeds", async () => {
    const text = "retry me";
    const created = createNotificationAndChunks({
      db,
      newId,
      args: { job_id: "job-1", chat_id: "chat-1", notification_type: "job_completed", text },
    });
    const transport = new StubOutboundTransport({
      plan: new Map([[created.chunks[0]!, "fail_once"]]),
    });
    // First pass: transient failure keeps chunk in pending.
    const pass1 = await sendNotification(
      { db, transport, max_attempts_per_chunk: 5 },
      created.notification_id,
      created.chunks,
    );
    expect(pass1.roll_up_status).toBe("pending");
    expect(chunkStatuses(created.notification_id)).toEqual(["pending"]);

    // Second pass: succeeds.
    const pass2 = await sendNotification(
      { db, transport, max_attempts_per_chunk: 5 },
      created.notification_id,
      created.chunks,
    );
    expect(pass2.roll_up_status).toBe("sent");
    expect(chunkStatuses(created.notification_id)).toEqual(["sent"]);
  });
});

describe("duplicate prevention — same payload_hash → same rows", () => {
  test("second insert returns the existing parent + chunk rows without creating new ones", () => {
    const args = {
      job_id: "job-1",
      chat_id: "chat-1",
      notification_type: "job_completed" as const,
      text: "hello",
    };
    const a = createNotificationAndChunks({ db, newId, args });
    const b = createNotificationAndChunks({ db, newId, args });
    expect(a.notification_id).toBe(b.notification_id);
    expect(b.created).toBe(false);
    const countParent = db
      .prepare<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM outbound_notifications WHERE job_id = ?",
      )
      .get("job-1")!.n;
    expect(countParent).toBe(1);
    const countChunks = db
      .prepare<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM outbound_notification_chunks WHERE outbound_notification_id = ?",
      )
      .get(a.notification_id)!.n;
    expect(countChunks).toBe(a.chunks.length);
  });
});

describe("provider_run / job independence", () => {
  test("chunk failure does NOT mutate jobs.status", async () => {
    const created = createNotificationAndChunks({
      db,
      newId,
      args: {
        job_id: "job-1",
        chat_id: "chat-1",
        notification_type: "job_completed",
        text: "nope",
      },
    });
    const transport = new StubOutboundTransport({
      plan: new Map([[created.chunks[0]!, "fail_non_retryable"]]),
    });
    const res = await sendNotification(
      { db, transport, max_attempts_per_chunk: 1 },
      created.notification_id,
      created.chunks,
    );
    expect(res.roll_up_status).toBe("failed");
    const status = db
      .prepare<{ status: string }>("SELECT status FROM jobs WHERE id = 'job-1'")
      .get()!.status;
    expect(status).toBe("succeeded"); // unchanged from fixture
  });
});
