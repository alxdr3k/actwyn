// TEST-NOTIF-CHUNK-001 — per-chunk ledger correctness.
// Covers AC-NOTIF-003, AC-NOTIF-004, AC-NOTIF-005.
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
  splitForTelegram,
} from "../../src/telegram/outbound.ts";

const MIGRATIONS = join(import.meta.dir, "..", "..", "migrations");

let workdir: string;
let db: DbHandle;
let counter = 0;
const newId = () => `id-${(++counter).toString().padStart(5, "0")}`;

beforeEach(() => {
  counter = 0;
  workdir = mkdtempSync(join(tmpdir(), "actwyn-nf-ledger-"));
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

function makeFourChunkText(): string {
  // DEFAULT_CHUNK_SIZE = 3800; four chunks ~ 15200 chars.
  return "x".repeat(3800 * 4);
}

describe("atomicity — parent + N chunk rows inserted in a single txn", () => {
  test("after creation, N chunks exist for N-chunk payload", () => {
    const text = makeFourChunkText();
    const created = createNotificationAndChunks({
      db,
      newId,
      args: { job_id: "job-1", chat_id: "chat-1", notification_type: "job_completed", text },
    });
    expect(created.chunks.length).toBeGreaterThanOrEqual(4);
    const n =
      db
        .prepare<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM outbound_notification_chunks WHERE outbound_notification_id = ?",
        )
        .get(created.notification_id)!.n;
    expect(n).toBe(created.chunks.length);
  });

  test("chunk_count on parent matches actual chunk row count", () => {
    const text = splitForTelegram("abc".repeat(5000)).join("").slice(0, 5000);
    const created = createNotificationAndChunks({
      db,
      newId,
      args: { job_id: "job-1", chat_id: "chat-1", notification_type: "job_completed", text },
    });
    const row = db
      .prepare<{ chunk_count: number }, [string]>(
        "SELECT chunk_count FROM outbound_notifications WHERE id = ?",
      )
      .get(created.notification_id)!;
    expect(row.chunk_count).toBe(created.chunks.length);
  });
});

describe("AC-NOTIF-003 / AC-NOTIF-005 — retry sends only pending|failed chunks", () => {
  test("chunks 1–2 sent, chunk 3 fails once: retry re-sends chunk 3 only", async () => {
    const text = makeFourChunkText();
    const created = createNotificationAndChunks({
      db,
      newId,
      args: { job_id: "job-1", chat_id: "chat-1", notification_type: "job_completed", text },
    });
    const chunks = created.chunks;
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    const c3 = chunks[2]!;
    const transport = new StubOutboundTransport({
      plan: new Map([[c3, "fail_once"]]),
    });

    // Pass 1: 1, 2, (3 fails), 4 all processed; chunk 3 sits in
    // pending with one failed attempt recorded.
    const pass1 = await sendNotification(
      { db, transport, max_attempts_per_chunk: 5 },
      created.notification_id,
      chunks,
    );
    // 1 and 2 and 4 sent; 3 still pending.
    const statuses1 = db
      .prepare<{ chunk_index: number; status: string; telegram_message_id: string | null }, [string]>(
        `SELECT chunk_index, status, telegram_message_id
         FROM outbound_notification_chunks
         WHERE outbound_notification_id = ? ORDER BY chunk_index ASC`,
      )
      .all(created.notification_id);
    expect(statuses1.find((r) => r.chunk_index === 3)?.status).toBe("pending");
    for (const r of statuses1) {
      if (r.chunk_index !== 3) {
        expect(r.status).toBe("sent");
        expect(r.telegram_message_id).not.toBeNull();
      }
    }
    expect(pass1.roll_up_status).toBe("pending");

    // Pass 2: retry sends ONLY chunk 3.
    const sendCountsBefore = chunks.map((c) => transport.countSendsFor(c));
    const pass2 = await sendNotification(
      { db, transport, max_attempts_per_chunk: 5 },
      created.notification_id,
      chunks,
    );
    const sendCountsAfter = chunks.map((c) => transport.countSendsFor(c));
    for (let i = 0; i < chunks.length; i++) {
      if (i === 2) {
        expect(sendCountsAfter[i]! - sendCountsBefore[i]!).toBe(1);
      } else {
        // chunks 1, 2, 4 were already sent — must not be re-sent.
        expect(sendCountsAfter[i]! - sendCountsBefore[i]!).toBe(0);
      }
    }
    expect(pass2.roll_up_status).toBe("sent");
    const statuses2 = db
      .prepare<{ status: string }, [string]>(
        "SELECT status FROM outbound_notification_chunks WHERE outbound_notification_id = ? ORDER BY chunk_index ASC",
      )
      .all(created.notification_id)
      .map((r) => r.status);
    expect(statuses2.every((s) => s === "sent")).toBe(true);
  });
});

describe("AC-NOTIF-004 — telegram_message_ids_json derived in chunk order", () => {
  test("after all chunks sent, parent row carries ordered ids", async () => {
    const text = makeFourChunkText();
    const created = createNotificationAndChunks({
      db,
      newId,
      args: { job_id: "job-1", chat_id: "chat-1", notification_type: "job_completed", text },
    });
    const transport = new StubOutboundTransport();
    await sendNotification({ db, transport }, created.notification_id, created.chunks);
    const parent = db
      .prepare<{ telegram_message_ids_json: string | null; status: string }, [string]>(
        "SELECT telegram_message_ids_json, status FROM outbound_notifications WHERE id = ?",
      )
      .get(created.notification_id)!;
    expect(parent.status).toBe("sent");
    const ids = JSON.parse(parent.telegram_message_ids_json!);
    expect(ids.length).toBe(created.chunks.length);
    // Stub assigns sequential tg-1, tg-2, ... in call order, which
    // maps to chunk order because the send pass iterates by
    // chunk_index ASC.
    for (let i = 0; i < ids.length; i++) expect(ids[i]).toBe(`tg-${i + 1}`);
  });
});

describe("parent roll-up — fail_non_retryable promotes parent to failed", () => {
  test("one non-retryable chunk failure: parent=failed after budget exhausted", async () => {
    const text = makeFourChunkText();
    const created = createNotificationAndChunks({
      db,
      newId,
      args: { job_id: "job-1", chat_id: "chat-1", notification_type: "job_completed", text },
    });
    const badChunk = created.chunks[1]!;
    const transport = new StubOutboundTransport({
      plan: new Map([[badChunk, "fail_non_retryable"]]),
    });
    // Single pass with max_attempts=1 so the failed chunk stays failed.
    const res = await sendNotification(
      { db, transport, max_attempts_per_chunk: 1 },
      created.notification_id,
      created.chunks,
    );
    expect(res.roll_up_status).toBe("failed");
    const parent = db
      .prepare<{ status: string; attempt_count: number }, [string]>(
        "SELECT status, attempt_count FROM outbound_notifications WHERE id = ?",
      )
      .get(created.notification_id)!;
    expect(parent.status).toBe("failed");
    expect(parent.attempt_count).toBeGreaterThanOrEqual(1);
    // Provider run / job unchanged (AC-NOTIF-001).
    const job = db
      .prepare<{ status: string }>("SELECT status FROM jobs WHERE id = 'job-1'")
      .get()!;
    expect(job.status).toBe("succeeded");
  });
});
