import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase, type DbHandle } from "../../src/db.ts";
import { migrate } from "../../src/db/migrator.ts";
import { buildStatusReport, formatStatus } from "../../src/commands/status.ts";
import { cancelJob } from "../../src/commands/cancel.ts";
import { enqueueSummaryJob, endSession } from "../../src/commands/summary.ts";
import { whoamiReply } from "../../src/commands/whoami.ts";
import { switchProvider } from "../../src/commands/provider.ts";
import { runDoctor } from "../../src/commands/doctor.ts";
import { saveLastAttachment } from "../../src/commands/save.ts";

const MIGRATIONS = join(import.meta.dir, "..", "..", "migrations");

let workdir: string;
let db: DbHandle;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "actwyn-cmd-"));
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
// /status
// ---------------------------------------------------------------

describe("/status", () => {
  test("empty DB reports zeros", () => {
    const r = buildStatusReport(db);
    expect(r.queue.queued).toBe(0);
    expect(r.queue.running).toBe(0);
    expect(r.storage_sync.pending).toBe(0);
    expect(r.attachment_capture_failures).toBe(0);
  });

  test("session-retention storage_objects do NOT count as backlog (§14.1 query contract)", () => {
    db.prepare<unknown, [string]>(
      `INSERT INTO storage_objects
         (id, storage_backend, bucket, storage_key, source_channel, source_message_id,
          source_job_id, source_external_id, artifact_type, retention_class,
          capture_status, status)
       VALUES(?, 's3', 'b', 'objects/2026/04/23/obj-sess/pending.bin', 'telegram', '0', NULL, NULL, 'user_upload', 'session', 'captured', 'pending')`,
    ).run("obj-sess");
    expect(buildStatusReport(db).storage_sync.pending).toBe(0);
  });

  test("long_term pending storage_objects DO count as backlog", () => {
    db.prepare<unknown, [string]>(
      `INSERT INTO storage_objects
         (id, storage_backend, bucket, storage_key, source_channel, source_message_id,
          source_job_id, source_external_id, artifact_type, retention_class,
          capture_status, status)
       VALUES(?, 's3', 'b', 'objects/2026/04/23/obj-lt/pending.bin', 'telegram', '0', NULL, NULL, 'user_upload', 'long_term', 'captured', 'pending')`,
    ).run("obj-lt");
    expect(buildStatusReport(db).storage_sync.pending).toBe(1);
  });

  test("formatStatus produces the PRD §14.1 contract lines", () => {
    const txt = formatStatus(buildStatusReport(db));
    const lines = txt.split("\n");
    // Minimum 7 lines: 상태, session, provider, queue, post-processing, S3, last completed.
    expect(lines.length).toBeGreaterThanOrEqual(7);
    expect(lines[0]).toMatch(/^상태:/);
    expect(lines[1]).toMatch(/^session:/);
    expect(lines[2]).toMatch(/^provider:.*packing_mode:/);
    expect(lines[3]).toMatch(/^queue:/);
    expect(lines[4]).toMatch(/^post-processing:/);
    expect(lines[5]).toMatch(/^S3:/);
    expect(lines[6]).toMatch(/^last completed:/);
  });

  test("formatStatus overall_status=issue when failed jobs exist", () => {
    db.prepare<unknown, [string, string, string]>(
      `INSERT INTO jobs(id, status, job_type, chat_id, request_json, idempotency_key, provider, session_id)
       VALUES(?, 'failed', 'provider_run', ?, '{}', ?, 'fake', 'sess-1')`,
    ).run("j-failed", "chat-1", "ikey-f");
    const report = buildStatusReport(db);
    expect(report.overall_status).toBe("issue");
    expect(formatStatus(report)).toContain("상태: issue");
  });
});

// ---------------------------------------------------------------
// /cancel
// ---------------------------------------------------------------

describe("/cancel", () => {
  test("queued job → cancelled_queued", () => {
    db.prepare<unknown, [string, string, string]>(
      `INSERT INTO jobs(id, status, job_type, chat_id, request_json, idempotency_key, provider, session_id)
       VALUES(?, 'queued', 'provider_run', ?, '{}', ?, 'fake', 'sess-1')`,
    ).run("j-q", "chat-1", "ikey-q");
    const r = cancelJob(db, { job_id: "j-q" });
    expect(r.kind).toBe("cancelled_queued");
    const status = db.prepare<{ status: string }, [string]>(
      "SELECT status FROM jobs WHERE id = ?",
    ).get("j-q")!.status;
    expect(status).toBe("cancelled");
  });

  test("running job + handle → cancel_signalled (abort fired)", () => {
    db.prepare<unknown, [string, string, string]>(
      `INSERT INTO jobs(id, status, job_type, chat_id, request_json, idempotency_key, provider, session_id)
       VALUES(?, 'running', 'provider_run', ?, '{}', ?, 'fake', 'sess-1')`,
    ).run("j-r", "chat-1", "ikey-r");
    const handles = new Map<string, AbortController>();
    const c = new AbortController();
    handles.set("j-r", c);
    const r = cancelJob(db, { job_id: "j-r", deps: { running_cancel_handles: handles } });
    expect(r.kind).toBe("cancel_signalled");
    expect(c.signal.aborted).toBe(true);
  });

  test("running job without registered handle → cancel_unavailable (not a false success)", () => {
    db.prepare<unknown, [string, string, string]>(
      `INSERT INTO jobs(id, status, job_type, chat_id, request_json, idempotency_key, provider, session_id)
       VALUES(?, 'running', 'provider_run', ?, '{}', ?, 'fake', 'sess-1')`,
    ).run("j-nohandle", "chat-1", "ikey-nohandle");
    const handles = new Map<string, AbortController>();
    const r = cancelJob(db, {
      job_id: "j-nohandle",
      deps: { running_cancel_handles: handles },
    });
    expect(r.kind).toBe("cancel_unavailable");
    // Crucial: must NOT claim the job was signalled.
    expect(r.kind).not.toBe("cancel_signalled");
  });

  test("running job with empty handle registry → cancel_unavailable", () => {
    db.prepare<unknown, [string, string, string]>(
      `INSERT INTO jobs(id, status, job_type, chat_id, request_json, idempotency_key, provider, session_id)
       VALUES(?, 'running', 'provider_run', ?, '{}', ?, 'fake', 'sess-1')`,
    ).run("j-noreg", "chat-1", "ikey-noreg");
    // No deps at all — previously this silently returned cancel_signalled.
    const r = cancelJob(db, { job_id: "j-noreg" });
    expect(r.kind).toBe("cancel_unavailable");
  });

  test("unknown id → not_found", () => {
    const r = cancelJob(db, { job_id: "nope" });
    expect(r.kind).toBe("not_found");
  });
});

// ---------------------------------------------------------------
// /summary, /end
// ---------------------------------------------------------------

describe("/summary, /end", () => {
  const newIdFactory = () => {
    let n = 0;
    return () => `id-${++n}`;
  };
  test("/summary enqueues a summary_generation job with correct idempotency_key", () => {
    const r = enqueueSummaryJob({
      db,
      newId: newIdFactory(),
      session_id: "sess-1",
      chat_id: "chat-1",
      user_id: "user-1",
      trigger: "explicit_summary",
    });
    expect(r.already_queued).toBe(false);
    const row = db
      .prepare<{ job_type: string; idempotency_key: string }, [string]>(
        "SELECT job_type, idempotency_key FROM jobs WHERE id = ?",
      )
      .get(r.job_id)!;
    expect(row.job_type).toBe("summary_generation");
    expect(row.idempotency_key).toContain("summary:sess-1:");
  });

  test("/end enqueues with a deterministic key per session", () => {
    const r1 = enqueueSummaryJob({
      db,
      newId: newIdFactory(),
      session_id: "sess-1",
      chat_id: "chat-1",
      user_id: "user-1",
      trigger: "explicit_end",
    });
    const r2 = enqueueSummaryJob({
      db,
      newId: newIdFactory(),
      session_id: "sess-1",
      chat_id: "chat-1",
      user_id: "user-1",
      trigger: "explicit_end",
    });
    expect(r2.already_queued).toBe(true);
    expect(r2.job_id).toBe(r1.job_id);
  });

  test("endSession flips active → ended", () => {
    endSession(db, "sess-1");
    const row = db.prepare<{ status: string }>("SELECT status FROM sessions WHERE id='sess-1'").get()!;
    expect(row.status).toBe("ended");
  });
});

// ---------------------------------------------------------------
// /whoami, /provider
// ---------------------------------------------------------------

describe("/whoami", () => {
  test("renders user_id + chat_id", () => {
    expect(whoamiReply({ user_id: "42", chat_id: "7", bootstrap: false }).text).toContain("user_id: 42");
  });
  test("bootstrap flag surfaced as warning", () => {
    expect(whoamiReply({ user_id: "42", chat_id: "7", bootstrap: true }).text).toContain("bootstrap_mode: true");
  });
});

describe("/provider", () => {
  test("claude → accepted", () => {
    expect(switchProvider({ requested: "claude" }).accepted).toBe(true);
  });
  test("gemini → not_enabled", () => {
    const r = switchProvider({ requested: "gemini" });
    expect(r.accepted).toBe(false);
    expect(r.message).toContain("not_enabled");
  });
});

// ---------------------------------------------------------------
// /doctor
// ---------------------------------------------------------------

describe("/doctor", () => {
  test("emits quick checks with {name, category, status, duration_ms}", async () => {
    const results = await runDoctor({
      db,
      required_bun_version: "1.3.11",
      current_bun_version: "1.3.11",
      bootstrap_whoami: false,
    });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(typeof r.name).toBe("string");
      expect(["quick", "deep"]).toContain(r.category);
      expect(["ok", "warn", "fail"]).toContain(r.status);
      expect(typeof r.duration_ms).toBe("number");
    }
  });

  test("bootstrap_whoami_guard warns when BOOTSTRAP_WHOAMI is on", async () => {
    const results = await runDoctor({
      db,
      required_bun_version: "1.3.11",
      current_bun_version: "1.3.11",
      bootstrap_whoami: true,
    });
    const guard = results.find((r) => r.name === "bootstrap_whoami_guard")!;
    expect(guard.status).toBe("warn");
  });

  test("bun_version mismatch warns", async () => {
    const results = await runDoctor({
      db,
      required_bun_version: "1.3.11",
      current_bun_version: "1.3.9",
      bootstrap_whoami: false,
    });
    const v = results.find((r) => r.name === "bun_version")!;
    expect(v.status).toBe("warn");
  });

  test("deep checks invoked when hooks present", async () => {
    let pinged = 0;
    const results = await runDoctor({
      db,
      required_bun_version: "1.3.11",
      current_bun_version: "1.3.11",
      bootstrap_whoami: false,
      telegram_ping: async () => {
        pinged += 1;
        return { ok: true, detail: "bot id 42" };
      },
      s3_ping: async () => ({ ok: true }),
    });
    expect(pinged).toBe(1);
    expect(results.some((r) => r.name === "telegram_api_reachable")).toBe(true);
    expect(results.some((r) => r.name === "s3_endpoint_smoke")).toBe(true);
  });
});

// ---------------------------------------------------------------
// /save_last_attachment
// ---------------------------------------------------------------

describe("/save_last_attachment", () => {
  test("promotes the most recent captured attachment to long_term + creates link", () => {
    db.prepare<unknown, [string, string, string, string]>(
      `INSERT INTO jobs(id, status, job_type, session_id, chat_id, request_json, idempotency_key, provider)
       VALUES(?, 'succeeded', 'provider_run', ?, ?, '{}', ?, 'fake')`,
    ).run("j-1", "sess-1", "chat-1", "ikey-save");
    db.prepare<unknown, [string]>(
      `INSERT INTO storage_objects
         (id, storage_backend, bucket, storage_key, source_channel, source_message_id,
          source_job_id, source_external_id, artifact_type, retention_class,
          capture_status, status, captured_at)
       VALUES(?, 's3', 'b', 'objects/2026/04/23/obj-save/pending.bin', 'telegram', '0', 'j-1', NULL, 'user_upload', 'session', 'captured', 'pending', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
    ).run("obj-save");
    db.prepare<unknown, [string]>(
      "INSERT INTO turns(id, session_id, job_id, role, content_redacted, redaction_applied) VALUES(?, 'sess-1', 'j-1', 'assistant', 'hi', 1)",
    ).run("turn-save");

    const r = saveLastAttachment({
      db,
      newId: () => "link-save",
      session_id: "sess-1",
      caption: "important diagram",
    });
    expect(r.promoted).toBe(true);
    const row = db
      .prepare<{ retention_class: string }, [string]>(
        "SELECT retention_class FROM storage_objects WHERE id = ?",
      )
      .get("obj-save")!;
    expect(row.retention_class).toBe("long_term");
    const link = db
      .prepare<{ provenance: string; caption_or_summary: string | null }, [string]>(
        "SELECT provenance, caption_or_summary FROM memory_artifact_links WHERE id = ?",
      )
      .get("link-save")!;
    expect(link.provenance).toBe("user_stated");
    expect(link.caption_or_summary).toBe("important diagram");
  });

  test("no captured attachment → promoted=false", () => {
    const r = saveLastAttachment({
      db,
      newId: () => "link-none",
      session_id: "sess-1",
    });
    expect(r.promoted).toBe(false);
  });
});
