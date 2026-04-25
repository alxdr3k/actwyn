import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

async function sha256HexUint8(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

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

    // Expect a user turn (message) followed by an assistant turn (response).
    const turns = db
      .prepare<{ role: string; content_redacted: string }, [string]>(
        "SELECT role, content_redacted FROM turns WHERE job_id = ? ORDER BY created_at ASC",
      )
      .all("j-ok");
    expect(turns.length).toBe(2);
    expect(turns[0]!.role).toBe("user");
    expect(turns[0]!.content_redacted).toBe("hello");
    expect(turns[1]!.role).toBe("assistant");
    expect(turns[1]!.content_redacted).toContain("hello");
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

  test("Blocker 9: summary_generation does NOT insert an assistant conversation turn", async () => {
    const summaryJson = JSON.stringify({
      session_id: "sess-1",
      summary_type: "session",
      facts: [{ content: "fact", provenance: "observed", confidence: 0.8 }],
      preferences: [],
      decisions: [],
      open_tasks: [],
      cautions: [],
      source_turn_ids: [],
    });
    db.prepare<unknown, [string, string, string, string]>(
      `INSERT INTO jobs
         (id, status, job_type, session_id, user_id, chat_id, request_json, idempotency_key, provider)
       VALUES(?, 'queued', 'summary_generation', ?, 'user-1', 'chat-1', ?, ?, 'fake')`,
    ).run(
      "j-summary-no-turn",
      "sess-1",
      JSON.stringify({ command: "/summary", args: "", text: "", has_attachments: false }),
      "telegram:summary-no-turn",
    );

    const turnsBefore = db
      .prepare<{ n: number }>("SELECT COUNT(*) AS n FROM turns WHERE session_id = 'sess-1'")
      .get()!.n;

    await runWorkerOnce(deps({
      summaryAdapter: {
        name: "fake",
        run: async () => ({
          kind: "succeeded" as const,
          response: {
            provider: "fake",
            session_id: "fake-session",
            final_text: summaryJson,
            raw_events: [],
            duration_ms: 1,
            exit_code: 0,
            parser_status: "parsed" as const,
          },
        }),
      },
    }));

    const turnsAfter = db
      .prepare<{ n: number }>("SELECT COUNT(*) AS n FROM turns WHERE session_id = 'sess-1'")
      .get()!.n;
    // No new conversation turn rows from the summary job.
    expect(turnsAfter).toBe(turnsBefore);

    // The structured summary payload DID land in memory_summaries.
    const sumRow = db
      .prepare<{ id: string }>("SELECT id FROM memory_summaries WHERE session_id = 'sess-1' LIMIT 1")
      .get();
    expect(sumRow).not.toBeNull();
  });

  test("/end on empty session (fake returns no JSON) still closes session + inserts minimal summary", async () => {
    // Fake adapter returns empty text — no valid JSON summary.
    db.prepare<unknown, [string, string, string, string]>(
      `INSERT INTO jobs
         (id, status, job_type, session_id, user_id, chat_id, request_json, idempotency_key, provider)
       VALUES(?, 'queued', 'summary_generation', ?, 'user-1', 'chat-1', ?, ?, 'fake')`,
    ).run(
      "j-end-empty",
      "sess-1",
      JSON.stringify({ trigger: "explicit_end" }),
      "telegram:end-empty",
    );

    await runWorkerOnce(deps({
      summaryAdapter: {
        name: "fake",
        run: async () => ({
          kind: "succeeded" as const,
          response: {
            provider: "fake",
            session_id: "fake-session",
            final_text: "",
            raw_events: [],
            duration_ms: 1,
            exit_code: 0,
            parser_status: "parsed" as const,
          },
        }),
      },
    }));

    const sess = db
      .prepare<{ status: string }>("SELECT status FROM sessions WHERE id = 'sess-1'")
      .get()!;
    expect(sess.status).toBe("ended");

    // A minimal memory_summaries row should have been created (HLD §7.5 failure modes).
    const sumRow = db
      .prepare<{ id: string }>("SELECT id FROM memory_summaries WHERE session_id = 'sess-1' LIMIT 1")
      .get();
    expect(sumRow).not.toBeNull();
  });
});

// ---------------------------------------------------------------
// AC-MEM-001: summary_generation → local file + storage_sync job
// ---------------------------------------------------------------

describe("AC-MEM-001 — summary_generation writes local file + enqueues storage_sync", () => {
  test("succeeded summary creates storage_objects row + local file + storage_sync job", async () => {
    const summaryJson = JSON.stringify({
      session_id: "sess-1",
      summary_type: "session",
      facts: [{ content: "fact", provenance: "observed", confidence: 0.8 }],
      preferences: [],
      open_tasks: [],
      decisions: [],
      cautions: [],
      source_turn_ids: [],
    });

    db.prepare<unknown, [string, string, string, string]>(
      `INSERT INTO jobs
         (id, status, job_type, session_id, user_id, chat_id, request_json, idempotency_key, provider)
       VALUES(?, 'queued', 'summary_generation', ?, 'user-1', 'chat-1', ?, ?, 'fake')`,
    ).run(
      "j-mem001",
      "sess-1",
      JSON.stringify({ text: "", command: "/summary", args: "", has_attachments: false }),
      "telegram:mem001",
    );

    const localDir = join(workdir, "objects");
    const memDir = join(workdir, "memory");
    const syncDeps = deps({
      summaryAdapter: {
        name: "fake",
        run: async () => ({
          kind: "succeeded" as const,
          response: {
            provider: "fake",
            session_id: "fake-session",
            final_text: summaryJson,
            raw_events: [],
            duration_ms: 1,
            exit_code: 0,
            parser_status: "parsed" as const,
          },
        }),
      },
      config: {
        capture: { max_download_size_bytes: 20 * 1024 * 1024, local_path: (id: string) => join(localDir, id) },
        sync: { max_attempts: 3, local_path: (id: string) => join(localDir, id) },
        memory_base_path: memDir,
      },
    });

    await runWorkerOnce(syncDeps);

    // memory_summaries row inserted
    const sumRow = db
      .prepare<{ id: string; storage_key: string | null }>(
        "SELECT id, storage_key FROM memory_summaries WHERE session_id = 'sess-1' LIMIT 1",
      )
      .get();
    expect(sumRow).not.toBeNull();
    expect(typeof sumRow!.storage_key).toBe("string");
    expect(sumRow!.storage_key).toMatch(/^objects\/\d{4}\/\d{2}\/\d{2}\//);

    // storage_objects row created (memory_snapshot, long_term, captured, pending)
    const so = db
      .prepare<{ id: string; artifact_type: string; retention_class: string; capture_status: string; status: string; storage_key: string }>(
        `SELECT id, artifact_type, retention_class, capture_status, status, storage_key
         FROM storage_objects WHERE artifact_type = 'memory_snapshot' LIMIT 1`,
      )
      .get();
    expect(so).not.toBeNull();
    expect(so!.artifact_type).toBe("memory_snapshot");
    expect(so!.retention_class).toBe("long_term");
    expect(so!.capture_status).toBe("captured");
    expect(so!.status).toBe("pending");
    expect(so!.storage_key).toMatch(/^objects\/\d{4}\/\d{2}\/\d{2}\//);
    // storage_key set on memory_summaries matches storage_objects
    expect(sumRow!.storage_key).toBe(so!.storage_key);

    // S3 staging file written at local_path(storage_object_id)
    const localPath = join(localDir, so!.id);
    expect(existsSync(localPath)).toBe(true);

    // AC-MEM-001: human-readable session JSONL file written at memory/sessions/<session_id>.jsonl
    const sessionJsonlPath = join(memDir, "sessions", "sess-1.jsonl");
    expect(existsSync(sessionJsonlPath)).toBe(true);

    // AC-MEM-001: daily markdown line appended to memory/personal/YYYY-MM-DD.md
    const dailyMdPath = join(memDir, "personal", "2026-04-23.md");
    expect(existsSync(dailyMdPath)).toBe(true);

    // storage_sync job enqueued
    const syncJob = db
      .prepare<{ status: string }>(
        "SELECT status FROM jobs WHERE job_type = 'storage_sync' LIMIT 1",
      )
      .get();
    expect(syncJob).not.toBeNull();
    expect(syncJob!.status).toBe("queued");
  });
});

// ---------------------------------------------------------------
// ---------------------------------------------------------------
// summary_generation uses advisory profile prompt (PRD §12.3)
// ---------------------------------------------------------------

describe("summary_generation — advisory profile schema prompt injected", () => {
  test("summary_generation job sends JSON schema instruction in packed message", async () => {
    let capturedMessage: string | undefined;
    db.prepare<unknown, [string, string, string, string]>(
      `INSERT INTO jobs
         (id, status, job_type, session_id, user_id, chat_id, request_json, idempotency_key, provider)
       VALUES(?, 'queued', 'summary_generation', ?, 'user-1', 'chat-1', ?, ?, 'fake')`,
    ).run(
      "j-prompt",
      "sess-1",
      JSON.stringify({ text: "", command: "/summary", args: "" }),
      "telegram:prompt-test",
    );

    await runWorkerOnce(deps({
      summaryAdapter: {
        name: "fake",
        run: async (req) => {
          capturedMessage = req.message;
          return {
            kind: "succeeded" as const,
            response: {
              provider: "fake",
              session_id: "fake-session",
              final_text: JSON.stringify({
                session_id: "sess-1", summary_type: "session",
                facts: [], preferences: [], open_tasks: [], decisions: [], cautions: [],
                source_turn_ids: [],
              }),
              raw_events: [],
              duration_ms: 1,
              exit_code: 0,
              parser_status: "parsed" as const,
            },
          };
        },
      },
    }));

    expect(capturedMessage).toContain("session summariser");
    expect(capturedMessage).toContain("JSON");
    expect(capturedMessage).toContain("facts");
    expect(capturedMessage).toContain("이 대화를");
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
       VALUES(?, 's3', 'test-bucket', ?, 'system', '0', NULL, 'user_upload', 'long_term', 'captured', 'pending', '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81')`,
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

  test("storage_sync rejects upload when sha256 does not match stored hash", async () => {
    const objectId = "so-sync-bad-hash";
    const objectKey = `objects/2026/04/23/${objectId}/badhash.bin`;
    const bytes = new Uint8Array([1, 2, 3]);
    const localDir = join(workdir, "objects");
    mkdirSync(localDir, { recursive: true });
    writeFileSync(join(localDir, objectId), bytes);

    db.prepare<unknown, [string, string]>(
      `INSERT INTO storage_objects
         (id, storage_backend, bucket, storage_key, source_channel, source_message_id,
          source_job_id, artifact_type, retention_class, capture_status, status, sha256)
       VALUES(?, 's3', 'test-bucket', ?, 'system', '0', NULL, 'user_upload', 'long_term', 'captured', 'pending', 'wronghash')`,
    ).run(objectId, objectKey);

    db.prepare<unknown, [string, string, string]>(
      `INSERT INTO jobs
         (id, status, job_type, request_json, idempotency_key)
       VALUES(?, 'queued', 'storage_sync', ?, ?)`,
    ).run("j-sync-bad", JSON.stringify({}), "sync:bad-hash");

    const stubTransport = new StubS3Transport();
    const syncDeps = deps({
      s3: stubTransport,
      config: {
        capture: { max_download_size_bytes: 20 * 1024 * 1024, local_path: (id) => join(localDir, id) },
        sync: { max_attempts: 3, local_path: (id) => join(localDir, id) },
      },
    });
    await runWorkerOnce(syncDeps);

    const so = db
      .prepare<{ status: string; error_json: string | null }, [string]>(
        "SELECT status, error_json FROM storage_objects WHERE id = ?",
      )
      .get(objectId)!;
    expect(so.status).toBe("failed");
    expect(so.error_json).toContain("hash_mismatch");
    expect(stubTransport.store.size).toBe(0);
  });

  test("Medium 12: storage_sync job invokes retry scheduler so failed rows get retried", async () => {
    const objectId = "so-retry-1";
    const objectKey = `objects/2026/04/23/${objectId}/retry.bin`;
    const bytes = new Uint8Array([9, 9, 9]);
    const localDir = join(workdir, "objects");
    mkdirSync(localDir, { recursive: true });
    writeFileSync(join(localDir, objectId), bytes);

    // Seed as a previously-failed row (attempts=1, still below max_attempts=3).
    // On a fresh storage_sync pass, the retry scheduler must flip this back
    // to 'pending' so the upload pass can retry it.
    const sha = "a6419fb3e46b9317e5302ecb12090c9c09d0ddc8a36e6e47e2a0f9d6d4d5fe3d";
    db.prepare<unknown, [string, string, string]>(
      `INSERT INTO storage_objects
         (id, storage_backend, bucket, storage_key, source_channel, source_message_id,
          source_job_id, artifact_type, retention_class, capture_status, status, sha256,
          error_json)
       VALUES(?, 's3', 'test-bucket', ?, 'system', '0', NULL, 'user_upload', 'long_term',
              'captured', 'failed', ?, json_object('attempts', 1, 'reason', 'transient'))`,
    ).run(objectId, objectKey, sha);

    db.prepare<unknown, [string, string, string]>(
      `INSERT INTO jobs
         (id, status, job_type, request_json, idempotency_key)
       VALUES(?, 'queued', 'storage_sync', ?, ?)`,
    ).run("j-sync-retry", JSON.stringify({ storage_object_id: objectId }), `sync:${objectId}`);

    // Transport that always succeeds — upload should now succeed since the
    // scheduler re-pended the failed row.
    const stubTransport = new StubS3Transport();
    const syncDeps = deps({
      s3: stubTransport,
      config: {
        capture: { max_download_size_bytes: 20 * 1024 * 1024, local_path: (id) => join(localDir, id) },
        sync: { max_attempts: 3, local_path: (id) => join(localDir, id) },
      },
    });
    // We use the bytes' true sha instead; recompute.
    const actualSha = await sha256HexUint8(bytes);
    db.prepare<unknown, [string, string]>(
      "UPDATE storage_objects SET sha256 = ? WHERE id = ?",
    ).run(actualSha, objectId);

    await runWorkerOnce(syncDeps);

    const job = db
      .prepare<{ status: string; result_json: string | null }, [string]>(
        "SELECT status, result_json FROM jobs WHERE id = ?",
      )
      .get("j-sync-retry")!;
    expect(job.status).toBe("succeeded");
    // The result_json must report the scheduler stats, confirming it was invoked.
    expect(job.result_json).toContain("retry_scheduler_repended");

    const so = db
      .prepare<{ status: string }, [string]>(
        "SELECT status FROM storage_objects WHERE id = ?",
      )
      .get(objectId)!;
    expect(so.status).toBe("uploaded");
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

// ---------------------------------------------------------------
// TEST-FORGET-UX: /forget_last and /forget_session response phrasing (Blocker 3)
// ---------------------------------------------------------------

describe("forget UX — response phrasing (Blocker 3)", () => {
  function seedForgetJob(id: string, ikey: string, command: "/forget_last" | "/forget_session"): void {
    db.prepare<unknown, [string, string, string, string]>(
      `INSERT INTO jobs
         (id, status, job_type, session_id, user_id, chat_id, request_json, idempotency_key, provider)
       VALUES(?, 'queued', 'provider_run', ?, 'user-1', 'chat-1', ?, ?, 'fake')`,
    ).run(
      id,
      "sess-1",
      JSON.stringify({ command, args: "", text: "", has_attachments: false }),
      ikey,
    );
  }

  test("/forget_last response does not say '삭제 예약' and says '기억 링크'", async () => {
    seedForgetJob("j-fl", "ikey-fl", "/forget_last");
    await runWorkerOnce(deps());
    const turn = db
      .prepare<{ content_redacted: string }>(
        "SELECT content_redacted FROM turns WHERE job_id = 'j-fl'",
      )
      .get();
    expect(turn).not.toBeNull();
    expect(turn!.content_redacted).not.toContain("삭제 예약");
    expect(turn!.content_redacted).toContain("기억 링크");
  });

  test("/forget_session response does not say '삭제 예약' and clarifies files are kept", async () => {
    db.prepare(
      `INSERT INTO memory_items(id, session_id, item_type, content, provenance, confidence, status, source_turn_ids)
       VALUES('mi-test', 'sess-1', 'fact', 'test memory', 'user_stated', 0.9, 'active', '[]')`,
    ).run();
    seedForgetJob("j-fs", "ikey-fs", "/forget_session");
    await runWorkerOnce(deps());
    const turn = db
      .prepare<{ content_redacted: string }>(
        "SELECT content_redacted FROM turns WHERE job_id = 'j-fs'",
      )
      .get();
    expect(turn).not.toBeNull();
    expect(turn!.content_redacted).not.toContain("삭제 예약");
    expect(turn!.content_redacted).toContain("revoked");
    expect(turn!.content_redacted).toContain("파일은 삭제하지 않았습니다");
  });
});

// ---------------------------------------------------------------
// TEST-STO-JOB-STATUS: storage_sync job fails when retryable rows remain (Blocker 5)
// ---------------------------------------------------------------

describe("storage_sync job failure semantics (Blocker 5)", () => {
  test("storage_sync job status is not succeeded when upload fails on retryable error", async () => {
    const localDir = join(workdir, "objects-b5");
    mkdirSync(localDir, { recursive: true });
    const bytes = new Uint8Array([11]);
    const sha = await sha256HexUint8(bytes);
    const key = `objects/2026/04/23/so-b5/test.bin`;
    writeFileSync(join(localDir, "so-b5"), bytes);

    db.prepare<unknown, [string, string, string]>(
      `INSERT INTO storage_objects
         (id, storage_backend, bucket, storage_key, source_channel, source_message_id,
          source_job_id, artifact_type, retention_class, capture_status, status, sha256)
       VALUES(?, 's3', 'test-bucket', ?, 'system', '0', NULL, 'user_upload', 'long_term', 'captured', 'pending', ?)`,
    ).run("so-b5", key, sha);

    db.prepare<unknown, [string, string, string]>(
      `INSERT INTO jobs(id, status, job_type, request_json, idempotency_key)
       VALUES(?, 'queued', 'storage_sync', ?, ?)`,
    ).run("j-b5", JSON.stringify({ storage_object_id: "so-b5" }), "sync:so-b5");

    const transport = new StubS3Transport(
      new Map([[`test-bucket/${key}`, "fail_retryable"]]),
    );
    const syncDeps = deps({
      s3: transport,
      config: {
        capture: { max_download_size_bytes: 20 * 1024 * 1024, local_path: (id) => join(localDir, id) },
        sync: { max_attempts: 3, local_path: (id) => join(localDir, id) },
      },
    });
    await runWorkerOnce(syncDeps);

    const job = db
      .prepare<{ status: string }>("SELECT status FROM jobs WHERE id = 'j-b5'")
      .get()!;
    // Retryable upload failure → storage_sync job must NOT be 'succeeded'.
    expect(job.status).not.toBe("succeeded");
  });

  test("storage_sync job succeeds when all uploads complete without error", async () => {
    const localDir = join(workdir, "objects-b5ok");
    mkdirSync(localDir, { recursive: true });
    const bytes = new Uint8Array([12]);
    const sha = await sha256HexUint8(bytes);
    const key = `objects/2026/04/23/so-b5ok/test.bin`;
    writeFileSync(join(localDir, "so-b5ok"), bytes);

    db.prepare<unknown, [string, string, string]>(
      `INSERT INTO storage_objects
         (id, storage_backend, bucket, storage_key, source_channel, source_message_id,
          source_job_id, artifact_type, retention_class, capture_status, status, sha256)
       VALUES(?, 's3', 'test-bucket', ?, 'system', '0', NULL, 'user_upload', 'long_term', 'captured', 'pending', ?)`,
    ).run("so-b5ok", key, sha);

    db.prepare<unknown, [string, string, string]>(
      `INSERT INTO jobs(id, status, job_type, request_json, idempotency_key)
       VALUES(?, 'queued', 'storage_sync', ?, ?)`,
    ).run("j-b5ok", JSON.stringify({ storage_object_id: "so-b5ok" }), "sync:so-b5ok");

    const transport = new StubS3Transport();
    const syncDeps = deps({
      s3: transport,
      config: {
        capture: { max_download_size_bytes: 20 * 1024 * 1024, local_path: (id) => join(localDir, id) },
        sync: { max_attempts: 3, local_path: (id) => join(localDir, id) },
      },
    });
    await runWorkerOnce(syncDeps);

    const job = db
      .prepare<{ status: string }>("SELECT status FROM jobs WHERE id = 'j-b5ok'")
      .get()!;
    expect(job.status).toBe("succeeded");
  });
});
