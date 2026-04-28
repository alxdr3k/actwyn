import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase, type DbHandle } from "../../src/db.ts";
import { migrate } from "../../src/db/migrator.ts";
import { createRedactor } from "../../src/observability/redact.ts";
import {
  classifyUpdate,
  processBatch,
  readOffset,
  type InboundDeps,
} from "../../src/telegram/inbound.ts";
import type { TelegramUpdate } from "../../src/telegram/types.ts";

const MIGRATIONS = join(import.meta.dir, "..", "..", "migrations");

const AUTHORIZED_USER_ID = 1_000_001;
const UNAUTHORIZED_USER_ID = 999_999;

// Deterministic id generator so assertions are stable.
function idFactory(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `id-${n.toString().padStart(4, "0")}`;
  };
}

function buildDeps(db: DbHandle): InboundDeps {
  return {
    db,
    redactor: createRedactor(
      {
        email_pii_mode: true,
        phone_pii_mode: false,
        high_entropy_min_length: 32,
        high_entropy_min_bits_per_char: 4.0,
      },
      { exact_values: [] },
    ),
    config: {
      authorized_user_ids: new Set([AUTHORIZED_USER_ID]),
      bootstrap_whoami: false,
      attachment: { max_inbound_size_bytes: 20 * 1024 * 1024 },
      s3_bucket: "actwyn-test",
    },
    newId: idFactory(),
    now: () => new Date("2026-04-23T00:00:00.000Z"),
  };
}

function textMessageUpdate(update_id: number, text: string, userId = AUTHORIZED_USER_ID): TelegramUpdate {
  return {
    update_id,
    message: {
      message_id: update_id * 10,
      date: 1_700_000_000,
      from: { id: userId },
      chat: { id: 100, type: "private" },
      text,
    },
  };
}

function photoUpdate(update_id: number, opts: { claimed_size_bytes?: number; caption?: string } | number = {}): TelegramUpdate {
  const o: { claimed_size_bytes?: number; caption?: string } = typeof opts === "number" ? { claimed_size_bytes: opts } : opts;
  return {
    update_id,
    message: {
      message_id: update_id * 10,
      date: 1_700_000_000,
      from: { id: AUTHORIZED_USER_ID },
      chat: { id: 100, type: "private" },
      photo: [
        o.claimed_size_bytes !== undefined
          ? { file_id: `photo-${update_id}-lg`, file_unique_id: `u${update_id}`, width: 1920, height: 1080, file_size: o.claimed_size_bytes }
          : { file_id: `photo-${update_id}-lg`, file_unique_id: `u${update_id}`, width: 1920, height: 1080 },
        { file_id: `photo-${update_id}-sm`, file_unique_id: `v${update_id}`, width: 90, height: 90 },
      ],
      ...(o.caption !== undefined ? { caption: o.caption } : {}),
    },
  };
}

function documentUpdate(update_id: number, opts: Partial<{ filename: string; mime: string; size: number }> = {}): TelegramUpdate {
  return {
    update_id,
    message: {
      message_id: update_id * 10,
      date: 1_700_000_000,
      from: { id: AUTHORIZED_USER_ID },
      chat: { id: 100, type: "private" },
      document: {
        file_id: `doc-${update_id}`,
        file_unique_id: `u${update_id}`,
        file_name: opts.filename ?? "hello.pdf",
        mime_type: opts.mime ?? "application/pdf",
        file_size: opts.size ?? 1024,
      },
    },
  };
}

let workdir: string;
let db: DbHandle;
let deps: InboundDeps;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "actwyn-inbound-"));
  db = openDatabase({ path: join(workdir, "t.db"), busyTimeoutMs: 250 });
  migrate(db, MIGRATIONS);
  deps = buildDeps(db);
});

afterEach(() => {
  db.close();
  rmSync(workdir, { recursive: true, force: true });
});

function countJobs(): number {
  return (db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM jobs").get()?.n) ?? 0;
}

function countStorageObjects(): number {
  return (db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM storage_objects").get()?.n) ?? 0;
}

function getUpdateRow(
  update_id: number,
): { status: string; skip_reason: string | null; job_id: string | null } {
  return db
    .prepare<
      { status: string; skip_reason: string | null; job_id: string | null },
      [number]
    >("SELECT status, skip_reason, job_id FROM telegram_updates WHERE update_id = ?")
    .get(update_id)!;
}

// ---------------------------------------------------------------
// Pure classifier
// ---------------------------------------------------------------

describe("classifyUpdate — pure", () => {
  const opts = {
    authorized_user_ids: new Set([AUTHORIZED_USER_ID]),
    bootstrap_whoami: false,
  };

  test("unauthorized text → skip/unauthorized", () => {
    const c = classifyUpdate(textMessageUpdate(1, "hello", UNAUTHORIZED_USER_ID), opts);
    expect(c.kind).toBe("skip");
    expect((c as any).reason).toBe("unauthorized");
  });

  test("authorized plain text → text", () => {
    const c = classifyUpdate(textMessageUpdate(2, "hello"), opts);
    expect(c.kind).toBe("text");
  });

  test("authorized slash command /status", () => {
    const c = classifyUpdate(textMessageUpdate(3, "/status"), opts);
    expect(c.kind).toBe("command");
    if (c.kind === "command") {
      expect(c.command).toBe("/status");
      expect(c.args).toBe("");
    }
  });

  test("authorized slash command with args: /forget_artifact abc123", () => {
    const c = classifyUpdate(textMessageUpdate(4, "/forget_artifact abc123"), opts);
    expect(c.kind).toBe("command");
    if (c.kind === "command") {
      expect(c.command).toBe("/forget_artifact");
      expect(c.args).toBe("abc123");
    }
  });

  test("command with @botname suffix still matches", () => {
    const c = classifyUpdate(textMessageUpdate(5, "/status@actwynbot"), opts);
    expect(c.kind).toBe("command");
    if (c.kind === "command") {
      expect(c.command).toBe("/status");
    }
  });

  test("unknown slash → unknown_command (not forwarded to provider as text)", () => {
    const c = classifyUpdate(textMessageUpdate(6, "/nothing here"), opts);
    expect(c.kind).toBe("unknown_command");
    if (c.kind === "unknown_command") expect(c.command).toBe("/nothing");
  });

  // Phase 1B.3 — judgment commands must be recognized as known commands.
  test("/judgment is recognized as a known command (Phase 1B.3)", () => {
    const c = classifyUpdate(textMessageUpdate(7, "/judgment"), opts);
    expect(c.kind).toBe("command");
    if (c.kind === "command") {
      expect(c.command).toBe("/judgment");
      expect(c.args).toBe("");
    }
  });

  test("/judgment_explain <id> is recognized as a known command with args (Phase 1B.3)", () => {
    const c = classifyUpdate(textMessageUpdate(8, "/judgment_explain abc-123"), opts);
    expect(c.kind).toBe("command");
    if (c.kind === "command") {
      expect(c.command).toBe("/judgment_explain");
      expect(c.args).toBe("abc-123");
    }
  });

  test("unsupported update (no message, no from) → skip/unsupported_type", () => {
    const c = classifyUpdate({ update_id: 7, edited_message: {} } as TelegramUpdate, opts);
    expect(c.kind).toBe("skip");
    if (c.kind === "skip") expect(c.reason).toBe("unsupported_type");
  });

  test("Blocker 7: group chat from authorized user → skip/unsupported_chat_type", () => {
    const groupUpdate: TelegramUpdate = {
      update_id: 201,
      message: {
        message_id: 2010,
        date: 1_700_000_000,
        from: { id: AUTHORIZED_USER_ID },
        chat: { id: -1001234567890, type: "group" },
        text: "hi everyone",
      },
    };
    const c = classifyUpdate(groupUpdate, opts);
    expect(c.kind).toBe("skip");
    if (c.kind === "skip") expect(c.reason).toBe("unsupported_chat_type");
  });

  test("Blocker 7: supergroup and channel are also rejected", () => {
    for (const chatType of ["supergroup", "channel"] as const) {
      const u: TelegramUpdate = {
        update_id: 202,
        message: {
          message_id: 2020,
          date: 1_700_000_000,
          from: { id: AUTHORIZED_USER_ID },
          chat: { id: -100555, type: chatType },
          text: "mentioned",
        },
      };
      const c = classifyUpdate(u, opts);
      expect(c.kind).toBe("skip");
      if (c.kind === "skip") expect(c.reason).toBe("unsupported_chat_type");
    }
  });

  test("Blocker 7 (writer): group chat message creates no job and no session", () => {
    // Also verify via the full writer path. Use an isolated deps with a fresh id factory.
    const u: TelegramUpdate = {
      update_id: 203,
      message: {
        message_id: 2030,
        date: 1_700_000_000,
        from: { id: AUTHORIZED_USER_ID },
        chat: { id: -100222, type: "group" },
        text: "group msg",
      },
    };
    processBatch(deps, [u]);
    const row = getUpdateRow(203);
    expect(row.status).toBe("skipped");
    expect(row.skip_reason).toBe("unsupported_chat_type");
    expect(countJobs()).toBe(0);
    const sessN = db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM sessions").get()!.n;
    expect(sessN).toBe(0);
  });

  test("bootstrap_whoami: unauthorized /whoami → whoami_bootstrap", () => {
    const c = classifyUpdate(textMessageUpdate(8, "/whoami", UNAUTHORIZED_USER_ID), {
      ...opts,
      bootstrap_whoami: true,
    });
    expect(c.kind).toBe("whoami_bootstrap");
  });
});

// ---------------------------------------------------------------
// Writer behaviour
// ---------------------------------------------------------------

describe("processBatch — base cases", () => {
  test("empty batch advances offset no further than current", () => {
    const result = processBatch(deps, []);
    expect(result.processed).toEqual([]);
    expect(result.offset_after).toBe(0);
  });

  test("authorized text: job created, telegram_updates enqueued, offset advanced", () => {
    const result = processBatch(deps, [textMessageUpdate(42, "hello")]);
    expect(result.processed.length).toBe(1);
    expect(result.processed[0]!.telegram_status).toBe("enqueued");
    expect(result.processed[0]!.job_id).toBeTruthy();
    expect(result.offset_after).toBe(43);
    expect(getUpdateRow(42).status).toBe("enqueued");
    expect(readOffset(db)).toBe(43);
    expect(countJobs()).toBe(1);
  });

  test("authorized command `/status`: creates a provider_run job with request_json.command set", () => {
    processBatch(deps, [textMessageUpdate(50, "/status")]);
    const row = db
      .prepare<{ request_json: string; job_type: string }>(
        "SELECT request_json, job_type FROM jobs LIMIT 1",
      )
      .get()!;
    expect(row.job_type).toBe("provider_run");
    const payload = JSON.parse(row.request_json);
    expect(payload.command).toBe("/status");
  });

  test("authorized `/summary` maps to a summary_generation job", () => {
    processBatch(deps, [textMessageUpdate(51, "/summary")]);
    const row = db
      .prepare<{ job_type: string }>("SELECT job_type FROM jobs LIMIT 1")
      .get()!;
    expect(row.job_type).toBe("summary_generation");
  });

  test("authorized `/end` maps to a summary_generation job", () => {
    processBatch(deps, [textMessageUpdate(52, "/end")]);
    const row = db
      .prepare<{ job_type: string; request_json: string }>("SELECT job_type, request_json FROM jobs LIMIT 1")
      .get()!;
    expect(row.job_type).toBe("summary_generation");
    expect(JSON.parse(row.request_json).command).toBe("/end");
  });
});

// ---------------------------------------------------------------
// AC-TEL-001: unauthorized never creates a job
// ---------------------------------------------------------------

describe("AC-TEL-001 — unauthorized sender never creates a job", () => {
  test("single unauthorized → row=skipped(reason=unauthorized), 0 jobs, offset still advances", () => {
    const result = processBatch(deps, [textMessageUpdate(1, "hi", UNAUTHORIZED_USER_ID)]);
    expect(result.processed[0]!.telegram_status).toBe("skipped");
    expect(result.processed[0]!.skip_reason).toBe("unauthorized");
    expect(countJobs()).toBe(0);
    expect(result.offset_after).toBe(2);
    expect(getUpdateRow(1).skip_reason).toBe("unauthorized");
  });

  test("mixed batch: unauthorized is skipped, authorized produces a job", () => {
    processBatch(deps, [
      textMessageUpdate(1, "spy", UNAUTHORIZED_USER_ID),
      textMessageUpdate(2, "real"),
    ]);
    expect(countJobs()).toBe(1);
    expect(getUpdateRow(1).status).toBe("skipped");
    expect(getUpdateRow(2).status).toBe("enqueued");
  });
});

// ---------------------------------------------------------------
// AC-TEL-003: duplicate update_id never creates a second job
// ---------------------------------------------------------------

describe("AC-TEL-003 — duplicate update_id", () => {
  test("same update delivered twice → 1 job, offset invariant holds", () => {
    const u = textMessageUpdate(77, "duplicate test");
    processBatch(deps, [u]);
    processBatch(deps, [u]);
    expect(countJobs()).toBe(1);
    // offset may not move backwards.
    expect(readOffset(db)).toBe(78);
  });

  test("Blocker 6: duplicate attachment update does NOT create a second storage_objects row", () => {
    const u = documentUpdate(301, { filename: "x.pdf", mime: "application/pdf", size: 1024 });
    processBatch(deps, [u]);
    expect(countStorageObjects()).toBe(1);
    processBatch(deps, [u]);
    // Same update_id re-delivered → NO new storage_objects (and no new job).
    expect(countStorageObjects()).toBe(1);
    expect(countJobs()).toBe(1);
  });

  test("Blocker 6: duplicate terminal-skipped update is not re-classified (no session promotion)", () => {
    // Unauthorized sender → skipped.
    const u = textMessageUpdate(311, "hi", UNAUTHORIZED_USER_ID);
    processBatch(deps, [u]);
    expect(countJobs()).toBe(0);
    expect(getUpdateRow(311).status).toBe("skipped");

    // Re-deliver: still skipped, no jobs, no sessions created.
    processBatch(deps, [u]);
    expect(countJobs()).toBe(0);
    const sessN = db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM sessions").get()!.n;
    expect(sessN).toBe(0);
  });

  test("Follow-up: duplicate update with prior status='failed' IS reprocessed (recovery path, not silently dropped)", () => {
    // Insert a row that already exists in `failed` (e.g., a previous classify
    // pass crashed and the operator marked it failed for retry). A duplicate
    // delivery of the same update_id must go back through classifyAndCommit
    // so the job actually gets enqueued.
    const u = textMessageUpdate(321, "retry me");
    db.prepare<unknown, [number, string]>(
      `INSERT INTO telegram_updates(update_id, chat_id, user_id, update_type, status, raw_update_json_redacted)
       VALUES(?, '100', '${AUTHORIZED_USER_ID}', 'message', 'failed', ?)`,
    ).run(321, JSON.stringify(u));

    processBatch(deps, [u]);
    // After reprocessing, the row should be enqueued and a job should exist.
    const row = getUpdateRow(321);
    expect(row.status).toBe("enqueued");
    expect(row.job_id).not.toBeNull();
    expect(countJobs()).toBe(1);
  });
});

// ---------------------------------------------------------------
// AC-STO-003a: attachment inbound metadata is txn-local, bytes-free
// ---------------------------------------------------------------

describe("AC-STO-003a — attachment inbound metadata (no network I/O)", () => {
  test("photo update: storage_objects row with capture_status='pending', NULL bytes", () => {
    processBatch(deps, [photoUpdate(100)]);
    const row = db
      .prepare<
        {
          capture_status: string;
          status: string;
          sha256: string | null;
          mime_type: string | null;
          size_bytes: number | null;
          source_external_id: string | null;
          retention_class: string;
          source_channel: string;
        }
      >(
        "SELECT capture_status, status, sha256, mime_type, size_bytes, source_external_id, retention_class, source_channel FROM storage_objects LIMIT 1",
      )
      .get()!;
    expect(row.capture_status).toBe("pending");
    expect(row.status).toBe("pending");
    expect(row.sha256).toBeNull();
    expect(row.mime_type).toBeNull();
    expect(row.size_bytes).toBeNull();
    expect(row.source_external_id).toBe("photo-100-lg"); // the largest photo
    expect(row.retention_class).toBe("session");
    expect(row.source_channel).toBe("telegram");
  });

  test("document update: single storage_objects row", () => {
    processBatch(deps, [documentUpdate(101)]);
    expect(countStorageObjects()).toBe(1);
  });

  test("oversize-by-claim: capture_status='failed' with oversize_inbound reason", () => {
    processBatch(deps, [documentUpdate(102, { size: 200 * 1024 * 1024 })]);
    const row = db
      .prepare<
        { capture_status: string; capture_error_json: string | null; source_external_id: string | null }
      >(
        "SELECT capture_status, capture_error_json, source_external_id FROM storage_objects LIMIT 1",
      )
      .get()!;
    expect(row.capture_status).toBe("failed");
    expect(row.capture_error_json).toContain("oversize_inbound");
    // retention policy: oversize-inbound rows clear source_external_id too.
    expect(row.source_external_id).toBeNull();
  });

  test("filename containing email is NOT persisted (§15 redaction safety)", () => {
    processBatch(deps, [documentUpdate(103, { filename: "invoice-alice@example.com.pdf" })]);
    const row = db
      .prepare<{ original_filename_redacted: string | null }>(
        "SELECT original_filename_redacted FROM storage_objects LIMIT 1",
      )
      .get()!;
    expect(row.original_filename_redacted).toBeNull();
  });
});

// ---------------------------------------------------------------
// Offset + status integrity when the batch spans multiple items
// ---------------------------------------------------------------

describe("processBatch — mixed 50-update stub-style batch", () => {
  test("counts roll up correctly and offset = max(update_id) + 1", () => {
    const updates: TelegramUpdate[] = [];
    for (let i = 1; i <= 50; i++) {
      if (i % 10 === 0) {
        updates.push(textMessageUpdate(i, "spy", UNAUTHORIZED_USER_ID));
      } else if (i % 7 === 0) {
        updates.push({ update_id: i, edited_message: {} } as TelegramUpdate);
      } else {
        updates.push(textMessageUpdate(i, `msg ${i}`));
      }
    }
    const r = processBatch(deps, updates);
    expect(r.offset_after).toBe(51);
    const enqueued = r.processed.filter((p) => p.telegram_status === "enqueued").length;
    const skipped = r.processed.filter((p) => p.telegram_status === "skipped").length;
    expect(enqueued + skipped).toBe(50);
    expect(countJobs()).toBe(enqueued);
  });
});

// ---------------------------------------------------------------
// TEST-ATTACH-CAPTION-SAVE: photo + save-intent caption → long_term
// ---------------------------------------------------------------

describe("attachment + save-intent caption — retention_class=long_term (Blocker 2)", () => {
  test("photo with caption '저장해줘' gets retention_class=long_term", () => {
    processBatch(deps, [photoUpdate(300, { caption: "이 사진 저장해줘" })]);
    const row = db
      .prepare<{ retention_class: string }>(
        "SELECT retention_class FROM storage_objects LIMIT 1",
      )
      .get()!;
    expect(row.retention_class).toBe("long_term");
  });

  test("photo without save-intent caption gets retention_class=session", () => {
    processBatch(deps, [photoUpdate(301, { caption: "그냥 사진이야" })]);
    const row = db
      .prepare<{ retention_class: string }>(
        "SELECT retention_class FROM storage_objects LIMIT 1",
      )
      .get()!;
    expect(row.retention_class).toBe("session");
  });

  test("photo with no caption gets retention_class=session", () => {
    processBatch(deps, [photoUpdate(302)]);
    const row = db
      .prepare<{ retention_class: string }>(
        "SELECT retention_class FROM storage_objects LIMIT 1",
      )
      .get()!;
    expect(row.retention_class).toBe("session");
  });
});

// ---------------------------------------------------------------
// TEST-TEL-UNKNOWN-SLASH: unknown /foobar → instant_response, no job
// ---------------------------------------------------------------

describe("unknown slash command (Medium 11)", () => {
  test("/foobar produces skipped status, instant_response, and no job", () => {
    const result = processBatch(deps, [textMessageUpdate(400, "/foobar arg1")]);
    expect(result.processed).toHaveLength(1);
    const outcome = result.processed[0]!;
    expect(outcome.telegram_status).toBe("skipped");
    expect(outcome.job_id).toBeNull();
    expect(outcome.instant_response).toBeDefined();
    expect(outcome.instant_response!.text).toContain("/foobar");
    expect(outcome.instant_response!.text).toContain("/help");
    expect(countJobs()).toBe(0);
  });

  test("known command /help does not produce instant_response via unknown path", () => {
    const result = processBatch(deps, [textMessageUpdate(401, "/help")]);
    expect(result.processed[0]!.telegram_status).toBe("enqueued");
    expect(result.processed[0]!.instant_response).toBeUndefined();
  });
});

// ---------------------------------------------------------------
// TEST-CANCEL-CONTROL-PLANE: /cancel sends instant_response without queuing
// ---------------------------------------------------------------

describe("/cancel control-plane (Blocker 1)", () => {
  test("/cancel with no running job → instant_response 'not_found', no job created", () => {
    const result = processBatch(deps, [textMessageUpdate(500, "/cancel")]);
    expect(result.processed).toHaveLength(1);
    const outcome = result.processed[0]!;
    expect(outcome.telegram_status).toBe("enqueued");
    expect(outcome.job_id).toBeNull();
    expect(outcome.instant_response).toBeDefined();
    expect(outcome.instant_response!.text).toContain("취소");
    expect(countJobs()).toBe(0);
  });

  test("/cancel with shared cancel_handles calls abort on matching running job", () => {
    const cancelHandles = new Map<string, AbortController>();
    const ac = new AbortController();
    // Pre-seed session and running job so cancelJob can find it.
    db.prepare(
      "INSERT OR IGNORE INTO sessions(id, chat_id, user_id) VALUES('sess-c', '100', ?)",
    ).run(String(AUTHORIZED_USER_ID));
    db.prepare(
      `INSERT INTO jobs(id, status, job_type, session_id, user_id, chat_id, request_json, idempotency_key, provider)
       VALUES('j-running', 'running', 'provider_run', 'sess-c', '${AUTHORIZED_USER_ID}', '100', '{}', 'ikey-r', 'fake')`,
    ).run();
    cancelHandles.set("j-running", ac);

    const depsWithHandles: InboundDeps = { ...buildDeps(db), cancel_handles: cancelHandles };
    const result = processBatch(depsWithHandles, [textMessageUpdate(501, "/cancel")]);

    expect(ac.signal.aborted).toBe(true);
    expect(result.processed[0]!.instant_response).toBeDefined();
    const jobRow = db.prepare<{ status: string }>("SELECT status FROM jobs WHERE id = 'j-running'").get()!;
    expect(jobRow.status).toBe("running");
  });
});

// ---------------------------------------------------------------
// raw_update_json_redacted never contains an email literal when the
// message text is an email.
// ---------------------------------------------------------------

describe("inbound redaction — email in message text is redacted before persisting", () => {
  test("telegram_updates.raw_update_json_redacted does not contain the raw email", () => {
    processBatch(deps, [textMessageUpdate(200, "contact me at alice@example.com please")]);
    const row = db
      .prepare<{ raw_update_json_redacted: string }, [number]>(
        "SELECT raw_update_json_redacted FROM telegram_updates WHERE update_id = ?",
      )
      .get(200)!;
    expect(row.raw_update_json_redacted).not.toContain("alice@example.com");
    expect(row.raw_update_json_redacted).toContain("[REDACTED:");
  });
});
