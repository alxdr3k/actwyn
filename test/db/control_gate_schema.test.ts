// Judgment System Phase 1A.8 — control_gate_events schema coverage.
//
// Tests CHECK constraints, NOT NULL, JSON validity, append-only triggers,
// and successful insert/fetch round-trips. No repository helper — direct SQL.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type SQLQueryBindings } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase, type DbHandle } from "../../src/db.ts";
import { migrate } from "../../src/db/migrator.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");

let workdir: string;
let db: DbHandle;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "actwyn-control-gate-schema-"));
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
interface RowOverrides {
  id?: string;
  phase?: string;
  turn_id?: string | null;
  candidate_id?: string | null;
  level?: string;
  probes_json?: string;
  lenses_json?: string;
  triggers_json?: string;
  budget_class?: string;
  critic_model_allowed?: number;
  persist_policy?: string;
  direct_commit_allowed?: number;
  created_at?: string;
}

function insertRow(o: RowOverrides = {}): string {
  const id = o.id ?? crypto.randomUUID();
  db.prepare<unknown, [string, string, string | null, string | null, string, string, string, string, string, number, string, number, string]>(
    `INSERT INTO control_gate_events
       (id, phase, turn_id, candidate_id, level,
        probes_json, lenses_json, triggers_json,
        budget_class, critic_model_allowed, persist_policy,
        direct_commit_allowed, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    o.phase ?? "turn",
    o.turn_id !== undefined ? o.turn_id : null,
    o.candidate_id !== undefined ? o.candidate_id : null,
    o.level ?? "L0",
    o.probes_json ?? "[]",
    o.lenses_json ?? "[]",
    o.triggers_json ?? "[]",
    o.budget_class ?? "tiny",
    o.critic_model_allowed ?? 0,
    o.persist_policy ?? "none",
    o.direct_commit_allowed ?? 0,
    o.created_at ?? new Date().toISOString(),
  );
  return id;
}

function insertRaw(sql: string, params: SQLQueryBindings[]): () => void {
  return () => {
    db.prepare<unknown, SQLQueryBindings[]>(sql).run(...params);
  };
}

// ---------------------------------------------------------------
// Happy path — insert and fetch
// ---------------------------------------------------------------
describe("insert and fetch", () => {
  test("inserts a minimal L0 row", () => {
    const id = insertRow();
    const row = db.prepare<{ id: string; level: string; phase: string }, [string]>(
      "SELECT id, level, phase FROM control_gate_events WHERE id = ?",
    ).get(id);
    expect(row).toBeDefined();
    expect(row!.id).toBe(id);
    expect(row!.level).toBe("L0");
    expect(row!.phase).toBe("turn");
  });

  test("inserts an L3 row with all fields", () => {
    const id = insertRow({
      phase: "pre_commit",
      level: "L3",
      probes_json: '["authority","conflict"]',
      lenses_json: '["architecture_critique_lens_v0.1"]',
      triggers_json: '["user_review_request"]',
      budget_class: "audit",
      critic_model_allowed: 1,
      persist_policy: "full",
    });
    const row = db.prepare<{
      level: string;
      budget_class: string;
      critic_model_allowed: number;
      persist_policy: string;
    }, [string]>(
      "SELECT level, budget_class, critic_model_allowed, persist_policy FROM control_gate_events WHERE id = ?",
    ).get(id);
    expect(row!.level).toBe("L3");
    expect(row!.budget_class).toBe("audit");
    expect(row!.critic_model_allowed).toBe(1);
    expect(row!.persist_policy).toBe("full");
  });

  test("stores turn_id and candidate_id as nullable", () => {
    const id = insertRow({ turn_id: "t1", candidate_id: null });
    const row = db.prepare<{ turn_id: string | null; candidate_id: string | null }, [string]>(
      "SELECT turn_id, candidate_id FROM control_gate_events WHERE id = ?",
    ).get(id);
    expect(row!.turn_id).toBe("t1");
    expect(row!.candidate_id).toBeNull();
  });
});

// ---------------------------------------------------------------
// CHECK constraints — phase
// ---------------------------------------------------------------
describe("phase CHECK", () => {
  const validPhases = ["turn", "candidate", "pre_context", "pre_commit"];

  for (const phase of validPhases) {
    test(`accepts phase='${phase}'`, () => {
      expect(() => insertRow({ phase })).not.toThrow();
    });
  }

  test("rejects unknown phase", () => {
    expect(insertRaw(
      "INSERT INTO control_gate_events (id, phase, level, budget_class, persist_policy, direct_commit_allowed) VALUES (?,?,?,?,?,?)",
      [crypto.randomUUID(), "unknown_phase", "L0", "tiny", "none", 0],
    )).toThrow();
  });
});

// ---------------------------------------------------------------
// CHECK constraints — level
// ---------------------------------------------------------------
describe("level CHECK", () => {
  const validLevels = ["L0", "L1", "L2", "L3"];

  for (const level of validLevels) {
    test(`accepts level='${level}'`, () => {
      expect(() => insertRow({ level })).not.toThrow();
    });
  }

  test("rejects unknown level", () => {
    expect(insertRaw(
      "INSERT INTO control_gate_events (id, phase, level, budget_class, persist_policy, direct_commit_allowed) VALUES (?,?,?,?,?,?)",
      [crypto.randomUUID(), "turn", "L4", "tiny", "none", 0],
    )).toThrow();
  });
});

// ---------------------------------------------------------------
// CHECK constraints — budget_class
// ---------------------------------------------------------------
describe("budget_class CHECK", () => {
  const validClasses = ["tiny", "normal", "deep", "audit"];

  for (const budget_class of validClasses) {
    test(`accepts budget_class='${budget_class}'`, () => {
      expect(() => insertRow({ budget_class })).not.toThrow();
    });
  }

  test("rejects unknown budget_class", () => {
    expect(insertRaw(
      "INSERT INTO control_gate_events (id, phase, level, budget_class, persist_policy, direct_commit_allowed) VALUES (?,?,?,?,?,?)",
      [crypto.randomUUID(), "turn", "L0", "massive", "none", 0],
    )).toThrow();
  });
});

// ---------------------------------------------------------------
// CHECK constraints — persist_policy
// ---------------------------------------------------------------
describe("persist_policy CHECK", () => {
  const validPolicies = ["none", "summary", "full"];

  for (const persist_policy of validPolicies) {
    test(`accepts persist_policy='${persist_policy}'`, () => {
      expect(() => insertRow({ persist_policy })).not.toThrow();
    });
  }

  test("rejects unknown persist_policy", () => {
    expect(insertRaw(
      "INSERT INTO control_gate_events (id, phase, level, budget_class, persist_policy, direct_commit_allowed) VALUES (?,?,?,?,?,?)",
      [crypto.randomUUID(), "turn", "L0", "tiny", "ephemeral", 0],
    )).toThrow();
  });
});

// ---------------------------------------------------------------
// CHECK constraints — critic_model_allowed
// ---------------------------------------------------------------
describe("critic_model_allowed CHECK", () => {
  test("accepts 0", () => {
    expect(() => insertRow({ critic_model_allowed: 0 })).not.toThrow();
  });
  test("accepts 1", () => {
    expect(() => insertRow({ critic_model_allowed: 1 })).not.toThrow();
  });
  test("rejects 2", () => {
    expect(insertRaw(
      "INSERT INTO control_gate_events (id, phase, level, budget_class, persist_policy, critic_model_allowed, direct_commit_allowed) VALUES (?,?,?,?,?,?,?)",
      [crypto.randomUUID(), "turn", "L0", "tiny", "none", 2, 0],
    )).toThrow();
  });
});

// ---------------------------------------------------------------
// CHECK constraint — direct_commit_allowed always 0
// ---------------------------------------------------------------
describe("direct_commit_allowed CHECK", () => {
  test("accepts 0", () => {
    expect(() => insertRow({ direct_commit_allowed: 0 })).not.toThrow();
  });
  test("rejects 1 (ADR-0012 invariant)", () => {
    expect(insertRaw(
      "INSERT INTO control_gate_events (id, phase, level, budget_class, persist_policy, direct_commit_allowed) VALUES (?,?,?,?,?,?)",
      [crypto.randomUUID(), "turn", "L0", "tiny", "none", 1],
    )).toThrow();
  });
});

// ---------------------------------------------------------------
// JSON validity constraints
// ---------------------------------------------------------------
describe("JSON column constraints", () => {
  test("rejects invalid probes_json", () => {
    expect(() => insertRow({ probes_json: "not-json" })).toThrow();
  });

  test("rejects non-array probes_json", () => {
    expect(() => insertRow({ probes_json: '{"not":"array"}' })).toThrow();
  });

  test("rejects invalid lenses_json", () => {
    expect(() => insertRow({ lenses_json: "not-json" })).toThrow();
  });

  test("rejects invalid triggers_json", () => {
    expect(() => insertRow({ triggers_json: "{bad" })).toThrow();
  });

  test("accepts empty arrays", () => {
    expect(() => insertRow({ probes_json: "[]", lenses_json: "[]", triggers_json: "[]" })).not.toThrow();
  });

  test("accepts populated arrays", () => {
    expect(() => insertRow({
      probes_json: '["authority","conflict"]',
      lenses_json: '["architecture_critique_lens_v0.1"]',
      triggers_json: '["user_review_request","durable_candidate"]',
    })).not.toThrow();
  });
});

// ---------------------------------------------------------------
// Append-only triggers
// ---------------------------------------------------------------
describe("append-only enforcement", () => {
  test("blocks UPDATE", () => {
    const id = insertRow();
    expect(() => {
      db.prepare("UPDATE control_gate_events SET level = 'L3' WHERE id = ?").run(id);
    }).toThrow(/append-only.*UPDATE/i);
  });

  test("blocks DELETE", () => {
    const id = insertRow();
    expect(() => {
      db.prepare("DELETE FROM control_gate_events WHERE id = ?").run(id);
    }).toThrow(/append-only.*DELETE/i);
  });

  test("allows multiple INSERTs", () => {
    insertRow();
    insertRow();
    const count = db.prepare<{ n: number }, []>("SELECT COUNT(*) as n FROM control_gate_events").get();
    expect(count!.n).toBe(2);
  });

  test("blocks INSERT OR REPLACE (REPLACE conflict algorithm bypasses BEFORE DELETE)", () => {
    const id = insertRow();
    expect(() => {
      db.prepare<unknown, SQLQueryBindings[]>(
        "INSERT OR REPLACE INTO control_gate_events (id, phase, level, budget_class, persist_policy, direct_commit_allowed) VALUES (?,?,?,?,?,?)",
      ).run(id, "candidate", "L3", "audit", "full", 0);
    }).toThrow(/append-only.*duplicate/i);
  });
});

// ---------------------------------------------------------------
// NOT NULL enforcement
// ---------------------------------------------------------------
describe("NOT NULL constraints", () => {
  test("rejects null phase", () => {
    expect(insertRaw(
      "INSERT INTO control_gate_events (id, phase, level, budget_class, persist_policy, direct_commit_allowed) VALUES (?,?,?,?,?,?)",
      [crypto.randomUUID(), null, "L0", "tiny", "none", 0],
    )).toThrow();
  });

  test("rejects null level", () => {
    expect(insertRaw(
      "INSERT INTO control_gate_events (id, phase, level, budget_class, persist_policy, direct_commit_allowed) VALUES (?,?,?,?,?,?)",
      [crypto.randomUUID(), "turn", null, "tiny", "none", 0],
    )).toThrow();
  });

  test("rejects null budget_class", () => {
    expect(insertRaw(
      "INSERT INTO control_gate_events (id, phase, level, budget_class, persist_policy, direct_commit_allowed) VALUES (?,?,?,?,?,?)",
      [crypto.randomUUID(), "turn", "L0", null, "none", 0],
    )).toThrow();
  });

  test("rejects null persist_policy", () => {
    expect(insertRaw(
      "INSERT INTO control_gate_events (id, phase, level, budget_class, persist_policy, direct_commit_allowed) VALUES (?,?,?,?,?,?)",
      [crypto.randomUUID(), "turn", "L0", "tiny", null, 0],
    )).toThrow();
  });
});
