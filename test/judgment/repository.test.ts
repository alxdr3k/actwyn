// Judgment System Phase 1A.2 — proposal repository integration tests.
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
  proposeJudgment,
  rejectProposedJudgment,
  type ApproveInput,
  type ProposalInput,
  type RejectInput,
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
  }>,
) {
  const sets: string[] = [];
  if (patch.lifecycle_status !== undefined) sets.push(`lifecycle_status = '${patch.lifecycle_status}'`);
  if (patch.approval_state !== undefined) sets.push(`approval_state = '${patch.approval_state}'`);
  if (patch.activation_state !== undefined) sets.push(`activation_state = '${patch.activation_state}'`);
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
