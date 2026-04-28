// Phase 1B.1 — Control Gate telemetry: every provider_run persists a
// control_gate_events row; system commands do not.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase, type DbHandle } from "../../src/db.ts";
import { migrate } from "../../src/db/migrator.ts";
import { createEmitter } from "../../src/observability/events.ts";
import { createRedactor } from "../../src/observability/redact.ts";
import { createFakeAdapter } from "../../src/providers/fake.ts";
import { runWorkerOnce, type WorkerDeps } from "../../src/queue/worker.ts";
import type { MimeProbe, TelegramFileTransport } from "../../src/telegram/attachment_capture.ts";

const MIGRATIONS = join(import.meta.dir, "..", "..", "migrations");

let workdir: string;
let db: DbHandle;

const noopTransport: TelegramFileTransport = {
  async getFile() { throw new Error("not called"); },
  async download() { throw new Error("not called"); },
};
const noopMime: MimeProbe = { async probe() { return "application/octet-stream"; } };

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "actwyn-cg-"));
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

let n = 0;
function deps(overrides: Partial<WorkerDeps> = {}): WorkerDeps {
  return {
    db,
    redactor: createRedactor(
      { email_pii_mode: false, phone_pii_mode: false, high_entropy_min_length: 32, high_entropy_min_bits_per_char: 4.0 },
      { exact_values: [] },
    ),
    events: createEmitter({ level: "error", sink: () => {} }),
    adapter: createFakeAdapter(),
    transport: noopTransport,
    mime: noopMime,
    newId: () => `gen-${(++n).toString().padStart(5, "0")}`,
    now: () => new Date("2026-04-28T00:00:00.000Z"),
    config: { capture: { max_download_size_bytes: 20 * 1024 * 1024, local_path: (id) => `${workdir}/objects/${id}` } },
    ...overrides,
  };
}

function seedProviderJob(id: string, ikey: string, message = "일반 메시지", command: string | null = null): void {
  db.prepare<unknown, [string, string, string, string]>(
    `INSERT INTO jobs
       (id, status, job_type, session_id, user_id, chat_id, request_json, idempotency_key, provider)
     VALUES(?, 'queued', 'provider_run', ?, 'user-1', 'chat-1', ?, ?, 'fake')`,
  ).run(id, "sess-1", JSON.stringify({ text: command ? undefined : message, command, args: "" }), ikey);
}

function cgRows(): Array<{ phase: string; level: string; direct_commit_allowed: number }> {
  return db
    .prepare<{ phase: string; level: string; direct_commit_allowed: number }, []>(
      "SELECT phase, level, direct_commit_allowed FROM control_gate_events ORDER BY created_at ASC",
    )
    .all();
}

describe("Phase 1B.1 — Control Gate telemetry", () => {
  test("provider_run inserts a control_gate_events row at L0 for ordinary message", async () => {
    seedProviderJob("j-cg-1", "k-cg-1", "안녕하세요");
    const result = await runWorkerOnce(deps());
    expect(result?.terminal).toBe("succeeded");

    const rows = cgRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.phase).toBe("turn");
    expect(rows[0]!.level).toBe("L0");
    // ADR-0012 invariant: direct_commit_allowed must always be 0.
    expect(rows[0]!.direct_commit_allowed).toBe(0);
  });

  test("system command (/status) does NOT insert a control_gate_events row", async () => {
    seedProviderJob("j-cg-sys", "k-cg-sys", "", "/status");
    await runWorkerOnce(deps());

    const rows = cgRows();
    expect(rows).toHaveLength(0);
  });

  test("two sequential provider_runs produce two control_gate_events rows", async () => {
    seedProviderJob("j-cg-a", "k-cg-a", "첫 번째");
    seedProviderJob("j-cg-b", "k-cg-b", "두 번째");

    await runWorkerOnce(deps());
    await runWorkerOnce(deps());

    const rows = cgRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.level).toBe("L0");
    expect(rows[1]!.level).toBe("L0");
  });

  test("each row has direct_commit_allowed=0 (ADR-0012 invariant)", async () => {
    seedProviderJob("j-cg-inv", "k-cg-inv");
    await runWorkerOnce(deps());

    const rows = cgRows();
    expect(rows.every((r) => r.direct_commit_allowed === 0)).toBe(true);
  });

  test("summary_generation job does NOT insert a control_gate_events row", async () => {
    db.prepare<unknown, [string, string, string, string]>(
      `INSERT INTO jobs
         (id, status, job_type, session_id, user_id, chat_id, request_json, idempotency_key, provider)
       VALUES(?, 'queued', 'summary_generation', ?, 'user-1', 'chat-1', ?, ?, 'fake')`,
    ).run("j-cg-sum", "sess-1", JSON.stringify({ command: "/summary", trigger: "manual" }), "k-cg-sum");
    await runWorkerOnce(deps());
    expect(cgRows()).toHaveLength(0);
  });

  test("all turns are recorded as L0 in Phase 1B.1 (signal detection deferred)", async () => {
    // Even messages that look like review requests are still recorded as L0
    // because Phase 1B.1 does not parse free-text for signals.
    seedProviderJob("j-cg-review", "k-cg-review", "이 판단을 검토해줘");
    await runWorkerOnce(deps());

    const rows = cgRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.level).toBe("L0");
  });
});
