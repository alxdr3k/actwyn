// Phase 1B.2 — Context injection scope and summary_generation exclusion.

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
import {
  proposeJudgment,
  approveProposedJudgment,
  commitApprovedJudgment,
  recordJudgmentSource,
  linkJudgmentEvidence,
} from "../../src/judgment/repository.ts";
import type { MimeProbe, TelegramFileTransport } from "../../src/telegram/attachment_capture.ts";

const MIGRATIONS = join(import.meta.dir, "..", "..", "migrations");

let workdir: string;
let db: DbHandle;

const noopTransport: TelegramFileTransport = {
  async getFile() { throw new Error("not called"); },
  async download() { throw new Error("not called"); },
};
const noopMime: MimeProbe = { async probe() { return "application/octet-stream"; } };

let n = 0;
beforeEach(() => {
  n = 0;
  workdir = mkdtempSync(join(tmpdir(), "actwyn-jci-"));
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

function seedProviderJob(id: string, ikey: string, message = "메시지"): void {
  db.prepare<unknown, [string, string, string, string]>(
    `INSERT INTO jobs
       (id, status, job_type, session_id, user_id, chat_id, request_json, idempotency_key, provider)
     VALUES(?, 'queued', 'provider_run', ?, 'user-1', 'chat-1', ?, ?, 'fake')`,
  ).run(id, "sess-1", JSON.stringify({ text: message, command: null, args: "" }), ikey);
}

function seedActiveScopedJudgment(judgmentId: string, statement: string, scope: Record<string, unknown>): void {
  const proposed = proposeJudgment(
    db,
    { kind: "decision", statement, scope, epistemic_origin: "user_stated", confidence: "high", importance: 5 },
    { newId: () => judgmentId },
  );
  const approved = approveProposedJudgment(db, { judgment_id: proposed.id, reviewer: "user-1" });
  const src = recordJudgmentSource(db, { kind: "user_statement", locator: `test:${judgmentId}` });
  linkJudgmentEvidence(db, { judgment_id: approved.id, source_id: src.id, relation: "supports" });
  commitApprovedJudgment(db, { judgment_id: approved.id, committer: "user-1", reason: "test" }, { nowIso: () => new Date().toISOString() });
}

// argv_json_redacted stores {message, channel} — the packed message sent to Claude.
// injected_snapshot_json stores slot metadata (key/tokens) but not the text.
function argvMessageFor(jobId: string): string {
  const row = db
    .prepare<{ argv_json_redacted: string | null }, [string]>(
      "SELECT argv_json_redacted FROM provider_runs WHERE job_id = ?",
    )
    .get(jobId);
  if (!row?.argv_json_redacted) return "";
  try {
    const parsed = JSON.parse(row.argv_json_redacted) as { message?: string };
    return parsed.message ?? "";
  } catch { return ""; }
}

function snapshotSlotsFor(jobId: string): string[] {
  const row = db
    .prepare<{ injected_snapshot_json: string | null }, [string]>(
      "SELECT injected_snapshot_json FROM provider_runs WHERE job_id = ?",
    )
    .get(jobId);
  if (!row?.injected_snapshot_json) return [];
  try {
    const parsed = JSON.parse(row.injected_snapshot_json) as { slots?: Array<{ key: string }> };
    return (parsed.slots ?? []).map((s) => s.key);
  } catch { return []; }
}

describe("Phase 1B.2 — context injection scope", () => {
  test("global-scope active judgment appears in packed message (argv_json_redacted)", async () => {
    seedActiveScopedJudgment("jdg-global", "전역 판단: WAL 항상 사용", { global: true });
    seedProviderJob("j-snap-global", "k-snap-global", "안녕");
    await runWorkerOnce(deps());
    const msg = argvMessageFor("j-snap-global");
    expect(msg).toContain("전역 판단: WAL 항상 사용");
    // Slot metadata confirms injection.
    expect(snapshotSlotsFor("j-snap-global")).toContain("judgment_active");
  });

  test("non-global-scope active judgment does NOT appear in packed message", async () => {
    seedActiveScopedJudgment("jdg-session", "세션 한정 판단", { session: "sess-specific" });
    seedProviderJob("j-snap-scoped", "k-snap-scoped", "안녕");
    await runWorkerOnce(deps());
    const msg = argvMessageFor("j-snap-scoped");
    expect(msg).not.toContain("세션 한정 판단");
    expect(snapshotSlotsFor("j-snap-scoped")).not.toContain("judgment_active");
  });

  test("archived judgment (retention_state=archived) does NOT appear in packed message", async () => {
    seedActiveScopedJudgment("jdg-arch", "아카이브된 판단", { global: true });
    db.prepare<unknown, [string]>(
      "UPDATE judgment_items SET retention_state = 'archived' WHERE id = ?",
    ).run("jdg-arch");
    seedProviderJob("j-snap-arch", "k-snap-arch", "안녕");
    await runWorkerOnce(deps());
    const msg = argvMessageFor("j-snap-arch");
    expect(msg).not.toContain("아카이브된 판단");
  });
});

describe("Phase 1B.2 — temporal validity filtering", () => {
  test("judgment with future valid_from does NOT appear in packed message", async () => {
    seedActiveScopedJudgment("jdg-future", "미래 판단", { global: true });
    db.prepare<unknown, [string, string]>(
      "UPDATE judgment_items SET valid_from = ? WHERE id = ?",
    ).run("2099-12-31T00:00:00.000Z", "jdg-future");
    seedProviderJob("j-future", "k-future", "안녕");
    await runWorkerOnce(deps());
    expect(argvMessageFor("j-future")).not.toContain("미래 판단");
  });

  test("judgment with past valid_until does NOT appear in packed message", async () => {
    seedActiveScopedJudgment("jdg-expired", "만료된 판단", { global: true });
    db.prepare<unknown, [string, string]>(
      "UPDATE judgment_items SET valid_until = ? WHERE id = ?",
    ).run("2020-01-01T00:00:00.000Z", "jdg-expired");
    seedProviderJob("j-expired", "k-expired", "안녕");
    await runWorkerOnce(deps());
    expect(argvMessageFor("j-expired")).not.toContain("만료된 판단");
  });

  test("judgment with null valid_from and valid_until always qualifies", async () => {
    seedActiveScopedJudgment("jdg-no-window", "창 없는 판단", { global: true });
    seedProviderJob("j-no-window", "k-no-window", "안녕");
    await runWorkerOnce(deps());
    expect(argvMessageFor("j-no-window")).toContain("창 없는 판단");
  });
});

describe("Phase 1B.3 — judgment command turns exclusion", () => {
  test("/judgment command does NOT create a conversation turn", async () => {
    seedActiveScopedJudgment("jdg-turn-test", "턴 테스트 판단", { global: true });
    db.prepare<unknown, [string, string, string, string]>(
      `INSERT INTO jobs
         (id, status, job_type, session_id, user_id, chat_id, request_json, idempotency_key, provider)
       VALUES(?, 'queued', 'provider_run', ?, 'user-1', 'chat-1', ?, ?, 'fake')`,
    ).run("j-jcmd-turn", "sess-1", JSON.stringify({ command: "/judgment", args: "" }), "k-jcmd-turn");
    await runWorkerOnce(deps());
    const turns = db
      .prepare<{ role: string; content_redacted: string }, [string]>(
        "SELECT role, content_redacted FROM turns WHERE job_id = ?",
      )
      .all("j-jcmd-turn");
    // Judgment commands must not produce a turn (to prevent replay contamination).
    expect(turns).toHaveLength(0);
  });
});

describe("Phase 1B.2 — summary_generation exclusion", () => {
  test("active global judgment does NOT appear in summary_generation packed message", async () => {
    seedActiveScopedJudgment("jdg-sum", "요약에 포함되면 안 됨", { global: true });
    db.prepare<unknown, [string, string, string, string]>(
      `INSERT INTO jobs
         (id, status, job_type, session_id, user_id, chat_id, request_json, idempotency_key, provider)
       VALUES(?, 'queued', 'summary_generation', ?, 'user-1', 'chat-1', ?, ?, 'fake')`,
    ).run("j-sumgen", "sess-1", JSON.stringify({ command: "/summary", trigger: "manual" }), "k-sumgen");
    await runWorkerOnce(deps());
    const msg = argvMessageFor("j-sumgen");
    expect(msg).not.toContain("요약에 포함되면 안 됨");
    expect(snapshotSlotsFor("j-sumgen")).not.toContain("judgment_active");
  });
});
