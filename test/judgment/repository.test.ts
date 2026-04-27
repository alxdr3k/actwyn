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
  JudgmentValidationError,
  proposeJudgment,
  type ProposalInput,
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
