// Phase 1B.3 — /judgment and /judgment_explain Telegram commands.

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
import { proposeJudgment, approveProposedJudgment, commitApprovedJudgment, recordJudgmentSource, linkJudgmentEvidence } from "../../src/judgment/repository.ts";
import { StubOutboundTransport } from "../../src/telegram/outbound.ts";
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
  workdir = mkdtempSync(join(tmpdir(), "actwyn-jcmd-"));
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

// Shared stub for verifying sent notification text.
let outboundStub: StubOutboundTransport;

function deps(overrides: Partial<WorkerDeps> = {}): WorkerDeps {
  outboundStub = new StubOutboundTransport();
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
    outbound: outboundStub,
    ...overrides,
  };
}

function seedCommandJob(id: string, ikey: string, command: string, args = ""): void {
  db.prepare<unknown, [string, string, string, string]>(
    `INSERT INTO jobs
       (id, status, job_type, session_id, user_id, chat_id, request_json, idempotency_key, provider)
     VALUES(?, 'queued', 'provider_run', ?, 'user-1', 'chat-1', ?, ?, 'fake')`,
  ).run(id, "sess-1", JSON.stringify({ command, args }), ikey);
}

// Judgment commands do not create turns (Phase 1B.3 design: prevents replay contamination).
// Verify via StubOutboundTransport.call_log — the text is sent to Telegram, not stored in DB.
function lastSentText(): string {
  const log = outboundStub.call_log;
  return log.length > 0 ? (log[log.length - 1]!.text ?? "") : "";
}

function seedActiveJudgment(judgmentId: string, statement: string): void {
  const proposed = proposeJudgment(
    db,
    {
      kind: "decision",
      statement,
      scope: { global: true },
      epistemic_origin: "user_stated",
      confidence: "high",
      importance: 5,
    },
    { newId: () => judgmentId },
  );
  const approved = approveProposedJudgment(db, { judgment_id: proposed.id, reviewer: "user-1" });
  // Evidence link is required before commit (Phase 1A.4 contract).
  const src = recordJudgmentSource(db, { kind: "user_statement", locator: `test:${judgmentId}` });
  linkJudgmentEvidence(db, { judgment_id: approved.id, source_id: src.id, relation: "supports" });
  commitApprovedJudgment(db, { judgment_id: approved.id, committer: "user-1", reason: "test seed" }, { nowIso: () => new Date().toISOString() });
}

describe("Phase 1B.3 — /judgment command", () => {
  test("/judgment with no active judgments returns empty message", async () => {
    seedCommandJob("j-jq-empty", "k-jq-empty", "/judgment");
    const result = await runWorkerOnce(deps());
    expect(result?.terminal).toBe("succeeded");
    expect(lastSentText()).toContain("활성 판단");
    expect(lastSentText()).toContain("없습니다");
  });

  test("/judgment lists active judgments with kind and statement", async () => {
    seedActiveJudgment("jdg-1", "SQLite를 canonical state store로 사용한다");
    seedCommandJob("j-jq-list", "k-jq-list", "/judgment");
    const result = await runWorkerOnce(deps());
    expect(result?.terminal).toBe("succeeded");
    const text = lastSentText();
    expect(text).toContain("decision");
    expect(text).toContain("SQLite를 canonical state store로 사용한다");
  });

  test("/judgment lists all active judgments regardless of scope (command-level query)", async () => {
    // /judgment uses executeJudgmentQueryTool which queries all active judgments.
    // Scope filtering only applies to context injection in buildContextForRun.
    seedActiveJudgment("jdg-list-1", "판단 항목 A");
    seedActiveJudgment("jdg-list-2", "판단 항목 B");
    seedCommandJob("j-jq-multi", "k-jq-multi", "/judgment");
    await runWorkerOnce(deps());
    const text = lastSentText();
    expect(text).toContain("판단 항목 A");
    expect(text).toContain("판단 항목 B");
  });

  test("/judgment does NOT insert a control_gate_events row (system command)", async () => {
    seedCommandJob("j-jq-cg", "k-jq-cg", "/judgment");
    await runWorkerOnce(deps());
    const cgCount = db
      .prepare<{ c: number }, []>("SELECT COUNT(*) AS c FROM control_gate_events")
      .get()!.c;
    expect(cgCount).toBe(0);
  });
});

describe("Phase 1B.3 — /judgment_explain command", () => {
  test("/judgment_explain with no id returns usage hint", async () => {
    seedCommandJob("j-je-noarg", "k-je-noarg", "/judgment_explain", "");
    const result = await runWorkerOnce(deps());
    expect(result?.terminal).toBe("succeeded");
    expect(lastSentText()).toContain("사용법");
  });

  test("/judgment_explain with unknown id returns not-found message", async () => {
    seedCommandJob("j-je-unknown", "k-je-unknown", "/judgment_explain", "nonexistent-id");
    const result = await runWorkerOnce(deps());
    expect(result?.terminal).toBe("succeeded");
    expect(lastSentText()).toContain("찾을 수 없습니다");
  });

  test("/judgment_explain with valid id returns judgment detail", async () => {
    seedActiveJudgment("jdg-explain-1", "WAL 모드를 SQLite에서 항상 사용한다");
    seedCommandJob("j-je-ok", "k-je-ok", "/judgment_explain", "jdg-explain-1");
    const result = await runWorkerOnce(deps());
    expect(result?.terminal).toBe("succeeded");
    const text = lastSentText();
    expect(text).toContain("decision");
    expect(text).toContain("WAL 모드를 SQLite에서 항상 사용한다");
    expect(text).toContain("active");
  });
});
