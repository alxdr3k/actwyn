import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { openDatabase, type DbHandle } from "../../src/db.ts";
import { migrate } from "../../src/db/migrator.ts";
import { retryNotificationFromLedger } from "../../src/queue/notification_retry.ts";
import {
  createNotificationAndChunks,
  StubOutboundTransport,
} from "../../src/telegram/outbound.ts";

const MIGRATIONS = join(import.meta.dir, "..", "..", "migrations");

let workdir: string;
let db: DbHandle;
let nextId = 0;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "actwyn-retry-driver-"));
  db = openDatabase({ path: join(workdir, "t.db"), busyTimeoutMs: 250 });
  migrate(db, MIGRATIONS);
  nextId = 0;
  db.prepare<unknown, [string, string, string]>(
    "INSERT INTO sessions(id, chat_id, user_id) VALUES(?, ?, ?)",
  ).run("sess-1", "chat-1", "user-1");
});

afterEach(() => {
  db.close();
  rmSync(workdir, { recursive: true, force: true });
});

describe("notification_retry driver", () => {
  test("retries from stored payload_text", async () => {
    seedJob("job-payload");
    const created = createNotification("job-payload", "payload body");
    const transport = new StubOutboundTransport();

    const result = await retryNotificationFromLedger(
      { db, transport },
      created.notification_id,
    );

    expect(result).toMatchObject({
      notification_id: created.notification_id,
      chunks_attempted: 1,
      roll_up_status: "sent",
      retry_outcome: "sent",
      retryable_chunks: 0,
    });
    expect(transport.call_log.map((call) => call.text)).toEqual(["payload body"]);
  });

  test("falls back to assistant turn text plus job footer for legacy null payload_text", async () => {
    seedJob("job-legacy", { duration_ms: 1234, provider: "fake" });
    db.prepare<unknown, [string, string, string]>(
      `INSERT INTO turns(id, session_id, job_id, role, content_redacted, redaction_applied)
       VALUES(?, 'sess-1', ?, 'assistant', ?, 1)`,
    ).run("turn-legacy", "job-legacy", "legacy body");
    const expectedText = "legacy body\n\n---\n1.2s · fake";
    const created = createNotification("job-legacy", expectedText);
    db.prepare<unknown, [string]>(
      "UPDATE outbound_notifications SET payload_text = NULL WHERE id = ?",
    ).run(created.notification_id);
    const transport = new StubOutboundTransport();

    const result = await retryNotificationFromLedger(
      { db, transport },
      created.notification_id,
    );

    expect(result?.retry_outcome).toBe("sent");
    expect(transport.call_log.map((call) => call.text)).toEqual([expectedText]);
  });

  test("terminalizes retryable chunks that exhaust their attempt budget", async () => {
    seedJob("job-exhaust");
    const created = createNotification("job-exhaust", "will fail");
    const transport = new StubOutboundTransport({
      plan: new Map([["will fail", "fail_retryable_always"]]),
    });

    const result = await retryNotificationFromLedger(
      { db, transport, max_attempts_per_chunk: 1 },
      created.notification_id,
    );

    expect(result).toMatchObject({
      chunks_attempted: 1,
      roll_up_status: "failed",
      retry_outcome: "exhausted",
      retryable_chunks: 0,
    });
    const chunk = db
      .prepare<{ status: string; attempt_count: number }, [string]>(
        "SELECT status, attempt_count FROM outbound_notification_chunks WHERE outbound_notification_id = ?",
      )
      .get(created.notification_id)!;
    expect(chunk.status).toBe("failed");
    expect(chunk.attempt_count).toBe(1);
  });

  test("does not reschedule when legacy text cannot be reconstructed", async () => {
    seedJob("job-missing-text");
    const created = createNotification("job-missing-text", "unrecoverable body");
    db.prepare<unknown, [string]>(
      "UPDATE outbound_notifications SET payload_text = NULL WHERE id = ?",
    ).run(created.notification_id);
    const transport = new StubOutboundTransport();

    const result = await retryNotificationFromLedger(
      { db, transport },
      created.notification_id,
    );

    expect(result).toMatchObject({
      chunks_attempted: 0,
      roll_up_status: "failed",
      retry_outcome: "exhausted",
      retryable_chunks: 0,
    });
    expect(transport.call_log).toEqual([]);
    const chunk = db
      .prepare<{ status: string; error_json: string | null }, [string]>(
        "SELECT status, error_json FROM outbound_notification_chunks WHERE outbound_notification_id = ?",
      )
      .get(created.notification_id)!;
    expect(chunk.status).toBe("failed");
    expect(chunk.error_json).toContain("chunk_text_missing");
  });
});

function seedJob(
  id: string,
  opts: { duration_ms?: number; provider?: string } = {},
): void {
  const resultJson = opts.duration_ms === undefined
    ? null
    : JSON.stringify({ duration_ms: opts.duration_ms });
  db.prepare<unknown, [string, string | null, string, string]>(
    `INSERT INTO jobs
       (id, status, job_type, session_id, user_id, chat_id, request_json, result_json, idempotency_key, provider)
     VALUES(?, 'succeeded', 'provider_run', 'sess-1', 'user-1', 'chat-1', '{}', ?, ?, ?)`,
  ).run(id, resultJson, `ikey-${id}`, opts.provider ?? "claude");
}

function createNotification(jobId: string, text: string): ReturnType<typeof createNotificationAndChunks> {
  return createNotificationAndChunks({
    db,
    newId: () => `gen-${(++nextId).toString().padStart(5, "0")}`,
    args: {
      job_id: jobId,
      chat_id: "chat-1",
      notification_type: "job_completed",
      text,
    },
  });
}
