import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { openDatabase, type DbHandle } from "../../src/db.ts";
import { migrate } from "../../src/db/migrator.ts";
import {
  StubS3Transport,
} from "../../src/storage/s3.ts";
import {
  runDeletePass,
  runRetryScheduler,
  runUploadPass,
  selectEligibleUploads,
} from "../../src/storage/sync.ts";

const MIGRATIONS = join(import.meta.dir, "..", "..", "migrations");

let workdir: string;
let dataDir: string;
let db: DbHandle;

function localPath(id: string): string {
  return join(dataDir, id);
}

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "actwyn-sync-"));
  dataDir = join(workdir, "objects");
  mkdirSync(dataDir, { recursive: true });
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

function seedStorageObject(args: {
  id: string;
  retention_class?: "ephemeral" | "session" | "long_term" | "archive";
  storage_backend?: "s3" | "local";
  bucket?: string | null;
  capture_status?: "pending" | "captured" | "failed";
  status?: "pending" | "uploaded" | "failed" | "deletion_requested" | "deleted" | "delete_failed";
  bytes?: Uint8Array;
  artifact_type?: string;
}): void {
  const backend = args.storage_backend ?? "s3";
  const bucket = args.bucket ?? (backend === "s3" ? "actwyn-test" : null);
  const captureStatus = args.capture_status ?? "captured";
  const status = args.status ?? "pending";
  const artifact = args.artifact_type ?? "user_upload";
  const key = `users/user-1/objects/${args.id}/original.bin`;
  db.prepare<
    unknown,
    [string, string, string | null, string, string, string, string, string]
  >(
    `INSERT INTO storage_objects
       (id, storage_backend, bucket, storage_key, source_channel, source_message_id,
        source_job_id, source_external_id, artifact_type, retention_class,
        capture_status, status, capture_error_json)
     VALUES(?, ?, ?, ?, 'system', '0', NULL, NULL, ?, ?, ?, ?, NULL)`,
  ).run(args.id, backend, bucket, key, artifact, args.retention_class ?? "long_term", captureStatus, status);

  if (captureStatus === "captured" && args.bytes) {
    const path = localPath(args.id);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, args.bytes);
  }
}

function readStatus(id: string): { capture_status: string; status: string; error_json: string | null; uploaded_at: string | null; deleted_at: string | null } {
  return db
    .prepare<
      { capture_status: string; status: string; error_json: string | null; uploaded_at: string | null; deleted_at: string | null },
      [string]
    >(
      "SELECT capture_status, status, error_json, uploaded_at, deleted_at FROM storage_objects WHERE id = ?",
    )
    .get(id)!;
}

// ---------------------------------------------------------------
// AC-STO-003b-aligned: selectEligibleUploads query contract
// ---------------------------------------------------------------

describe("selectEligibleUploads — §14.1 query contract", () => {
  test("captured + long_term + pending s3 rows are selected", () => {
    seedStorageObject({ id: "so-ok" });
    const rows = selectEligibleUploads(db);
    expect(rows.map((r) => r.id)).toContain("so-ok");
  });

  test("session-retention rows are NOT selected (expected /status backlog)", () => {
    seedStorageObject({ id: "so-sess", retention_class: "session" });
    const rows = selectEligibleUploads(db);
    expect(rows.find((r) => r.id === "so-sess")).toBeUndefined();
  });

  test("ephemeral rows are NOT selected even when long_term would be", () => {
    seedStorageObject({ id: "so-eph", retention_class: "ephemeral", storage_backend: "local", bucket: null });
    const rows = selectEligibleUploads(db);
    expect(rows.find((r) => r.id === "so-eph")).toBeUndefined();
  });

  test("capture_status='failed' rows are NOT selected", () => {
    seedStorageObject({ id: "so-cfail", capture_status: "failed" });
    const rows = selectEligibleUploads(db);
    expect(rows.find((r) => r.id === "so-cfail")).toBeUndefined();
  });

  test("status='uploaded' rows are NOT selected (already done)", () => {
    seedStorageObject({ id: "so-up", status: "uploaded" });
    const rows = selectEligibleUploads(db);
    expect(rows.find((r) => r.id === "so-up")).toBeUndefined();
  });
});

// ---------------------------------------------------------------
// Upload pass: pending → uploaded on success
// ---------------------------------------------------------------

describe("upload pass — happy path", () => {
  test("pending → uploaded; uploaded_at set; S3 store has bytes", async () => {
    seedStorageObject({ id: "so-1", bytes: new Uint8Array([1, 2, 3]) });
    const transport = new StubS3Transport();
    const res = await runUploadPass({
      db,
      transport,
      config: { max_attempts: 3, local_path: localPath },
    });
    expect(res.uploaded).toBe(1);
    expect(res.failed).toBe(0);
    const r = readStatus("so-1");
    expect(r.status).toBe("uploaded");
    expect(r.uploaded_at).not.toBeNull();
    expect(transport.store.size).toBe(1);
  });

  test("local file missing → marked failed with reason", async () => {
    // captured but we did not write the local bytes.
    seedStorageObject({ id: "so-missing" });
    const transport = new StubS3Transport();
    const res = await runUploadPass({
      db,
      transport,
      config: { max_attempts: 3, local_path: localPath },
    });
    expect(res.local_missing).toBe(1);
    const r = readStatus("so-missing");
    expect(r.status).toBe("failed");
    expect(r.error_json).toContain("local_missing");
  });
});

// ---------------------------------------------------------------
// pending → failed → pending → uploaded (retry loop)
// ---------------------------------------------------------------

describe("retry scheduler — failed → pending → uploaded", () => {
  test("transient failure then success", async () => {
    seedStorageObject({ id: "so-retry", bytes: new Uint8Array([9]) });
    const planKey = "actwyn-test/users/user-1/objects/so-retry/original.bin";
    const transport = new StubS3Transport(
      new Map([[planKey, "fail_once"]]),
    );
    // Pass 1: transient put error → failed.
    await runUploadPass({
      db,
      transport,
      config: { max_attempts: 3, local_path: localPath },
    });
    expect(readStatus("so-retry").status).toBe("failed");

    // Scheduler moves failed → pending (attempts=1).
    const sched = runRetryScheduler({
      db,
      transport,
      config: { max_attempts: 3, local_path: localPath },
    });
    expect(sched.repended).toBe(1);
    expect(readStatus("so-retry").status).toBe("pending");

    // Pass 2: succeeds.
    await runUploadPass({
      db,
      transport,
      config: { max_attempts: 3, local_path: localPath },
    });
    expect(readStatus("so-retry").status).toBe("uploaded");
  });

  test("retry exhaustion does NOT re-pend", async () => {
    seedStorageObject({ id: "so-exhaust", bytes: new Uint8Array([9]) });
    const transport = new StubS3Transport(
      new Map([["actwyn-test/users/user-1/objects/so-exhaust/original.bin", "fail_retryable"]]),
    );
    // Pass 1 fails.
    await runUploadPass({ db, transport, config: { max_attempts: 2, local_path: localPath } });
    expect(readStatus("so-exhaust").status).toBe("failed");
    // First scheduler: bump attempts to 1; re-pend.
    runRetryScheduler({ db, transport, config: { max_attempts: 2, local_path: localPath } });
    expect(readStatus("so-exhaust").status).toBe("pending");
    // Pass 2 fails again.
    await runUploadPass({ db, transport, config: { max_attempts: 2, local_path: localPath } });
    expect(readStatus("so-exhaust").status).toBe("failed");
    // Second scheduler: attempts=2 ≥ max; do not re-pend.
    const r = runRetryScheduler({ db, transport, config: { max_attempts: 2, local_path: localPath } });
    expect(r.exhausted).toBe(1);
    expect(r.repended).toBe(0);
    expect(readStatus("so-exhaust").status).toBe("failed");
  });
});

// ---------------------------------------------------------------
// Delete path (HLD §12.6)
// ---------------------------------------------------------------

describe("delete pass — deletion_requested → deleted | delete_failed", () => {
  test("S3-backed deletion_requested → deleted on success", async () => {
    seedStorageObject({ id: "so-del", bytes: new Uint8Array([7]) });
    const transport = new StubS3Transport();
    // First upload so there's an object to delete (matches real flow).
    await runUploadPass({ db, transport, config: { max_attempts: 3, local_path: localPath } });
    db.prepare<unknown, [string]>(
      "UPDATE storage_objects SET status='deletion_requested' WHERE id = ?",
    ).run("so-del");

    const res = await runDeletePass({
      db,
      transport,
      config: { max_attempts: 3, local_path: localPath },
    });
    expect(res.deleted).toBe(1);
    const r = readStatus("so-del");
    expect(r.status).toBe("deleted");
    expect(r.deleted_at).not.toBeNull();
  });

  test("S3 DELETE failure → delete_failed", async () => {
    seedStorageObject({ id: "so-del-fail", bytes: new Uint8Array([7]) });
    const transport = new StubS3Transport(
      new Map([["actwyn-test/users/user-1/objects/so-del-fail/original.bin", "fail_non_retryable"]]),
    );
    // Force row into deletion_requested state.
    db.prepare<unknown, [string]>(
      "UPDATE storage_objects SET status='deletion_requested' WHERE id = ?",
    ).run("so-del-fail");
    const res = await runDeletePass({
      db,
      transport,
      config: { max_attempts: 3, local_path: localPath },
    });
    expect(res.delete_failed).toBe(1);
    expect(readStatus("so-del-fail").status).toBe("delete_failed");
  });

  test("local-only deletion_requested → deleted directly (HLD §12.6 local-only path)", async () => {
    seedStorageObject({
      id: "so-local",
      storage_backend: "local",
      bucket: null,
      retention_class: "session",
      bytes: new Uint8Array([3]),
    });
    // seedStorageObject seeded with status=pending; flip to deletion_requested.
    db.prepare<unknown, [string]>(
      "UPDATE storage_objects SET status='deletion_requested' WHERE id = ?",
    ).run("so-local");

    const res = await runDeletePass({
      db,
      transport: new StubS3Transport(),
      config: { max_attempts: 3, local_path: localPath },
    });
    expect(res.local_only_deleted).toBe(1);
    const r = readStatus("so-local");
    expect(r.status).toBe("deleted");
    // Audit marker in error_json per HLD §12.6.
    expect(r.error_json).toContain("local_only_delete");
  });
});

// ---------------------------------------------------------------
// Independence: storage failure never mutates provider_runs / jobs
// ---------------------------------------------------------------

describe("independence — storage failure does NOT touch provider_runs/jobs", () => {
  test("failed upload leaves jobs.status unchanged", async () => {
    // Seed a succeeded job + a captured long_term object owned by it.
    db.prepare<unknown, [string, string]>(
      `INSERT INTO jobs(id, status, job_type, chat_id, request_json, idempotency_key, provider)
       VALUES('job-a', 'succeeded', 'provider_run', ?, '{}', ?, 'fake')`,
    ).run("chat-1", "ikey-a");
    seedStorageObject({ id: "so-ind", bytes: new Uint8Array([5]) });
    db.prepare<unknown, [string, string]>(
      "UPDATE storage_objects SET source_job_id = ? WHERE id = ?",
    ).run("job-a", "so-ind");
    const transport = new StubS3Transport(
      new Map([["actwyn-test/users/user-1/objects/so-ind/original.bin", "fail_non_retryable"]]),
    );
    await runUploadPass({
      db,
      transport,
      config: { max_attempts: 1, local_path: localPath },
    });
    expect(readStatus("so-ind").status).toBe("failed");
    const job = db
      .prepare<{ status: string }, [string]>(
        "SELECT status FROM jobs WHERE id = ?",
      )
      .get("job-a")!;
    expect(job.status).toBe("succeeded");
  });
});
