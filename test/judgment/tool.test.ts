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
  JUDGMENT_PROPOSE_TOOL,
  executeJudgmentProposeTool,
  type ProposalInput,
} from "../../src/judgment/tool.ts";

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

describe("static boundary — judgment tool not registered", () => {
  const TOOL_IMPORT_PATTERNS = [
    /['"][^'"]*judgment\/tool/,
    /['"]judgment\.propose['"]/,
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
