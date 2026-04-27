// AC-OBS-001 — /doctor state-triggered checks + CI-optional S3 smoke.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase, type DbHandle } from "../../src/db.ts";
import { migrate } from "../../src/db/migrator.ts";
import { runDoctor } from "../../src/commands/doctor.ts";
import { BunS3Transport } from "../../src/storage/s3.ts";

const MIGRATIONS = join(import.meta.dir, "..", "..", "migrations");

const {
  S3_ENDPOINT,
  S3_BUCKET,
  S3_REGION,
  S3_ACCESS_KEY_ID,
  S3_SECRET_ACCESS_KEY,
} = process.env;

const SKIP_S3 = !S3_ENDPOINT || !S3_BUCKET || !S3_REGION || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY;

let workdir: string;
let db: DbHandle;

const BASE_DEPS = {
  required_bun_version: "1.3.11",
  current_bun_version: "1.3.11",
  bootstrap_whoami: false,
};

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "actwyn-doctor-"));
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
// storage_sync_backlog check (PRD §14.1 query contract)
// ---------------------------------------------------------------

describe("storage_sync_backlog check", () => {
  test("ok when backlog is zero", async () => {
    const results = await runDoctor({ db, ...BASE_DEPS });
    const check = results.find((r) => r.name === "storage_sync_backlog")!;
    expect(check.status).toBe("ok");
  });

  test("ok when backlog is ≤ 50 (low threshold)", async () => {
    for (let i = 0; i < 5; i++) {
      db.prepare<unknown, [string, string]>(
        `INSERT INTO storage_objects
           (id, storage_backend, bucket, storage_key, source_channel, source_message_id,
            artifact_type, retention_class, capture_status, status)
         VALUES(?, 's3', 'b', ?, 'system', '0', 'user_upload', 'long_term', 'captured', 'pending')`,
      ).run(`so-${i}`, `objects/2026/04/23/so-${i}/sha.bin`);
    }
    const results = await runDoctor({ db, ...BASE_DEPS });
    const check = results.find((r) => r.name === "storage_sync_backlog")!;
    expect(check.status).toBe("ok");
  });

  test("warn when backlog exceeds 50", async () => {
    for (let i = 0; i < 51; i++) {
      db.prepare<unknown, [string, string]>(
        `INSERT INTO storage_objects
           (id, storage_backend, bucket, storage_key, source_channel, source_message_id,
            artifact_type, retention_class, capture_status, status)
         VALUES(?, 's3', 'b', ?, 'system', '0', 'user_upload', 'long_term', 'captured', 'pending')`,
      ).run(`so-big-${i}`, `objects/2026/04/23/so-big-${i}/sha.bin`);
    }
    const results = await runDoctor({ db, ...BASE_DEPS });
    const check = results.find((r) => r.name === "storage_sync_backlog")!;
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("pending=51");
  });
});

// ---------------------------------------------------------------
// attachment_capture_failures check
// ---------------------------------------------------------------

describe("attachment_capture_failures check", () => {
  test("ok with no failures", async () => {
    const results = await runDoctor({ db, ...BASE_DEPS });
    const check = results.find((r) => r.name === "attachment_capture_failures")!;
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("count=0");
  });

  test("warn when there is at least one capture failure", async () => {
    db.prepare<unknown, [string, string]>(
      `INSERT INTO storage_objects
         (id, storage_backend, bucket, storage_key, source_channel, source_message_id,
          artifact_type, retention_class, capture_status, status)
       VALUES(?, 's3', 'b', ?, 'telegram', '1', 'user_upload', 'session', 'failed', 'pending')`,
    ).run("so-cfail", "objects/2026/04/23/so-cfail/capture_pending.bin");
    const results = await runDoctor({ db, ...BASE_DEPS });
    const check = results.find((r) => r.name === "attachment_capture_failures")!;
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("count=1");
  });
});

// ---------------------------------------------------------------
// interrupted_jobs check
// ---------------------------------------------------------------

describe("interrupted_jobs check", () => {
  test("ok with no interrupted jobs", async () => {
    const results = await runDoctor({ db, ...BASE_DEPS });
    const check = results.find((r) => r.name === "interrupted_jobs")!;
    expect(check.status).toBe("ok");
  });

  test("warn when there are interrupted jobs", async () => {
    db.prepare<unknown, [string, string, string, string]>(
      `INSERT INTO jobs(id, status, job_type, session_id, chat_id, request_json, idempotency_key, provider)
       VALUES(?, 'interrupted', 'provider_run', ?, ?, '{}', ?, 'fake')`,
    ).run("j-int", "sess-1", "chat-1", "ikey-int");
    const results = await runDoctor({ db, ...BASE_DEPS });
    const check = results.find((r) => r.name === "interrupted_jobs")!;
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("count=1");
  });
});

// ---------------------------------------------------------------
// AC-OBS-001 — S3 smoke (CI-optional)
// ---------------------------------------------------------------

// ---------------------------------------------------------------
// config_loaded check
// ---------------------------------------------------------------

describe("config_loaded check", () => {
  test("ok when config_ok returns ok", async () => {
    const results = await runDoctor({
      db,
      ...BASE_DEPS,
      config_ok: () => ({ ok: true, detail: "all fields present" }),
    });
    const check = results.find((r) => r.name === "config_loaded")!;
    expect(check.status).toBe("ok");
  });

  test("fail when config_ok returns not ok", async () => {
    const results = await runDoctor({
      db,
      ...BASE_DEPS,
      config_ok: () => ({ ok: false, detail: "missing TELEGRAM_BOT_TOKEN" }),
    });
    const check = results.find((r) => r.name === "config_loaded")!;
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("missing");
  });

  test("omitted when config_ok is not injected", async () => {
    const results = await runDoctor({ db, ...BASE_DEPS });
    expect(results.find((r) => r.name === "config_loaded")).toBeUndefined();
  });
});

// ---------------------------------------------------------------
// migrations_applied check
// ---------------------------------------------------------------

describe("migrations_applied check", () => {
  test("ok when all expected migrations are applied", async () => {
    // After migrate(db, MIGRATIONS) in beforeEach, 001..004 are applied.
    const results = await runDoctor({ db, ...BASE_DEPS, expected_schema_version: 4 });
    const check = results.find((r) => r.name === "migrations_applied")!;
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("applied=4");
  });

  test("fail when expected version is higher than applied", async () => {
    const results = await runDoctor({ db, ...BASE_DEPS, expected_schema_version: 99 });
    const check = results.find((r) => r.name === "migrations_applied")!;
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("missing migrations");
  });

  test("omitted when expected_schema_version is not set", async () => {
    const results = await runDoctor({ db, ...BASE_DEPS });
    expect(results.find((r) => r.name === "migrations_applied")).toBeUndefined();
  });
});

// ---------------------------------------------------------------
// redaction_boundary_quick check
// ---------------------------------------------------------------

describe("redaction_boundary_quick check", () => {
  test("ok when self-test passes", async () => {
    const results = await runDoctor({
      db,
      ...BASE_DEPS,
      redaction_self_test: () => ({ ok: true }),
    });
    const check = results.find((r) => r.name === "redaction_boundary_quick")!;
    expect(check.status).toBe("ok");
  });

  test("fail when self-test fails", async () => {
    const results = await runDoctor({
      db,
      ...BASE_DEPS,
      redaction_self_test: () => ({ ok: false, detail: "pattern not redacted" }),
    });
    const check = results.find((r) => r.name === "redaction_boundary_quick")!;
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("not redacted");
  });
});

// ---------------------------------------------------------------
// stale_pending_notifications check
// ---------------------------------------------------------------

describe("stale_pending_notifications check", () => {
  test("ok with no pending notifications", async () => {
    const results = await runDoctor({ db, ...BASE_DEPS });
    const check = results.find((r) => r.name === "stale_pending_notifications")!;
    expect(check.status).toBe("ok");
  });

  test("warn with a pending notification older than threshold", async () => {
    // Insert the job FK dependency, then the stale notification.
    db.prepare<unknown, [string, string, string, string]>(
      `INSERT INTO jobs(id, status, job_type, session_id, chat_id, request_json, idempotency_key, provider)
       VALUES(?, 'succeeded', 'provider_run', ?, ?, '{}', ?, 'fake')`,
    ).run("job-stale", "sess-1", "chat-1", "ikey-stale");
    db.prepare<unknown, [string, string, string, string]>(
      `INSERT INTO outbound_notifications
         (id, job_id, chat_id, notification_type, payload_hash, chunk_count, status, created_at)
       VALUES(?, ?, ?, 'job_completed', 'abc123', 1, 'pending', ?)`,
    ).run("notif-stale", "job-stale", "chat-1", "2000-01-01T00:00:00.000Z");
    const results = await runDoctor({ db, ...BASE_DEPS, stale_threshold_ms: 1000 });
    const check = results.find((r) => r.name === "stale_pending_notifications")!;
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("stale_count=1");
  });
});

// ---------------------------------------------------------------
// stale_pending_storage_sync check
// ---------------------------------------------------------------

describe("stale_pending_storage_sync check", () => {
  test("ok with no stale storage objects", async () => {
    const results = await runDoctor({ db, ...BASE_DEPS });
    const check = results.find((r) => r.name === "stale_pending_storage_sync")!;
    expect(check.status).toBe("ok");
  });

  test("warn with a storage object in pending capture status older than threshold", async () => {
    db.prepare<unknown, [string, string]>(
      `INSERT INTO storage_objects
         (id, storage_backend, bucket, storage_key, source_channel, source_message_id,
          artifact_type, retention_class, capture_status, status, created_at)
       VALUES(?, 's3', 'b', ?, 'telegram', '1', 'user_upload', 'session', 'pending', 'pending', '2000-01-01T00:00:00.000Z')`,
    ).run("so-stale", "objects/stale.bin");
    const results = await runDoctor({ db, ...BASE_DEPS, stale_threshold_ms: 1000 });
    const check = results.find((r) => r.name === "stale_pending_storage_sync")!;
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("stale_count=1");
  });
});

// ---------------------------------------------------------------
// orphan_processes check
// ---------------------------------------------------------------

describe("orphan_processes check", () => {
  test("ok with no orphan processes", async () => {
    const results = await runDoctor({ db, ...BASE_DEPS });
    const check = results.find((r) => r.name === "orphan_processes")!;
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("count=0");
  });

  test("warn when a provider_run is stuck in started with a process_group_id", async () => {
    // Insert a job and provider_run to satisfy FK constraints.
    db.prepare<unknown, [string, string, string, string]>(
      `INSERT INTO jobs(id, status, job_type, session_id, chat_id, request_json, idempotency_key, provider)
       VALUES(?, 'running', 'provider_run', ?, ?, '{}', ?, 'fake')`,
    ).run("j-orphan", "sess-1", "chat-1", "ikey-orphan");
    db.prepare<unknown, [string, string]>(
      `INSERT INTO provider_runs(id, job_id, session_id, provider, context_packing_mode, status,
                                 argv_json_redacted, cwd, injected_snapshot_json, parser_status,
                                 process_group_id)
       VALUES(?, ?, 'sess-1', 'fake', 'replay_mode', 'started', '[]', '/tmp', '{}', 'parsed', 12345)`,
    ).run("pr-orphan", "j-orphan");
    const results = await runDoctor({ db, ...BASE_DEPS });
    const check = results.find((r) => r.name === "orphan_processes")!;
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("count=1");
  });
});

// ---------------------------------------------------------------
// AC-OBS-001 — S3 smoke (CI-optional)
// ---------------------------------------------------------------

describe("AC-OBS-001 / Blocker 8 — s3_endpoint_smoke attributes failures to stage", () => {
  test("get-stage failure is surfaced as fail even when put/delete would succeed", async () => {
    const results = await runDoctor({
      db,
      ...BASE_DEPS,
      // The transport-layer smoke test covers put/get/stat/list/delete. Here we
      // simulate a hypothetical environment where put + delete pass but the
      // deep-read round-trip fails — the doctor must still fail the gate.
      s3_ping: async () => ({ ok: false, detail: "get failed: 403 Forbidden" }),
    });
    const check = results.find((r) => r.name === "s3_endpoint_smoke")!;
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("get failed");
  });

  test("list-stage failure is surfaced as fail", async () => {
    const results = await runDoctor({
      db,
      ...BASE_DEPS,
      s3_ping: async () => ({ ok: false, detail: "list did not return sentinel under prefix '_actwyn_ping_1700000000000_abc123'" }),
    });
    const check = results.find((r) => r.name === "s3_endpoint_smoke")!;
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("list");
  });
});

describe.skipIf(SKIP_S3)("AC-OBS-001 — S3 smoke check via /doctor (requires S3_* env)", () => {
  test("s3_endpoint_smoke is ok when credentials and endpoint are valid", async () => {
    const transport = new BunS3Transport({
      endpoint: S3_ENDPOINT!,
      bucket: S3_BUCKET!,
      region: S3_REGION!,
      access_key_id: S3_ACCESS_KEY_ID!,
      secret_access_key: S3_SECRET_ACCESS_KEY!,
    });
    const results = await runDoctor({
      db,
      ...BASE_DEPS,
      s3_ping: async () => {
        const key = `_doctor_probe/${Date.now()}.txt`;
        const probe = new TextEncoder().encode("actwyn-doctor-probe");
        try {
          await transport.put({ bucket: S3_BUCKET!, key, bytes: probe, content_type: "text/plain" });
          await transport.delete({ bucket: S3_BUCKET!, key });
          return { ok: true, detail: `probe key ${key}` };
        } catch (e) {
          return { ok: false, detail: (e as Error).message };
        }
      },
    });
    const check = results.find((r) => r.name === "s3_endpoint_smoke");
    expect(check).not.toBeUndefined();
    expect(check?.status).toBe("ok");
  });
});
