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

describe.skipIf(SKIP_S3)("AC-OBS-001 — S3 smoke check via /doctor (requires S3_* env)", () => {
  test("s3_reachable is ok when credentials and endpoint are valid", async () => {
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
    const check = results.find((r) => r.name === "s3_reachable");
    expect(check).not.toBeUndefined();
    expect(check?.status).toBe("ok");
  });
});
