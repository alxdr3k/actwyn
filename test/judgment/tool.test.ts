// Judgment System Phase 1A.2 — typed-tool contract tests.
//
// Covers:
//   1. Tool contract constants
//   2. Executor happy / error paths
//   3. Static boundary tests (file-content assertions proving no imports
//      violate the ADR-0014 boundary or the "not registered" invariant)

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase, type DbHandle } from "../../src/db.ts";
import { migrate } from "../../src/db/migrator.ts";
import {
  JUDGMENT_APPROVE_TOOL,
  JUDGMENT_PROPOSE_TOOL,
  JUDGMENT_REJECT_TOOL,
  executeJudgmentApproveTool,
  executeJudgmentProposeTool,
  executeJudgmentRejectTool,
  type ApproveInput,
  type ProposalInput,
  type RejectInput,
} from "../../src/judgment/tool.ts";
import { proposeJudgment } from "../../src/judgment/repository.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");
const SRC_DIR = join(import.meta.dir, "..", "..", "src");

let workdir: string;
let db: DbHandle;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "actwyn-judgment-tool-"));
  db = openDatabase({ path: join(workdir, "test.db"), busyTimeoutMs: 250 });
  migrate(db, MIGRATIONS_DIR);
});

afterEach(() => {
  db.close();
  rmSync(workdir, { recursive: true, force: true });
});

const validInput: ProposalInput = {
  kind: "fact",
  statement: "the user prefers dark mode",
  epistemic_origin: "user_stated",
  confidence: "medium",
  scope: { project: "actwyn" },
};

// ---------------------------------------------------------------
// Tool contract constants
// ---------------------------------------------------------------

describe("JUDGMENT_PROPOSE_TOOL", () => {
  test("tool name is judgment.propose", () => {
    expect(JUDGMENT_PROPOSE_TOOL.name).toBe("judgment.propose");
  });

  test("tool has a description string", () => {
    expect(typeof JUDGMENT_PROPOSE_TOOL.description).toBe("string");
    expect(JUDGMENT_PROPOSE_TOOL.description.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------
// Executor happy path
// ---------------------------------------------------------------

describe("executeJudgmentProposeTool — happy path", () => {
  test("valid input returns ok: true with judgment result", () => {
    const result = executeJudgmentProposeTool(db, validInput);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.judgment.id).toBeTruthy();
      expect(result.judgment.lifecycle_status).toBe("proposed");
      expect(result.judgment.activation_state).toBe("history_only");
    }
  });

  test("result judgment is not approved or activated", () => {
    const result = executeJudgmentProposeTool(db, validInput);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.judgment.approval_state).toBe("pending");
      expect(result.judgment.activation_state).toBe("history_only");
      expect(result.judgment.lifecycle_status).toBe("proposed");
      expect(result.judgment.authority_source).toBe("none");
    }
  });
});

// ---------------------------------------------------------------
// Executor error path
// ---------------------------------------------------------------

describe("executeJudgmentProposeTool — error path", () => {
  test("null input returns ok: false (not an uncaught TypeError)", () => {
    const result = executeJudgmentProposeTool(db, null as never);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation_error");
    }
  });

  test("primitive input returns ok: false (not an uncaught TypeError)", () => {
    const result = executeJudgmentProposeTool(db, 42 as never);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation_error");
    }
  });

  test("invalid input returns ok: false with validation_error", () => {
    const result = executeJudgmentProposeTool(db, {
      ...validInput,
      kind: "not-a-kind",
    } as never);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation_error");
      expect(typeof result.error.message).toBe("string");
    }
  });

  test("invalid input returns field in error when available", () => {
    const result = executeJudgmentProposeTool(db, {
      ...validInput,
      kind: "fact",
      confidence: "impossible",
    } as never);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.field).toBe("confidence");
    }
  });

  test("invalid tool input does not write judgment_items", () => {
    const before = db
      .prepare<{ n: number }, never[]>("SELECT COUNT(*) as n FROM judgment_items")
      .get()!.n;
    executeJudgmentProposeTool(db, { ...validInput, kind: "banana" } as never);
    const after = db
      .prepare<{ n: number }, never[]>("SELECT COUNT(*) as n FROM judgment_items")
      .get()!.n;
    expect(after).toBe(before);
  });

  test("invalid tool input does not write judgment_events", () => {
    const before = db
      .prepare<{ n: number }, never[]>("SELECT COUNT(*) as n FROM judgment_events")
      .get()!.n;
    executeJudgmentProposeTool(db, { ...validInput, epistemic_origin: "rumor" } as never);
    const after = db
      .prepare<{ n: number }, never[]>("SELECT COUNT(*) as n FROM judgment_events")
      .get()!.n;
    expect(after).toBe(before);
  });

  test("non-string timestamp field returns ok: false (not a raw TypeError)", () => {
    // Before the timestamp-validation fix, passing observed_at: {} caused a TypeError
    // inside db.tx() which bypassed JudgmentValidationError and surfaced as an unhandled
    // throw. After the fix, executeJudgmentProposeTool must return { ok: false, ... }.
    const result = executeJudgmentProposeTool(
      db,
      { ...validInput, observed_at: {} as unknown as string },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation_error");
      expect(result.error.field).toBe("observed_at");
    }
  });

  test("Date scope returns ok: false (not stored as scalar string)", () => {
    const result = executeJudgmentProposeTool(
      db,
      { ...validInput, scope: new Date() as unknown as Record<string, unknown> },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation_error");
    }
  });
});

// ---------------------------------------------------------------
// Phase 1A.3 — review tool constants
// ---------------------------------------------------------------

describe("JUDGMENT_APPROVE_TOOL", () => {
  test("tool contract name is judgment.approve", () => {
    expect(JUDGMENT_APPROVE_TOOL.name).toBe("judgment.approve");
  });

  test("tool has a description string", () => {
    expect(typeof JUDGMENT_APPROVE_TOOL.description).toBe("string");
    expect(JUDGMENT_APPROVE_TOOL.description.length).toBeGreaterThan(0);
  });
});

describe("JUDGMENT_REJECT_TOOL", () => {
  test("tool contract name is judgment.reject", () => {
    expect(JUDGMENT_REJECT_TOOL.name).toBe("judgment.reject");
  });

  test("tool has a description string", () => {
    expect(typeof JUDGMENT_REJECT_TOOL.description).toBe("string");
    expect(JUDGMENT_REJECT_TOOL.description.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------
// Phase 1A.3 — approve executor
// ---------------------------------------------------------------

const validApproveInput: ApproveInput = {
  judgment_id: "", // filled per test
  reviewer: "tool-reviewer",
};

const validRejectInput: RejectInput = {
  judgment_id: "", // filled per test
  reviewer: "tool-reviewer",
  reason: "not accurate",
};

describe("executeJudgmentApproveTool — happy path", () => {
  test("valid approval returns ok: true with judgment result", () => {
    const j = proposeJudgment(db, validInput);
    const result = executeJudgmentApproveTool(db, { ...validApproveInput, judgment_id: j.id });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.judgment.id).toBe(j.id);
      expect(result.judgment.approval_state).toBe("approved");
      expect(result.judgment.event_type).toBe("judgment.approved");
    }
  });

  test("approved judgment is not activated", () => {
    const j = proposeJudgment(db, validInput);
    const result = executeJudgmentApproveTool(db, { ...validApproveInput, judgment_id: j.id });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.judgment.lifecycle_status).toBe("proposed");
      expect(result.judgment.activation_state).toBe("history_only");
      expect(result.judgment.lifecycle_status).not.toBe("active");
      expect(result.judgment.activation_state).not.toBe("eligible");
    }
  });
});

describe("executeJudgmentApproveTool — error path", () => {
  test("invalid input (null) returns ok: false with validation_error", () => {
    const result = executeJudgmentApproveTool(db, null as never);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation_error");
  });

  test("empty judgment_id returns ok: false with validation_error", () => {
    const result = executeJudgmentApproveTool(db, { ...validApproveInput, judgment_id: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation_error");
      expect(result.error.field).toBe("judgment_id");
    }
  });

  test("missing target returns ok: false with not_found", () => {
    const result = executeJudgmentApproveTool(db, { ...validApproveInput, judgment_id: "no-such-id" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  test("invalid state (already approved) returns ok: false with invalid_state", () => {
    const j = proposeJudgment(db, validInput);
    executeJudgmentApproveTool(db, { ...validApproveInput, judgment_id: j.id });
    const result = executeJudgmentApproveTool(db, { ...validApproveInput, judgment_id: j.id });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_state");
  });

  test("failed tool call does not write status updates", () => {
    const j = proposeJudgment(db, validInput);
    const rowBefore = db
      .prepare<{ approval_state: string }, [string]>("SELECT approval_state FROM judgment_items WHERE id = ?")
      .get(j.id)!;
    executeJudgmentApproveTool(db, { ...validApproveInput, judgment_id: "nonexistent" });
    const rowAfter = db
      .prepare<{ approval_state: string }, [string]>("SELECT approval_state FROM judgment_items WHERE id = ?")
      .get(j.id)!;
    expect(rowAfter.approval_state).toBe(rowBefore.approval_state);
  });

  test("failed tool call does not append events", () => {
    const before = db
      .prepare<{ n: number }, never[]>("SELECT COUNT(*) as n FROM judgment_events")
      .get()!.n;
    executeJudgmentApproveTool(db, { ...validApproveInput, judgment_id: "nonexistent" });
    const after = db
      .prepare<{ n: number }, never[]>("SELECT COUNT(*) as n FROM judgment_events")
      .get()!.n;
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------
// Phase 1A.3 — reject executor
// ---------------------------------------------------------------

describe("executeJudgmentRejectTool — happy path", () => {
  test("valid rejection returns ok: true with judgment result", () => {
    const j = proposeJudgment(db, validInput);
    const result = executeJudgmentRejectTool(db, { ...validRejectInput, judgment_id: j.id });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.judgment.id).toBe(j.id);
      expect(result.judgment.approval_state).toBe("rejected");
      expect(result.judgment.lifecycle_status).toBe("rejected");
      expect(result.judgment.activation_state).toBe("excluded");
      expect(result.judgment.event_type).toBe("judgment.rejected");
    }
  });

  test("rejected judgment is not activated", () => {
    const j = proposeJudgment(db, validInput);
    const result = executeJudgmentRejectTool(db, { ...validRejectInput, judgment_id: j.id });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.judgment.lifecycle_status).not.toBe("active");
      expect(result.judgment.activation_state).not.toBe("eligible");
    }
  });
});

describe("executeJudgmentRejectTool — error path", () => {
  test("invalid input (null) returns ok: false with validation_error", () => {
    const result = executeJudgmentRejectTool(db, null as never);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation_error");
  });

  test("missing reason returns ok: false with validation_error", () => {
    const j = proposeJudgment(db, validInput);
    const result = executeJudgmentRejectTool(db, {
      judgment_id: j.id,
      reviewer: "alice",
      reason: "" as string,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation_error");
      expect(result.error.field).toBe("reason");
    }
  });

  test("missing target returns ok: false with not_found", () => {
    const result = executeJudgmentRejectTool(db, { ...validRejectInput, judgment_id: "no-such-id" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  test("invalid state (already rejected) returns ok: false with invalid_state", () => {
    const j = proposeJudgment(db, validInput);
    executeJudgmentRejectTool(db, { ...validRejectInput, judgment_id: j.id });
    const result = executeJudgmentRejectTool(db, { ...validRejectInput, judgment_id: j.id });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_state");
  });

  test("failed tool call does not write status updates", () => {
    const j = proposeJudgment(db, validInput);
    const rowBefore = db
      .prepare<{ lifecycle_status: string }, [string]>("SELECT lifecycle_status FROM judgment_items WHERE id = ?")
      .get(j.id)!;
    executeJudgmentRejectTool(db, { ...validRejectInput, judgment_id: "nonexistent" });
    const rowAfter = db
      .prepare<{ lifecycle_status: string }, [string]>("SELECT lifecycle_status FROM judgment_items WHERE id = ?")
      .get(j.id)!;
    expect(rowAfter.lifecycle_status).toBe(rowBefore.lifecycle_status);
  });

  test("failed tool call does not append events", () => {
    const before = db
      .prepare<{ n: number }, never[]>("SELECT COUNT(*) as n FROM judgment_events")
      .get()!.n;
    executeJudgmentRejectTool(db, { ...validRejectInput, judgment_id: "nonexistent" });
    const after = db
      .prepare<{ n: number }, never[]>("SELECT COUNT(*) as n FROM judgment_events")
      .get()!.n;
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------
// Static boundary tests
// ---------------------------------------------------------------

describe("static boundary — ADR-0014 Bun boundary", () => {
  test("src/judgment/*.ts has no direct bun: import", () => {
    const judgmentDir = join(SRC_DIR, "judgment");
    const files = readdirSync(judgmentDir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const content = readFileSync(join(judgmentDir, file), "utf-8");
      expect(
        content,
        `${file} must not contain a direct bun: import`,
      ).not.toMatch(/from ['"]bun:/);
    }
  });
});

describe("static boundary — judgment tools not registered", () => {
  const TOOL_IMPORT_PATTERNS = [
    /['"][^'"]*judgment\/tool/,
    /['"]judgment\.propose['"]/,
    /['"]judgment\.approve['"]/,
    /['"]judgment\.reject['"]/,
  ];

  function checkDir(dirName: string): void {
    const dir = join(SRC_DIR, dirName);
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    } catch {
      return; // directory may not exist in all environments
    }
    for (const file of files) {
      const content = readFileSync(join(dir, file), "utf-8");
      for (const pattern of TOOL_IMPORT_PATTERNS) {
        expect(
          content,
          `src/${dirName}/${file} must not import judgment/tool`,
        ).not.toMatch(pattern);
      }
    }
  }

  test("no src/providers/* imports judgment tool", () => checkDir("providers"));
  test("no src/context/* imports judgment tool", () => checkDir("context"));
  test("no src/memory/* imports judgment tool", () => checkDir("memory"));
  test("no src/telegram/* imports judgment tool", () => checkDir("telegram"));
  test("no src/commands/* imports judgment tool", () => checkDir("commands"));

  test("src/queue/worker.ts does not import judgment tool", () => {
    const content = readFileSync(join(SRC_DIR, "queue", "worker.ts"), "utf-8");
    for (const pattern of TOOL_IMPORT_PATTERNS) {
      expect(content, "worker.ts must not import judgment/tool").not.toMatch(pattern);
    }
  });

  test("src/main.ts does not import judgment tool", () => {
    const content = readFileSync(join(SRC_DIR, "main.ts"), "utf-8");
    for (const pattern of TOOL_IMPORT_PATTERNS) {
      expect(content, "main.ts must not import judgment/tool").not.toMatch(pattern);
    }
  });
});
