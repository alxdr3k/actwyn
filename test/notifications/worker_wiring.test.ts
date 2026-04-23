// Worker → outbound wiring: a succeeded provider_run produces a
// job_completed notification with a chunk ledger that the stub
// transport delivers end to end.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase, type DbHandle } from "../../src/db.ts";
import { migrate } from "../../src/db/migrator.ts";
import { createEmitter } from "../../src/observability/events.ts";
import { createRedactor } from "../../src/observability/redact.ts";
import { createFakeAdapter } from "../../src/providers/fake.ts";
import { runWorkerOnce, type WorkerDeps } from "../../src/queue/worker.ts";
import { StubOutboundTransport } from "../../src/telegram/outbound.ts";

const MIGRATIONS = join(import.meta.dir, "..", "..", "migrations");

let workdir: string;
let db: DbHandle;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "actwyn-nf-wire-"));
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

function seedJob(id: string, message: string): void {
  db.prepare<unknown, [string, string, string, string]>(
    `INSERT INTO jobs
       (id, status, job_type, session_id, user_id, chat_id, request_json, idempotency_key, provider)
     VALUES(?, 'queued', 'provider_run', ?, 'user-1', 'chat-1', ?, ?, 'fake')`,
  ).run(id, "sess-1", JSON.stringify({ text: message }), `ikey-${id}`);
}

function buildDeps(
  transport: StubOutboundTransport,
  overrides: Partial<WorkerDeps> = {},
): WorkerDeps {
  let n = 0;
  return {
    db,
    redactor: createRedactor(
      {
        email_pii_mode: false,
        phone_pii_mode: false,
        high_entropy_min_length: 32,
        high_entropy_min_bits_per_char: 4.0,
      },
      { exact_values: [] },
    ),
    events: createEmitter({ level: "error", sink: () => {} }),
    adapter: createFakeAdapter(),
    transport: { async getFile() { throw new Error("unused"); }, async download() { throw new Error("unused"); } },
    mime: { async probe() { return "application/octet-stream"; } },
    newId: () => `gen-${(++n).toString().padStart(5, "0")}`,
    now: () => new Date("2026-04-23T00:00:00.000Z"),
    config: { capture: { max_download_size_bytes: 1, local_path: (id) => `${workdir}/${id}` } },
    outbound: transport,
    ...overrides,
  };
}

describe("worker → outbound wiring", () => {
  test("provider_run → job_accepted sent before job_completed (PRD §13.3 DEC-012)", async () => {
    seedJob("j-accepted", "hi");
    const transport = new StubOutboundTransport();
    await runWorkerOnce(buildDeps(transport));

    const accepted = db
      .prepare<{ notification_type: string; status: string }, [string]>(
        "SELECT notification_type, status FROM outbound_notifications WHERE job_id = ? AND notification_type = 'job_accepted'",
      )
      .get("j-accepted");
    expect(accepted).not.toBeNull();
    expect(accepted!.notification_type).toBe("job_accepted");
    expect(accepted!.status).toBe("sent");
  });

  test("succeeded provider_run → one job_completed notification; all chunks sent; ids recorded", async () => {
    seedJob("j-ok", "hello");
    const transport = new StubOutboundTransport();
    await runWorkerOnce(buildDeps(transport));

    const notif = db
      .prepare<
        { id: string; notification_type: string; status: string; chunk_count: number },
        []
      >(
        "SELECT id, notification_type, status, chunk_count FROM outbound_notifications WHERE notification_type = 'job_completed' LIMIT 1",
      )
      .get()!;
    expect(notif.notification_type).toBe("job_completed");
    expect(notif.status).toBe("sent");
    expect(notif.chunk_count).toBe(1);

    const chunkRows = db
      .prepare<{ status: string; telegram_message_id: string | null }, [string]>(
        "SELECT status, telegram_message_id FROM outbound_notification_chunks WHERE outbound_notification_id = ?",
      )
      .all(notif.id);
    expect(chunkRows.every((c) => c.status === "sent")).toBe(true);
    expect(chunkRows.every((c) => c.telegram_message_id !== null)).toBe(true);
  });

  test("failed provider_run → one job_failed notification (chunk sends ok, parent=sent)", async () => {
    seedJob("j-fail", "triggers error");
    const transport = new StubOutboundTransport();
    await runWorkerOnce(
      buildDeps(transport, {
        adapter: createFakeAdapter({
          mode: { kind: "error", error_type: "bad_input", exit_code: 2 },
        }),
      }),
    );
    const row = db
      .prepare<
        { notification_type: string; status: string },
        []
      >("SELECT notification_type, status FROM outbound_notifications WHERE notification_type = 'job_failed' LIMIT 1")
      .get()!;
    expect(row.notification_type).toBe("job_failed");
    expect(row.status).toBe("sent");
  });

  test("transport failure does NOT roll back jobs.status or provider_runs.status", async () => {
    seedJob("j-nofail", "will send badly");
    const planText = "echo: will send badly"; // fake adapter final_text prefix
    const transport = new StubOutboundTransport({
      plan: new Map([[planText, "fail_non_retryable"]]),
    });
    await runWorkerOnce(buildDeps(transport));
    const job = db
      .prepare<{ status: string }>("SELECT status FROM jobs WHERE id='j-nofail'")
      .get()!;
    expect(job.status).toBe("succeeded");
    const prun = db
      .prepare<{ status: string }>(
        "SELECT status FROM provider_runs WHERE job_id='j-nofail'",
      )
      .get()!;
    expect(prun.status).toBe("succeeded");
  });

  test("chunk send failure enqueues a notification_retry job", async () => {
    seedJob("j-retry-enq", "hello retry");
    // Fake adapter echoes the full packed message (system_identity + user message).
    const planText = "echo: [system_identity]\nactwyn personal agent\n\nhello retry";
    const transport = new StubOutboundTransport({
      plan: new Map([[planText, "fail_once"]]),
    });
    await runWorkerOnce(buildDeps(transport));

    // A notification_retry job should be queued.
    const retryJob = db
      .prepare<{ job_type: string; status: string; request_json: string }>(
        "SELECT job_type, status, request_json FROM jobs WHERE job_type = 'notification_retry' LIMIT 1",
      )
      .get();
    expect(retryJob).not.toBeNull();
    expect(retryJob!.job_type).toBe("notification_retry");
    expect(retryJob!.status).toBe("queued");
    const req = JSON.parse(retryJob!.request_json) as { notification_id?: string };
    expect(typeof req.notification_id).toBe("string");
  });

  test("notification_retry job dispatch retries chunks and marks job succeeded", async () => {
    seedJob("j-retry-run", "retry me");
    // Fake adapter echoes the full packed message (system_identity + user message).
    const planText = "echo: [system_identity]\nactwyn personal agent\n\nretry me";
    // Fail on first attempt, succeed on second.
    const transport = new StubOutboundTransport({
      plan: new Map([[planText, "fail_once"]]),
    });
    // Run the provider job (creates notification_retry job in queue).
    await runWorkerOnce(buildDeps(transport));

    // Run again to pick up the notification_retry job.
    await runWorkerOnce(buildDeps(transport));

    const retryJob = db
      .prepare<{ status: string; result_json: string | null }>(
        "SELECT status, result_json FROM jobs WHERE job_type = 'notification_retry' LIMIT 1",
      )
      .get()!;
    expect(retryJob.status).toBe("succeeded");

    // The chunk should now be sent.
    const chunkStatus = db
      .prepare<{ status: string }>(
        `SELECT c.status FROM outbound_notification_chunks c
         JOIN outbound_notifications n ON c.outbound_notification_id = n.id
         WHERE n.job_id = 'j-retry-run'
         ORDER BY c.chunk_index ASC LIMIT 1`,
      )
      .get()!;
    expect(chunkStatus.status).toBe("sent");
  });
});
