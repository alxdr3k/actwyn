// Judgment System Phase 1A.2–1A.5 — typed-tool contract tests.
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
  JUDGMENT_COMMIT_TOOL,
  JUDGMENT_EXPLAIN_TOOL,
  JUDGMENT_LINK_EVIDENCE_TOOL,
  JUDGMENT_PROPOSE_TOOL,
  JUDGMENT_QUERY_TOOL,
  JUDGMENT_RECORD_SOURCE_TOOL,
  JUDGMENT_REJECT_TOOL,
  executeJudgmentApproveTool,
  executeJudgmentCommitTool,
  executeJudgmentExplainTool,
  executeJudgmentLinkEvidenceTool,
  executeJudgmentProposeTool,
  executeJudgmentQueryTool,
  executeJudgmentRecordSourceTool,
  executeJudgmentRejectTool,
  type ApproveInput,
  type CommitInput,
  type EvidenceLinkInput,
  type ProposalInput,
  type RejectInput,
  type SourceInput,
} from "../../src/judgment/tool.ts";
import {
  approveProposedJudgment,
  linkJudgmentEvidence,
  proposeJudgment,
  recordJudgmentSource,
} from "../../src/judgment/repository.ts";

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
// Phase 1A.4 — record_source tool constants
// ---------------------------------------------------------------

describe("JUDGMENT_RECORD_SOURCE_TOOL", () => {
  test("tool contract name is judgment.record_source", () => {
    expect(JUDGMENT_RECORD_SOURCE_TOOL.name).toBe("judgment.record_source");
  });

  test("tool has a description string", () => {
    expect(typeof JUDGMENT_RECORD_SOURCE_TOOL.description).toBe("string");
    expect(JUDGMENT_RECORD_SOURCE_TOOL.description.length).toBeGreaterThan(0);
  });
});

describe("JUDGMENT_LINK_EVIDENCE_TOOL", () => {
  test("tool contract name is judgment.link_evidence", () => {
    expect(JUDGMENT_LINK_EVIDENCE_TOOL.name).toBe("judgment.link_evidence");
  });

  test("tool has a description string", () => {
    expect(typeof JUDGMENT_LINK_EVIDENCE_TOOL.description).toBe("string");
    expect(JUDGMENT_LINK_EVIDENCE_TOOL.description.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------
// Phase 1A.4 — record_source executor
// ---------------------------------------------------------------

const validSourceInput: SourceInput = {
  kind: "turn",
  locator: "session:abc/turn:5",
};

describe("executeJudgmentRecordSourceTool — happy path", () => {
  test("valid source input returns ok: true with source result", () => {
    const result = executeJudgmentRecordSourceTool(db, validSourceInput);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source.id).toBeTruthy();
      expect(result.source.event_type).toBe("judgment.source.recorded");
      expect(result.source.trust_level).toBe("medium");
      expect(result.source.redacted).toBe(true);
    }
  });

  test("successful tool does not activate any judgment rows", () => {
    executeJudgmentRecordSourceTool(db, validSourceInput);
    const rows = db
      .prepare<{ n: number }, never[]>(
        `SELECT COUNT(*) as n FROM judgment_items WHERE activation_state = 'eligible'`,
      )
      .get()!.n;
    expect(rows).toBe(0);
  });
});

describe("executeJudgmentRecordSourceTool — error path", () => {
  test("invalid source input (empty kind) returns ok: false with validation_error", () => {
    const result = executeJudgmentRecordSourceTool(db, { ...validSourceInput, kind: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation_error");
    }
  });

  test("null input returns ok: false (not uncaught TypeError)", () => {
    const result = executeJudgmentRecordSourceTool(db, null as never);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation_error");
    }
  });

  test("invalid tool call does not write judgment_sources", () => {
    const before = db
      .prepare<{ n: number }, never[]>("SELECT COUNT(*) as n FROM judgment_sources")
      .get()!.n;
    executeJudgmentRecordSourceTool(db, { ...validSourceInput, locator: "" });
    const after = db
      .prepare<{ n: number }, never[]>("SELECT COUNT(*) as n FROM judgment_sources")
      .get()!.n;
    expect(after).toBe(before);
  });

  test("invalid tool call does not write judgment_events", () => {
    const before = db
      .prepare<{ n: number }, never[]>("SELECT COUNT(*) as n FROM judgment_events")
      .get()!.n;
    executeJudgmentRecordSourceTool(db, { ...validSourceInput, trust_level: "excellent" } as never);
    const after = db
      .prepare<{ n: number }, never[]>("SELECT COUNT(*) as n FROM judgment_events")
      .get()!.n;
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------
// Phase 1A.4 — link_evidence executor
// ---------------------------------------------------------------

const validLinkInput: EvidenceLinkInput = {
  judgment_id: "placeholder",
  source_id: "placeholder",
  relation: "supports",
};

describe("executeJudgmentLinkEvidenceTool — happy path", () => {
  test("valid evidence link input returns ok: true with evidence_link result", () => {
    const j = proposeJudgment(db, validInput);
    const s = recordJudgmentSource(db, validSourceInput);
    const result = executeJudgmentLinkEvidenceTool(db, {
      ...validLinkInput,
      judgment_id: j.id,
      source_id: s.id,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.evidence_link.id).toBeTruthy();
      expect(result.evidence_link.event_type).toBe("judgment.evidence.linked");
      expect(result.evidence_link.judgment_id).toBe(j.id);
      expect(result.evidence_link.source_id).toBe(s.id);
    }
  });

  test("successful tool does not activate the judgment", () => {
    const j = proposeJudgment(db, validInput);
    const s = recordJudgmentSource(db, validSourceInput);
    executeJudgmentLinkEvidenceTool(db, {
      ...validLinkInput,
      judgment_id: j.id,
      source_id: s.id,
    });
    const row = db
      .prepare<{ lifecycle_status: string; activation_state: string }, [string]>(
        `SELECT lifecycle_status, activation_state FROM judgment_items WHERE id = ?`,
      )
      .get(j.id)!;
    expect(row.lifecycle_status).toBe("proposed");
    expect(row.activation_state).toBe("history_only");
  });
});

describe("executeJudgmentLinkEvidenceTool — error path", () => {
  test("invalid evidence link input (empty relation) returns ok: false with validation_error", () => {
    const j = proposeJudgment(db, validInput);
    const s = recordJudgmentSource(db, validSourceInput);
    const result = executeJudgmentLinkEvidenceTool(db, {
      ...validLinkInput,
      judgment_id: j.id,
      source_id: s.id,
      relation: "",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation_error");
    }
  });

  test("missing judgment returns ok: false with not_found", () => {
    const s = recordJudgmentSource(db, validSourceInput);
    const result = executeJudgmentLinkEvidenceTool(db, {
      ...validLinkInput,
      judgment_id: "nonexistent",
      source_id: s.id,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("not_found");
    }
  });

  test("missing source returns ok: false with not_found", () => {
    const j = proposeJudgment(db, validInput);
    const result = executeJudgmentLinkEvidenceTool(db, {
      ...validLinkInput,
      judgment_id: j.id,
      source_id: "nonexistent-source",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("not_found");
    }
  });

  test("invalid judgment state (rejected) returns ok: false with invalid_state", () => {
    const j = proposeJudgment(db, validInput);
    // reject it
    executeJudgmentRejectTool(db, {
      judgment_id: j.id,
      reviewer: "tester",
      reason: "wrong",
    });
    const s = recordJudgmentSource(db, validSourceInput);
    const result = executeJudgmentLinkEvidenceTool(db, {
      ...validLinkInput,
      judgment_id: j.id,
      source_id: s.id,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid_state");
    }
  });

  test("failed link tool call does not write judgment_evidence_links", () => {
    const before = db
      .prepare<{ n: number }, never[]>("SELECT COUNT(*) as n FROM judgment_evidence_links")
      .get()!.n;
    executeJudgmentLinkEvidenceTool(db, {
      ...validLinkInput,
      judgment_id: "nonexistent",
      source_id: "nonexistent",
    });
    const after = db
      .prepare<{ n: number }, never[]>("SELECT COUNT(*) as n FROM judgment_evidence_links")
      .get()!.n;
    expect(after).toBe(before);
  });

  test("failed link tool call does not append events", () => {
    const before = db
      .prepare<{ n: number }, never[]>("SELECT COUNT(*) as n FROM judgment_events")
      .get()!.n;
    executeJudgmentLinkEvidenceTool(db, {
      ...validLinkInput,
      judgment_id: "nonexistent",
      source_id: "nonexistent",
    });
    const after = db
      .prepare<{ n: number }, never[]>("SELECT COUNT(*) as n FROM judgment_events")
      .get()!.n;
    expect(after).toBe(before);
  });

  test("archived proposed/history_only judgment returns ok: false with invalid_state", () => {
    const j = proposeJudgment(db, validInput);
    db.prepare(`UPDATE judgment_items SET retention_state = 'archived' WHERE id = ?`).run(j.id);
    const s = recordJudgmentSource(db, validSourceInput);
    const result = executeJudgmentLinkEvidenceTool(db, {
      ...validLinkInput,
      judgment_id: j.id,
      source_id: s.id,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid_state");
    }
  });

  test("archived judgment: no link row inserted", () => {
    const j = proposeJudgment(db, validInput);
    db.prepare(`UPDATE judgment_items SET retention_state = 'archived' WHERE id = ?`).run(j.id);
    const s = recordJudgmentSource(db, validSourceInput);
    const before = db
      .prepare<{ n: number }, never[]>("SELECT COUNT(*) as n FROM judgment_evidence_links")
      .get()!.n;
    executeJudgmentLinkEvidenceTool(db, {
      ...validLinkInput,
      judgment_id: j.id,
      source_id: s.id,
    });
    expect(db.prepare<{ n: number }, never[]>("SELECT COUNT(*) as n FROM judgment_evidence_links").get()!.n).toBe(before);
  });

  test("archived judgment: no event appended", () => {
    const j = proposeJudgment(db, validInput);
    db.prepare(`UPDATE judgment_items SET retention_state = 'archived' WHERE id = ?`).run(j.id);
    const s = recordJudgmentSource(db, validSourceInput);
    const before = db
      .prepare<{ n: number }, [string]>("SELECT COUNT(*) as n FROM judgment_events WHERE judgment_id = ?")
      .get(j.id)!.n;
    executeJudgmentLinkEvidenceTool(db, {
      ...validLinkInput,
      judgment_id: j.id,
      source_id: s.id,
    });
    expect(db.prepare<{ n: number }, [string]>("SELECT COUNT(*) as n FROM judgment_events WHERE judgment_id = ?").get(j.id)!.n).toBe(before);
  });

  test("archived judgment: source_ids_json not mutated", () => {
    const j = proposeJudgment(db, validInput);
    db.prepare(`UPDATE judgment_items SET retention_state = 'archived' WHERE id = ?`).run(j.id);
    const s = recordJudgmentSource(db, validSourceInput);
    const before = db
      .prepare<{ source_ids_json: string | null }, [string]>("SELECT source_ids_json FROM judgment_items WHERE id = ?")
      .get(j.id)!.source_ids_json;
    executeJudgmentLinkEvidenceTool(db, {
      ...validLinkInput,
      judgment_id: j.id,
      source_id: s.id,
    });
    expect(db.prepare<{ source_ids_json: string | null }, [string]>("SELECT source_ids_json FROM judgment_items WHERE id = ?").get(j.id)!.source_ids_json).toEqual(before);
  });

  test("archived judgment: evidence_ids_json not mutated", () => {
    const j = proposeJudgment(db, validInput);
    db.prepare(`UPDATE judgment_items SET retention_state = 'archived' WHERE id = ?`).run(j.id);
    const s = recordJudgmentSource(db, validSourceInput);
    const before = db
      .prepare<{ evidence_ids_json: string | null }, [string]>("SELECT evidence_ids_json FROM judgment_items WHERE id = ?")
      .get(j.id)!.evidence_ids_json;
    executeJudgmentLinkEvidenceTool(db, {
      ...validLinkInput,
      judgment_id: j.id,
      source_id: s.id,
    });
    expect(db.prepare<{ evidence_ids_json: string | null }, [string]>("SELECT evidence_ids_json FROM judgment_items WHERE id = ?").get(j.id)!.evidence_ids_json).toEqual(before);
  });
});

// ---------------------------------------------------------------
// Phase 1A.5 — Commit tool tests
// ---------------------------------------------------------------

const validCommitInput: CommitInput = {
  judgment_id: "placeholder",
  committer: "committer",
  reason: "ready for runtime",
};

function makeApprovedJudgmentWithEvidence(dbHandle: DbHandle) {
  const j = proposeJudgment(dbHandle, {
    kind: "fact",
    statement: "the user prefers dark mode",
    epistemic_origin: "user_stated",
    confidence: "medium",
    scope: { project: "actwyn" },
  });
  approveProposedJudgment(dbHandle, { judgment_id: j.id, reviewer: "approver" });
  const s = recordJudgmentSource(dbHandle, { kind: "conversation", locator: "msg:001" });
  linkJudgmentEvidence(dbHandle, { ...validLinkInput, judgment_id: j.id, source_id: s.id });
  return { j, s };
}

describe("JUDGMENT_COMMIT_TOOL", () => {
  test("tool contract name is judgment.commit", () => {
    expect(JUDGMENT_COMMIT_TOOL.name).toBe("judgment.commit");
  });

  test("tool has a description string", () => {
    expect(typeof JUDGMENT_COMMIT_TOOL.description).toBe("string");
    expect(JUDGMENT_COMMIT_TOOL.description.length).toBeGreaterThan(0);
  });
});

describe("executeJudgmentCommitTool — happy path", () => {
  test("valid commit input returns ok: true", () => {
    const { j } = makeApprovedJudgmentWithEvidence(db);
    const result = executeJudgmentCommitTool(db, { ...validCommitInput, judgment_id: j.id });
    expect(result.ok).toBe(true);
  });

  test("valid commit result has lifecycle_status active", () => {
    const { j } = makeApprovedJudgmentWithEvidence(db);
    const result = executeJudgmentCommitTool(db, { ...validCommitInput, judgment_id: j.id });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.judgment.lifecycle_status).toBe("active");
    }
  });

  test("valid commit result has activation_state eligible", () => {
    const { j } = makeApprovedJudgmentWithEvidence(db);
    const result = executeJudgmentCommitTool(db, { ...validCommitInput, judgment_id: j.id });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.judgment.activation_state).toBe("eligible");
    }
  });

  test("valid commit result has authority_source user_confirmed", () => {
    const { j } = makeApprovedJudgmentWithEvidence(db);
    const result = executeJudgmentCommitTool(db, { ...validCommitInput, judgment_id: j.id });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.judgment.authority_source).toBe("user_confirmed");
    }
  });

  test("successful commit tool does not register or wire runtime behavior", () => {
    const { j } = makeApprovedJudgmentWithEvidence(db);
    const result = executeJudgmentCommitTool(db, { ...validCommitInput, judgment_id: j.id });
    // The function returns a plain result object; no side effects on providers/context.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.judgment.id).toBeTruthy();
    }
  });
});

describe("executeJudgmentCommitTool — error paths", () => {
  test("invalid input (empty committer) returns ok false with validation_error", () => {
    const result = executeJudgmentCommitTool(db, {
      ...validCommitInput,
      judgment_id: "some-id",
      committer: "",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation_error");
    }
  });

  test("missing target returns ok false with not_found", () => {
    const result = executeJudgmentCommitTool(db, {
      ...validCommitInput,
      judgment_id: "nonexistent-id",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("not_found");
    }
  });

  test("invalid state (pending judgment) returns ok false with invalid_state", () => {
    const j = proposeJudgment(db, {
      kind: "fact",
      statement: "some fact",
      epistemic_origin: "user_stated",
      confidence: "medium",
      scope: {},
    });
    const result = executeJudgmentCommitTool(db, { ...validCommitInput, judgment_id: j.id });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid_state");
    }
  });

  test("missing evidence returns ok false with invalid_state", () => {
    const j = proposeJudgment(db, {
      kind: "fact",
      statement: "some fact",
      epistemic_origin: "user_stated",
      confidence: "medium",
      scope: {},
    });
    approveProposedJudgment(db, { judgment_id: j.id, reviewer: "approver" });
    const result = executeJudgmentCommitTool(db, { ...validCommitInput, judgment_id: j.id });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid_state");
    }
  });

  test("failed tool call does not write status updates", () => {
    const j = proposeJudgment(db, {
      kind: "fact",
      statement: "some fact",
      epistemic_origin: "user_stated",
      confidence: "medium",
      scope: {},
    });
    const before = db
      .prepare<{ lifecycle_status: string }, [string]>(
        `SELECT lifecycle_status FROM judgment_items WHERE id = ?`,
      )
      .get(j.id)!;
    executeJudgmentCommitTool(db, { ...validCommitInput, judgment_id: j.id });
    const after = db
      .prepare<{ lifecycle_status: string }, [string]>(
        `SELECT lifecycle_status FROM judgment_items WHERE id = ?`,
      )
      .get(j.id)!;
    expect(after.lifecycle_status).toBe(before.lifecycle_status);
  });

  test("failed tool call does not append events", () => {
    const before = db
      .prepare<{ n: number }, never[]>("SELECT COUNT(*) as n FROM judgment_events")
      .get()!.n;
    executeJudgmentCommitTool(db, { ...validCommitInput, judgment_id: "nonexistent" });
    const after = db
      .prepare<{ n: number }, never[]>("SELECT COUNT(*) as n FROM judgment_events")
      .get()!.n;
    expect(after).toBe(before);
  });

  test("source_ids_json = [123] returns ok false with validation_error", () => {
    const { j } = makeApprovedJudgmentWithEvidence(db);
    db.prepare(`UPDATE judgment_items SET source_ids_json = '[123]' WHERE id = ?`).run(j.id);
    const result = executeJudgmentCommitTool(db, { ...validCommitInput, judgment_id: j.id });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation_error");
    }
  });

  test("source_ids_json = [123] does not update lifecycle_status", () => {
    const { j } = makeApprovedJudgmentWithEvidence(db);
    db.prepare(`UPDATE judgment_items SET source_ids_json = '[123]' WHERE id = ?`).run(j.id);
    executeJudgmentCommitTool(db, { ...validCommitInput, judgment_id: j.id });
    const row = db
      .prepare<{ lifecycle_status: string }, [string]>(
        `SELECT lifecycle_status FROM judgment_items WHERE id = ?`,
      )
      .get(j.id)!;
    expect(row.lifecycle_status).toBe("proposed");
  });

  test("source_ids_json = [123] does not append judgment.committed event", () => {
    const { j } = makeApprovedJudgmentWithEvidence(db);
    db.prepare(`UPDATE judgment_items SET source_ids_json = '[123]' WHERE id = ?`).run(j.id);
    const before = db
      .prepare<{ n: number }, [string]>(
        `SELECT COUNT(*) as n FROM judgment_events WHERE judgment_id = ?`,
      )
      .get(j.id)!.n;
    executeJudgmentCommitTool(db, { ...validCommitInput, judgment_id: j.id });
    const after = db
      .prepare<{ n: number }, [string]>(
        `SELECT COUNT(*) as n FROM judgment_events WHERE judgment_id = ?`,
      )
      .get(j.id)!.n;
    expect(after).toBe(before);
  });

  test("evidence_ids_json = [123] returns ok false with validation_error", () => {
    const { j } = makeApprovedJudgmentWithEvidence(db);
    db.prepare(`UPDATE judgment_items SET evidence_ids_json = '[123]' WHERE id = ?`).run(j.id);
    const result = executeJudgmentCommitTool(db, { ...validCommitInput, judgment_id: j.id });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation_error");
    }
  });

  test("evidence_ids_json = [123] does not update lifecycle_status", () => {
    const { j } = makeApprovedJudgmentWithEvidence(db);
    db.prepare(`UPDATE judgment_items SET evidence_ids_json = '[123]' WHERE id = ?`).run(j.id);
    executeJudgmentCommitTool(db, { ...validCommitInput, judgment_id: j.id });
    const row = db
      .prepare<{ lifecycle_status: string }, [string]>(
        `SELECT lifecycle_status FROM judgment_items WHERE id = ?`,
      )
      .get(j.id)!;
    expect(row.lifecycle_status).toBe("proposed");
  });

  test("evidence_ids_json = [123] does not append judgment.committed event", () => {
    const { j } = makeApprovedJudgmentWithEvidence(db);
    db.prepare(`UPDATE judgment_items SET evidence_ids_json = '[123]' WHERE id = ?`).run(j.id);
    const before = db
      .prepare<{ n: number }, [string]>(
        `SELECT COUNT(*) as n FROM judgment_events WHERE judgment_id = ?`,
      )
      .get(j.id)!.n;
    executeJudgmentCommitTool(db, { ...validCommitInput, judgment_id: j.id });
    const after = db
      .prepare<{ n: number }, [string]>(
        `SELECT COUNT(*) as n FROM judgment_events WHERE judgment_id = ?`,
      )
      .get(j.id)!.n;
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------
// Phase 1A.6 — Query / explain tool tests
// ---------------------------------------------------------------

describe("JUDGMENT_QUERY_TOOL", () => {
  test("tool contract name is judgment.query", () => {
    expect(JUDGMENT_QUERY_TOOL.name).toBe("judgment.query");
  });
});

describe("JUDGMENT_EXPLAIN_TOOL", () => {
  test("tool contract name is judgment.explain", () => {
    expect(JUDGMENT_EXPLAIN_TOOL.name).toBe("judgment.explain");
  });
});

describe("executeJudgmentQueryTool / executeJudgmentExplainTool", () => {
  test("valid query input returns ok true", () => {
    const { j } = makeApprovedJudgmentWithEvidence(db);
    executeJudgmentCommitTool(db, { ...validCommitInput, judgment_id: j.id });

    const result = executeJudgmentQueryTool(db, { statement_match: "dark mode" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.items.map((item) => item.id)).toContain(j.id);
    }
  });

  test("valid explain input returns ok true", () => {
    const { j } = makeApprovedJudgmentWithEvidence(db);
    executeJudgmentCommitTool(db, { ...validCommitInput, judgment_id: j.id });

    const result = executeJudgmentExplainTool(db, { judgment_id: j.id });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.explanation.judgment.id).toBe(j.id);
      expect(result.explanation.events.length).toBeGreaterThan(0);
    }
  });

  test("invalid query input returns ok false with validation_error", () => {
    const result = executeJudgmentQueryTool(db, { limit: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation_error");
      expect(result.error.field).toBe("limit");
    }
  });

  test("invalid explain input returns ok false with validation_error", () => {
    const result = executeJudgmentExplainTool(db, { judgment_id: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation_error");
      expect(result.error.field).toBe("judgment_id");
    }
  });

  test("missing explain target returns ok false with not_found", () => {
    const result = executeJudgmentExplainTool(db, { judgment_id: "missing-judgment" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("not_found");
    }
  });

  test("deleted explain target returns ok false with invalid_state", () => {
    const { j } = makeApprovedJudgmentWithEvidence(db);
    executeJudgmentCommitTool(db, { ...validCommitInput, judgment_id: j.id });
    db.prepare(`UPDATE judgment_items SET retention_state = 'deleted' WHERE id = ?`).run(j.id);

    const result = executeJudgmentExplainTool(db, { judgment_id: j.id });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid_state");
    }
  });

  test("query/explain tools do not append events or mutate judgment_items", () => {
    const { j } = makeApprovedJudgmentWithEvidence(db);
    executeJudgmentCommitTool(db, { ...validCommitInput, judgment_id: j.id });
    const beforeEvents = db
      .prepare<{ n: number }, never[]>("SELECT COUNT(*) as n FROM judgment_events")
      .get()!.n;
    const beforeRow = db
      .prepare<{ updated_at: string; source_ids_json: string | null; evidence_ids_json: string | null }, [string]>(
        `SELECT updated_at, source_ids_json, evidence_ids_json
         FROM judgment_items WHERE id = ?`,
      )
      .get(j.id)!;

    const queryResult = executeJudgmentQueryTool(db, { statement_match: "dark mode" });
    const explainResult = executeJudgmentExplainTool(db, { judgment_id: j.id });

    expect(queryResult.ok).toBe(true);
    expect(explainResult.ok).toBe(true);

    const afterEvents = db
      .prepare<{ n: number }, never[]>("SELECT COUNT(*) as n FROM judgment_events")
      .get()!.n;
    const afterRow = db
      .prepare<{ updated_at: string; source_ids_json: string | null; evidence_ids_json: string | null }, [string]>(
        `SELECT updated_at, source_ids_json, evidence_ids_json
         FROM judgment_items WHERE id = ?`,
      )
      .get(j.id)!;

    expect(afterEvents).toBe(beforeEvents);
    expect(afterRow).toEqual(beforeRow);
  });
});

// ---------------------------------------------------------------
// Static boundary tests
// ---------------------------------------------------------------

describe("static boundary — ADR-0014 Bun boundary", () => {
  test("src/judgment/*.ts has no direct bun:* import or Bun global use", () => {
    const judgmentDir = join(SRC_DIR, "judgment");
    const files = readdirSync(judgmentDir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const content = readFileSync(join(judgmentDir, file), "utf-8");
      expect(
        content,
        `${file} must not contain a direct bun: import`,
      ).not.toMatch(/from ['"]bun:/);
      expect(
        content,
        `${file} must not use the Bun global directly`,
      ).not.toMatch(/\bBun\./);
    }
  });
});

describe("static boundary — judgment tools not registered", () => {
  const TOOL_IMPORT_PATTERNS = [
    /['"][^'"]*judgment\/tool/,
    /['"]judgment\.propose['"]/,
    /['"]judgment\.approve['"]/,
    /['"]judgment\.reject['"]/,
    /['"]judgment\.record_source['"]/,
    /['"]judgment\.link_evidence['"]/,
    /['"]judgment\.commit['"]/,
    /['"]judgment\.query['"]/,
    /['"]judgment\.explain['"]/,
  ];

  function checkDir(dirName: string): void {
    const dir = join(SRC_DIR, dirName);
    // Fail-loud: a missing directory or an empty directory means the
    // boundary check is silently doing nothing. The judgment system
    // explicitly enumerates these runtime directories (providers,
    // context, memory, telegram, commands, queue/worker.ts, main.ts)
    // as forbidden import sites. Any of them disappearing or being
    // renamed must surface as a test failure so we re-evaluate the
    // boundary, not as a green test.
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    expect(
      files.length,
      `src/${dirName}/ must contain at least one .ts file for the boundary check to be meaningful`,
    ).toBeGreaterThan(0);
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
