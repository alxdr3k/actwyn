// Stage 4 Context Compiler v0 — unit tests.
// Tests replay/resume modes, judgment scope/time filters,
// summary-generation exclusion, and prompt-overflow propagation.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase, type DbHandle } from "../../src/db.ts";
import { migrate } from "../../src/db/migrator.ts";
import { compile, PromptOverflowError } from "../../src/context/compiler.ts";
import {
  proposeJudgment,
  approveProposedJudgment,
  commitApprovedJudgment,
  recordJudgmentSource,
  linkJudgmentEvidence,
} from "../../src/judgment/repository.ts";

const MIGRATIONS = join(import.meta.dir, "..", "..", "migrations");
const SESSION = "sess-compiler";

let workdir: string;
let db: DbHandle;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "actwyn-compiler-"));
  db = openDatabase({ path: join(workdir, "t.db"), busyTimeoutMs: 250 });
  migrate(db, MIGRATIONS);
  db.prepare<unknown, [string, string, string]>(
    "INSERT INTO sessions(id, chat_id, user_id) VALUES(?, ?, ?)",
  ).run(SESSION, "chat-1", "user-1");
});

afterEach(() => {
  db.close();
  rmSync(workdir, { recursive: true, force: true });
});

// --- seed helpers ---

function seedTurn(id: string, role: string, content: string, createdAt: string): void {
  db.prepare<unknown, [string, string, string, string, number, string]>(
    `INSERT INTO turns(id, session_id, role, content_redacted, redaction_applied, created_at)
     VALUES(?, ?, ?, ?, ?, ?)`,
  ).run(id, SESSION, role, content, 0, createdAt);
}

function seedMemoryItem(id: string, provenance: string, content: string, status = "active"): void {
  db.prepare<unknown, [string, string, string, string, string, number]>(
    `INSERT INTO memory_items(id, session_id, content, provenance, item_type, status, confidence, source_turn_ids, created_at)
     VALUES(?, ?, ?, ?, 'preference', ?, ?, '[]', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
  ).run(id, SESSION, content, provenance, status, 0.9);
}

function seedSummary(factsJson: string | null, tasksJson: string | null, createdAt: string): void {
  db.prepare<unknown, [string, string, string | null, string | null, string]>(
    `INSERT INTO memory_summaries(id, session_id, summary_type, facts_json, open_tasks_json, created_at)
     VALUES(?, ?, 'session', ?, ?, ?)`,
  ).run(`sum-${createdAt}`, SESSION, factsJson, tasksJson, createdAt);
}

let jCount = 0;
function seedJudgment(
  statement: string,
  scope: Record<string, unknown>,
  overrides: { validFrom?: string; validUntil?: string; retentionState?: string } = {},
): string {
  const id = `j-${(++jCount).toString().padStart(3, "0")}`;
  const proposed = proposeJudgment(
    db,
    { kind: "decision", statement, scope, epistemic_origin: "user_stated", confidence: "high", importance: 5 },
    { newId: () => id },
  );
  const approved = approveProposedJudgment(db, { judgment_id: proposed.id, reviewer: "user-1" });
  const src = recordJudgmentSource(db, { kind: "user_statement", locator: `test:${id}` });
  linkJudgmentEvidence(db, { judgment_id: approved.id, source_id: src.id, relation: "supports" });
  commitApprovedJudgment(db, { judgment_id: approved.id, committer: "user-1", reason: "test" }, { nowIso: () => new Date().toISOString() });

  if (overrides.validFrom !== undefined || overrides.validUntil !== undefined) {
    db.prepare<unknown, [string | null, string | null, string]>(
      "UPDATE judgment_items SET valid_from = ?, valid_until = ? WHERE id = ?",
    ).run(overrides.validFrom ?? null, overrides.validUntil ?? null, id);
  }
  if (overrides.retentionState) {
    db.prepare<unknown, [string, string]>(
      "UPDATE judgment_items SET retention_state = ? WHERE id = ?",
    ).run(overrides.retentionState, id);
  }
  return id;
}

// --- replay mode tests ---

describe("replay_mode — no session", () => {
  test("null sessionId returns user message as-is", () => {
    const result = compile({ db, sessionId: null, mode: "replay_mode", userMessage: "안녕" });
    expect(result.packedMessage).toBe("안녕");
    const snap = JSON.parse(result.injectedSnapshotJson) as { mode: string; session_id: string };
    expect(snap.mode).toBe("replay_mode");
    expect(snap.session_id).toBe("");
  });

  test("empty string sessionId returns user message as-is", () => {
    const result = compile({ db, sessionId: "", mode: "replay_mode", userMessage: "Q" });
    expect(result.packedMessage).toBe("Q");
  });
});

describe("replay_mode — turns", () => {
  test("includes recent turns (up to 20, oldest first)", () => {
    seedTurn("t1", "user", "첫 번째 발언", "2026-01-01T00:00:00.000Z");
    seedTurn("t2", "assistant", "응답", "2026-01-01T00:01:00.000Z");
    const result = compile({ db, sessionId: SESSION, mode: "replay_mode", userMessage: "Q" });
    expect(result.packedMessage).toContain("첫 번째 발언");
    expect(result.packedMessage).toContain("응답");
  });

  test("recent_turns slot appears before user_message", () => {
    seedTurn("t1", "user", "이전 발언", "2026-01-01T00:00:00.000Z");
    const result = compile({ db, sessionId: SESSION, mode: "replay_mode", userMessage: "현재 질문" });
    const msgIdx = result.packedMessage.indexOf("현재 질문");
    const turnIdx = result.packedMessage.indexOf("이전 발언");
    expect(turnIdx).toBeGreaterThan(-1);
    expect(msgIdx).toBeGreaterThan(turnIdx);
  });
});

describe("replay_mode — memory items", () => {
  test("active user_stated items included", () => {
    seedMemoryItem("m1", "user_stated", "선호: 한국어로 응답");
    const result = compile({ db, sessionId: SESSION, mode: "replay_mode", userMessage: "Q" });
    expect(result.packedMessage).toContain("선호: 한국어로 응답");
  });

  test("superseded/revoked items excluded", () => {
    seedMemoryItem("m2", "user_stated", "오래된 선호", "superseded");
    seedMemoryItem("m3", "inferred", "철회된 추론", "revoked");
    const result = compile({ db, sessionId: SESSION, mode: "replay_mode", userMessage: "Q" });
    expect(result.packedMessage).not.toContain("오래된 선호");
    expect(result.packedMessage).not.toContain("철회된 추론");
  });
});

describe("replay_mode — summary", () => {
  test("latest summary injected when present", () => {
    seedSummary(JSON.stringify([{ content: "SQLite 사용 결정" }]), null, "2026-04-01T00:00:00.000Z");
    const result = compile({ db, sessionId: SESSION, mode: "replay_mode", userMessage: "Q" });
    expect(result.packedMessage).toContain("SQLite 사용 결정");
  });

  test("only latest summary is used when multiple exist", () => {
    seedSummary(JSON.stringify([{ content: "오래된 사실" }]), null, "2026-03-01T00:00:00.000Z");
    seedSummary(JSON.stringify([{ content: "최신 사실" }]), null, "2026-04-01T00:00:00.000Z");
    const result = compile({ db, sessionId: SESSION, mode: "replay_mode", userMessage: "Q" });
    expect(result.packedMessage).toContain("최신 사실");
    expect(result.packedMessage).not.toContain("오래된 사실");
  });

  test("open_tasks in summary are included", () => {
    seedSummary(null, JSON.stringify([{ content: "테스트 커버리지 개선" }]), "2026-04-01T00:00:00.000Z");
    const result = compile({ db, sessionId: SESSION, mode: "replay_mode", userMessage: "Q" });
    expect(result.packedMessage).toContain("테스트 커버리지 개선");
  });
});

// --- judgment scope/time filter tests ---

describe("judgment scope filters", () => {
  test("global=true judgment is injected in replay_mode", () => {
    seedJudgment("전역: WAL 항상 사용", { global: true });
    const result = compile({ db, sessionId: SESSION, mode: "replay_mode", userMessage: "Q" });
    expect(result.packedMessage).toContain("전역: WAL 항상 사용");
  });

  test("non-global (session-scoped) judgment is excluded", () => {
    seedJudgment("세션 한정 판단", { session: "other-session" });
    const result = compile({ db, sessionId: SESSION, mode: "replay_mode", userMessage: "Q" });
    expect(result.packedMessage).not.toContain("세션 한정 판단");
  });

  test("archived (retention_state=archived) judgment excluded", () => {
    const id = seedJudgment("아카이브 판단", { global: true });
    db.prepare<unknown, [string]>("UPDATE judgment_items SET retention_state = 'archived' WHERE id = ?").run(id);
    const result = compile({ db, sessionId: SESSION, mode: "replay_mode", userMessage: "Q" });
    expect(result.packedMessage).not.toContain("아카이브 판단");
  });

  test("future valid_from judgment excluded", () => {
    seedJudgment("미래 판단", { global: true }, { validFrom: "2099-01-01T00:00:00.000Z" });
    const result = compile({ db, sessionId: SESSION, mode: "replay_mode", userMessage: "Q" });
    expect(result.packedMessage).not.toContain("미래 판단");
  });

  test("expired valid_until judgment excluded", () => {
    seedJudgment("만료 판단", { global: true }, { validUntil: "2020-01-01T00:00:00.000Z" });
    const result = compile({ db, sessionId: SESSION, mode: "replay_mode", userMessage: "Q" });
    expect(result.packedMessage).not.toContain("만료 판단");
  });

  test("valid_from in past and valid_until in future → included", () => {
    seedJudgment("현재 유효 판단", { global: true }, {
      validFrom: "2020-01-01T00:00:00.000Z",
      validUntil: "2099-01-01T00:00:00.000Z",
    });
    const result = compile({ db, sessionId: SESSION, mode: "replay_mode", userMessage: "Q" });
    expect(result.packedMessage).toContain("현재 유효 판단");
  });

  test("null valid_from and null valid_until → always included", () => {
    seedJudgment("무기한 판단", { global: true });
    const result = compile({ db, sessionId: SESSION, mode: "replay_mode", userMessage: "Q" });
    expect(result.packedMessage).toContain("무기한 판단");
  });
});

// --- skipJudgments (summary_generation exclusion) ---

describe("skipJudgments", () => {
  test("skipJudgments=true excludes judgment_active slot in replay_mode", () => {
    seedJudgment("요약에 넣으면 안 됨", { global: true });
    const result = compile({ db, sessionId: SESSION, mode: "replay_mode", userMessage: "요약해주세요", skipJudgments: true });
    expect(result.packedMessage).not.toContain("요약에 넣으면 안 됨");
  });

  test("skipJudgments=false (default) includes global judgment in replay_mode", () => {
    seedJudgment("포함되어야 함", { global: true });
    const result = compile({ db, sessionId: SESSION, mode: "replay_mode", userMessage: "Q" });
    expect(result.packedMessage).toContain("포함되어야 함");
  });

  test("skipJudgments=true excludes judgment in resume_mode", () => {
    seedJudgment("재개 시 요약 제외 판단", { global: true });
    const result = compile({ db, sessionId: SESSION, mode: "resume_mode", userMessage: "Q", skipJudgments: true });
    // resume with no judgments returns bare user message
    expect(result.packedMessage).toBe("Q");
  });
});

// --- resume_mode ---

describe("resume_mode", () => {
  test("no judgments → returns bare user message", () => {
    const result = compile({ db, sessionId: SESSION, mode: "resume_mode", userMessage: "재개 메시지" });
    expect(result.packedMessage).toBe("재개 메시지");
    const snap = JSON.parse(result.injectedSnapshotJson) as { mode: string; session_id: string };
    expect(snap.mode).toBe("resume_mode");
    expect(snap.session_id).toBe(SESSION);
  });

  test("with global judgment → judgment injected, turns/memory NOT included", () => {
    seedTurn("rt1", "user", "재개 모드 턴", "2026-04-01T00:00:00.000Z");
    seedMemoryItem("rm1", "user_stated", "재개 메모리");
    seedJudgment("재개 전역 판단", { global: true });
    const result = compile({ db, sessionId: SESSION, mode: "resume_mode", userMessage: "재개 Q" });
    expect(result.packedMessage).toContain("재개 전역 판단");
    expect(result.packedMessage).not.toContain("재개 모드 턴");
    expect(result.packedMessage).not.toContain("재개 메모리");
  });

  test("non-global judgment not injected in resume_mode", () => {
    seedJudgment("세션 한정 재개", { session: SESSION });
    const result = compile({ db, sessionId: SESSION, mode: "resume_mode", userMessage: "Q" });
    expect(result.packedMessage).toBe("Q");
  });

  test("resume_mode with null sessionId returns user message", () => {
    const result = compile({ db, sessionId: null, mode: "resume_mode", userMessage: "Q" });
    expect(result.packedMessage).toBe("Q");
  });
});

// --- injectedSnapshotJson shape ---

describe("injectedSnapshotJson", () => {
  test("replay_mode snapshot contains mode, total_tokens, budget, slots", () => {
    seedTurn("t1", "user", "발언", "2026-04-01T00:00:00.000Z");
    const result = compile({ db, sessionId: SESSION, mode: "replay_mode", userMessage: "Q" });
    const snap = JSON.parse(result.injectedSnapshotJson) as {
      mode: string;
      total_tokens: number;
      budget: number;
      slots: Array<{ key: string }>;
    };
    expect(snap.mode).toBe("replay_mode");
    expect(typeof snap.total_tokens).toBe("number");
    expect(snap.budget).toBe(6000);
    expect(Array.isArray(snap.slots)).toBe(true);
    expect(snap.slots.map((s) => s.key)).toContain("user_message");
  });

  test("resume_mode with judgments snapshot contains judgment_active slot", () => {
    seedJudgment("스냅샷 전역 판단", { global: true });
    const result = compile({ db, sessionId: SESSION, mode: "resume_mode", userMessage: "Q" });
    const snap = JSON.parse(result.injectedSnapshotJson) as { slots: Array<{ key: string }> };
    const keys = snap.slots.map((s) => s.key);
    expect(keys).toContain("judgment_active");
  });
});

// --- import boundary ---

describe("import boundary", () => {
  test("compiler.ts does not import from src/judgment/*", () => {
    const source = readFileSync(
      join(import.meta.dir, "..", "..", "src", "context", "compiler.ts"),
      "utf-8",
    );
    expect(source).not.toContain("src/judgment");
    expect(source).not.toContain("~/judgment");
    expect(source).not.toContain("../judgment");
    expect(source).not.toContain("../../judgment");
  });
});

// --- prompt-overflow ---

describe("prompt overflow", () => {
  test("resume_mode with active judgments and over-budget userMessage falls back to bare message", () => {
    // Worker behavior: overflow during optional judgment refresh falls back silently.
    seedJudgment("재개 overflow 판단", { global: true });
    const longMessage = "긴 재개 메시지 ".repeat(400);
    const result = compile({
      db,
      sessionId: SESSION,
      mode: "resume_mode",
      userMessage: longMessage,
      tokenBudget: 1,
    });
    // Must NOT throw; falls back to bare user message
    expect(result.packedMessage).toBe(longMessage);
    const snap = JSON.parse(result.injectedSnapshotJson) as { mode: string; session_id: string };
    expect(snap.mode).toBe("resume_mode");
    expect(snap.session_id).toBe(SESSION);
  });

  test("throws PromptOverflowError when minimum slots exceed budget", () => {
    // Tiny budget forces overflow when system_identity + user_message can't fit.
    expect(() =>
      compile({
        db,
        sessionId: SESSION,
        mode: "replay_mode",
        userMessage: "이 메시지가 매우 긴 텍스트입니다. ".repeat(300),
        tokenBudget: 1,
      }),
    ).toThrow(PromptOverflowError);
  });

  test("droppable slots are dropped before overflow (budget just fits minimum)", () => {
    seedTurn("t1", "user", "오래된 턴 내용 ".repeat(50), "2026-04-01T00:00:00.000Z");
    // budget is tight but enough for user_message + system_identity
    const result = compile({
      db,
      sessionId: SESSION,
      mode: "replay_mode",
      userMessage: "짧은 메시지",
      tokenBudget: 20,
    });
    // Should not throw; droppable recent_turns was dropped
    expect(result.packedMessage).toContain("짧은 메시지");
    expect(result.packedMessage).not.toContain("오래된 턴 내용");
  });
});
