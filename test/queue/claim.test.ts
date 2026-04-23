import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase, type DbHandle } from "../../src/db.ts";
import { migrate } from "../../src/db/migrator.ts";
import { claimNextJob } from "../../src/queue/worker.ts";

const MIGRATIONS = join(import.meta.dir, "..", "..", "migrations");

let workdir: string;
let dbPath: string;
let db: DbHandle;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "actwyn-claim-"));
  dbPath = join(workdir, "t.db");
  db = openDatabase({ path: dbPath, busyTimeoutMs: 250 });
  migrate(db, MIGRATIONS);
  db.prepare<unknown, [string, string, string]>(
    "INSERT INTO sessions(id, chat_id, user_id) VALUES(?, ?, ?)",
  ).run("sess-1", "chat-1", "user-1");
});

afterEach(() => {
  db.close();
  rmSync(workdir, { recursive: true, force: true });
});

function seed(opts: {
  id: string;
  ikey: string;
  job_type?: "provider_run" | "summary_generation" | "storage_sync" | "notification_retry";
  priority?: number;
  scheduled_at?: string;
}): void {
  const jobType = opts.job_type ?? "provider_run";
  const priority = opts.priority ?? 0;
  const scheduled = opts.scheduled_at ?? new Date(Date.now() - 1000).toISOString();
  db.prepare<unknown, [string, string, number, string, string]>(
    `INSERT INTO jobs(id, status, job_type, priority, scheduled_at, request_json, idempotency_key)
     VALUES(?, 'queued', ?, ?, ?, '{}', ?)`,
  ).run(opts.id, jobType, priority, scheduled, opts.ikey);
}

describe("claimNextJob", () => {
  test("returns null when no queued jobs exist", () => {
    expect(claimNextJob(db)).toBeNull();
  });

  test("claims exactly one queued job and moves it to running", () => {
    seed({ id: "j-1", ikey: "k1" });
    const c = claimNextJob(db);
    expect(c?.id).toBe("j-1");
    expect(c?.attempts).toBe(1);
    const status = db
      .prepare<{ status: string }, [string]>("SELECT status FROM jobs WHERE id = ?")
      .get("j-1")?.status;
    expect(status).toBe("running");
  });

  test("does NOT claim a job scheduled in the future", () => {
    seed({ id: "future", ikey: "k-future", scheduled_at: new Date(Date.now() + 60_000).toISOString() });
    expect(claimNextJob(db)).toBeNull();
  });

  test("higher priority wins", () => {
    seed({ id: "j-lo", ikey: "k-lo", priority: 0 });
    seed({ id: "j-hi", ikey: "k-hi", priority: 5 });
    const c = claimNextJob(db);
    expect(c?.id).toBe("j-hi");
  });

  test("no double-claim: two consecutive claims on one queued job", () => {
    seed({ id: "only", ikey: "only" });
    const a = claimNextJob(db);
    const b = claimNextJob(db);
    expect(a?.id).toBe("only");
    expect(b).toBeNull();
  });

  test("no double-claim under concurrent claimers (same DB path)", async () => {
    for (let i = 0; i < 25; i++) seed({ id: `c-${i}`, ikey: `ck-${i}` });
    // Two parallel open handles to the same file. busy_timeout lets
    // them serialize at BEGIN IMMEDIATE.
    const db1 = openDatabase({ path: dbPath, busyTimeoutMs: 5000 });
    const db2 = openDatabase({ path: dbPath, busyTimeoutMs: 5000 });
    try {
      const results = await Promise.all(
        Array.from({ length: 50 }, (_, i) => (i % 2 === 0 ? claimNextJob(db1) : claimNextJob(db2))),
      );
      const claimed = results.filter((r) => r !== null).map((r) => r!.id);
      const unique = new Set(claimed);
      expect(claimed.length).toBe(unique.size); // every claim distinct
      expect(unique.size).toBeLessThanOrEqual(25); // no more claims than rows
    } finally {
      db1.close();
      db2.close();
    }
  });
});
