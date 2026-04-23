// AC-STO-003b — Telegram attachment byte capture (worker pre-step).
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase, type DbHandle } from "../../src/db.ts";
import { migrate } from "../../src/db/migrator.ts";
import { createEmitter } from "../../src/observability/events.ts";
import { createRedactor } from "../../src/observability/redact.ts";
import { createFakeAdapter } from "../../src/providers/fake.ts";
import { runWorkerOnce, type WorkerDeps } from "../../src/queue/worker.ts";
import {
  captureOne,
  classifyFailure,
  sha256Hex,
  type MimeProbe,
  type TelegramFileTransport,
} from "../../src/telegram/attachment_capture.ts";

const MIGRATIONS = join(import.meta.dir, "..", "..", "migrations");

let workdir: string;
let objectsDir: string;
let db: DbHandle;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "actwyn-capture-"));
  objectsDir = join(workdir, "objects");
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

function seedJobWithAttachment(args: {
  jobId: string;
  objectId: string;
  file_id: string;
  claimed_size_bytes?: number;
  retention_class?: "session" | "long_term";
}): void {
  db.prepare<unknown, [string, string, string]>(
    `INSERT INTO jobs
       (id, status, job_type, session_id, user_id, chat_id, request_json, idempotency_key, provider)
     VALUES(?, 'queued', 'provider_run', ?, 'user-1', 'chat-1', '{"text":"with photo"}', ?, 'fake')`,
  ).run(args.jobId, "sess-1", `ikey-${args.jobId}`);

  db.prepare<unknown, [string, string, string, string, string]>(
    `INSERT INTO storage_objects
       (id, storage_backend, bucket, storage_key, source_channel, source_message_id,
        source_job_id, source_external_id, artifact_type, retention_class,
        capture_status, status)
     VALUES(?, 's3', 'bucket', ?, 'telegram', '100', ?, ?, 'user_upload', ?, 'pending', 'pending')`,
  ).run(
    args.objectId,
    `users/user-1/objects/${args.objectId}/original.document`,
    args.jobId,
    args.file_id,
    args.retention_class ?? "session",
  );
}

function successTransport(bytes: Uint8Array, size?: number): TelegramFileTransport {
  const handle = {
    file_id: "",
    file_path: "documents/file.pdf",
    file_size: size ?? bytes.byteLength,
  };
  return {
    async getFile(file_id: string) {
      return { ...handle, file_id };
    },
    async download() {
      return bytes;
    },
  };
}

const pdfMime: MimeProbe = { async probe() { return "application/pdf"; } };

function buildDeps(overrides: Partial<WorkerDeps> = {}): WorkerDeps {
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
    mime: pdfMime,
    newId: () => `gen-${(++n).toString().padStart(5, "0")}`,
    now: () => new Date("2026-04-23T00:00:00.000Z"),
    config: {
      capture: {
        max_download_size_bytes: 10 * 1024 * 1024,
        local_path: (id) => join(objectsDir, `${id}.bin`),
      },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------
// classifyFailure — P0 retry policy
// ---------------------------------------------------------------

describe("classifyFailure", () => {
  test("get_file_failed is retryable (network-ish)", () => {
    expect(classifyFailure("get_file_failed")).toBe("retryable");
  });
  test("download_failed is retryable", () => {
    expect(classifyFailure("download_failed")).toBe("retryable");
  });
  test("oversize_at_download is non_retryable", () => {
    expect(classifyFailure("oversize_at_download")).toBe("non_retryable");
  });
  test("mime_probe_failed is non_retryable", () => {
    expect(classifyFailure("mime_probe_failed")).toBe("non_retryable");
  });
});

// ---------------------------------------------------------------
// captureOne — pure orchestration, I/O via injected deps
// ---------------------------------------------------------------

describe("captureOne", () => {
  const objectId = "obj-capture-1";
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"

  test("success: returns bytes/hash/mime, writes local file", async () => {
    const result = await captureOne({
      input: {
        storage_object_id: objectId,
        file_id: "tg-file-1",
        current_sync_status: "pending",
      },
      transport: successTransport(bytes),
      mime: pdfMime,
      config: buildDeps().config.capture,
    });
    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.size_bytes).toBe(5);
      expect(result.sha256).toBe(sha256Hex(bytes));
      expect(result.mime_type).toBe("application/pdf");
      expect(existsSync(result.local_path)).toBe(true);
      const onDisk = readFileSync(result.local_path);
      expect(onDisk.byteLength).toBe(5);
    }
  });

  test("getFile failure → failure(get_file_failed, retryable)", async () => {
    const result = await captureOne({
      input: { storage_object_id: objectId, file_id: "tg-1", current_sync_status: "pending" },
      transport: {
        async getFile() { throw new Error("network timeout"); },
        async download() { throw new Error("unreached"); },
      },
      mime: pdfMime,
      config: buildDeps().config.capture,
    });
    expect(result.kind).toBe("failure");
    if (result.kind === "failure") {
      expect(result.reason).toBe("get_file_failed");
      expect(result.category).toBe("retryable");
    }
  });

  test("download failure → failure(download_failed, retryable)", async () => {
    const result = await captureOne({
      input: { storage_object_id: objectId, file_id: "tg-1", current_sync_status: "pending" },
      transport: {
        async getFile(file_id) { return { file_id, file_path: "p", file_size: 10 }; },
        async download() { throw new Error("ECONNRESET"); },
      },
      mime: pdfMime,
      config: buildDeps().config.capture,
    });
    expect(result.kind).toBe("failure");
    if (result.kind === "failure") expect(result.reason).toBe("download_failed");
  });

  test("mime probe failure → failure(mime_probe_failed, non_retryable)", async () => {
    const result = await captureOne({
      input: { storage_object_id: objectId, file_id: "tg-1", current_sync_status: "pending" },
      transport: successTransport(bytes),
      mime: { async probe() { throw new Error("probe oom"); } },
      config: buildDeps().config.capture,
    });
    expect(result.kind).toBe("failure");
    if (result.kind === "failure") {
      expect(result.reason).toBe("mime_probe_failed");
      expect(result.category).toBe("non_retryable");
    }
  });

  test("oversize at getFile handle → failure(oversize_at_download, non_retryable)", async () => {
    const bigHandleSize = 100 * 1024 * 1024;
    const result = await captureOne({
      input: { storage_object_id: objectId, file_id: "tg-1", current_sync_status: "pending" },
      transport: {
        async getFile(file_id) { return { file_id, file_path: "p", file_size: bigHandleSize }; },
        async download() { throw new Error("should not be called"); },
      },
      mime: pdfMime,
      config: buildDeps().config.capture,
    });
    expect(result.kind).toBe("failure");
    if (result.kind === "failure") {
      expect(result.reason).toBe("oversize_at_download");
      expect(result.category).toBe("non_retryable");
    }
  });
});

// ---------------------------------------------------------------
// Worker pre-step ledger oracle (AC-STO-003b)
// ---------------------------------------------------------------

describe("AC-STO-003b — worker capture pass via runWorkerOnce", () => {
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);

  test("success: row becomes captured + source_external_id NULL + provider_run reaches terminal", async () => {
    seedJobWithAttachment({
      jobId: "j-cap-ok",
      objectId: "obj-cap-ok",
      file_id: "tg-file-A",
    });
    await runWorkerOnce(
      buildDeps({ transport: successTransport(bytes) }),
    );

    const so = db
      .prepare<
        {
          capture_status: string;
          sha256: string | null;
          mime_type: string | null;
          size_bytes: number | null;
          source_external_id: string | null;
          captured_at: string | null;
          status: string;
        },
        [string]
      >(
        `SELECT capture_status, sha256, mime_type, size_bytes, source_external_id, captured_at, status
         FROM storage_objects WHERE id = ?`,
      )
      .get("obj-cap-ok")!;
    expect(so.capture_status).toBe("captured");
    expect(so.sha256).toBe(sha256Hex(bytes));
    expect(so.mime_type).toBe("application/pdf");
    expect(so.size_bytes).toBe(5);
    expect(so.source_external_id).toBeNull(); // cleared per §13.5
    expect(so.captured_at).not.toBeNull();

    // Session-retention attachment: NO storage_sync job enqueued.
    const syncJobs =
      db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE job_type='storage_sync'").get()?.n ?? 0;
    expect(syncJobs).toBe(0);

    const job = db
      .prepare<{ status: string }, [string]>("SELECT status FROM jobs WHERE id = ?")
      .get("j-cap-ok")!;
    expect(job.status).toBe("succeeded");
  });

  test("long_term retention: success enqueues exactly one storage_sync job", async () => {
    seedJobWithAttachment({
      jobId: "j-cap-lt",
      objectId: "obj-cap-lt",
      file_id: "tg-file-B",
      retention_class: "long_term",
    });
    await runWorkerOnce(buildDeps({ transport: successTransport(bytes) }));

    const syncJobs = db
      .prepare<
        { id: string; idempotency_key: string; request_json: string },
        []
      >("SELECT id, idempotency_key, request_json FROM jobs WHERE job_type='storage_sync'")
      .all();
    expect(syncJobs.length).toBe(1);
    expect(syncJobs[0]!.idempotency_key).toBe("sync:obj-cap-lt");
    expect(JSON.parse(syncJobs[0]!.request_json)).toEqual({ storage_object_id: "obj-cap-lt" });
  });

  test("retryable failure: capture_status=failed, capture_error_json set, source_external_id retained, NO sync job, provider_run still terminal", async () => {
    seedJobWithAttachment({
      jobId: "j-cap-fail",
      objectId: "obj-cap-fail",
      file_id: "tg-file-C",
    });
    await runWorkerOnce(
      buildDeps({
        transport: {
          async getFile() { throw new Error("telegram unreachable"); },
          async download() { throw new Error("unreached"); },
        },
      }),
    );

    const so = db
      .prepare<
        { capture_status: string; capture_error_json: string | null; source_external_id: string | null },
        [string]
      >(
        "SELECT capture_status, capture_error_json, source_external_id FROM storage_objects WHERE id = ?",
      )
      .get("obj-cap-fail")!;
    expect(so.capture_status).toBe("failed");
    expect(so.capture_error_json).toContain("get_file_failed");
    // retryable: source_external_id is retained until the retry
    // budget is exhausted (PRD §13.5 retention policy).
    expect(so.source_external_id).toBe("tg-file-C");

    const syncJobs =
      db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE job_type='storage_sync'").get()?.n ?? 0;
    expect(syncJobs).toBe(0);

    const job = db
      .prepare<{ status: string }, [string]>("SELECT status FROM jobs WHERE id = ?")
      .get("j-cap-fail")!;
    expect(["succeeded", "failed"]).toContain(job.status);
    // Key invariant: jobs.status is NOT rolled back to `queued`.
    expect(job.status).not.toBe("queued");
  });

  test("non-retryable failure (oversize at download): source_external_id is cleared", async () => {
    seedJobWithAttachment({
      jobId: "j-cap-over",
      objectId: "obj-cap-over",
      file_id: "tg-file-D",
    });
    // Transport reports a file_size > cap, so capture fails with oversize_at_download.
    const transport: TelegramFileTransport = {
      async getFile(file_id) { return { file_id, file_path: "p", file_size: 999_000_000 }; },
      async download() { throw new Error("should not be reached"); },
    };
    await runWorkerOnce(buildDeps({ transport }));

    const so = db
      .prepare<
        { capture_status: string; source_external_id: string | null; capture_error_json: string | null },
        [string]
      >(
        "SELECT capture_status, source_external_id, capture_error_json FROM storage_objects WHERE id = ?",
      )
      .get("obj-cap-over")!;
    expect(so.capture_status).toBe("failed");
    expect(so.capture_error_json).toContain("oversize_at_download");
    expect(so.source_external_id).toBeNull();
  });
});
