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

describe("Phase 1B.4 — /judgment_propose command", () => {
  test("/judgment_propose with no args returns usage hint", async () => {
    seedCommandJob("j-jp-noarg", "k-jp-noarg", "/judgment_propose", "");
    const result = await runWorkerOnce(deps());
    expect(result?.terminal).toBe("succeeded");
    expect(lastSentText()).toContain("사용법");
  });

  test("/judgment_propose creates a proposed judgment with default kind=decision", async () => {
    seedCommandJob("j-jp-ok", "k-jp-ok", "/judgment_propose", "SQLite WAL 모드를 항상 활성화한다");
    const result = await runWorkerOnce(deps());
    expect(result?.terminal).toBe("succeeded");
    const text = lastSentText();
    expect(text).toContain("제안됨");
    expect(text).toContain("decision");
  });

  test("/judgment_propose with kind: prefix creates judgment with that kind", async () => {
    seedCommandJob("j-jp-kind", "k-jp-kind", "/judgment_propose", "kind:preference 코드 리뷰를 PR 제출 전에 실행한다");
    const result = await runWorkerOnce(deps());
    expect(result?.terminal).toBe("succeeded");
    const text = lastSentText();
    expect(text).toContain("제안됨");
    expect(text).toContain("preference");
  });

  test("/judgment_propose does NOT store a turn", async () => {
    seedCommandJob("j-jp-turn", "k-jp-turn", "/judgment_propose", "테스트 판단");
    await runWorkerOnce(deps());
    const turns = db.prepare<{ c: number }, []>("SELECT COUNT(*) AS c FROM turns").get()!.c;
    expect(turns).toBe(0);
  });

  test("/judgment_propose does NOT insert a control_gate_events row", async () => {
    seedCommandJob("j-jp-cg", "k-jp-cg", "/judgment_propose", "테스트 판단");
    await runWorkerOnce(deps());
    const cgCount = db.prepare<{ c: number }, []>("SELECT COUNT(*) AS c FROM control_gate_events").get()!.c;
    expect(cgCount).toBe(0);
  });
});

describe("Phase 1B.4 — /judgment_approve and /judgment_reject commands", () => {
  test("/judgment_approve with no id returns usage hint", async () => {
    seedCommandJob("j-ja-noarg", "k-ja-noarg", "/judgment_approve", "");
    const result = await runWorkerOnce(deps());
    expect(result?.terminal).toBe("succeeded");
    expect(lastSentText()).toContain("사용법");
  });

  test("/judgment_approve with unknown id returns not-found", async () => {
    seedCommandJob("j-ja-unknown", "k-ja-unknown", "/judgment_approve", "nonexistent-id");
    const result = await runWorkerOnce(deps());
    expect(result?.terminal).toBe("succeeded");
    expect(lastSentText()).toContain("찾을 수 없습니다");
  });

  test("/judgment_approve approves a proposed judgment", async () => {
    const proposed = proposeJudgment(db, {
      kind: "decision",
      statement: "TypeScript strict mode를 활성화한다",
      epistemic_origin: "user_stated",
      confidence: "high",
      scope: { global: true },
    }, { newId: () => "jdg-approve-1" });
    seedCommandJob("j-ja-ok", "k-ja-ok", "/judgment_approve", proposed.id);
    const result = await runWorkerOnce(deps());
    expect(result?.terminal).toBe("succeeded");
    const text = lastSentText();
    expect(text).toContain("승인됨");
    expect(text).toContain("approved");
  });

  test("/judgment_reject with no reason returns usage hint", async () => {
    seedCommandJob("j-jr-noarg", "k-jr-noarg", "/judgment_reject", "some-id");
    const result = await runWorkerOnce(deps());
    expect(result?.terminal).toBe("succeeded");
    expect(lastSentText()).toContain("사용법");
  });

  test("/judgment_reject rejects a proposed judgment", async () => {
    const proposed = proposeJudgment(db, {
      kind: "decision",
      statement: "거부될 판단",
      epistemic_origin: "user_stated",
      confidence: "low",
      scope: { global: true },
    }, { newId: () => "jdg-reject-1" });
    seedCommandJob("j-jr-ok", "k-jr-ok", "/judgment_reject", `${proposed.id} 근거 부족`);
    const result = await runWorkerOnce(deps());
    expect(result?.terminal).toBe("succeeded");
    const text = lastSentText();
    expect(text).toContain("거부됨");
    expect(text).toContain("rejected");
  });

  test("/judgment_approve does NOT store a turn", async () => {
    const proposed = proposeJudgment(db, {
      kind: "decision",
      statement: "테스트용 판단",
      epistemic_origin: "user_stated",
      confidence: "high",
      scope: { global: true },
    }, { newId: () => "jdg-turn-test" });
    seedCommandJob("j-ja-turn", "k-ja-turn", "/judgment_approve", proposed.id);
    await runWorkerOnce(deps());
    const turns = db.prepare<{ c: number }, []>("SELECT COUNT(*) AS c FROM turns").get()!.c;
    expect(turns).toBe(0);
  });
});

describe("Phase 1B.4 — /judgment_source and /judgment_link commands", () => {
  test("/judgment_source with no args returns usage hint", async () => {
    seedCommandJob("j-js-noarg", "k-js-noarg", "/judgment_source", "");
    const result = await runWorkerOnce(deps());
    expect(result?.terminal).toBe("succeeded");
    expect(lastSentText()).toContain("사용법");
  });

  test("/judgment_source records a source", async () => {
    seedCommandJob("j-js-ok", "k-js-ok", "/judgment_source", "user_statement https://example.com/doc");
    const result = await runWorkerOnce(deps());
    expect(result?.terminal).toBe("succeeded");
    const text = lastSentText();
    expect(text).toContain("소스 기록됨");
    expect(text).toContain("user_statement");
  });

  test("/judgment_link with missing args returns usage hint", async () => {
    seedCommandJob("j-jl-noarg", "k-jl-noarg", "/judgment_link", "jdg-id src-id");
    const result = await runWorkerOnce(deps());
    expect(result?.terminal).toBe("succeeded");
    expect(lastSentText()).toContain("사용법");
  });

  test("/judgment_link links evidence to a judgment", async () => {
    const proposed = proposeJudgment(db, {
      kind: "decision",
      statement: "증거 연결 테스트 판단",
      epistemic_origin: "user_stated",
      confidence: "high",
      scope: { global: true },
    }, { newId: () => "jdg-link-1" });
    approveProposedJudgment(db, { judgment_id: proposed.id, reviewer: "user-1" });
    const src = recordJudgmentSource(db, { kind: "user_statement", locator: "test:evidence" }, { newSourceId: () => "src-link-1" });
    seedCommandJob("j-jl-ok", "k-jl-ok", "/judgment_link", `${proposed.id} ${src.id} supports`);
    const result = await runWorkerOnce(deps());
    expect(result?.terminal).toBe("succeeded");
    const text = lastSentText();
    expect(text).toContain("증거 연결됨");
    expect(text).toContain("supports");
  });
});

describe("Phase 1B.4 — /judgment_commit command", () => {
  test("/judgment_commit with no id returns usage hint", async () => {
    seedCommandJob("j-jc-noarg", "k-jc-noarg", "/judgment_commit", "");
    const result = await runWorkerOnce(deps());
    expect(result?.terminal).toBe("succeeded");
    expect(lastSentText()).toContain("사용법");
  });

  test("/judgment_commit with unknown id returns not-found", async () => {
    seedCommandJob("j-jc-unknown", "k-jc-unknown", "/judgment_commit", "nonexistent-id");
    const result = await runWorkerOnce(deps());
    expect(result?.terminal).toBe("succeeded");
    expect(lastSentText()).toContain("찾을 수 없습니다");
  });

  test("/judgment_commit commits an approved evidence-linked judgment to active/eligible", async () => {
    const proposed = proposeJudgment(db, {
      kind: "decision",
      statement: "커밋 테스트 판단",
      epistemic_origin: "user_stated",
      confidence: "high",
      scope: { global: true },
    }, { newId: () => "jdg-commit-1" });
    approveProposedJudgment(db, { judgment_id: proposed.id, reviewer: "user-1" });
    const src = recordJudgmentSource(db, { kind: "user_statement", locator: "test:commit" });
    linkJudgmentEvidence(db, { judgment_id: proposed.id, source_id: src.id, relation: "supports" });
    seedCommandJob("j-jc-ok", "k-jc-ok", "/judgment_commit", proposed.id);
    const result = await runWorkerOnce(deps());
    expect(result?.terminal).toBe("succeeded");
    const text = lastSentText();
    expect(text).toContain("커밋됨");
    expect(text).toContain("active");
    expect(text).toContain("eligible");
  });

  test("/judgment_commit does NOT store a turn", async () => {
    const proposed = proposeJudgment(db, {
      kind: "decision",
      statement: "턴 미저장 테스트",
      epistemic_origin: "user_stated",
      confidence: "high",
      scope: { global: true },
    }, { newId: () => "jdg-noturn" });
    approveProposedJudgment(db, { judgment_id: proposed.id, reviewer: "user-1" });
    const src = recordJudgmentSource(db, { kind: "user_statement", locator: "test:noturn" });
    linkJudgmentEvidence(db, { judgment_id: proposed.id, source_id: src.id, relation: "supports" });
    seedCommandJob("j-jc-turn", "k-jc-turn", "/judgment_commit", proposed.id);
    await runWorkerOnce(deps());
    const turns = db.prepare<{ c: number }, []>("SELECT COUNT(*) AS c FROM turns").get()!.c;
    expect(turns).toBe(0);
  });

  test("/judgment_commit fails on not-yet-approved judgment", async () => {
    const proposed = proposeJudgment(db, {
      kind: "decision",
      statement: "미승인 판단 커밋 시도",
      epistemic_origin: "user_stated",
      confidence: "high",
      scope: { global: true },
    }, { newId: () => "jdg-nonapproved" });
    seedCommandJob("j-jc-fail", "k-jc-fail", "/judgment_commit", proposed.id);
    const result = await runWorkerOnce(deps());
    expect(result?.terminal).toBe("succeeded");
    expect(lastSentText()).toContain("커밋 실패");
  });
});

describe("Phase 1B.5 — /judgment_revoke command", () => {
  test("/judgment_revoke with no id returns usage hint", async () => {
    seedCommandJob("j-rv-noarg", "k-rv-noarg", "/judgment_revoke", "");
    const result = await runWorkerOnce(deps());
    expect(result?.terminal).toBe("succeeded");
    expect(lastSentText()).toContain("사용법");
  });

  test("/judgment_revoke with id but no reason returns usage hint", async () => {
    seedCommandJob("j-rv-noreason", "k-rv-noreason", "/judgment_revoke", "some-id");
    const result = await runWorkerOnce(deps());
    expect(result?.terminal).toBe("succeeded");
    expect(lastSentText()).toContain("사용법");
  });

  test("/judgment_revoke with unknown id returns not-found", async () => {
    seedCommandJob("j-rv-unknown", "k-rv-unknown", "/judgment_revoke", "nonexistent-id 잘못된 판단");
    const result = await runWorkerOnce(deps());
    expect(result?.terminal).toBe("succeeded");
    expect(lastSentText()).toContain("찾을 수 없습니다");
  });

  test("/judgment_revoke revokes an active judgment", async () => {
    seedActiveJudgment("jdg-revoke-1", "철회될 판단");
    seedCommandJob("j-rv-ok", "k-rv-ok", "/judgment_revoke", "jdg-revoke-1 더 이상 유효하지 않음");
    const result = await runWorkerOnce(deps());
    expect(result?.terminal).toBe("succeeded");
    const text = lastSentText();
    expect(text).toContain("철회됨");
    expect(text).toContain("revoked");
    expect(text).toContain("excluded");
  });

  test("/judgment_revoke does NOT store a turn", async () => {
    seedActiveJudgment("jdg-rv-turn", "턴 미저장 테스트 판단");
    seedCommandJob("j-rv-turn", "k-rv-turn", "/judgment_revoke", "jdg-rv-turn 테스트용");
    await runWorkerOnce(deps());
    const turns = db.prepare<{ c: number }, []>("SELECT COUNT(*) AS c FROM turns").get()!.c;
    expect(turns).toBe(0);
  });

  test("/judgment_revoke does NOT insert a control_gate_events row", async () => {
    seedActiveJudgment("jdg-rv-cg", "CG 미생성 테스트");
    seedCommandJob("j-rv-cg", "k-rv-cg", "/judgment_revoke", "jdg-rv-cg 테스트");
    await runWorkerOnce(deps());
    const cgCount = db.prepare<{ c: number }, []>("SELECT COUNT(*) AS c FROM control_gate_events").get()!.c;
    expect(cgCount).toBe(0);
  });

  test("revoked judgment no longer appears in /judgment list", async () => {
    seedActiveJudgment("jdg-rv-hidden", "숨겨질 판단");
    // revoke it
    seedCommandJob("j-rv-hide1", "k-rv-hide1", "/judgment_revoke", "jdg-rv-hidden 테스트 철회");
    await runWorkerOnce(deps());
    // now query
    seedCommandJob("j-rv-hide2", "k-rv-hide2", "/judgment");
    await runWorkerOnce(deps());
    expect(lastSentText()).toContain("없습니다");
  });
});

describe("Phase 1B.5 — /judgment_expire command", () => {
  test("/judgment_expire with no id returns usage hint", async () => {
    seedCommandJob("j-ex-noarg", "k-ex-noarg", "/judgment_expire", "");
    const result = await runWorkerOnce(deps());
    expect(result?.terminal).toBe("succeeded");
    expect(lastSentText()).toContain("사용법");
  });

  test("/judgment_expire with id but no reason returns usage hint", async () => {
    seedCommandJob("j-ex-noreason", "k-ex-noreason", "/judgment_expire", "some-id");
    const result = await runWorkerOnce(deps());
    expect(result?.terminal).toBe("succeeded");
    expect(lastSentText()).toContain("사용법");
  });

  test("/judgment_expire with unknown id returns not-found", async () => {
    seedCommandJob("j-ex-unknown", "k-ex-unknown", "/judgment_expire", "nonexistent-id 만료 이유");
    const result = await runWorkerOnce(deps());
    expect(result?.terminal).toBe("succeeded");
    expect(lastSentText()).toContain("찾을 수 없습니다");
  });

  test("/judgment_expire expires an active judgment", async () => {
    seedActiveJudgment("jdg-expire-1", "만료될 판단");
    seedCommandJob("j-ex-ok", "k-ex-ok", "/judgment_expire", "jdg-expire-1 시효 만료");
    const result = await runWorkerOnce(deps());
    expect(result?.terminal).toBe("succeeded");
    const text = lastSentText();
    expect(text).toContain("만료됨");
    expect(text).toContain("expired");
    expect(text).toContain("excluded");
  });

  test("/judgment_expire does NOT store a turn", async () => {
    seedActiveJudgment("jdg-ex-turn", "만료 턴 미저장");
    seedCommandJob("j-ex-turn", "k-ex-turn", "/judgment_expire", "jdg-ex-turn 테스트");
    await runWorkerOnce(deps());
    const turns = db.prepare<{ c: number }, []>("SELECT COUNT(*) AS c FROM turns").get()!.c;
    expect(turns).toBe(0);
  });
});

describe("Phase 1B.5 — /judgment_supersede command", () => {
  test("/judgment_supersede with missing args returns usage hint", async () => {
    seedCommandJob("j-su-noarg", "k-su-noarg", "/judgment_supersede", "old-id");
    const result = await runWorkerOnce(deps());
    expect(result?.terminal).toBe("succeeded");
    expect(lastSentText()).toContain("사용법");
  });

  test("/judgment_supersede with ids but no reason returns usage hint", async () => {
    seedCommandJob("j-su-noreason", "k-su-noreason", "/judgment_supersede", "old-id new-id");
    const result = await runWorkerOnce(deps());
    expect(result?.terminal).toBe("succeeded");
    expect(lastSentText()).toContain("사용법");
  });

  test("/judgment_supersede supersedes an active judgment with another", async () => {
    seedActiveJudgment("jdg-old-1", "구 판단: SQLite 버전 A 사용");
    seedActiveJudgment("jdg-new-1", "신 판단: SQLite 버전 B 사용");
    seedCommandJob("j-su-ok", "k-su-ok", "/judgment_supersede", "jdg-old-1 jdg-new-1 버전 업그레이드로 인한 교체");
    const result = await runWorkerOnce(deps());
    expect(result?.terminal).toBe("succeeded");
    const text = lastSentText();
    expect(text).toContain("교체됨");
    expect(text).toContain("superseded");
  });

  test("/judgment_supersede does NOT store a turn", async () => {
    seedActiveJudgment("jdg-su-old", "교체될 판단");
    seedActiveJudgment("jdg-su-new", "대체 판단");
    seedCommandJob("j-su-turn", "k-su-turn", "/judgment_supersede", "jdg-su-old jdg-su-new 테스트");
    await runWorkerOnce(deps());
    const turns = db.prepare<{ c: number }, []>("SELECT COUNT(*) AS c FROM turns").get()!.c;
    expect(turns).toBe(0);
  });
});
