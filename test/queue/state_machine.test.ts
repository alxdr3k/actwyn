import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase, type DbHandle } from "../../src/db.ts";
import { migrate } from "../../src/db/migrator.ts";
import { createEmitter } from "../../src/observability/events.ts";
import { createRedactor } from "../../src/observability/redact.ts";
import { createFakeAdapter } from "../../src/providers/fake.ts";
import { runWorkerOnce, type WorkerDeps } from "../../src/queue/worker.ts";
import { StubS3Transport } from "../../src/storage/s3.ts";
import type { MimeProbe, TelegramFileTransport } from "../../src/telegram/attachment_capture.ts";

const MIGRATIONS = join(import.meta.dir, "..", "..", "migrations");

let workdir: string;
let db: DbHandle;

const noopTransport: TelegramFileTransport = {
  async getFile() {
    throw new Error("transport should not be called when no attachments");
  },
  async download() {
    throw new Error("transport should not be called when no attachments");
  },
};
const noopMime: MimeProbe = { async probe() { return "application/octet-stream"; } };

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "actwyn-sm-"));
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

function deps(overrides: Partial<WorkerDeps> = {}): WorkerDeps {
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
    transport: noopTransport,
    mime: noopMime,
    newId: () => `gen-${(++n).toString().padStart(5, "0")}`,
    now: () => new Date("2026-04-23T00:00:00.000Z"),
    config: { capture: { max_download_size_bytes: 20 * 1024 * 1024, local_path: (id) => `${workdir}/objects/${id}` } },
    ...overrides,
  };
}

function seedProviderJob(id: string, ikey: string, message = "hello"): void {
  db.prepare<unknown, [string, string, string, string]>(
    `INSERT INTO jobs
       (id, status, job_type, session_id, user_id, chat_id, request_json, idempotency_key, provider)
     VALUES(?, 'queued', 'provider_run', ?, 'user-1', 'chat-1', ?, ?, 'fake')`,
  ).run(id, "sess-1", JSON.stringify({ text: message, command: null, args: "" }), ikey);
}

function row<T>(sql: string, params: readonly string[] = []): T {
  const stmt = db.prepare<T, string[]>(sql);
  return stmt.get(...(params as string[])) as T;
}

describe("state machine — queued → running → succeeded (fake adapter)", () => {
  test("full happy path produces an assistant turn + succeeded job + provider_run", async () => {
    seedProviderJob("j-ok", "k-ok", "hello");
    const result = await runWorkerOnce(deps());
    expect(result?.terminal).toBe("succeeded");

    const job = row<{ status: string; result_json: string | null }>(
      "SELECT status, result_json FROM jobs WHERE id = ?",
      ["j-ok"],
    );
    expect(job.status).toBe("succeeded");
    expect(job.result_json).toContain("parsed");

    const prun = row<{ status: string; parser_status: string }>(
      "SELECT status, parser_status FROM provider_runs WHERE job_id = ?",
      ["j-ok"],
    );
    expect(prun.status).toBe("succeeded");
    expect(prun.parser_status).toBe("parsed");

    const turn = row<{ role: string; content_redacted: string }>(
      "SELECT role, content_redacted FROM turns WHERE job_id = ?",
      ["j-ok"],
    );
    expect(turn.role).toBe("assistant");
    expect(turn.content_redacted).toContain("echo: hello");
  });
});

describe("state machine — queued → running → failed", () => {
  test("fake adapter error: job.status=failed, error_json set, provider_run.status=failed", async () => {
    seedProviderJob("j-err", "k-err");
    const result = await runWorkerOnce(
      deps({
        adapter: createFakeAdapter({
          mode: { kind: "error", error_type: "bad_input", exit_code: 2, stderr: "stderr blurb" },
        }),
      }),
    );
    expect(result?.terminal).toBe("failed");

    const job = row<{ status: string; error_json: string | null }>(
      "SELECT status, error_json FROM jobs WHERE id = ?",
      ["j-err"],
    );
    expect(job.status).toBe("failed");
    expect(job.error_json).toContain("bad_input");

    const prun = row<{ status: string; error_type: string | null }>(
      "SELECT status, error_type FROM provider_runs WHERE job_id = ?",
      ["j-err"],
    );
    expect(prun.status).toBe("failed");
    expect(prun.error_type).toBe("bad_input");

    // No assistant turn on failure.
    const turnCount =
      db.prepare<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM turns WHERE job_id = ?").get("j-err")?.n ?? 0;
    expect(turnCount).toBe(0);
  });
});

describe("state machine — queued → running → cancelled", () => {
  test("cancel signal mid-run: terminal=cancelled, no assistant turn, provider_run.status=cancelled", async () => {
    seedProviderJob("j-can", "k-can");
    const controller = new AbortController();
    const adapter = createFakeAdapter({ mode: { kind: "cancel_on_signal" } });
    const promise = runWorkerOnce(deps({ adapter }), controller.signal);
    // Signal shortly after to let the adapter start.
    setTimeout(() => controller.abort(), 5);
    const result = await promise;
    expect(result?.terminal).toBe("cancelled");

    const job = row<{ status: string }>(
      "SELECT status FROM jobs WHERE id = ?",
      ["j-can"],
    );
    expect(job.status).toBe("cancelled");

    const prun = row<{ status: string }>(
      "SELECT status FROM provider_runs WHERE job_id = ?",
      ["j-can"],
    );
    expect(prun.status).toBe("cancelled");
  });
});

describe("state machine — concurrency invariant", () => {
  test("only one provider_run job in `running` at a time", async () => {
    seedProviderJob("j-a", "k-a", "a");
    seedProviderJob("j-b", "k-b", "b");
    seedProviderJob("j-c", "k-c", "c");

    // Run workers serially (Phase 4 is concurrency=1); while the
    // adapter is executing we inspect the DB to ensure only one is
    // `running`.
    const d = deps({
      adapter: createFakeAdapter({
        mode: { kind: "ok" },
      }),
    });
    const observedRunning: number[] = [];
    async function tick(): Promise<void> {
      const result = await runWorkerOnce(d);
      expect(result).not.toBeNull();
      const running =
        db
          .prepare<{ n: number }>(
            "SELECT COUNT(*) AS n FROM jobs WHERE status = 'running'",
          )
          .get()?.n ?? 0;
      observedRunning.push(running);
    }
    await tick();
    await tick();
    await tick();
    for (const r of observedRunning) expect(r).toBeLessThanOrEqual(1);

    const terminal = db
      .prepare<{ n: number }>(
        "SELECT COUNT(*) AS n FROM jobs WHERE status IN ('succeeded','failed','cancelled')",
      )
      .get()?.n ?? 0;
    expect(terminal).toBe(3);
  });
});

describe("provider_raw_events are redacted at rest", () => {
  test("bearer token in the adapter's event payload is [REDACTED] before insert", async () => {
    seedProviderJob("j-rd", "k-rd", "give me Bearer abcdef1234567890XYZ");
    await runWorkerOnce(deps());
    const rows = db
      .prepare<{ redacted_payload: string; redaction_applied: number }, [string]>(
        `SELECT redacted_payload, redaction_applied
         FROM provider_raw_events
         WHERE provider_run_id = (SELECT id FROM provider_runs WHERE job_id = ?)`,
      )
      .all("j-rd");
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.redaction_applied).toBe(1);
      expect(r.redacted_payload).not.toContain("abcdef1234567890XYZ");
    }
  });
});

// ---------------------------------------------------------------
// /end command: summary_generation job marks session ended
// ---------------------------------------------------------------

describe("/end: summary_generation job marks session ended on success", () => {
  test("session.status flips to 'ended' after the /end summary_generation job succeeds", async () => {
    db.prepare<unknown, [string, string, string, string]>(
      `INSERT INTO jobs
         (id, status, job_type, session_id, user_id, chat_id, request_json, idempotency_key, provider)
       VALUES(?, 'queued', 'summary_generation', ?, 'user-1', 'chat-1', ?, ?, 'fake')`,
    ).run(
      "j-end",
      "sess-1",
      JSON.stringify({ command: "/end", args: "", text: "", has_attachments: false }),
      "telegram:end-test",
    );

    await runWorkerOnce(deps());

    const job = db
      .prepare<{ status: string }, [string]>("SELECT status FROM jobs WHERE id = ?")
      .get("j-end")!;
    expect(job.status).toBe("succeeded");

    const sess = db
      .prepare<{ status: string }>("SELECT status FROM sessions WHERE id = 'sess-1'")
      .get()!;
    expect(sess.status).toBe("ended");
  });
});

// ---------------------------------------------------------------
// Context snapshot stored in provider_runs.injected_snapshot_json
// ---------------------------------------------------------------

describe("context snapshot — injected_snapshot_json contains packed context", () => {
  test("injected_snapshot_json includes mode and slots from context builder", async () => {
    seedProviderJob("j-snap", "k-snap", "what is 2+2?");
    await runWorkerOnce(deps());

    const prun = db
      .prepare<{ injected_snapshot_json: string }, [string]>(
        "SELECT injected_snapshot_json FROM provider_runs WHERE job_id = ?",
      )
      .get("j-snap")!;
    const snap = JSON.parse(prun.injected_snapshot_json) as { mode?: string; slots?: unknown[] };
    expect(snap.mode).toBe("replay_mode");
    expect(Array.isArray(snap.slots)).toBe(true);
  });
});

// ---------------------------------------------------------------
// storage_sync job dispatch
// ---------------------------------------------------------------

describe("storage_sync job dispatch — uploads pending storage_objects when s3 wired", () => {
  test("storage_sync job triggers upload pass and marks job succeeded", async () => {
    const objectId = "so-sync-1";
    const objectKey = `objects/2026/04/23/${objectId}/deadbeef.bin`;
    const bytes = new Uint8Array([1, 2, 3]);
    const localDir = join(workdir, "objects");
    mkdirSync(localDir, { recursive: true });
    writeFileSync(join(localDir, objectId), bytes);

    db.prepare<unknown, [string, string]>(
      `INSERT INTO storage_objects
         (id, storage_backend, bucket, storage_key, source_channel, source_message_id,
          source_job_id, artifact_type, retention_class, capture_status, status, sha256)
       VALUES(?, 's3', 'test-bucket', ?, 'system', '0', NULL, 'user_upload', 'long_term', 'captured', 'pending', 'deadbeef')`,
    ).run(objectId, objectKey);

    db.prepare<unknown, [string, string, string]>(
      `INSERT INTO jobs
         (id, status, job_type, request_json, idempotency_key)
       VALUES(?, 'queued', 'storage_sync', ?, ?)`,
    ).run(
      "j-sync-1",
      JSON.stringify({ storage_object_id: objectId }),
      `sync:${objectId}`,
    );

    const stubTransport = new StubS3Transport();
    const syncDeps = deps({
      s3: stubTransport,
      config: {
        capture: { max_download_size_bytes: 20 * 1024 * 1024, local_path: (id) => join(localDir, id) },
        sync: { max_attempts: 3, local_path: (id) => join(localDir, id) },
      },
    });
    await runWorkerOnce(syncDeps);

    const job = db
      .prepare<{ status: string; result_json: string | null }, [string]>(
        "SELECT status, result_json FROM jobs WHERE id = ?",
      )
      .get("j-sync-1")!;
    expect(job.status).toBe("succeeded");
    expect(job.result_json).toContain("uploaded");

    const so = db
      .prepare<{ status: string }, [string]>(
        "SELECT status FROM storage_objects WHERE id = ?",
      )
      .get(objectId)!;
    expect(so.status).toBe("uploaded");
    expect(stubTransport.store.size).toBe(1);
  });

  test("storage_sync without s3 dep → noop (succeeds without uploading)", async () => {
    db.prepare<unknown, []>(
      `INSERT INTO jobs
         (id, status, job_type, request_json, idempotency_key)
       VALUES('j-sync-noop', 'queued', 'storage_sync', '{}', 'sync:noop')`,
    ).run();

    await runWorkerOnce(deps());

    const job = db
      .prepare<{ status: string; result_json: string | null }, [string]>(
        "SELECT status, result_json FROM jobs WHERE id = ?",
      )
      .get("j-sync-noop")!;
    expect(job.status).toBe("succeeded");
    expect(job.result_json).toContain("noop");
  });
});

// ---------------------------------------------------------------
// System command dispatch — worker handles /status locally
// ---------------------------------------------------------------

describe("system command dispatch — /status handled locally by worker", () => {
  test("/status command produces succeeded job and a turn with queue info", async () => {
    db.prepare<unknown, [string, string, string, string]>(
      `INSERT INTO jobs
         (id, status, job_type, session_id, user_id, chat_id, request_json, idempotency_key, provider)
       VALUES(?, 'queued', 'provider_run', ?, 'user-1', 'chat-1', ?, ?, 'claude')`,
    ).run(
      "j-status",
      "sess-1",
      JSON.stringify({ command: "/status", args: "", text: "", has_attachments: false }),
      "telegram:status-test",
    );

    const result = await runWorkerOnce(deps());
    expect(result?.terminal).toBe("succeeded");

    const job = db
      .prepare<{ status: string; result_json: string | null }, [string]>(
        "SELECT status, result_json FROM jobs WHERE id = ?",
      )
      .get("j-status")!;
    expect(job.status).toBe("succeeded");

    // A turn should be created with the status response.
    const turn = db
      .prepare<{ role: string; content_redacted: string }, [string]>(
        "SELECT role, content_redacted FROM turns WHERE job_id = ?",
      )
      .get("j-status");
    expect(turn).not.toBeNull();
    expect(turn!.role).toBe("assistant");
    expect(turn!.content_redacted).toContain("queue:");
  });
});

// ---------------------------------------------------------------
// Auto-trigger summary (AC-MEM-005 / PRD §12.3 DEC-019)
// ---------------------------------------------------------------

describe("auto-trigger summary — enqueues summary_generation after threshold", () => {
  test("20 turns (10 user) since last summary → auto summary_generation job created", async () => {
    // Insert 20 turns directly (10 user, 10 assistant) to simulate long conversation.
    for (let i = 0; i < 10; i++) {
      db.prepare<unknown, []>(
        `INSERT INTO turns(id, session_id, job_id, role, content_redacted, redaction_applied)
         VALUES('turn-u-${i}', 'sess-1', NULL, 'user', 'message', 0)`,
      ).run();
      db.prepare<unknown, []>(
        `INSERT INTO turns(id, session_id, job_id, role, content_redacted, redaction_applied)
         VALUES('turn-a-${i}', 'sess-1', NULL, 'assistant', 'reply', 0)`,
      ).run();
    }

    // Now run a provider_run job that succeeds — should trigger auto-summary.
    seedProviderJob("j-auto-sum", "k-auto-sum", "trigger check");
    await runWorkerOnce(deps());

    // A summary_generation job should have been enqueued.
    const sumJob = db
      .prepare<{ job_type: string; status: string }>(
        "SELECT job_type, status FROM jobs WHERE job_type = 'summary_generation' LIMIT 1",
      )
      .get();
    expect(sumJob).not.toBeNull();
    expect(sumJob!.job_type).toBe("summary_generation");
    expect(sumJob!.status).toBe("queued");
  });
});
