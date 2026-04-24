import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase, type DbHandle } from "../../src/db.ts";
import { migrate } from "../../src/db/migrator.ts";
import { runStartupRecovery } from "../../src/startup/recovery.ts";

const MIGRATIONS = join(import.meta.dir, "..", "..", "migrations");

let workdir: string;
let db: DbHandle;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "actwyn-recovery-"));
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

function seedRunningJob(args: {
  id: string;
  ikey: string;
  safe_retry?: boolean;
  attempts?: number;
  max_attempts?: number;
  chat_id?: string;
  pgid?: number;
}): void {
  db.prepare<unknown, [string, string, string, number, number, number]>(
    `INSERT INTO jobs
       (id, status, job_type, session_id, chat_id, request_json,
        idempotency_key, provider, attempts, max_attempts, safe_retry)
     VALUES(?, 'running', 'provider_run', 'sess-1', ?, '{}', ?, 'fake', ?, ?, ?)`,
  ).run(
    args.id,
    args.chat_id ?? "chat-1",
    args.ikey,
    args.attempts ?? 1,
    args.max_attempts ?? 3,
    args.safe_retry ? 1 : 0,
  );

  if (args.pgid !== undefined) {
    db.prepare<
      unknown,
      [string, string, number]
    >(
      `INSERT INTO provider_runs
         (id, job_id, session_id, provider, context_packing_mode, status,
          argv_json_redacted, cwd, injected_snapshot_json, parser_status, process_group_id, started_at)
       VALUES(?, ?, 'sess-1', 'fake', 'replay_mode', 'started', '{}', '.', '{}', 'parsed', ?,
              strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
    ).run(`prun-${args.id}`, args.id, args.pgid);
  }
}

describe("HLD §15 — running → interrupted", () => {
  test("every running job is transitioned to interrupted with a recovery note", () => {
    seedRunningJob({ id: "j-1", ikey: "k1" });
    seedRunningJob({ id: "j-2", ikey: "k2" });
    const r = runStartupRecovery(db);
    expect(r.interrupted.length).toBe(2);
    for (const id of ["j-1", "j-2"]) {
      const row = db
        .prepare<{ status: string; error_json: string | null }, [string]>(
          "SELECT status, error_json FROM jobs WHERE id = ?",
        )
        .get(id)!;
      // Either still interrupted (no safe_retry) or re-queued.
      expect(["interrupted", "queued"]).toContain(row.status);
      expect(row.error_json).toContain("restarted_mid_run");
    }
  });
});

describe("HLD §15 — safe_retry + attempts < max → requeued", () => {
  test("eligible job is flipped to queued; attempts unchanged", () => {
    seedRunningJob({
      id: "j-safe",
      ikey: "ksafe",
      safe_retry: true,
      attempts: 1,
      max_attempts: 3,
    });
    const r = runStartupRecovery(db);
    expect(r.requeued).toContain("j-safe");
    const row = db
      .prepare<{ status: string; attempts: number }, [string]>(
        "SELECT status, attempts FROM jobs WHERE id = ?",
      )
      .get("j-safe")!;
    expect(row.status).toBe("queued");
    expect(row.attempts).toBe(1); // NOT charged for OS interruption
  });

  test("budget-exhausted safe_retry stays interrupted", () => {
    seedRunningJob({
      id: "j-exhaust",
      ikey: "kx",
      safe_retry: true,
      attempts: 3,
      max_attempts: 3,
    });
    const r = runStartupRecovery(db);
    expect(r.requeued).not.toContain("j-exhaust");
    expect(r.remained_interrupted).toContain("j-exhaust");
    const row = db
      .prepare<{ status: string }, [string]>(
        "SELECT status FROM jobs WHERE id = ?",
      )
      .get("j-exhaust")!;
    expect(row.status).toBe("interrupted");
  });
});

describe("DEC-016 — user-visible restart notification for non-requeued", () => {
  test("remaining interrupted job with chat_id enqueues a job_failed notification + chunk row", () => {
    seedRunningJob({
      id: "j-terminal",
      ikey: "kterm",
      safe_retry: false,
    });
    runStartupRecovery(db);
    const notif = db
      .prepare<
        { id: string; notification_type: string; status: string; chunk_count: number },
        [string]
      >(
        "SELECT id, notification_type, status, chunk_count FROM outbound_notifications WHERE job_id = ?",
      )
      .get("j-terminal");
    expect(notif?.notification_type).toBe("job_failed");
    expect(notif?.chunk_count).toBe(1);
    const chunks = db
      .prepare<{ status: string }, [string]>(
        "SELECT status FROM outbound_notification_chunks WHERE outbound_notification_id = ?",
      )
      .all(notif!.id);
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.status).toBe("pending");
  });

  test("requeued safe_retry job enqueues a job_accepted restart notification (DEC-016)", () => {
    seedRunningJob({
      id: "j-requeued",
      ikey: "kr",
      safe_retry: true,
    });
    runStartupRecovery(db);
    const notif = db
      .prepare<{ notification_type: string; status: string; chunk_count: number }, [string]>(
        "SELECT notification_type, status, chunk_count FROM outbound_notifications WHERE job_id = ?",
      )
      .get("j-requeued");
    expect(notif).not.toBeNull();
    expect(notif!.notification_type).toBe("job_accepted");
    expect(notif!.status).toBe("pending");
    expect(notif!.chunk_count).toBe(1);
    // A notification_retry job must be enqueued for delivery.
    const retryJob = db
      .prepare<{ job_type: string; status: string }, []>(
        "SELECT job_type, status FROM jobs WHERE job_type = 'notification_retry' LIMIT 1",
      )
      .get();
    expect(retryJob?.job_type).toBe("notification_retry");
    expect(retryJob?.status).toBe("queued");
  });

  test("non-retryable interrupted job also enqueues a notification_retry job for actual delivery", () => {
    seedRunningJob({
      id: "j-notif-retry",
      ikey: "knr",
      safe_retry: false,
    });
    runStartupRecovery(db);
    const retryJob = db
      .prepare<{ job_type: string; status: string; request_json: string }, []>(
        "SELECT job_type, status, request_json FROM jobs WHERE job_type = 'notification_retry' LIMIT 1",
      )
      .get();
    expect(retryJob).not.toBeNull();
    expect(retryJob!.status).toBe("queued");
    const req = JSON.parse(retryJob!.request_json) as { notification_id?: string };
    expect(typeof req.notification_id).toBe("string");
  });
});

describe("orphan sweep — kill_orphan callback", () => {
  test("callback invoked for each provider_runs row with a process_group_id", () => {
    seedRunningJob({ id: "j-pg", ikey: "kpg", pgid: 123456 });
    const killed: number[] = [];
    const r = runStartupRecovery(db, {
      kill_orphan: (pgid) => {
        killed.push(pgid);
        return "alive_killed";
      },
    });
    expect(killed).toEqual([123456]);
    expect(r.orphans_killed).toEqual([123456]);
  });

  test("already-gone orphans are not counted as killed", () => {
    seedRunningJob({ id: "j-gone", ikey: "kg", pgid: 789 });
    const r = runStartupRecovery(db, {
      kill_orphan: () => "already_gone",
    });
    expect(r.orphans_killed).toEqual([]);
  });
});

describe("idempotence — second boot is a no-op", () => {
  test("re-running recovery after completion interrupts nothing new", () => {
    seedRunningJob({ id: "j-id", ikey: "kid" });
    runStartupRecovery(db);
    const second = runStartupRecovery(db);
    expect(second.interrupted).toEqual([]);
    expect(second.requeued).toEqual([]);
  });
});
