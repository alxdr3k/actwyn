// Judgment System Phase 1A.2–1A.5 — proposal/review/source/commit repository integration tests.
//
// Uses a real temp-file SQLite with all migrations applied (pattern from
// test/db/judgment_schema.test.ts). No mocking of DB internals.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase, type DbHandle } from "../../src/db.ts";
import { migrate } from "../../src/db/migrator.ts";
import {
  JudgmentNotFoundError,
  JudgmentStateError,
  JudgmentValidationError,
  approveProposedJudgment,
  commitApprovedJudgment,
  linkJudgmentEvidence,
  proposeJudgment,
  recordJudgmentSource,
  rejectProposedJudgment,
  type ApproveInput,
  type CommitInput,
  type EvidenceLinkInput,
  type ProposalInput,
  type RejectInput,
  type SourceInput,
} from "../../src/judgment/repository.ts";
import { ONTOLOGY_VERSION, SCHEMA_VERSION } from "../../src/judgment/types.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");

let workdir: string;
let db: DbHandle;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "actwyn-judgment-repo-"));
  db = openDatabase({ path: join(workdir, "test.db"), busyTimeoutMs: 250 });
  migrate(db, MIGRATIONS_DIR);
});

afterEach(() => {
  db.close();
  rmSync(workdir, { recursive: true, force: true });
});

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

const validInput: ProposalInput = {
  kind: "fact",
  statement: "the user prefers dark mode",
  epistemic_origin: "user_stated",
  confidence: "medium",
  scope: { project: "actwyn" },
};

interface ItemRow {
  id: string;
  kind: string;
  statement: string;
  epistemic_origin: string;
  confidence: string;
  importance: number;
  lifecycle_status: string;
  approval_state: string;
  activation_state: string;
  retention_state: string;
  authority_source: string;
  decay_policy: string;
  ontology_version: string;
  schema_version: string;
  procedure_subtype: string | null;
}

function getItem(id: string): ItemRow | null {
  return db
    .prepare<ItemRow, [string]>(
      `SELECT id, kind, statement, epistemic_origin, confidence, importance,
              lifecycle_status, approval_state, activation_state, retention_state,
              authority_source, decay_policy, ontology_version, schema_version,
              procedure_subtype
       FROM judgment_items WHERE id = ?`,
    )
    .get(id);
}

function countItems(): number {
  return db
    .prepare<{ n: number }, never[]>("SELECT COUNT(*) as n FROM judgment_items")
    .get()!.n;
}

function countEvents(judgmentId?: string): number {
  if (judgmentId) {
    return db
      .prepare<{ n: number }, [string]>(
        "SELECT COUNT(*) as n FROM judgment_events WHERE judgment_id = ?",
      )
      .get(judgmentId)!.n;
  }
  return db
    .prepare<{ n: number }, never[]>("SELECT COUNT(*) as n FROM judgment_events")
    .get()!.n;
}

function ftsHits(query: string): string[] {
  return db
    .prepare<{ id: string }, [string]>(
      `SELECT id FROM judgment_items
       WHERE fts_rowid IN (
         SELECT rowid FROM judgment_items_fts
         WHERE judgment_items_fts MATCH ?
       )
       ORDER BY id`,
    )
    .all(query)
    .map((r) => r.id);
}

// ---------------------------------------------------------------
// Basic insert
// ---------------------------------------------------------------

describe("proposeJudgment — basic insert", () => {
  test("inserts one row into judgment_items", () => {
    proposeJudgment(db, validInput);
    expect(countItems()).toBe(1);
  });

  test("result id is non-empty string", () => {
    const j = proposeJudgment(db, validInput);
    expect(typeof j.id).toBe("string");
    expect(j.id.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------
// Required proposal defaults
// ---------------------------------------------------------------

describe("proposeJudgment — proposal defaults", () => {
  test("lifecycle_status = proposed", () => {
    const j = proposeJudgment(db, validInput);
    expect(getItem(j.id)!.lifecycle_status).toBe("proposed");
  });

  test("approval_state = pending", () => {
    const j = proposeJudgment(db, validInput);
    expect(getItem(j.id)!.approval_state).toBe("pending");
  });

  test("activation_state = history_only (not the DB default eligible)", () => {
    const j = proposeJudgment(db, validInput);
    const row = getItem(j.id)!;
    expect(row.activation_state).toBe("history_only");
    expect(row.activation_state).not.toBe("eligible");
  });

  test("retention_state = normal", () => {
    const j = proposeJudgment(db, validInput);
    expect(getItem(j.id)!.retention_state).toBe("normal");
  });

  test("authority_source = none", () => {
    const j = proposeJudgment(db, validInput);
    expect(getItem(j.id)!.authority_source).toBe("none");
  });

  test("decay_policy = supersede_only", () => {
    const j = proposeJudgment(db, validInput);
    expect(getItem(j.id)!.decay_policy).toBe("supersede_only");
  });

  test(`ontology_version = ${ONTOLOGY_VERSION}`, () => {
    const j = proposeJudgment(db, validInput);
    expect(getItem(j.id)!.ontology_version).toBe(ONTOLOGY_VERSION);
  });

  test(`schema_version = ${SCHEMA_VERSION}`, () => {
    const j = proposeJudgment(db, validInput);
    expect(getItem(j.id)!.schema_version).toBe(SCHEMA_VERSION);
  });
});

// ---------------------------------------------------------------
// Statement trimming
// ---------------------------------------------------------------

describe("proposeJudgment — statement trimming", () => {
  test("stores trimmed statement in DB", () => {
    const j = proposeJudgment(db, { ...validInput, statement: "  padded  " });
    expect(getItem(j.id)!.statement).toBe("padded");
  });

  test("result returns trimmed statement", () => {
    const j = proposeJudgment(db, { ...validInput, statement: "  padded  " });
    expect(j.statement).toBe("padded");
  });
});

// ---------------------------------------------------------------
// procedure_subtype logic
// ---------------------------------------------------------------

describe("proposeJudgment — procedure_subtype", () => {
  test("procedure kind defaults procedure_subtype to skill", () => {
    const j = proposeJudgment(db, { ...validInput, kind: "procedure" });
    expect(j.procedure_subtype).toBe("skill");
    expect(getItem(j.id)!.procedure_subtype).toBe("skill");
  });

  test("procedure kind with explicit valid procedure_subtype is accepted", () => {
    const j = proposeJudgment(db, {
      ...validInput,
      kind: "procedure",
      procedure_subtype: "policy",
    });
    expect(j.procedure_subtype).toBe("policy");
  });

  test("non-procedure with procedure_subtype is rejected before DB insert", () => {
    const before = countItems();
    expect(() =>
      proposeJudgment(db, { ...validInput, kind: "fact", procedure_subtype: "skill" }),
    ).toThrow(JudgmentValidationError);
    expect(countItems()).toBe(before);
  });

  test("procedure with invalid procedure_subtype is rejected before DB insert", () => {
    const before = countItems();
    expect(() =>
      proposeJudgment(db, {
        ...validInput,
        kind: "procedure",
        procedure_subtype: "magic",
      }),
    ).toThrow(JudgmentValidationError);
    expect(countItems()).toBe(before);
  });
});

// ---------------------------------------------------------------
// Validation rejections (all before DB insert)
// ---------------------------------------------------------------

describe("proposeJudgment — validation rejections", () => {
  function assertRejectedBeforeInsert(input: typeof validInput) {
    const before = countItems();
    expect(() => proposeJudgment(db, input)).toThrow(JudgmentValidationError);
    expect(countItems()).toBe(before);
  }

  test("null input throws JudgmentValidationError (not a raw TypeError)", () => {
    const before = countItems();
    expect(() => proposeJudgment(db, null as never)).toThrow(JudgmentValidationError);
    expect(countItems()).toBe(before);
  });

  test("empty statement is rejected before DB insert", () => {
    assertRejectedBeforeInsert({ ...validInput, statement: "" });
  });

  test("whitespace-only statement is rejected before DB insert", () => {
    assertRejectedBeforeInsert({ ...validInput, statement: "   " });
    assertRejectedBeforeInsert({ ...validInput, statement: "\t\n\r " });
  });

  test("invalid kind is rejected before DB insert", () => {
    assertRejectedBeforeInsert({ ...validInput, kind: "banana" } as never);
  });

  test("invalid epistemic_origin is rejected before DB insert", () => {
    assertRejectedBeforeInsert({
      ...validInput,
      epistemic_origin: "rumor",
    } as never);
  });

  test("invalid confidence is rejected before DB insert", () => {
    assertRejectedBeforeInsert({
      ...validInput,
      confidence: "definite",
    } as never);
  });

  test("scope = null is rejected before DB insert", () => {
    assertRejectedBeforeInsert({ ...validInput, scope: null } as never);
  });

  test("scope = array is rejected before DB insert", () => {
    assertRejectedBeforeInsert({ ...validInput, scope: [] } as never);
  });

  test("scope = primitive is rejected before DB insert", () => {
    assertRejectedBeforeInsert({ ...validInput, scope: "flat" } as never);
    assertRejectedBeforeInsert({ ...validInput, scope: 42 } as never);
  });

  test("invalid importance values are rejected before DB insert", () => {
    assertRejectedBeforeInsert({
      ...validInput,
      importance: 0,
    } as never);
    assertRejectedBeforeInsert({
      ...validInput,
      importance: 6,
    } as never);
    assertRejectedBeforeInsert({
      ...validInput,
      importance: 2.5,
    } as never);
  });

  test("source_ids must be string arrays if supplied", () => {
    assertRejectedBeforeInsert({
      ...validInput,
      source_ids: [123 as unknown as string],
    });
    assertRejectedBeforeInsert({ ...validInput, source_ids: [""] });
  });

  test("evidence_ids must be string arrays if supplied", () => {
    assertRejectedBeforeInsert({
      ...validInput,
      evidence_ids: [null as unknown as string],
    });
    assertRejectedBeforeInsert({ ...validInput, evidence_ids: [""] });
  });

  test("unserializable scope cannot be inserted through the repository", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    assertRejectedBeforeInsert({ ...validInput, scope: circular });
  });

  test("scope = Date instance is rejected (class instances not allowed as plain objects)", () => {
    // Date serializes to a string scalar — would corrupt scope_json shape if allowed.
    assertRejectedBeforeInsert({ ...validInput, scope: new Date() as unknown as Record<string, unknown> });
  });

  test("scope = Map instance is rejected before DB insert", () => {
    // Map serializes to {} — silently loses all entries; stored scope_json diverges from
    // the live value returned by proposeJudgment.  proto check must catch this.
    assertRejectedBeforeInsert({
      ...validInput,
      scope: new Map([["k", "v"]]) as unknown as Record<string, unknown>,
    });
  });

  test("scope with toJSON() returning undefined is rejected before DB insert", () => {
    // JSON.stringify returns undefined → non-bindable scope_json causes SQLite error without this guard.
    const undefinedJson = { toJSON() { return undefined; } } as unknown as Record<string, unknown>;
    assertRejectedBeforeInsert({ ...validInput, scope: undefinedJson });
  });

  test("scope with toJSON() returning scalar is rejected before DB insert", () => {
    const scalarJson = { toJSON() { return "scalar"; } } as unknown as Record<string, unknown>;
    assertRejectedBeforeInsert({ ...validInput, scope: scalarJson });
  });

  test("source_ids with toJSON() returning undefined is rejected before DB insert", () => {
    const arr = Object.assign(["s1"], { toJSON() { return undefined; } });
    assertRejectedBeforeInsert({ ...validInput, source_ids: arr });
  });

  test("evidence_ids with toJSON() returning scalar is rejected before DB insert", () => {
    const arr = Object.assign(["e1"], { toJSON() { return "scalar"; } });
    assertRejectedBeforeInsert({ ...validInput, evidence_ids: arr });
  });

  test("source_ids with toJSON() returning non-string-element array is rejected before DB insert", () => {
    const arr = Object.assign(["s1"], { toJSON() { return [1, 2]; } });
    assertRejectedBeforeInsert({ ...validInput, source_ids: arr });
  });

  test("would_change_if = Date instance is rejected before DB insert", () => {
    // Date serializes to a string scalar — would corrupt would_change_if_json shape.
    assertRejectedBeforeInsert({ ...validInput, would_change_if: new Date() });
  });

  test("missing_evidence with toJSON() returning scalar is rejected before DB insert", () => {
    const scalarJson = { toJSON() { return "scalar"; } };
    assertRejectedBeforeInsert({ ...validInput, missing_evidence: scalarJson });
  });

  test("optional timestamp field as non-string is rejected before DB insert", () => {
    // Ensures non-string observed_at causes JudgmentValidationError, not a raw TypeError
    // from the SQLite binding (which would bypass the documented error shape in tool.ts).
    assertRejectedBeforeInsert({ ...validInput, observed_at: {} as unknown as string });
    assertRejectedBeforeInsert({ ...validInput, valid_from: 42 as unknown as string });
    assertRejectedBeforeInsert({ ...validInput, volatility: [] as unknown as string });
  });
});

// ---------------------------------------------------------------
// FTS trigger
// ---------------------------------------------------------------

describe("proposeJudgment — FTS trigger", () => {
  test("repository insert populates judgment_items_fts via trigger", () => {
    const j = proposeJudgment(db, {
      ...validInput,
      statement: "uniqueftstestterm actwyn",
    });
    const hits = ftsHits("uniqueftstestterm");
    expect(hits).toContain(j.id);
  });
});

// ---------------------------------------------------------------
// judgment_events
// ---------------------------------------------------------------

describe("proposeJudgment — judgment_events", () => {
  test("inserts exactly one event row with event_type = judgment.proposed", () => {
    const j = proposeJudgment(db, validInput);
    const events = db
      .prepare<{ event_type: string }, [string]>(
        "SELECT event_type FROM judgment_events WHERE judgment_id = ?",
      )
      .all(j.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.event_type).toBe("judgment.proposed");
  });

  test("event payload_json is valid JSON and includes judgment_id", () => {
    const j = proposeJudgment(db, validInput);
    const event = db
      .prepare<{ payload_json: string }, [string]>(
        "SELECT payload_json FROM judgment_events WHERE judgment_id = ?",
      )
      .get(j.id);
    expect(event).not.toBeNull();
    const payload = JSON.parse(event!.payload_json) as Record<string, unknown>;
    expect(payload.judgment_id).toBe(j.id);
  });

  test("event payload includes source_ids when supplied", () => {
    const j = proposeJudgment(db, {
      ...validInput,
      source_ids: ["src-001"],
    });
    const event = db
      .prepare<{ payload_json: string }, [string]>(
        "SELECT payload_json FROM judgment_events WHERE judgment_id = ?",
      )
      .get(j.id);
    const payload = JSON.parse(event!.payload_json) as Record<string, unknown>;
    expect(payload.source_ids).toEqual(["src-001"]);
  });
});

// ---------------------------------------------------------------
// Transaction rollback
// ---------------------------------------------------------------

describe("proposeJudgment — transaction rollback", () => {
  test("rollback leaves no judgment row if event insert fails", () => {
    const id = "rollback-test-id-001";
    const err = new Error("simulated event insert failure");
    expect(() =>
      proposeJudgment(db, validInput, {
        newId: () => id,
        _injectEventInsertError: err,
      }),
    ).toThrow("simulated event insert failure");

    const row = db
      .prepare<{ id: string }, [string]>("SELECT id FROM judgment_items WHERE id = ?")
      .get(id);
    expect(row).toBeNull();
    expect(countEvents()).toBe(0);
  });
});

// ---------------------------------------------------------------
// Deps injection
// ---------------------------------------------------------------

describe("proposeJudgment — deps injection", () => {
  test("newId is used for judgment item id", () => {
    const j = proposeJudgment(db, validInput, { newId: () => "test-id-fixed" });
    expect(j.id).toBe("test-id-fixed");
    expect(getItem("test-id-fixed")).not.toBeNull();
  });

  test("actor is stamped on judgment_events", () => {
    const j = proposeJudgment(db, validInput, { actor: "test-actor" });
    const event = db
      .prepare<{ actor: string }, [string]>(
        "SELECT actor FROM judgment_events WHERE judgment_id = ?",
      )
      .get(j.id);
    expect(event!.actor).toBe("test-actor");
  });

  test("actor defaults to system", () => {
    const j = proposeJudgment(db, validInput);
    const event = db
      .prepare<{ actor: string }, [string]>(
        "SELECT actor FROM judgment_events WHERE judgment_id = ?",
      )
      .get(j.id);
    expect(event!.actor).toBe("system");
  });
});

// ---------------------------------------------------------------
// Optional fields
// ---------------------------------------------------------------

describe("proposeJudgment — optional fields", () => {
  test("source_ids stored as JSON array in source_ids_json", () => {
    const j = proposeJudgment(db, { ...validInput, source_ids: ["s1", "s2"] });
    const row = db
      .prepare<{ source_ids_json: string }, [string]>(
        "SELECT source_ids_json FROM judgment_items WHERE id = ?",
      )
      .get(j.id);
    expect(JSON.parse(row!.source_ids_json)).toEqual(["s1", "s2"]);
    expect(j.source_ids).toEqual(["s1", "s2"]);
  });

  test("result source_ids is null when not supplied", () => {
    const j = proposeJudgment(db, validInput);
    expect(j.source_ids).toBeNull();
  });

  test("importance is stored and returned correctly", () => {
    const j = proposeJudgment(db, { ...validInput, importance: 5 });
    expect(j.importance).toBe(5);
    expect(getItem(j.id)!.importance).toBe(5);
  });
});

// ---------------------------------------------------------------
// Phase 1A.3 — approveProposedJudgment
// ---------------------------------------------------------------

const validApproveInput: ApproveInput = {
  judgment_id: "", // filled per test
  reviewer: "test-reviewer",
};

const validRejectInput: RejectInput = {
  judgment_id: "", // filled per test
  reviewer: "test-reviewer",
  reason: "not accurate",
};

function getFullItem(id: string) {
  return db
    .prepare<
      {
        id: string;
        kind: string;
        statement: string;
        lifecycle_status: string;
        approval_state: string;
        activation_state: string;
        retention_state: string;
        authority_source: string;
        approved_by: string | null;
        approved_at: string | null;
        updated_at: string;
      },
      [string]
    >(
      `SELECT id, kind, statement, lifecycle_status, approval_state,
              activation_state, retention_state, authority_source,
              approved_by, approved_at, updated_at
       FROM judgment_items WHERE id = ?`,
    )
    .get(id);
}

function getEvents(judgmentId: string) {
  return db
    .prepare<{ id: string; event_type: string; payload_json: string; actor: string }, [string]>(
      "SELECT id, event_type, payload_json, actor FROM judgment_events WHERE judgment_id = ? ORDER BY created_at",
    )
    .all(judgmentId);
}

function forceState(
  id: string,
  patch: Partial<{
    lifecycle_status: string;
    approval_state: string;
    activation_state: string;
    retention_state: string;
  }>,
) {
  const sets: string[] = [];
  if (patch.lifecycle_status !== undefined) sets.push(`lifecycle_status = '${patch.lifecycle_status}'`);
  if (patch.approval_state !== undefined) sets.push(`approval_state = '${patch.approval_state}'`);
  if (patch.activation_state !== undefined) sets.push(`activation_state = '${patch.activation_state}'`);
  if (patch.retention_state !== undefined) sets.push(`retention_state = '${patch.retention_state}'`);
  if (sets.length === 0) return;
  db.prepare(`UPDATE judgment_items SET ${sets.join(", ")} WHERE id = ?`).run(id);
}

describe("approveProposedJudgment — basic approval", () => {
  test("approves an existing proposed/pending/history_only row", () => {
    const j = proposeJudgment(db, validInput);
    const r = approveProposedJudgment(db, { ...validApproveInput, judgment_id: j.id });
    expect(r.id).toBe(j.id);
    expect(r.approval_state).toBe("approved");
  });

  test("approval sets approval_state = approved", () => {
    const j = proposeJudgment(db, validInput);
    approveProposedJudgment(db, { ...validApproveInput, judgment_id: j.id });
    expect(getFullItem(j.id)!.approval_state).toBe("approved");
  });

  test("approval sets approved_by = reviewer", () => {
    const j = proposeJudgment(db, validInput);
    approveProposedJudgment(db, { ...validApproveInput, judgment_id: j.id, reviewer: "alice" });
    expect(getFullItem(j.id)!.approved_by).toBe("alice");
  });

  test("approval sets approved_at", () => {
    const j = proposeJudgment(db, validInput);
    const fixedNow = "2026-04-27T12:00:00.000Z";
    const r = approveProposedJudgment(db, { ...validApproveInput, judgment_id: j.id }, { nowIso: () => fixedNow });
    expect(r.approved_at).toBe(fixedNow);
    expect(getFullItem(j.id)!.approved_at).toBe(fixedNow);
  });

  test("approval leaves lifecycle_status = proposed", () => {
    const j = proposeJudgment(db, validInput);
    approveProposedJudgment(db, { ...validApproveInput, judgment_id: j.id });
    const row = getFullItem(j.id)!;
    expect(row.lifecycle_status).toBe("proposed");
  });

  test("approval leaves activation_state = history_only", () => {
    const j = proposeJudgment(db, validInput);
    approveProposedJudgment(db, { ...validApproveInput, judgment_id: j.id });
    expect(getFullItem(j.id)!.activation_state).toBe("history_only");
  });

  test("approval leaves retention_state = normal", () => {
    const j = proposeJudgment(db, validInput);
    approveProposedJudgment(db, { ...validApproveInput, judgment_id: j.id });
    expect(getFullItem(j.id)!.retention_state).toBe("normal");
  });

  test("approval leaves authority_source = none", () => {
    const j = proposeJudgment(db, validInput);
    approveProposedJudgment(db, { ...validApproveInput, judgment_id: j.id });
    expect(getFullItem(j.id)!.authority_source).toBe("none");
  });

  test("approval updates updated_at", () => {
    const j = proposeJudgment(db, validInput);
    const before = getFullItem(j.id)!.updated_at;
    const fixedNow = "2099-01-01T00:00:00.000Z";
    approveProposedJudgment(db, { ...validApproveInput, judgment_id: j.id }, { nowIso: () => fixedNow });
    expect(getFullItem(j.id)!.updated_at).toBe(fixedNow);
    expect(getFullItem(j.id)!.updated_at).not.toBe(before);
  });

  test("approval does not create active/eligible rows", () => {
    const j = proposeJudgment(db, validInput);
    approveProposedJudgment(db, { ...validApproveInput, judgment_id: j.id });
    const row = getFullItem(j.id)!;
    expect(row.lifecycle_status).not.toBe("active");
    expect(row.activation_state).not.toBe("eligible");
  });
});

describe("approveProposedJudgment — event", () => {
  test("approval appends exactly one judgment.approved event", () => {
    const j = proposeJudgment(db, validInput);
    approveProposedJudgment(db, { ...validApproveInput, judgment_id: j.id });
    const events = getEvents(j.id);
    const approvedEvents = events.filter((e) => e.event_type === "judgment.approved");
    expect(approvedEvents).toHaveLength(1);
  });

  test("event payload_json is valid JSON with required fields", () => {
    const j = proposeJudgment(db, validInput);
    approveProposedJudgment(db, { ...validApproveInput, judgment_id: j.id, reviewer: "bob" });
    const events = getEvents(j.id);
    const ev = events.find((e) => e.event_type === "judgment.approved")!;
    const payload = JSON.parse(ev.payload_json) as Record<string, unknown>;
    expect(payload.judgment_id).toBe(j.id);
    expect(payload.reviewer).toBe("bob");
    expect(payload.previous_approval_state).toBe("pending");
    expect(payload.new_approval_state).toBe("approved");
    expect(payload.previous_lifecycle_status).toBe("proposed");
    expect(payload.new_lifecycle_status).toBe("proposed");
    expect(payload.previous_activation_state).toBe("history_only");
    expect(payload.new_activation_state).toBe("history_only");
  });

  test("approval with reason stores trimmed reason in event payload", () => {
    const j = proposeJudgment(db, validInput);
    approveProposedJudgment(db, { ...validApproveInput, judgment_id: j.id, reason: "  looks good  " });
    const ev = getEvents(j.id).find((e) => e.event_type === "judgment.approved")!;
    const payload = JSON.parse(ev.payload_json) as Record<string, unknown>;
    expect(payload.reason).toBe("looks good");
  });

  test("approval with optional payload stores it as object in event payload", () => {
    const j = proposeJudgment(db, validInput);
    approveProposedJudgment(db, { ...validApproveInput, judgment_id: j.id, payload: { source: "manual" } });
    const ev = getEvents(j.id).find((e) => e.event_type === "judgment.approved")!;
    const payload = JSON.parse(ev.payload_json) as Record<string, unknown>;
    expect(payload.payload).toEqual({ source: "manual" });
  });

  test("event id matches return value event_id", () => {
    const j = proposeJudgment(db, validInput);
    const fixedId = "evt-approve-fixed";
    const r = approveProposedJudgment(db, { ...validApproveInput, judgment_id: j.id }, { newEventId: () => fixedId });
    expect(r.event_id).toBe(fixedId);
    const ev = getEvents(j.id).find((e) => e.event_type === "judgment.approved")!;
    expect(ev.id).toBe(fixedId);
  });
});

describe("approveProposedJudgment — error cases", () => {
  test("approval of missing judgment throws JudgmentNotFoundError", () => {
    expect(() =>
      approveProposedJudgment(db, { ...validApproveInput, judgment_id: "nonexistent-id" }),
    ).toThrow(JudgmentNotFoundError);
  });

  test("approval of missing judgment appends no event", () => {
    const before = countEvents();
    try { approveProposedJudgment(db, { ...validApproveInput, judgment_id: "nonexistent-id" }); } catch {}
    expect(countEvents()).toBe(before);
  });

  test("approval of already approved judgment fails with JudgmentStateError", () => {
    const j = proposeJudgment(db, validInput);
    approveProposedJudgment(db, { ...validApproveInput, judgment_id: j.id });
    expect(() =>
      approveProposedJudgment(db, { ...validApproveInput, judgment_id: j.id }),
    ).toThrow(JudgmentStateError);
  });

  test("approval of already approved judgment appends no second event", () => {
    const j = proposeJudgment(db, validInput);
    approveProposedJudgment(db, { ...validApproveInput, judgment_id: j.id });
    const countBefore = getEvents(j.id).filter((e) => e.event_type === "judgment.approved").length;
    try { approveProposedJudgment(db, { ...validApproveInput, judgment_id: j.id }); } catch {}
    expect(getEvents(j.id).filter((e) => e.event_type === "judgment.approved").length).toBe(countBefore);
  });

  test("approval of rejected judgment fails with JudgmentStateError", () => {
    const j = proposeJudgment(db, validInput);
    rejectProposedJudgment(db, { ...validRejectInput, judgment_id: j.id });
    expect(() =>
      approveProposedJudgment(db, { ...validApproveInput, judgment_id: j.id }),
    ).toThrow(JudgmentStateError);
  });

  test("approval of active row fails with JudgmentStateError", () => {
    const j = proposeJudgment(db, validInput);
    forceState(j.id, { lifecycle_status: "active", approval_state: "not_required", activation_state: "eligible" });
    expect(() =>
      approveProposedJudgment(db, { ...validApproveInput, judgment_id: j.id }),
    ).toThrow(JudgmentStateError);
  });

  test("approval of revoked row fails with JudgmentStateError", () => {
    const j = proposeJudgment(db, validInput);
    forceState(j.id, { lifecycle_status: "revoked", approval_state: "not_required" });
    expect(() =>
      approveProposedJudgment(db, { ...validApproveInput, judgment_id: j.id }),
    ).toThrow(JudgmentStateError);
  });

  test("approval of superseded row fails with JudgmentStateError", () => {
    const j = proposeJudgment(db, validInput);
    forceState(j.id, { lifecycle_status: "superseded", approval_state: "not_required" });
    expect(() =>
      approveProposedJudgment(db, { ...validApproveInput, judgment_id: j.id }),
    ).toThrow(JudgmentStateError);
  });

  test("approval of expired row fails with JudgmentStateError", () => {
    const j = proposeJudgment(db, validInput);
    forceState(j.id, { lifecycle_status: "expired", approval_state: "not_required" });
    expect(() =>
      approveProposedJudgment(db, { ...validApproveInput, judgment_id: j.id }),
    ).toThrow(JudgmentStateError);
  });
});

describe("approveProposedJudgment — transaction rollback", () => {
  test("if event insert fails, status update is rolled back", () => {
    const j = proposeJudgment(db, validInput);
    const err = new Error("simulated event insert failure");
    expect(() =>
      approveProposedJudgment(db, { ...validApproveInput, judgment_id: j.id }, { _injectEventInsertError: err }),
    ).toThrow("simulated event insert failure");
    // Row must still be in original proposed/pending state
    const row = getFullItem(j.id)!;
    expect(row.approval_state).toBe("pending");
    expect(row.approved_by).toBeNull();
    expect(row.approved_at).toBeNull();
    // No approve event appended
    expect(getEvents(j.id).filter((e) => e.event_type === "judgment.approved")).toHaveLength(0);
  });
});

describe("approveProposedJudgment — validation", () => {
  test("empty judgment_id is rejected", () => {
    expect(() =>
      approveProposedJudgment(db, { ...validApproveInput, judgment_id: "" }),
    ).toThrow(JudgmentValidationError);
  });

  test("whitespace-only judgment_id is rejected", () => {
    expect(() =>
      approveProposedJudgment(db, { ...validApproveInput, judgment_id: "   " }),
    ).toThrow(JudgmentValidationError);
  });

  test("empty reviewer is rejected", () => {
    const j = proposeJudgment(db, validInput);
    expect(() =>
      approveProposedJudgment(db, { judgment_id: j.id, reviewer: "" }),
    ).toThrow(JudgmentValidationError);
  });

  test("whitespace-only reviewer is rejected", () => {
    const j = proposeJudgment(db, validInput);
    expect(() =>
      approveProposedJudgment(db, { judgment_id: j.id, reviewer: "  " }),
    ).toThrow(JudgmentValidationError);
  });

  test("whitespace-only optional reason is rejected", () => {
    const j = proposeJudgment(db, validInput);
    expect(() =>
      approveProposedJudgment(db, { ...validApproveInput, judgment_id: j.id, reason: "   " }),
    ).toThrow(JudgmentValidationError);
  });

  test("null payload is rejected", () => {
    const j = proposeJudgment(db, validInput);
    expect(() =>
      approveProposedJudgment(db, { ...validApproveInput, judgment_id: j.id, payload: null as never }),
    ).toThrow(JudgmentValidationError);
  });

  test("array payload is rejected", () => {
    const j = proposeJudgment(db, validInput);
    expect(() =>
      approveProposedJudgment(db, { ...validApproveInput, judgment_id: j.id, payload: [] as never }),
    ).toThrow(JudgmentValidationError);
  });

  test("primitive payload is rejected", () => {
    const j = proposeJudgment(db, validInput);
    expect(() =>
      approveProposedJudgment(db, { ...validApproveInput, judgment_id: j.id, payload: "string" as never }),
    ).toThrow(JudgmentValidationError);
  });

  test("class instance payload is rejected", () => {
    const j = proposeJudgment(db, validInput);
    expect(() =>
      approveProposedJudgment(db, { ...validApproveInput, judgment_id: j.id, payload: new Date() as never }),
    ).toThrow(JudgmentValidationError);
  });

  test("unserializable payload is rejected before DB write", () => {
    const j = proposeJudgment(db, validInput);
    const circ: Record<string, unknown> = {};
    circ["self"] = circ;
    const before = countItems();
    expect(() =>
      approveProposedJudgment(db, { ...validApproveInput, judgment_id: j.id, payload: circ }),
    ).toThrow(JudgmentValidationError);
    expect(countItems()).toBe(before);
  });
});

// ---------------------------------------------------------------
// Phase 1A.3 — rejectProposedJudgment
// ---------------------------------------------------------------

describe("rejectProposedJudgment — basic rejection", () => {
  test("rejects an existing proposed/pending/history_only row", () => {
    const j = proposeJudgment(db, validInput);
    const r = rejectProposedJudgment(db, { ...validRejectInput, judgment_id: j.id });
    expect(r.id).toBe(j.id);
    expect(r.approval_state).toBe("rejected");
  });

  test("rejection sets approval_state = rejected", () => {
    const j = proposeJudgment(db, validInput);
    rejectProposedJudgment(db, { ...validRejectInput, judgment_id: j.id });
    expect(getFullItem(j.id)!.approval_state).toBe("rejected");
  });

  test("rejection sets lifecycle_status = rejected", () => {
    const j = proposeJudgment(db, validInput);
    rejectProposedJudgment(db, { ...validRejectInput, judgment_id: j.id });
    expect(getFullItem(j.id)!.lifecycle_status).toBe("rejected");
  });

  test("rejection sets activation_state = excluded", () => {
    const j = proposeJudgment(db, validInput);
    rejectProposedJudgment(db, { ...validRejectInput, judgment_id: j.id });
    expect(getFullItem(j.id)!.activation_state).toBe("excluded");
  });

  test("rejection leaves retention_state = normal", () => {
    const j = proposeJudgment(db, validInput);
    rejectProposedJudgment(db, { ...validRejectInput, judgment_id: j.id });
    expect(getFullItem(j.id)!.retention_state).toBe("normal");
  });

  test("rejection leaves authority_source = none", () => {
    const j = proposeJudgment(db, validInput);
    rejectProposedJudgment(db, { ...validRejectInput, judgment_id: j.id });
    expect(getFullItem(j.id)!.authority_source).toBe("none");
  });

  test("rejection leaves approved_by null", () => {
    const j = proposeJudgment(db, validInput);
    rejectProposedJudgment(db, { ...validRejectInput, judgment_id: j.id });
    expect(getFullItem(j.id)!.approved_by).toBeNull();
  });

  test("rejection leaves approved_at null", () => {
    const j = proposeJudgment(db, validInput);
    rejectProposedJudgment(db, { ...validRejectInput, judgment_id: j.id });
    expect(getFullItem(j.id)!.approved_at).toBeNull();
  });

  test("rejection updates updated_at", () => {
    const j = proposeJudgment(db, validInput);
    const before = getFullItem(j.id)!.updated_at;
    const fixedNow = "2099-01-01T00:00:00.000Z";
    rejectProposedJudgment(db, { ...validRejectInput, judgment_id: j.id }, { nowIso: () => fixedNow });
    expect(getFullItem(j.id)!.updated_at).toBe(fixedNow);
    expect(getFullItem(j.id)!.updated_at).not.toBe(before);
  });

  test("rejection does not create active/eligible rows", () => {
    const j = proposeJudgment(db, validInput);
    rejectProposedJudgment(db, { ...validRejectInput, judgment_id: j.id });
    const row = getFullItem(j.id)!;
    expect(row.lifecycle_status).not.toBe("active");
    expect(row.activation_state).not.toBe("eligible");
  });
});

describe("rejectProposedJudgment — event", () => {
  test("rejection appends exactly one judgment.rejected event", () => {
    const j = proposeJudgment(db, validInput);
    rejectProposedJudgment(db, { ...validRejectInput, judgment_id: j.id });
    const events = getEvents(j.id);
    const rejectedEvents = events.filter((e) => e.event_type === "judgment.rejected");
    expect(rejectedEvents).toHaveLength(1);
  });

  test("event payload_json is valid JSON with required fields", () => {
    const j = proposeJudgment(db, validInput);
    rejectProposedJudgment(db, { ...validRejectInput, judgment_id: j.id, reviewer: "carol", reason: "stale" });
    const ev = getEvents(j.id).find((e) => e.event_type === "judgment.rejected")!;
    const payload = JSON.parse(ev.payload_json) as Record<string, unknown>;
    expect(payload.judgment_id).toBe(j.id);
    expect(payload.reviewer).toBe("carol");
    expect(payload.reason).toBe("stale");
    expect(payload.previous_approval_state).toBe("pending");
    expect(payload.new_approval_state).toBe("rejected");
    expect(payload.previous_lifecycle_status).toBe("proposed");
    expect(payload.new_lifecycle_status).toBe("rejected");
    expect(payload.previous_activation_state).toBe("history_only");
    expect(payload.new_activation_state).toBe("excluded");
  });

  test("rejection stores trimmed reason in event payload", () => {
    const j = proposeJudgment(db, validInput);
    rejectProposedJudgment(db, { ...validRejectInput, judgment_id: j.id, reason: "  bad data  " });
    const ev = getEvents(j.id).find((e) => e.event_type === "judgment.rejected")!;
    const payload = JSON.parse(ev.payload_json) as Record<string, unknown>;
    expect(payload.reason).toBe("bad data");
  });

  test("rejection with optional payload stores it as object in event payload", () => {
    const j = proposeJudgment(db, validInput);
    rejectProposedJudgment(db, { ...validRejectInput, judgment_id: j.id, payload: { note: "duplicate" } });
    const ev = getEvents(j.id).find((e) => e.event_type === "judgment.rejected")!;
    const payload = JSON.parse(ev.payload_json) as Record<string, unknown>;
    expect(payload.payload).toEqual({ note: "duplicate" });
  });

  test("event id matches return value event_id", () => {
    const j = proposeJudgment(db, validInput);
    const fixedId = "evt-reject-fixed";
    const r = rejectProposedJudgment(db, { ...validRejectInput, judgment_id: j.id }, { newEventId: () => fixedId });
    expect(r.event_id).toBe(fixedId);
    const ev = getEvents(j.id).find((e) => e.event_type === "judgment.rejected")!;
    expect(ev.id).toBe(fixedId);
  });
});

describe("rejectProposedJudgment — error cases", () => {
  test("rejection of missing judgment throws JudgmentNotFoundError", () => {
    expect(() =>
      rejectProposedJudgment(db, { ...validRejectInput, judgment_id: "nonexistent-id" }),
    ).toThrow(JudgmentNotFoundError);
  });

  test("rejection of missing judgment appends no event", () => {
    const before = countEvents();
    try { rejectProposedJudgment(db, { ...validRejectInput, judgment_id: "nonexistent-id" }); } catch {}
    expect(countEvents()).toBe(before);
  });

  test("rejection of already rejected judgment fails with JudgmentStateError", () => {
    const j = proposeJudgment(db, validInput);
    rejectProposedJudgment(db, { ...validRejectInput, judgment_id: j.id });
    expect(() =>
      rejectProposedJudgment(db, { ...validRejectInput, judgment_id: j.id }),
    ).toThrow(JudgmentStateError);
  });

  test("rejection of already rejected judgment appends no second event", () => {
    const j = proposeJudgment(db, validInput);
    rejectProposedJudgment(db, { ...validRejectInput, judgment_id: j.id });
    const countBefore = getEvents(j.id).filter((e) => e.event_type === "judgment.rejected").length;
    try { rejectProposedJudgment(db, { ...validRejectInput, judgment_id: j.id }); } catch {}
    expect(getEvents(j.id).filter((e) => e.event_type === "judgment.rejected").length).toBe(countBefore);
  });

  test("rejection of approved judgment fails with JudgmentStateError", () => {
    const j = proposeJudgment(db, validInput);
    approveProposedJudgment(db, { ...validApproveInput, judgment_id: j.id });
    expect(() =>
      rejectProposedJudgment(db, { ...validRejectInput, judgment_id: j.id }),
    ).toThrow(JudgmentStateError);
  });

  test("rejection of active row fails with JudgmentStateError", () => {
    const j = proposeJudgment(db, validInput);
    forceState(j.id, { lifecycle_status: "active", approval_state: "not_required", activation_state: "eligible" });
    expect(() =>
      rejectProposedJudgment(db, { ...validRejectInput, judgment_id: j.id }),
    ).toThrow(JudgmentStateError);
  });

  test("rejection of revoked row fails with JudgmentStateError", () => {
    const j = proposeJudgment(db, validInput);
    forceState(j.id, { lifecycle_status: "revoked", approval_state: "not_required" });
    expect(() =>
      rejectProposedJudgment(db, { ...validRejectInput, judgment_id: j.id }),
    ).toThrow(JudgmentStateError);
  });

  test("rejection of superseded row fails with JudgmentStateError", () => {
    const j = proposeJudgment(db, validInput);
    forceState(j.id, { lifecycle_status: "superseded", approval_state: "not_required" });
    expect(() =>
      rejectProposedJudgment(db, { ...validRejectInput, judgment_id: j.id }),
    ).toThrow(JudgmentStateError);
  });

  test("rejection of expired row fails with JudgmentStateError", () => {
    const j = proposeJudgment(db, validInput);
    forceState(j.id, { lifecycle_status: "expired", approval_state: "not_required" });
    expect(() =>
      rejectProposedJudgment(db, { ...validRejectInput, judgment_id: j.id }),
    ).toThrow(JudgmentStateError);
  });
});

describe("rejectProposedJudgment — transaction rollback", () => {
  test("if event insert fails, status update is rolled back", () => {
    const j = proposeJudgment(db, validInput);
    const err = new Error("simulated event insert failure");
    expect(() =>
      rejectProposedJudgment(db, { ...validRejectInput, judgment_id: j.id }, { _injectEventInsertError: err }),
    ).toThrow("simulated event insert failure");
    const row = getFullItem(j.id)!;
    expect(row.lifecycle_status).toBe("proposed");
    expect(row.approval_state).toBe("pending");
    expect(row.activation_state).toBe("history_only");
    expect(getEvents(j.id).filter((e) => e.event_type === "judgment.rejected")).toHaveLength(0);
  });
});

describe("rejectProposedJudgment — validation", () => {
  test("empty judgment_id is rejected", () => {
    expect(() =>
      rejectProposedJudgment(db, { ...validRejectInput, judgment_id: "" }),
    ).toThrow(JudgmentValidationError);
  });

  test("whitespace-only judgment_id is rejected", () => {
    expect(() =>
      rejectProposedJudgment(db, { ...validRejectInput, judgment_id: "  " }),
    ).toThrow(JudgmentValidationError);
  });

  test("empty reviewer is rejected", () => {
    const j = proposeJudgment(db, validInput);
    expect(() =>
      rejectProposedJudgment(db, { judgment_id: j.id, reviewer: "", reason: "bad" }),
    ).toThrow(JudgmentValidationError);
  });

  test("whitespace-only reviewer is rejected", () => {
    const j = proposeJudgment(db, validInput);
    expect(() =>
      rejectProposedJudgment(db, { judgment_id: j.id, reviewer: "  ", reason: "bad" }),
    ).toThrow(JudgmentValidationError);
  });

  test("reject reason required (missing)", () => {
    const j = proposeJudgment(db, validInput);
    expect(() =>
      rejectProposedJudgment(db, { judgment_id: j.id, reviewer: "alice", reason: undefined as never }),
    ).toThrow(JudgmentValidationError);
  });

  test("whitespace-only reason is rejected", () => {
    const j = proposeJudgment(db, validInput);
    expect(() =>
      rejectProposedJudgment(db, { ...validRejectInput, judgment_id: j.id, reason: "   " }),
    ).toThrow(JudgmentValidationError);
  });

  test("null payload is rejected", () => {
    const j = proposeJudgment(db, validInput);
    expect(() =>
      rejectProposedJudgment(db, { ...validRejectInput, judgment_id: j.id, payload: null as never }),
    ).toThrow(JudgmentValidationError);
  });

  test("array payload is rejected", () => {
    const j = proposeJudgment(db, validInput);
    expect(() =>
      rejectProposedJudgment(db, { ...validRejectInput, judgment_id: j.id, payload: [] as never }),
    ).toThrow(JudgmentValidationError);
  });

  test("primitive payload is rejected", () => {
    const j = proposeJudgment(db, validInput);
    expect(() =>
      rejectProposedJudgment(db, { ...validRejectInput, judgment_id: j.id, payload: 42 as never }),
    ).toThrow(JudgmentValidationError);
  });

  test("class instance payload is rejected", () => {
    const j = proposeJudgment(db, validInput);
    expect(() =>
      rejectProposedJudgment(db, { ...validRejectInput, judgment_id: j.id, payload: new Date() as never }),
    ).toThrow(JudgmentValidationError);
  });

  test("unserializable payload is rejected before DB write", () => {
    const j = proposeJudgment(db, validInput);
    const circ: Record<string, unknown> = {};
    circ["self"] = circ;
    const before = countItems();
    expect(() =>
      rejectProposedJudgment(db, { ...validRejectInput, judgment_id: j.id, payload: circ }),
    ).toThrow(JudgmentValidationError);
    expect(countItems()).toBe(before);
  });
});

// ---------------------------------------------------------------
// Stateful toJSON() — TOCTOU serialization regression
// ---------------------------------------------------------------

describe("approveProposedJudgment — stateful toJSON payload", () => {
  test("payload with toJSON that throws on second call is rejected as JudgmentValidationError", () => {
    // Guards against double-serialize bug: validatePlainJsonObject serializes once
    // internally; a second JSON.stringify call on a stateful toJSON would throw a
    // raw SyntaxError instead of a structured JudgmentValidationError.
    const j = proposeJudgment(db, validInput);
    let callCount = 0;
    const badPayload: Record<string, unknown> = {};
    (badPayload as Record<string, unknown>).toJSON = () => {
      callCount++;
      if (callCount >= 2) throw new SyntaxError("stateful toJSON exhausted");
      return { x: 1 };
    };
    expect(() =>
      approveProposedJudgment(db, { ...validApproveInput, judgment_id: j.id, payload: badPayload }),
    ).toThrow(JudgmentValidationError);
    // The row must remain in its original proposed/pending state
    const row = getFullItem(j.id)!;
    expect(row.approval_state).toBe("pending");
    expect(row.lifecycle_status).toBe("proposed");
  });
});

describe("rejectProposedJudgment — stateful toJSON payload", () => {
  test("payload with toJSON that throws on second call is rejected as JudgmentValidationError", () => {
    const j = proposeJudgment(db, validInput);
    let callCount = 0;
    const badPayload: Record<string, unknown> = {};
    (badPayload as Record<string, unknown>).toJSON = () => {
      callCount++;
      if (callCount >= 2) throw new SyntaxError("stateful toJSON exhausted");
      return { x: 1 };
    };
    expect(() =>
      rejectProposedJudgment(db, { ...validRejectInput, judgment_id: j.id, payload: badPayload }),
    ).toThrow(JudgmentValidationError);
    const row = getFullItem(j.id)!;
    expect(row.approval_state).toBe("pending");
    expect(row.lifecycle_status).toBe("proposed");
  });
});

// ---------------------------------------------------------------
// Phase 1A.4 — recordJudgmentSource
// ---------------------------------------------------------------

interface SourceRow {
  id: string;
  kind: string;
  locator: string;
  content_hash: string | null;
  trust_level: string;
  redacted: number;
  captured_at: string;
}

function getSource(id: string): SourceRow | null {
  return db
    .prepare<SourceRow, [string]>(
      `SELECT id, kind, locator, content_hash, trust_level, redacted, captured_at
       FROM judgment_sources WHERE id = ?`,
    )
    .get(id);
}

function countSources(): number {
  return db
    .prepare<{ n: number }, never[]>("SELECT COUNT(*) as n FROM judgment_sources")
    .get()!.n;
}

const validSourceInput: SourceInput = {
  kind: "turn",
  locator: "session:abc/turn:5",
};

describe("recordJudgmentSource — basic insert", () => {
  test("inserts one row into judgment_sources", () => {
    recordJudgmentSource(db, validSourceInput);
    expect(countSources()).toBe(1);
  });

  test("result id is non-empty string", () => {
    const s = recordJudgmentSource(db, validSourceInput);
    expect(typeof s.id).toBe("string");
    expect(s.id.length).toBeGreaterThan(0);
  });

  test("result event_type is judgment.source.recorded", () => {
    const s = recordJudgmentSource(db, validSourceInput);
    expect(s.event_type).toBe("judgment.source.recorded");
  });

  test("result event_id is non-empty string", () => {
    const s = recordJudgmentSource(db, validSourceInput);
    expect(typeof s.event_id).toBe("string");
    expect(s.event_id.length).toBeGreaterThan(0);
  });
});

describe("recordJudgmentSource — defaults", () => {
  test("default trust_level is medium", () => {
    const s = recordJudgmentSource(db, validSourceInput);
    expect(s.trust_level).toBe("medium");
    expect(getSource(s.id)!.trust_level).toBe("medium");
  });

  test("default redacted is true", () => {
    const s = recordJudgmentSource(db, validSourceInput);
    expect(s.redacted).toBe(true);
    expect(getSource(s.id)!.redacted).toBe(1);
  });

  test("content_hash defaults to null", () => {
    const s = recordJudgmentSource(db, validSourceInput);
    expect(s.content_hash).toBeNull();
  });
});

describe("recordJudgmentSource — trimming", () => {
  test("kind is trimmed", () => {
    const s = recordJudgmentSource(db, { ...validSourceInput, kind: "  turn  " });
    expect(s.kind).toBe("turn");
    expect(getSource(s.id)!.kind).toBe("turn");
  });

  test("locator is trimmed", () => {
    const s = recordJudgmentSource(db, { ...validSourceInput, locator: "  session:abc  " });
    expect(s.locator).toBe("session:abc");
  });

  test("content_hash is trimmed when supplied", () => {
    const s = recordJudgmentSource(db, {
      ...validSourceInput,
      content_hash: "  abc123  ",
    });
    expect(s.content_hash).toBe("abc123");
  });
});

describe("recordJudgmentSource — optional fields", () => {
  test("explicit trust_level low is accepted", () => {
    const s = recordJudgmentSource(db, { ...validSourceInput, trust_level: "low" });
    expect(s.trust_level).toBe("low");
  });

  test("explicit trust_level high is accepted", () => {
    const s = recordJudgmentSource(db, { ...validSourceInput, trust_level: "high" });
    expect(s.trust_level).toBe("high");
  });

  test("explicit redacted false is persisted as 0", () => {
    const s = recordJudgmentSource(db, { ...validSourceInput, redacted: false });
    expect(s.redacted).toBe(false);
    expect(getSource(s.id)!.redacted).toBe(0);
  });

  test("captured_at is returned when supplied", () => {
    const ts = "2025-01-01T00:00:00.000Z";
    const s = recordJudgmentSource(db, { ...validSourceInput, captured_at: ts });
    expect(s.captured_at).toBe(ts);
  });

  test("payload is accepted and included in event payload_json", () => {
    const s = recordJudgmentSource(db, {
      ...validSourceInput,
      payload: { extra: "data" },
    });
    const eventRow = db
      .prepare<{ payload_json: string }, [string]>(
        `SELECT payload_json FROM judgment_events WHERE id = ?`,
      )
      .get(s.event_id)!;
    const ep = JSON.parse(eventRow.payload_json) as Record<string, unknown>;
    expect(ep.payload).toEqual({ extra: "data" });
  });
});

describe("recordJudgmentSource — validation rejections", () => {
  function assertRejectedBeforeSourceInsert(input: SourceInput) {
    const before = countSources();
    expect(() => recordJudgmentSource(db, input)).toThrow(JudgmentValidationError);
    expect(countSources()).toBe(before);
  }

  test("invalid kind (empty) is rejected before DB insert", () => {
    assertRejectedBeforeSourceInsert({ ...validSourceInput, kind: "   " });
  });

  test("invalid locator (empty) is rejected before DB insert", () => {
    assertRejectedBeforeSourceInsert({ ...validSourceInput, locator: "" });
  });

  test("invalid trust_level is rejected before DB insert", () => {
    assertRejectedBeforeSourceInsert({
      ...validSourceInput,
      trust_level: "excellent",
    } as SourceInput);
  });

  test("non-boolean redacted is rejected before DB insert", () => {
    assertRejectedBeforeSourceInsert({
      ...validSourceInput,
      redacted: "yes" as unknown as boolean,
    });
  });

  test("null payload is rejected before DB insert", () => {
    assertRejectedBeforeSourceInsert({
      ...validSourceInput,
      payload: null as unknown as Record<string, unknown>,
    });
  });

  test("array payload is rejected before DB insert", () => {
    assertRejectedBeforeSourceInsert({
      ...validSourceInput,
      payload: [] as unknown as Record<string, unknown>,
    });
  });

  test("primitive payload is rejected before DB insert", () => {
    assertRejectedBeforeSourceInsert({
      ...validSourceInput,
      payload: 42 as unknown as Record<string, unknown>,
    });
  });

  test("class instance payload is rejected before DB insert", () => {
    assertRejectedBeforeSourceInsert({
      ...validSourceInput,
      payload: new Date() as unknown as Record<string, unknown>,
    });
  });

  test("unserializable payload is rejected before DB insert", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    assertRejectedBeforeSourceInsert({ ...validSourceInput, payload: circular });
  });

  test("null input is rejected as JudgmentValidationError", () => {
    expect(() => recordJudgmentSource(db, null as never)).toThrow(JudgmentValidationError);
  });
});

describe("recordJudgmentSource — event", () => {
  test("appends one judgment.source.recorded event", () => {
    const before = countEvents();
    const s = recordJudgmentSource(db, validSourceInput);
    expect(countEvents()).toBe(before + 1);
    const eventRow = db
      .prepare<{ event_type: string; judgment_id: string | null; payload_json: string }, [string]>(
        `SELECT event_type, judgment_id, payload_json FROM judgment_events WHERE id = ?`,
      )
      .get(s.event_id)!;
    expect(eventRow.event_type).toBe("judgment.source.recorded");
    expect(eventRow.judgment_id).toBeNull();
  });

  test("source event payload_json is valid JSON", () => {
    const s = recordJudgmentSource(db, validSourceInput);
    const eventRow = db
      .prepare<{ payload_json: string }, [string]>(
        `SELECT payload_json FROM judgment_events WHERE id = ?`,
      )
      .get(s.event_id)!;
    expect(() => JSON.parse(eventRow.payload_json)).not.toThrow();
  });

  test("source event payload contains source_id, kind, locator, trust_level, redacted", () => {
    const s = recordJudgmentSource(db, validSourceInput);
    const eventRow = db
      .prepare<{ payload_json: string }, [string]>(
        `SELECT payload_json FROM judgment_events WHERE id = ?`,
      )
      .get(s.event_id)!;
    const ep = JSON.parse(eventRow.payload_json) as Record<string, unknown>;
    expect(ep.source_id).toBe(s.id);
    expect(ep.kind).toBe(s.kind);
    expect(ep.locator).toBe(s.locator);
    expect(ep.trust_level).toBe(s.trust_level);
    expect(ep.redacted).toBe(s.redacted);
  });
});

describe("recordJudgmentSource — rollback", () => {
  test("if event insert fails, no source row remains", () => {
    const before = countSources();
    const beforeEvents = countEvents();
    expect(() =>
      recordJudgmentSource(db, validSourceInput, {
        _injectEventInsertError: new Error("forced event failure"),
      }),
    ).toThrow("forced event failure");
    expect(countSources()).toBe(before);
    expect(countEvents()).toBe(beforeEvents);
  });
});

// ---------------------------------------------------------------
// Phase 1A.4 — linkJudgmentEvidence
// ---------------------------------------------------------------

interface LinkRow {
  id: string;
  judgment_id: string;
  source_id: string;
  relation: string;
  span_locator: string | null;
  quote_excerpt: string | null;
  rationale: string | null;
  created_at: string;
}

function getLink(id: string): LinkRow | null {
  return db
    .prepare<LinkRow, [string]>(
      `SELECT id, judgment_id, source_id, relation, span_locator, quote_excerpt, rationale, created_at
       FROM judgment_evidence_links WHERE id = ?`,
    )
    .get(id);
}

function countLinks(): number {
  return db
    .prepare<{ n: number }, never[]>("SELECT COUNT(*) as n FROM judgment_evidence_links")
    .get()!.n;
}

function makeProposedJudgment() {
  return proposeJudgment(db, validInput);
}

function makeSource() {
  return recordJudgmentSource(db, validSourceInput);
}

const validLinkInput: EvidenceLinkInput = {
  judgment_id: "placeholder",
  source_id: "placeholder",
  relation: "supports",
};

describe("linkJudgmentEvidence — basic insert", () => {
  test("inserts one row into judgment_evidence_links", () => {
    const j = makeProposedJudgment();
    const s = makeSource();
    linkJudgmentEvidence(db, { ...validLinkInput, judgment_id: j.id, source_id: s.id });
    expect(countLinks()).toBe(1);
  });

  test("result id is non-empty string", () => {
    const j = makeProposedJudgment();
    const s = makeSource();
    const lnk = linkJudgmentEvidence(db, {
      ...validLinkInput,
      judgment_id: j.id,
      source_id: s.id,
    });
    expect(typeof lnk.id).toBe("string");
    expect(lnk.id.length).toBeGreaterThan(0);
  });

  test("result event_type is judgment.evidence.linked", () => {
    const j = makeProposedJudgment();
    const s = makeSource();
    const lnk = linkJudgmentEvidence(db, {
      ...validLinkInput,
      judgment_id: j.id,
      source_id: s.id,
    });
    expect(lnk.event_type).toBe("judgment.evidence.linked");
  });

  test("link row has correct judgment_id, source_id, relation", () => {
    const j = makeProposedJudgment();
    const s = makeSource();
    const lnk = linkJudgmentEvidence(db, {
      ...validLinkInput,
      judgment_id: j.id,
      source_id: s.id,
    });
    const row = getLink(lnk.id)!;
    expect(row.judgment_id).toBe(j.id);
    expect(row.source_id).toBe(s.id);
    expect(row.relation).toBe("supports");
  });
});

describe("linkJudgmentEvidence — target existence checks", () => {
  test("missing judgment returns JudgmentNotFoundError", () => {
    const s = makeSource();
    expect(() =>
      linkJudgmentEvidence(db, {
        ...validLinkInput,
        judgment_id: "nonexistent-j",
        source_id: s.id,
      }),
    ).toThrow(JudgmentNotFoundError);
  });

  test("missing source returns JudgmentNotFoundError", () => {
    const j = makeProposedJudgment();
    expect(() =>
      linkJudgmentEvidence(db, {
        ...validLinkInput,
        judgment_id: j.id,
        source_id: "nonexistent-s",
      }),
    ).toThrow(JudgmentNotFoundError);
  });
});

describe("linkJudgmentEvidence — state guards", () => {
  test("proposed/pending/history_only judgment succeeds", () => {
    const j = proposeJudgment(db, validInput);
    const s = makeSource();
    expect(() =>
      linkJudgmentEvidence(db, { ...validLinkInput, judgment_id: j.id, source_id: s.id }),
    ).not.toThrow();
  });

  test("proposed/approved/history_only judgment succeeds", () => {
    const j = proposeJudgment(db, validInput);
    approveProposedJudgment(db, { judgment_id: j.id, reviewer: "tester" });
    const s = makeSource();
    expect(() =>
      linkJudgmentEvidence(db, { ...validLinkInput, judgment_id: j.id, source_id: s.id }),
    ).not.toThrow();
  });

  test("rejected/excluded judgment fails with JudgmentStateError", () => {
    const j = proposeJudgment(db, validInput);
    rejectProposedJudgment(db, {
      judgment_id: j.id,
      reviewer: "tester",
      reason: "not accurate",
    });
    const s = makeSource();
    expect(() =>
      linkJudgmentEvidence(db, { ...validLinkInput, judgment_id: j.id, source_id: s.id }),
    ).toThrow(JudgmentStateError);
  });

  test("revoked judgment fails with JudgmentStateError", () => {
    const j = proposeJudgment(db, validInput);
    forceState(j.id, { lifecycle_status: "revoked", approval_state: "not_required" });
    const s = makeSource();
    expect(() =>
      linkJudgmentEvidence(db, { ...validLinkInput, judgment_id: j.id, source_id: s.id }),
    ).toThrow(JudgmentStateError);
  });

  test("superseded judgment fails with JudgmentStateError", () => {
    const j = proposeJudgment(db, validInput);
    forceState(j.id, { lifecycle_status: "superseded", approval_state: "not_required" });
    const s = makeSource();
    expect(() =>
      linkJudgmentEvidence(db, { ...validLinkInput, judgment_id: j.id, source_id: s.id }),
    ).toThrow(JudgmentStateError);
  });

  test("expired judgment fails with JudgmentStateError", () => {
    const j = proposeJudgment(db, validInput);
    forceState(j.id, { lifecycle_status: "expired", approval_state: "not_required" });
    const s = makeSource();
    expect(() =>
      linkJudgmentEvidence(db, { ...validLinkInput, judgment_id: j.id, source_id: s.id }),
    ).toThrow(JudgmentStateError);
  });

  test("archived proposed/history_only judgment fails with JudgmentStateError", () => {
    const j = proposeJudgment(db, validInput);
    forceState(j.id, { retention_state: "archived" });
    const s = makeSource();
    expect(() =>
      linkJudgmentEvidence(db, { ...validLinkInput, judgment_id: j.id, source_id: s.id }),
    ).toThrow(JudgmentStateError);
  });

  test("deleted proposed/history_only judgment fails with JudgmentStateError", () => {
    const j = proposeJudgment(db, validInput);
    forceState(j.id, { retention_state: "deleted" });
    const s = makeSource();
    expect(() =>
      linkJudgmentEvidence(db, { ...validLinkInput, judgment_id: j.id, source_id: s.id }),
    ).toThrow(JudgmentStateError);
  });
});

describe("linkJudgmentEvidence — non-normal retention isolation", () => {
  test("archived failure does not insert a judgment_evidence_links row", () => {
    const j = proposeJudgment(db, validInput);
    forceState(j.id, { retention_state: "archived" });
    const s = makeSource();
    const before = countLinks();
    try { linkJudgmentEvidence(db, { ...validLinkInput, judgment_id: j.id, source_id: s.id }); } catch {}
    expect(countLinks()).toBe(before);
  });

  test("archived failure does not append judgment.evidence.linked event", () => {
    const j = proposeJudgment(db, validInput);
    forceState(j.id, { retention_state: "archived" });
    const s = makeSource();
    const before = countEvents(j.id);
    try { linkJudgmentEvidence(db, { ...validLinkInput, judgment_id: j.id, source_id: s.id }); } catch {}
    expect(countEvents(j.id)).toBe(before);
  });

  test("archived failure does not mutate source_ids_json", () => {
    const j = proposeJudgment(db, validInput);
    forceState(j.id, { retention_state: "archived" });
    const s = makeSource();
    const before = db
      .prepare<{ source_ids_json: string | null }, [string]>(
        `SELECT source_ids_json FROM judgment_items WHERE id = ?`,
      )
      .get(j.id)!.source_ids_json;
    try { linkJudgmentEvidence(db, { ...validLinkInput, judgment_id: j.id, source_id: s.id }); } catch {}
    const after = db
      .prepare<{ source_ids_json: string | null }, [string]>(
        `SELECT source_ids_json FROM judgment_items WHERE id = ?`,
      )
      .get(j.id)!.source_ids_json;
    expect(after).toEqual(before);
  });

  test("archived failure does not mutate evidence_ids_json", () => {
    const j = proposeJudgment(db, validInput);
    forceState(j.id, { retention_state: "archived" });
    const s = makeSource();
    const before = db
      .prepare<{ evidence_ids_json: string | null }, [string]>(
        `SELECT evidence_ids_json FROM judgment_items WHERE id = ?`,
      )
      .get(j.id)!.evidence_ids_json;
    try { linkJudgmentEvidence(db, { ...validLinkInput, judgment_id: j.id, source_id: s.id }); } catch {}
    const after = db
      .prepare<{ evidence_ids_json: string | null }, [string]>(
        `SELECT evidence_ids_json FROM judgment_items WHERE id = ?`,
      )
      .get(j.id)!.evidence_ids_json;
    expect(after).toEqual(before);
  });

  test("deleted failure does not insert a judgment_evidence_links row", () => {
    const j = proposeJudgment(db, validInput);
    forceState(j.id, { retention_state: "deleted" });
    const s = makeSource();
    const before = countLinks();
    try { linkJudgmentEvidence(db, { ...validLinkInput, judgment_id: j.id, source_id: s.id }); } catch {}
    expect(countLinks()).toBe(before);
  });

  test("deleted failure does not append judgment.evidence.linked event", () => {
    const j = proposeJudgment(db, validInput);
    forceState(j.id, { retention_state: "deleted" });
    const s = makeSource();
    const before = countEvents(j.id);
    try { linkJudgmentEvidence(db, { ...validLinkInput, judgment_id: j.id, source_id: s.id }); } catch {}
    expect(countEvents(j.id)).toBe(before);
  });

  test("deleted failure does not mutate source_ids_json", () => {
    const j = proposeJudgment(db, validInput);
    forceState(j.id, { retention_state: "deleted" });
    const s = makeSource();
    const before = db
      .prepare<{ source_ids_json: string | null }, [string]>(
        `SELECT source_ids_json FROM judgment_items WHERE id = ?`,
      )
      .get(j.id)!.source_ids_json;
    try { linkJudgmentEvidence(db, { ...validLinkInput, judgment_id: j.id, source_id: s.id }); } catch {}
    const after = db
      .prepare<{ source_ids_json: string | null }, [string]>(
        `SELECT source_ids_json FROM judgment_items WHERE id = ?`,
      )
      .get(j.id)!.source_ids_json;
    expect(after).toEqual(before);
  });

  test("deleted failure does not mutate evidence_ids_json", () => {
    const j = proposeJudgment(db, validInput);
    forceState(j.id, { retention_state: "deleted" });
    const s = makeSource();
    const before = db
      .prepare<{ evidence_ids_json: string | null }, [string]>(
        `SELECT evidence_ids_json FROM judgment_items WHERE id = ?`,
      )
      .get(j.id)!.evidence_ids_json;
    try { linkJudgmentEvidence(db, { ...validLinkInput, judgment_id: j.id, source_id: s.id }); } catch {}
    const after = db
      .prepare<{ evidence_ids_json: string | null }, [string]>(
        `SELECT evidence_ids_json FROM judgment_items WHERE id = ?`,
      )
      .get(j.id)!.evidence_ids_json;
    expect(after).toEqual(before);
  });
});

describe("linkJudgmentEvidence — trimming", () => {
  test("relation is trimmed", () => {
    const j = makeProposedJudgment();
    const s = makeSource();
    const lnk = linkJudgmentEvidence(db, {
      ...validLinkInput,
      judgment_id: j.id,
      source_id: s.id,
      relation: "  supports  ",
    });
    expect(lnk.relation).toBe("supports");
    expect(getLink(lnk.id)!.relation).toBe("supports");
  });

  test("span_locator is trimmed", () => {
    const j = makeProposedJudgment();
    const s = makeSource();
    const lnk = linkJudgmentEvidence(db, {
      ...validLinkInput,
      judgment_id: j.id,
      source_id: s.id,
      span_locator: "  p.5  ",
    });
    expect(lnk.span_locator).toBe("p.5");
  });

  test("quote_excerpt is trimmed", () => {
    const j = makeProposedJudgment();
    const s = makeSource();
    const lnk = linkJudgmentEvidence(db, {
      ...validLinkInput,
      judgment_id: j.id,
      source_id: s.id,
      quote_excerpt: "  some text  ",
    });
    expect(lnk.quote_excerpt).toBe("some text");
  });

  test("rationale is trimmed", () => {
    const j = makeProposedJudgment();
    const s = makeSource();
    const lnk = linkJudgmentEvidence(db, {
      ...validLinkInput,
      judgment_id: j.id,
      source_id: s.id,
      rationale: "  because of x  ",
    });
    expect(lnk.rationale).toBe("because of x");
  });
});

describe("linkJudgmentEvidence — validation rejections", () => {
  function assertRejectedBeforeLinkInsert(input: EvidenceLinkInput) {
    const before = countLinks();
    expect(() => linkJudgmentEvidence(db, input)).toThrow(JudgmentValidationError);
    expect(countLinks()).toBe(before);
  }

  test("invalid judgment_id (empty) is rejected before DB write", () => {
    assertRejectedBeforeLinkInsert({ ...validLinkInput, judgment_id: "  " });
  });

  test("invalid source_id (empty) is rejected before DB write", () => {
    assertRejectedBeforeLinkInsert({ ...validLinkInput, source_id: "" });
  });

  test("invalid relation (empty) is rejected before DB write", () => {
    assertRejectedBeforeLinkInsert({ ...validLinkInput, relation: "" });
  });

  test("invalid span_locator (empty string) is rejected before DB write", () => {
    const j = makeProposedJudgment();
    const s = makeSource();
    assertRejectedBeforeLinkInsert({
      ...validLinkInput,
      judgment_id: j.id,
      source_id: s.id,
      span_locator: "",
    });
  });

  test("invalid quote_excerpt (empty string) is rejected before DB write", () => {
    const j = makeProposedJudgment();
    const s = makeSource();
    assertRejectedBeforeLinkInsert({
      ...validLinkInput,
      judgment_id: j.id,
      source_id: s.id,
      quote_excerpt: "  ",
    });
  });

  test("invalid rationale (empty string) is rejected before DB write", () => {
    const j = makeProposedJudgment();
    const s = makeSource();
    assertRejectedBeforeLinkInsert({
      ...validLinkInput,
      judgment_id: j.id,
      source_id: s.id,
      rationale: "",
    });
  });

  test("null payload is rejected before DB write", () => {
    const j = makeProposedJudgment();
    const s = makeSource();
    assertRejectedBeforeLinkInsert({
      ...validLinkInput,
      judgment_id: j.id,
      source_id: s.id,
      payload: null as unknown as Record<string, unknown>,
    });
  });

  test("array payload is rejected before DB write", () => {
    const j = makeProposedJudgment();
    const s = makeSource();
    assertRejectedBeforeLinkInsert({
      ...validLinkInput,
      judgment_id: j.id,
      source_id: s.id,
      payload: [] as unknown as Record<string, unknown>,
    });
  });

  test("primitive payload is rejected before DB write", () => {
    const j = makeProposedJudgment();
    const s = makeSource();
    assertRejectedBeforeLinkInsert({
      ...validLinkInput,
      judgment_id: j.id,
      source_id: s.id,
      payload: "string" as unknown as Record<string, unknown>,
    });
  });

  test("class instance payload is rejected before DB write", () => {
    const j = makeProposedJudgment();
    const s = makeSource();
    assertRejectedBeforeLinkInsert({
      ...validLinkInput,
      judgment_id: j.id,
      source_id: s.id,
      payload: new Date() as unknown as Record<string, unknown>,
    });
  });

  test("unserializable payload is rejected before DB write", () => {
    const j = makeProposedJudgment();
    const s = makeSource();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    assertRejectedBeforeLinkInsert({
      ...validLinkInput,
      judgment_id: j.id,
      source_id: s.id,
      payload: circular,
    });
  });
});

describe("linkJudgmentEvidence — event", () => {
  test("appends one judgment.evidence.linked event", () => {
    const j = makeProposedJudgment();
    const s = makeSource();
    const before = countEvents(j.id);
    const lnk = linkJudgmentEvidence(db, {
      ...validLinkInput,
      judgment_id: j.id,
      source_id: s.id,
    });
    expect(countEvents(j.id)).toBe(before + 1);
    const eventRow = db
      .prepare<{ event_type: string; judgment_id: string | null }, [string]>(
        `SELECT event_type, judgment_id FROM judgment_events WHERE id = ?`,
      )
      .get(lnk.event_id)!;
    expect(eventRow.event_type).toBe("judgment.evidence.linked");
    expect(eventRow.judgment_id).toBe(j.id);
  });

  test("event payload_json is valid JSON", () => {
    const j = makeProposedJudgment();
    const s = makeSource();
    const lnk = linkJudgmentEvidence(db, {
      ...validLinkInput,
      judgment_id: j.id,
      source_id: s.id,
    });
    const eventRow = db
      .prepare<{ payload_json: string }, [string]>(
        `SELECT payload_json FROM judgment_events WHERE id = ?`,
      )
      .get(lnk.event_id)!;
    expect(() => JSON.parse(eventRow.payload_json)).not.toThrow();
  });

  test("event payload contains evidence_link_id, judgment_id, source_id, relation", () => {
    const j = makeProposedJudgment();
    const s = makeSource();
    const lnk = linkJudgmentEvidence(db, {
      ...validLinkInput,
      judgment_id: j.id,
      source_id: s.id,
    });
    const eventRow = db
      .prepare<{ payload_json: string }, [string]>(
        `SELECT payload_json FROM judgment_events WHERE id = ?`,
      )
      .get(lnk.event_id)!;
    const ep = JSON.parse(eventRow.payload_json) as Record<string, unknown>;
    expect(ep.evidence_link_id).toBe(lnk.id);
    expect(ep.judgment_id).toBe(j.id);
    expect(ep.source_id).toBe(s.id);
    expect(ep.relation).toBe("supports");
  });
});

describe("linkJudgmentEvidence — denormalized JSON arrays", () => {
  test("source_ids_json is updated to include source_id exactly once", () => {
    const j = makeProposedJudgment();
    const s = makeSource();
    linkJudgmentEvidence(db, { ...validLinkInput, judgment_id: j.id, source_id: s.id });
    const row = db
      .prepare<{ source_ids_json: string }, [string]>(
        `SELECT source_ids_json FROM judgment_items WHERE id = ?`,
      )
      .get(j.id)!;
    const arr = JSON.parse(row.source_ids_json) as string[];
    expect(arr).toContain(s.id);
    expect(arr.filter((x) => x === s.id).length).toBe(1);
  });

  test("evidence_ids_json is updated to include evidence link id exactly once", () => {
    const j = makeProposedJudgment();
    const s = makeSource();
    const lnk = linkJudgmentEvidence(db, {
      ...validLinkInput,
      judgment_id: j.id,
      source_id: s.id,
    });
    const row = db
      .prepare<{ evidence_ids_json: string }, [string]>(
        `SELECT evidence_ids_json FROM judgment_items WHERE id = ?`,
      )
      .get(j.id)!;
    const arr = JSON.parse(row.evidence_ids_json) as string[];
    expect(arr).toContain(lnk.id);
    expect(arr.filter((x) => x === lnk.id).length).toBe(1);
  });

  test("second link from different source does not duplicate first source_id in source_ids_json", () => {
    const j = makeProposedJudgment();
    const s1 = makeSource();
    const s2 = recordJudgmentSource(db, { kind: "external_url", locator: "https://example.com" });
    linkJudgmentEvidence(db, { ...validLinkInput, judgment_id: j.id, source_id: s1.id });
    linkJudgmentEvidence(db, { ...validLinkInput, judgment_id: j.id, source_id: s2.id });
    const row = db
      .prepare<{ source_ids_json: string }, [string]>(
        `SELECT source_ids_json FROM judgment_items WHERE id = ?`,
      )
      .get(j.id)!;
    const arr = JSON.parse(row.source_ids_json) as string[];
    expect(arr.filter((x) => x === s1.id).length).toBe(1);
    expect(arr.filter((x) => x === s2.id).length).toBe(1);
  });

  test("linking same source twice does not duplicate source in source_ids_json", () => {
    const j = makeProposedJudgment();
    const s = makeSource();
    linkJudgmentEvidence(db, { ...validLinkInput, judgment_id: j.id, source_id: s.id });
    linkJudgmentEvidence(db, {
      ...validLinkInput,
      judgment_id: j.id,
      source_id: s.id,
      relation: "contextualizes",
    });
    const row = db
      .prepare<{ source_ids_json: string }, [string]>(
        `SELECT source_ids_json FROM judgment_items WHERE id = ?`,
      )
      .get(j.id)!;
    const arr = JSON.parse(row.source_ids_json) as string[];
    expect(arr.filter((x) => x === s.id).length).toBe(1);
  });
});

describe("linkJudgmentEvidence — judgment state invariants", () => {
  test("evidence linking does not activate the judgment", () => {
    const j = makeProposedJudgment();
    const s = makeSource();
    linkJudgmentEvidence(db, { ...validLinkInput, judgment_id: j.id, source_id: s.id });
    const row = getFullItem(j.id)!;
    expect(row.lifecycle_status).toBe("proposed");
    expect(row.activation_state).toBe("history_only");
    expect(row.authority_source).toBe("none");
  });

  test("evidence linking does not approve or reject the judgment", () => {
    const j = makeProposedJudgment();
    const s = makeSource();
    linkJudgmentEvidence(db, { ...validLinkInput, judgment_id: j.id, source_id: s.id });
    const row = getFullItem(j.id)!;
    expect(row.approval_state).toBe("pending");
  });

  test("evidence linking bumps updated_at on judgment_items", () => {
    const j = makeProposedJudgment();
    const before = getFullItem(j.id)!.updated_at;
    const s = makeSource();
    linkJudgmentEvidence(db, { ...validLinkInput, judgment_id: j.id, source_id: s.id });
    const after = getFullItem(j.id)!.updated_at;
    expect(after >= before).toBe(true);
  });
});

describe("linkJudgmentEvidence — rollback", () => {
  test("if event insert fails, no link row remains", () => {
    const j = makeProposedJudgment();
    const s = makeSource();
    const before = countLinks();
    const beforeEvents = countEvents(j.id);
    expect(() =>
      linkJudgmentEvidence(
        db,
        { ...validLinkInput, judgment_id: j.id, source_id: s.id },
        { _injectEventInsertError: new Error("forced event failure") },
      ),
    ).toThrow("forced event failure");
    expect(countLinks()).toBe(before);
    expect(countEvents(j.id)).toBe(beforeEvents);
  });

  test("rollback also reverts source_ids_json and evidence_ids_json updates", () => {
    const j = makeProposedJudgment();
    const s = makeSource();
    const beforeRow = db
      .prepare<{ source_ids_json: string | null; evidence_ids_json: string | null }, [string]>(
        `SELECT source_ids_json, evidence_ids_json FROM judgment_items WHERE id = ?`,
      )
      .get(j.id)!;

    expect(() =>
      linkJudgmentEvidence(
        db,
        { ...validLinkInput, judgment_id: j.id, source_id: s.id },
        { _injectEventInsertError: new Error("forced") },
      ),
    ).toThrow("forced");

    const afterRow = db
      .prepare<{ source_ids_json: string | null; evidence_ids_json: string | null }, [string]>(
        `SELECT source_ids_json, evidence_ids_json FROM judgment_items WHERE id = ?`,
      )
      .get(j.id)!;
    expect(afterRow.source_ids_json).toEqual(beforeRow.source_ids_json);
    expect(afterRow.evidence_ids_json).toEqual(beforeRow.evidence_ids_json);
  });
});

// ---------------------------------------------------------------
// Phase 1A.5 — commitApprovedJudgment
// ---------------------------------------------------------------

function makeApprovedJudgmentWithEvidence() {
  const j = proposeJudgment(db, validInput);
  approveProposedJudgment(db, { judgment_id: j.id, reviewer: "approver" });
  const s = makeSource();
  const lnk = linkJudgmentEvidence(db, { ...validLinkInput, judgment_id: j.id, source_id: s.id });
  return { j, s, lnk };
}

const validCommitInput: CommitInput = {
  judgment_id: "placeholder",
  committer: "committer",
  reason: "ready for runtime",
};

describe("commitApprovedJudgment — success", () => {
  test("commits an approved proposed/history_only/normal judgment with evidence link", () => {
    const { j } = makeApprovedJudgmentWithEvidence();
    const r = commitApprovedJudgment(db, { ...validCommitInput, judgment_id: j.id });
    expect(r.id).toBe(j.id);
  });

  test("commit sets lifecycle_status = active", () => {
    const { j } = makeApprovedJudgmentWithEvidence();
    commitApprovedJudgment(db, { ...validCommitInput, judgment_id: j.id });
    expect(getFullItem(j.id)!.lifecycle_status).toBe("active");
  });

  test("commit sets activation_state = eligible", () => {
    const { j } = makeApprovedJudgmentWithEvidence();
    commitApprovedJudgment(db, { ...validCommitInput, judgment_id: j.id });
    expect(getFullItem(j.id)!.activation_state).toBe("eligible");
  });

  test("commit keeps approval_state = approved", () => {
    const { j } = makeApprovedJudgmentWithEvidence();
    commitApprovedJudgment(db, { ...validCommitInput, judgment_id: j.id });
    expect(getFullItem(j.id)!.approval_state).toBe("approved");
  });

  test("commit keeps retention_state = normal", () => {
    const { j } = makeApprovedJudgmentWithEvidence();
    commitApprovedJudgment(db, { ...validCommitInput, judgment_id: j.id });
    expect(getFullItem(j.id)!.retention_state).toBe("normal");
  });

  test("commit sets authority_source = user_confirmed", () => {
    const { j } = makeApprovedJudgmentWithEvidence();
    commitApprovedJudgment(db, { ...validCommitInput, judgment_id: j.id });
    expect(getFullItem(j.id)!.authority_source).toBe("user_confirmed");
  });

  test("commit updates updated_at", () => {
    const { j } = makeApprovedJudgmentWithEvidence();
    const before = getFullItem(j.id)!.updated_at;
    const fixedNow = "2026-04-27T20:00:00.000Z";
    commitApprovedJudgment(db, { ...validCommitInput, judgment_id: j.id }, { nowIso: () => fixedNow });
    expect(getFullItem(j.id)!.updated_at).toBe(fixedNow);
    expect(getFullItem(j.id)!.updated_at).not.toBe(before);
  });

  test("commit appends exactly one judgment.committed event", () => {
    const { j } = makeApprovedJudgmentWithEvidence();
    const beforeCount = countEvents(j.id);
    commitApprovedJudgment(db, { ...validCommitInput, judgment_id: j.id });
    const events = getEvents(j.id);
    const committedEvents = events.filter((e) => e.event_type === "judgment.committed");
    expect(committedEvents.length).toBe(1);
    expect(countEvents(j.id)).toBe(beforeCount + 1);
  });

  test("commit event payload_json is valid JSON", () => {
    const { j } = makeApprovedJudgmentWithEvidence();
    const r = commitApprovedJudgment(db, { ...validCommitInput, judgment_id: j.id });
    const eventRow = db
      .prepare<{ payload_json: string }, [string]>(
        `SELECT payload_json FROM judgment_events WHERE id = ?`,
      )
      .get(r.event_id)!;
    expect(() => JSON.parse(eventRow.payload_json)).not.toThrow();
  });

  test("commit event payload includes required fields", () => {
    const { j, lnk, s } = makeApprovedJudgmentWithEvidence();
    const r = commitApprovedJudgment(db, {
      ...validCommitInput,
      judgment_id: j.id,
      committer: "alice",
      reason: "ready",
    });
    const eventRow = db
      .prepare<{ payload_json: string }, [string]>(
        `SELECT payload_json FROM judgment_events WHERE id = ?`,
      )
      .get(r.event_id)!;
    const ep = JSON.parse(eventRow.payload_json) as Record<string, unknown>;
    expect(ep.judgment_id).toBe(j.id);
    expect(ep.committer).toBe("alice");
    expect(ep.reason).toBe("ready");
    expect(ep.previous_lifecycle_status).toBe("proposed");
    expect(ep.new_lifecycle_status).toBe("active");
    expect(ep.previous_activation_state).toBe("history_only");
    expect(ep.new_activation_state).toBe("eligible");
    expect(ep.previous_authority_source).toBe("none");
    expect(ep.new_authority_source).toBe("user_confirmed");
    expect(ep.approval_state).toBe("approved");
    expect(Array.isArray(ep.evidence_link_ids)).toBe(true);
    expect((ep.evidence_link_ids as string[]).includes(lnk.id)).toBe(true);
    expect(Array.isArray(ep.source_ids)).toBe(true);
    expect((ep.source_ids as string[]).includes(s.id)).toBe(true);
  });

  test("commit trims committer", () => {
    const { j } = makeApprovedJudgmentWithEvidence();
    const r = commitApprovedJudgment(db, {
      ...validCommitInput,
      judgment_id: j.id,
      committer: "  alice  ",
    });
    expect(r.event_id).toBeTruthy();
    const eventRow = db
      .prepare<{ actor: string }, [string]>(
        `SELECT actor FROM judgment_events WHERE id = ?`,
      )
      .get(r.event_id)!;
    expect(eventRow.actor).toBe("alice");
  });

  test("commit trims reason", () => {
    const { j } = makeApprovedJudgmentWithEvidence();
    const r = commitApprovedJudgment(db, {
      ...validCommitInput,
      judgment_id: j.id,
      reason: "  my reason  ",
    });
    const eventRow = db
      .prepare<{ payload_json: string }, [string]>(
        `SELECT payload_json FROM judgment_events WHERE id = ?`,
      )
      .get(r.event_id)!;
    const ep = JSON.parse(eventRow.payload_json) as Record<string, unknown>;
    expect(ep.reason).toBe("my reason");
  });

  test("commit with optional payload stores it in event payload", () => {
    const { j } = makeApprovedJudgmentWithEvidence();
    const r = commitApprovedJudgment(db, {
      ...validCommitInput,
      judgment_id: j.id,
      payload: { context: "manual review" },
    });
    const eventRow = db
      .prepare<{ payload_json: string }, [string]>(
        `SELECT payload_json FROM judgment_events WHERE id = ?`,
      )
      .get(r.event_id)!;
    const ep = JSON.parse(eventRow.payload_json) as Record<string, unknown>;
    expect(ep.payload).toEqual({ context: "manual review" });
  });

  test("commit returns canonical evidence_link_ids and source_ids", () => {
    const { j, lnk, s } = makeApprovedJudgmentWithEvidence();
    const r = commitApprovedJudgment(db, { ...validCommitInput, judgment_id: j.id });
    expect(r.evidence_link_ids).toContain(lnk.id);
    expect(r.source_ids).toContain(s.id);
  });

  test("commit syncs source_ids_json and evidence_ids_json to canonical arrays", () => {
    const { j, lnk, s } = makeApprovedJudgmentWithEvidence();
    commitApprovedJudgment(db, { ...validCommitInput, judgment_id: j.id });
    const row = db
      .prepare<{ source_ids_json: string; evidence_ids_json: string }, [string]>(
        `SELECT source_ids_json, evidence_ids_json FROM judgment_items WHERE id = ?`,
      )
      .get(j.id)!;
    expect(JSON.parse(row.source_ids_json)).toContain(s.id);
    expect(JSON.parse(row.evidence_ids_json)).toContain(lnk.id);
  });

  test("commit result event_type is judgment.committed", () => {
    const { j } = makeApprovedJudgmentWithEvidence();
    const r = commitApprovedJudgment(db, { ...validCommitInput, judgment_id: j.id });
    expect(r.event_type).toBe("judgment.committed");
  });

  test("commit result includes lifecycle_status active, activation_state eligible, authority_source user_confirmed", () => {
    const { j } = makeApprovedJudgmentWithEvidence();
    const r = commitApprovedJudgment(db, { ...validCommitInput, judgment_id: j.id });
    expect(r.lifecycle_status).toBe("active");
    expect(r.activation_state).toBe("eligible");
    expect(r.authority_source).toBe("user_confirmed");
  });

  test("commit with multiple evidence links returns all link ids", () => {
    const j = proposeJudgment(db, validInput);
    approveProposedJudgment(db, { judgment_id: j.id, reviewer: "approver" });
    const s1 = makeSource();
    const s2 = recordJudgmentSource(db, { kind: "external_url", locator: "https://b.example.com" });
    const lnk1 = linkJudgmentEvidence(db, { ...validLinkInput, judgment_id: j.id, source_id: s1.id });
    const lnk2 = linkJudgmentEvidence(db, { ...validLinkInput, judgment_id: j.id, source_id: s2.id });
    const r = commitApprovedJudgment(db, { ...validCommitInput, judgment_id: j.id });
    expect(r.evidence_link_ids).toContain(lnk1.id);
    expect(r.evidence_link_ids).toContain(lnk2.id);
    expect(r.source_ids).toContain(s1.id);
    expect(r.source_ids).toContain(s2.id);
  });
});

describe("commitApprovedJudgment — invalid state", () => {
  test("missing judgment returns JudgmentNotFoundError", () => {
    expect(() =>
      commitApprovedJudgment(db, { ...validCommitInput, judgment_id: "nonexistent-j" }),
    ).toThrow(JudgmentNotFoundError);
  });

  test("pending judgment fails with JudgmentStateError", () => {
    const j = makeProposedJudgment();
    const s = makeSource();
    linkJudgmentEvidence(db, { ...validLinkInput, judgment_id: j.id, source_id: s.id });
    expect(() =>
      commitApprovedJudgment(db, { ...validCommitInput, judgment_id: j.id }),
    ).toThrow(JudgmentStateError);
  });

  test("rejected judgment fails with JudgmentStateError", () => {
    const j = proposeJudgment(db, validInput);
    rejectProposedJudgment(db, { judgment_id: j.id, reviewer: "reviewer", reason: "bad" });
    expect(() =>
      commitApprovedJudgment(db, { ...validCommitInput, judgment_id: j.id }),
    ).toThrow(JudgmentStateError);
  });

  test("already active judgment fails with JudgmentStateError and appends no second event", () => {
    const { j } = makeApprovedJudgmentWithEvidence();
    commitApprovedJudgment(db, { ...validCommitInput, judgment_id: j.id });
    const eventsBefore = countEvents(j.id);
    expect(() =>
      commitApprovedJudgment(db, { ...validCommitInput, judgment_id: j.id }),
    ).toThrow(JudgmentStateError);
    expect(countEvents(j.id)).toBe(eventsBefore);
  });

  test("revoked (excluded activation) judgment fails with JudgmentStateError", () => {
    const { j } = makeApprovedJudgmentWithEvidence();
    forceState(j.id, { lifecycle_status: "revoked", activation_state: "excluded" });
    expect(() =>
      commitApprovedJudgment(db, { ...validCommitInput, judgment_id: j.id }),
    ).toThrow(JudgmentStateError);
  });

  test("superseded judgment fails with JudgmentStateError", () => {
    const { j } = makeApprovedJudgmentWithEvidence();
    forceState(j.id, { lifecycle_status: "superseded", activation_state: "excluded" });
    expect(() =>
      commitApprovedJudgment(db, { ...validCommitInput, judgment_id: j.id }),
    ).toThrow(JudgmentStateError);
  });

  test("expired judgment fails with JudgmentStateError", () => {
    const { j } = makeApprovedJudgmentWithEvidence();
    forceState(j.id, { lifecycle_status: "expired", activation_state: "excluded" });
    expect(() =>
      commitApprovedJudgment(db, { ...validCommitInput, judgment_id: j.id }),
    ).toThrow(JudgmentStateError);
  });

  test("archived judgment fails with JudgmentStateError", () => {
    const { j } = makeApprovedJudgmentWithEvidence();
    db.prepare(`UPDATE judgment_items SET retention_state = 'archived' WHERE id = ?`).run(j.id);
    expect(() =>
      commitApprovedJudgment(db, { ...validCommitInput, judgment_id: j.id }),
    ).toThrow(JudgmentStateError);
  });

  test("deleted judgment fails with JudgmentStateError", () => {
    const { j } = makeApprovedJudgmentWithEvidence();
    db.prepare(`UPDATE judgment_items SET retention_state = 'deleted' WHERE id = ?`).run(j.id);
    expect(() =>
      commitApprovedJudgment(db, { ...validCommitInput, judgment_id: j.id }),
    ).toThrow(JudgmentStateError);
  });

  test("approved proposed/history_only/normal judgment with no evidence link fails with JudgmentStateError", () => {
    const j = proposeJudgment(db, validInput);
    approveProposedJudgment(db, { judgment_id: j.id, reviewer: "approver" });
    expect(() =>
      commitApprovedJudgment(db, { ...validCommitInput, judgment_id: j.id }),
    ).toThrow(JudgmentStateError);
  });

  test("failed commit does not change lifecycle_status", () => {
    const j = makeProposedJudgment();
    try {
      commitApprovedJudgment(db, { ...validCommitInput, judgment_id: j.id });
    } catch {
      // expected
    }
    expect(getFullItem(j.id)!.lifecycle_status).toBe("proposed");
  });

  test("failed commit does not change activation_state", () => {
    const j = makeProposedJudgment();
    try {
      commitApprovedJudgment(db, { ...validCommitInput, judgment_id: j.id });
    } catch {
      // expected
    }
    expect(getFullItem(j.id)!.activation_state).toBe("history_only");
  });

  test("failed commit does not change authority_source", () => {
    const j = makeProposedJudgment();
    try {
      commitApprovedJudgment(db, { ...validCommitInput, judgment_id: j.id });
    } catch {
      // expected
    }
    expect(getFullItem(j.id)!.authority_source).toBe("none");
  });

  test("failed commit does not append judgment.committed event", () => {
    const j = makeProposedJudgment();
    const before = countEvents(j.id);
    try {
      commitApprovedJudgment(db, { ...validCommitInput, judgment_id: j.id });
    } catch {
      // expected
    }
    expect(countEvents(j.id)).toBe(before);
  });

  test("approved judgment with non-array source_ids_json fails before update", () => {
    // DB json_valid() passes for any valid JSON; 42 is valid JSON but not an array.
    const { j } = makeApprovedJudgmentWithEvidence();
    db.prepare(`UPDATE judgment_items SET source_ids_json = '42' WHERE id = ?`).run(j.id);
    expect(() =>
      commitApprovedJudgment(db, { ...validCommitInput, judgment_id: j.id }),
    ).toThrow(JudgmentValidationError);
    expect(getFullItem(j.id)!.lifecycle_status).toBe("proposed");
  });

  test("approved judgment with non-array evidence_ids_json fails before update", () => {
    // DB json_valid() passes for any valid JSON; "\"bad\"" is valid JSON but not an array.
    const { j } = makeApprovedJudgmentWithEvidence();
    db.prepare(`UPDATE judgment_items SET evidence_ids_json = '"not-an-array"' WHERE id = ?`).run(j.id);
    expect(() =>
      commitApprovedJudgment(db, { ...validCommitInput, judgment_id: j.id }),
    ).toThrow(JudgmentValidationError);
    expect(getFullItem(j.id)!.lifecycle_status).toBe("proposed");
  });

  test("failed commit does not mutate denormalized arrays when state check fails", () => {
    const j = makeProposedJudgment();
    const beforeRow = db
      .prepare<{ source_ids_json: string | null; evidence_ids_json: string | null }, [string]>(
        `SELECT source_ids_json, evidence_ids_json FROM judgment_items WHERE id = ?`,
      )
      .get(j.id)!;
    try {
      commitApprovedJudgment(db, { ...validCommitInput, judgment_id: j.id });
    } catch {
      // expected
    }
    const afterRow = db
      .prepare<{ source_ids_json: string | null; evidence_ids_json: string | null }, [string]>(
        `SELECT source_ids_json, evidence_ids_json FROM judgment_items WHERE id = ?`,
      )
      .get(j.id)!;
    expect(afterRow.source_ids_json).toEqual(beforeRow.source_ids_json);
    expect(afterRow.evidence_ids_json).toEqual(beforeRow.evidence_ids_json);
  });
});

describe("commitApprovedJudgment — transaction rollback", () => {
  test("if event insert fails, lifecycle_status rolls back", () => {
    const { j } = makeApprovedJudgmentWithEvidence();
    expect(() =>
      commitApprovedJudgment(
        db,
        { ...validCommitInput, judgment_id: j.id },
        { _injectEventInsertError: new Error("forced event failure") },
      ),
    ).toThrow("forced event failure");
    expect(getFullItem(j.id)!.lifecycle_status).toBe("proposed");
  });

  test("if event insert fails, activation_state rolls back", () => {
    const { j } = makeApprovedJudgmentWithEvidence();
    expect(() =>
      commitApprovedJudgment(
        db,
        { ...validCommitInput, judgment_id: j.id },
        { _injectEventInsertError: new Error("forced") },
      ),
    ).toThrow("forced");
    expect(getFullItem(j.id)!.activation_state).toBe("history_only");
  });

  test("if event insert fails, authority_source rolls back", () => {
    const { j } = makeApprovedJudgmentWithEvidence();
    expect(() =>
      commitApprovedJudgment(
        db,
        { ...validCommitInput, judgment_id: j.id },
        { _injectEventInsertError: new Error("forced") },
      ),
    ).toThrow("forced");
    expect(getFullItem(j.id)!.authority_source).toBe("none");
  });

  test("if event insert fails, denormalized arrays roll back", () => {
    const { j } = makeApprovedJudgmentWithEvidence();
    const beforeRow = db
      .prepare<{ source_ids_json: string | null; evidence_ids_json: string | null }, [string]>(
        `SELECT source_ids_json, evidence_ids_json FROM judgment_items WHERE id = ?`,
      )
      .get(j.id)!;
    expect(() =>
      commitApprovedJudgment(
        db,
        { ...validCommitInput, judgment_id: j.id },
        { _injectEventInsertError: new Error("forced") },
      ),
    ).toThrow("forced");
    const afterRow = db
      .prepare<{ source_ids_json: string | null; evidence_ids_json: string | null }, [string]>(
        `SELECT source_ids_json, evidence_ids_json FROM judgment_items WHERE id = ?`,
      )
      .get(j.id)!;
    expect(afterRow.source_ids_json).toEqual(beforeRow.source_ids_json);
    expect(afterRow.evidence_ids_json).toEqual(beforeRow.evidence_ids_json);
  });

  test("if event insert fails, no judgment.committed event is appended", () => {
    const { j } = makeApprovedJudgmentWithEvidence();
    const before = countEvents(j.id);
    expect(() =>
      commitApprovedJudgment(
        db,
        { ...validCommitInput, judgment_id: j.id },
        { _injectEventInsertError: new Error("forced") },
      ),
    ).toThrow("forced");
    expect(countEvents(j.id)).toBe(before);
  });
});

describe("commitApprovedJudgment — validation rejections", () => {
  test("empty judgment_id is rejected", () => {
    expect(() =>
      commitApprovedJudgment(db, { ...validCommitInput, judgment_id: "" }),
    ).toThrow(JudgmentValidationError);
  });

  test("whitespace-only judgment_id is rejected", () => {
    expect(() =>
      commitApprovedJudgment(db, { ...validCommitInput, judgment_id: "   " }),
    ).toThrow(JudgmentValidationError);
  });

  test("empty committer is rejected", () => {
    expect(() =>
      commitApprovedJudgment(db, { ...validCommitInput, committer: "" }),
    ).toThrow(JudgmentValidationError);
  });

  test("whitespace-only committer is rejected", () => {
    expect(() =>
      commitApprovedJudgment(db, { ...validCommitInput, committer: "  " }),
    ).toThrow(JudgmentValidationError);
  });

  test("empty reason is rejected", () => {
    expect(() =>
      commitApprovedJudgment(db, { ...validCommitInput, reason: "" }),
    ).toThrow(JudgmentValidationError);
  });

  test("whitespace-only reason is rejected", () => {
    expect(() =>
      commitApprovedJudgment(db, { ...validCommitInput, reason: "\t\n" }),
    ).toThrow(JudgmentValidationError);
  });

  test("null payload is rejected", () => {
    expect(() =>
      commitApprovedJudgment(db, {
        ...validCommitInput,
        payload: null as unknown as Record<string, unknown>,
      }),
    ).toThrow(JudgmentValidationError);
  });

  test("array payload is rejected", () => {
    expect(() =>
      commitApprovedJudgment(db, {
        ...validCommitInput,
        payload: [] as unknown as Record<string, unknown>,
      }),
    ).toThrow(JudgmentValidationError);
  });

  test("primitive payload is rejected", () => {
    expect(() =>
      commitApprovedJudgment(db, {
        ...validCommitInput,
        payload: "string" as unknown as Record<string, unknown>,
      }),
    ).toThrow(JudgmentValidationError);
  });

  test("class instance payload is rejected", () => {
    expect(() =>
      commitApprovedJudgment(db, {
        ...validCommitInput,
        payload: new Date() as unknown as Record<string, unknown>,
      }),
    ).toThrow(JudgmentValidationError);
  });

  test("null input throws JudgmentValidationError", () => {
    expect(() =>
      commitApprovedJudgment(db, null as unknown as CommitInput),
    ).toThrow(JudgmentValidationError);
  });
});
