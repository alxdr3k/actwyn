// Judgment System Phase 1A.1 — schema-level CHECK / NOT NULL /
// JSON / FTS5 coverage.
//
// These tests exercise the SQL schema directly via prepared
// statements (no shared helper module — Phase 1A.1 keeps the
// repository / writer surface deliberately empty).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase, type DbHandle } from "../../src/db.ts";
import { migrate } from "../../src/db/migrator.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");

let workdir: string;
let db: DbHandle;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "actwyn-judgment-schema-"));
  db = openDatabase({ path: join(workdir, "test.db"), busyTimeoutMs: 250 });
  migrate(db, MIGRATIONS_DIR);
});

afterEach(() => {
  db.close();
  rmSync(workdir, { recursive: true, force: true });
});

// ---------------------------------------------------------------
// Helpers — no shared module; just local conveniences.
// ---------------------------------------------------------------

interface ItemOverrides {
  id?: string;
  kind?: string;
  scope_json?: string;
  statement?: string | null;
  epistemic_origin?: string;
  authority_source?: string;
  approval_state?: string;
  lifecycle_status?: string;
  activation_state?: string;
  retention_state?: string;
  confidence?: string;
  importance?: number;
  decay_policy?: string;
  procedure_subtype?: string | null;
  ontology_version?: string | null;
  schema_version?: string | null;
  scope_json_override?: string | null;
  would_change_if_json?: string | null;
}

function defaultsFor(o: ItemOverrides): Record<string, unknown> {
  return {
    id: o.id ?? crypto.randomUUID(),
    kind: o.kind ?? "fact",
    scope_json: o.scope_json_override !== undefined
      ? o.scope_json_override
      : (o.scope_json ?? '{"project":"actwyn"}'),
    statement: o.statement === undefined ? "the user prefers dark mode" : o.statement,
    epistemic_origin: o.epistemic_origin ?? "user_stated",
    authority_source: o.authority_source ?? "none",
    approval_state: o.approval_state ?? "pending",
    lifecycle_status: o.lifecycle_status ?? "proposed",
    activation_state: o.activation_state ?? "eligible",
    retention_state: o.retention_state ?? "normal",
    confidence: o.confidence ?? "medium",
    importance: o.importance ?? 3,
    decay_policy: o.decay_policy ?? "supersede_only",
    procedure_subtype: o.procedure_subtype ?? null,
    ontology_version:
      o.ontology_version === undefined ? "judgment-taxonomy-v0.1" : o.ontology_version,
    schema_version: o.schema_version === undefined ? "0.1.0" : o.schema_version,
    would_change_if_json:
      o.would_change_if_json === undefined ? null : o.would_change_if_json,
  };
}

const FULL_INSERT_SQL = `
  INSERT INTO judgment_items (
    id, kind, scope_json, statement,
    epistemic_origin, authority_source, approval_state,
    lifecycle_status, activation_state, retention_state,
    confidence, importance, decay_policy, procedure_subtype,
    ontology_version, schema_version,
    would_change_if_json
  ) VALUES (
    $id, $kind, $scope_json, $statement,
    $epistemic_origin, $authority_source, $approval_state,
    $lifecycle_status, $activation_state, $retention_state,
    $confidence, $importance, $decay_policy, $procedure_subtype,
    $ontology_version, $schema_version,
    $would_change_if_json
  )
`;

function insertValidJudgmentItem(
  h: DbHandle,
  overrides: ItemOverrides = {},
): string {
  const row = defaultsFor(overrides);
  h.prepare(FULL_INSERT_SQL).run(row as never);
  return row.id as string;
}

function tryInsert(h: DbHandle, overrides: ItemOverrides): () => void {
  return () => {
    const row = defaultsFor(overrides);
    h.prepare(FULL_INSERT_SQL).run(row as never);
  };
}

// ---------------------------------------------------------------
// CHECK rejection cases
// ---------------------------------------------------------------

describe("judgment_items — CHECK enum rejections", () => {
  test("kind = 'banana' is rejected", () => {
    expect(tryInsert(db, { kind: "banana" })).toThrow();
  });

  test("epistemic_origin = 'rumor' is rejected", () => {
    expect(tryInsert(db, { epistemic_origin: "rumor" })).toThrow();
  });

  test("lifecycle_status = 'frozen' is rejected", () => {
    expect(tryInsert(db, { lifecycle_status: "frozen" })).toThrow();
  });

  test("activation_state = 'dormant' is rejected (P0.5 only eligible/history_only/excluded)", () => {
    expect(tryInsert(db, { activation_state: "dormant" })).toThrow();
  });

  test("retention_state = 'shredded' is rejected", () => {
    expect(tryInsert(db, { retention_state: "shredded" })).toThrow();
  });

  test("authority_source = 'maintainer_approved' is rejected (P0.5 only none/user_confirmed)", () => {
    expect(tryInsert(db, { authority_source: "maintainer_approved" })).toThrow();
  });

  test("decay_policy = 'time_decay' is rejected (P0.5 only none/supersede_only)", () => {
    expect(tryInsert(db, { decay_policy: "time_decay" })).toThrow();
  });

  test("procedure_subtype = 'magic' is rejected (must be one of 5 or NULL)", () => {
    expect(tryInsert(db, { procedure_subtype: "magic" })).toThrow();
  });

  test("confidence = 'definite' is rejected", () => {
    expect(tryInsert(db, { confidence: "definite" })).toThrow();
  });

  test("importance = 7 is rejected (must be 1..5)", () => {
    expect(tryInsert(db, { importance: 7 })).toThrow();
  });

  test("importance = 0 is rejected", () => {
    expect(tryInsert(db, { importance: 0 })).toThrow();
  });

  test("approval_state = 'denied' is rejected", () => {
    expect(tryInsert(db, { approval_state: "denied" })).toThrow();
  });
});

// ---------------------------------------------------------------
// NOT NULL rejection cases
// ---------------------------------------------------------------

describe("judgment_items — NOT NULL rejections", () => {
  test("missing statement is rejected (NULL fails NOT NULL)", () => {
    expect(tryInsert(db, { statement: null })).toThrow();
  });

  test("missing ontology_version is rejected", () => {
    expect(tryInsert(db, { ontology_version: null })).toThrow();
  });

  test("missing schema_version is rejected", () => {
    expect(tryInsert(db, { schema_version: null })).toThrow();
  });
});

// ---------------------------------------------------------------
// CHECK rejection: empty / whitespace-only statement
// ---------------------------------------------------------------

describe("judgment_items — statement length CHECK", () => {
  test("empty statement is rejected", () => {
    expect(tryInsert(db, { statement: "" })).toThrow();
  });

  test("whitespace-only statement is rejected (trim-based CHECK)", () => {
    // Mirrors validateStatement() in src/judgment/validators.ts —
    // both layers must agree on whitespace-only being invalid.
    expect(tryInsert(db, { statement: "   " })).toThrow();
    expect(tryInsert(db, { statement: "\t\n\r " })).toThrow();
  });
});

// ---------------------------------------------------------------
// id NOT NULL — explicit NOT NULL + UNIQUE invariants
// ---------------------------------------------------------------

describe("judgment_items — id NOT NULL invariants", () => {
  // Using a partial-column insert lets us probe the NOT NULL
  // constraint directly. The full insert helper always fills id
  // with crypto.randomUUID(), which would mask the bug.
  function insertWithoutId(): void {
    db.prepare(
      `INSERT INTO judgment_items (
         kind, scope_json, statement, epistemic_origin,
         ontology_version, schema_version
       ) VALUES (
         $kind, $scope_json, $statement, $epistemic_origin,
         $ontology_version, $schema_version
       )`,
    ).run({
      kind: "fact",
      scope_json: '{"project":"actwyn"}',
      statement: "id-omitted statement",
      epistemic_origin: "user_stated",
      ontology_version: "judgment-taxonomy-v0.1",
      schema_version: "0.1.0",
    } as never);
  }

  function insertWithNullId(): void {
    db.prepare(
      `INSERT INTO judgment_items (
         id, kind, scope_json, statement, epistemic_origin,
         ontology_version, schema_version
       ) VALUES (
         NULL, $kind, $scope_json, $statement, $epistemic_origin,
         $ontology_version, $schema_version
       )`,
    ).run({
      kind: "fact",
      scope_json: '{"project":"actwyn"}',
      statement: "id-null statement",
      epistemic_origin: "user_stated",
      ontology_version: "judgment-taxonomy-v0.1",
      schema_version: "0.1.0",
    } as never);
  }

  test("INSERT without id is rejected (NOT NULL on id)", () => {
    expect(insertWithoutId).toThrow();
  });

  test("INSERT with NULL id is rejected (NOT NULL on id)", () => {
    expect(insertWithNullId).toThrow();
  });

  test("normal valid INSERT still passes", () => {
    expect(() => insertValidJudgmentItem(db)).not.toThrow();
  });

  test("duplicate id is rejected (UNIQUE on id)", () => {
    const id = insertValidJudgmentItem(db);
    expect(() => insertValidJudgmentItem(db, { id })).toThrow();
  });
});

// ---------------------------------------------------------------
// JSON CHECK rejections
// ---------------------------------------------------------------

describe("judgment_items — JSON validity CHECKs", () => {
  test("malformed scope_json is rejected", () => {
    expect(
      tryInsert(db, { scope_json_override: "not json {" }),
    ).toThrow();
  });

  test("malformed would_change_if_json is rejected", () => {
    expect(tryInsert(db, { would_change_if_json: "[" })).toThrow();
  });

  test("valid would_change_if_json (an array) is accepted", () => {
    expect(() =>
      insertValidJudgmentItem(db, { would_change_if_json: '["new evidence"]' }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------
// Default-value insertion round-trip
// ---------------------------------------------------------------

describe("judgment_items — default values", () => {
  test("omitting defaulted columns round-trips with the documented defaults", () => {
    // Insert using only the strictly required columns. Everything
    // else should fall back to the column default.
    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO judgment_items (
         id, kind, scope_json, statement, epistemic_origin,
         ontology_version, schema_version
       ) VALUES (
         $id, $kind, $scope_json, $statement, $epistemic_origin,
         $ontology_version, $schema_version
       )`,
    ).run({
      id,
      kind: "fact",
      scope_json: '{"project":"actwyn"}',
      statement: "default-roundtrip statement",
      epistemic_origin: "user_stated",
      ontology_version: "judgment-taxonomy-v0.1",
      schema_version: "0.1.0",
    } as never);

    const row = db
      .prepare<
        {
          lifecycle_status: string;
          activation_state: string;
          retention_state: string;
          authority_source: string;
          approval_state: string;
          confidence: string;
          importance: number;
          decay_policy: string;
        },
        [string]
      >(
        `SELECT lifecycle_status, activation_state, retention_state,
                authority_source, approval_state, confidence,
                importance, decay_policy
         FROM judgment_items WHERE id = ?`,
      )
      .get(id);

    expect(row).not.toBeNull();
    expect(row!.lifecycle_status).toBe("proposed");
    expect(row!.activation_state).toBe("eligible");
    expect(row!.retention_state).toBe("normal");
    expect(row!.authority_source).toBe("none");
    expect(row!.approval_state).toBe("pending");
    expect(row!.confidence).toBe("medium");
    expect(row!.importance).toBe(3);
    expect(row!.decay_policy).toBe("supersede_only");
  });
});

// ---------------------------------------------------------------
// FTS5 external-content + trigger sync
// ---------------------------------------------------------------

describe("judgment_items_fts — external-content + triggers under bun:sqlite", () => {
  // Look up the FTS hit by joining on the stable `fts_rowid`
  // alias rather than the implicit `rowid`. This documents the
  // operational contract: external-content keys are bound to
  // `judgment_items.fts_rowid`, not to whatever value SQLite
  // happens to assign to `rowid` at the moment.
  function fts(query: string): string[] {
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

  test("fts_rowid mirrors the implicit rowid (INTEGER PK alias)", () => {
    const id = insertValidJudgmentItem(db, {
      statement: "rowid alias mirror check",
    });
    // Both column names refer to the same INTEGER PK alias, so we
    // must alias them to distinct result keys to read them back.
    const row = db
      .prepare<{ implicit_rowid: number; fts_rowid: number }, [string]>(
        `SELECT rowid AS implicit_rowid, fts_rowid AS fts_rowid
         FROM judgment_items WHERE id = ?`,
      )
      .get(id);
    expect(row).not.toBeNull();
    expect(typeof row!.fts_rowid).toBe("number");
    expect(row!.fts_rowid).toBe(row!.implicit_rowid);
  });

  test("INSERT triggers index the new row (lookup via fts_rowid)", () => {
    const a = insertValidJudgmentItem(db, {
      statement: "the user prefers dark mode",
    });
    const b = insertValidJudgmentItem(db, {
      statement: "backup retention is 30 days",
    });

    expect(fts("dark")).toEqual([a].sort());
    expect(fts("retention")).toEqual([b].sort());
  });

  test("UPDATE trigger re-indexes on statement change", () => {
    const a = insertValidJudgmentItem(db, {
      statement: "the user prefers dark mode",
    });
    insertValidJudgmentItem(db, {
      statement: "backup retention is 30 days",
    });

    db.prepare<unknown, [string, string]>(
      `UPDATE judgment_items SET statement = ? WHERE id = ?`,
    ).run("the user prefers light mode", a);

    expect(fts("dark")).toEqual([]);
    expect(fts("light")).toEqual([a]);
  });

  test("DELETE trigger removes the row from the FTS index", () => {
    const a = insertValidJudgmentItem(db, {
      statement: "the user prefers light mode",
    });

    db.prepare<unknown, [string]>(`DELETE FROM judgment_items WHERE id = ?`).run(a);

    expect(fts("light")).toEqual([]);
  });

  test("FTS index survives VACUUM (fts_rowid stability)", () => {
    const a = insertValidJudgmentItem(db, {
      statement: "the user prefers dark mode",
    });
    const b = insertValidJudgmentItem(db, {
      statement: "backup retention is 30 days",
    });

    // VACUUM rebuilds the database file. The implicit rowid of a
    // non-INTEGER-PK rowid table is *not* guaranteed to survive
    // such operations, but our INTEGER PRIMARY KEY alias is —
    // that is the entire point of the fts_rowid column.
    db.prepare("VACUUM").run();

    expect(fts("dark")).toEqual([a].sort());
    expect(fts("retention")).toEqual([b].sort());

    // The fts_rowid value itself is preserved (rowid alias
    // semantics). Pull both rows back and confirm.
    const got = db
      .prepare<{ id: string; fts_rowid: number }, never[]>(
        `SELECT id, fts_rowid FROM judgment_items ORDER BY fts_rowid`,
      )
      .all();
    expect(got.map((r) => r.id)).toEqual([a, b]);
  });
});

// ---------------------------------------------------------------
// judgment_sources / evidence_links / edges / events smoke
// ---------------------------------------------------------------

describe("judgment auxiliary tables — minimal insert smoke", () => {
  test("judgment_sources accepts a minimal valid row", () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO judgment_sources (id, kind, locator)
           VALUES ($id, $kind, $locator)`,
        )
        .run({
          id: crypto.randomUUID(),
          kind: "turn",
          locator: "turn:abc",
        } as never),
    ).not.toThrow();
  });

  test("judgment_sources rejects an invalid trust_level", () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO judgment_sources (id, kind, locator, trust_level)
           VALUES ($id, $kind, $locator, $trust_level)`,
        )
        .run({
          id: crypto.randomUUID(),
          kind: "turn",
          locator: "turn:abc",
          trust_level: "absolute",
        } as never),
    ).toThrow();
  });

  test("judgment_events rejects malformed payload_json", () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO judgment_events (id, event_type, payload_json, actor)
           VALUES ($id, $event_type, $payload_json, $actor)`,
        )
        .run({
          id: crypto.randomUUID(),
          event_type: "smoke",
          payload_json: "not-json",
          actor: "test",
        } as never),
    ).toThrow();
  });
});
