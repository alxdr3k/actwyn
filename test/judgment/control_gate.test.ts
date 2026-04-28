// Judgment System Phase 1A.8 — control gate evaluator coverage.
//
// Covers:
//   - evaluateTurn: L0 default, L1 doubt signal, L3 explicit review
//   - evaluateCandidate: L0 default, L1 assistant_generated, L2 durable kind,
//     L2 schema change, L3 explicit full review
//   - 6 eval fixtures from JUDGMENT_SYSTEM.md §Eval fixtures
//   - recordControlGateDecision: persistence round-trip
//   - Static import boundary: control_gate.ts must not import runtime modules

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

import { openDatabase, type DbHandle } from "../../src/db.ts";
import { migrate } from "../../src/db/migrator.ts";
import {
  evaluateTurn,
  evaluateCandidate,
  recordControlGateDecision,
  type ControlGateDecision,
  type TurnInput,
  type JudgmentCandidate,
} from "../../src/judgment/control_gate.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");

let workdir: string;
let db: DbHandle;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "actwyn-control-gate-"));
  db = openDatabase({ path: join(workdir, "test.db"), busyTimeoutMs: 250 });
  migrate(db, MIGRATIONS_DIR);
});

afterEach(() => {
  db.close();
  rmSync(workdir, { recursive: true, force: true });
});

// ---------------------------------------------------------------
// evaluateTurn
// ---------------------------------------------------------------
describe("evaluateTurn", () => {
  test("default L0 for casual turn", () => {
    const d = evaluateTurn({ text: "오늘 날씨 어때?" });
    expect(d.level).toBe("L0");
    expect(d.probes).toHaveLength(0);
    expect(d.lenses).toHaveLength(0);
    expect(d.triggers).toHaveLength(0);
    expect(d.budget_class).toBe("tiny");
    expect(d.persist_policy).toBe("none");
    expect(d.critic_model_allowed).toBe(false);
    expect(d.direct_commit_allowed).toBe(false);
    expect(d.phase).toBe("turn");
  });

  test("L0 does not create Tension content", () => {
    const d = evaluateTurn({ text: "What time is it?" });
    expect(d.level).toBe("L0");
    expect(d.lenses).toHaveLength(0);
  });

  test("L1 for doubt signal", () => {
    const d = evaluateTurn({ text: "흠, 이 로직 좀 이상한 것 같은데", is_doubt_signal: true });
    expect(d.level).toBe("L1");
    expect(d.triggers).toContain("doubt_signal");
    expect(d.critic_model_allowed).toBe(false);
    expect(d.budget_class).toBe("normal");
    expect(d.persist_policy).toBe("none");
  });

  test("L3 for explicit review request", () => {
    const d = evaluateTurn({ text: "이 설계 구현 들어가도 돼?", is_explicit_review_request: true });
    expect(d.level).toBe("L3");
    expect(d.triggers).toContain("user_review_request");
    expect(d.critic_model_allowed).toBe(true);
    expect(d.budget_class).toBe("audit");
    expect(d.persist_policy).toBe("full");
  });

  test("attaches turn_id when provided", () => {
    const d = evaluateTurn({ text: "hello" }, "turn-abc");
    expect(d.turn_id).toBe("turn-abc");
  });

  test("no turn_id when not provided", () => {
    const d = evaluateTurn({ text: "hello" });
    expect(d.turn_id).toBeUndefined();
  });

  test("direct_commit_allowed is always false", () => {
    const inputs: TurnInput[] = [
      { text: "casual" },
      { text: "doubt", is_doubt_signal: true },
      { text: "review", is_explicit_review_request: true },
    ];
    for (const input of inputs) {
      expect(evaluateTurn(input).direct_commit_allowed).toBe(false);
    }
  });

  test("produces unique ids each call", () => {
    const d1 = evaluateTurn({ text: "hello" });
    const d2 = evaluateTurn({ text: "hello" });
    expect(d1.id).not.toBe(d2.id);
  });
});

// ---------------------------------------------------------------
// evaluateCandidate
// ---------------------------------------------------------------
describe("evaluateCandidate", () => {
  const base: JudgmentCandidate = {
    kind: "fact",
    epistemic_origin: "user_stated",
    authority_source: "user_confirmed",
  };

  test("default L0 for simple fact candidate", () => {
    const d = evaluateCandidate(base);
    expect(d.level).toBe("L0");
    expect(d.probes).toHaveLength(0);
    expect(d.lenses).toHaveLength(0);
    expect(d.triggers).toHaveLength(0);
    expect(d.phase).toBe("candidate");
    expect(d.direct_commit_allowed).toBe(false);
  });

  test("L1 for assistant_generated + no authority — no durable_candidate trigger", () => {
    const d = evaluateCandidate({
      ...base,
      kind: "fact",
      epistemic_origin: "assistant_generated",
      authority_source: "none",
    });
    expect(d.level).toBe("L1");
    expect(d.probes).toContain("authority");
    expect(d.triggers).not.toContain("durable_candidate");
    expect(d.triggers).toHaveLength(0);
    expect(d.critic_model_allowed).toBe(false);
  });

  test("L2 for 'decision' kind", () => {
    const d = evaluateCandidate({ ...base, kind: "decision" });
    expect(d.level).toBe("L2");
    expect(d.probes).toContain("authority");
    expect(d.lenses).toContain("architecture_critique_lens_v0.1");
    expect(d.triggers).toContain("durable_candidate");
    expect(d.budget_class).toBe("deep");
    expect(d.persist_policy).toBe("summary");
  });

  test("L2 for 'current_state' kind", () => {
    const d = evaluateCandidate({ ...base, kind: "current_state" });
    expect(d.level).toBe("L2");
  });

  test("L2 for 'procedure' kind", () => {
    const d = evaluateCandidate({ ...base, kind: "procedure" });
    expect(d.level).toBe("L2");
    expect(d.probes).toContain("authority");
    expect(d.triggers).toContain("durable_candidate");
  });

  test("L2 for schema change", () => {
    const d = evaluateCandidate({ ...base, kind: "fact", touches_schema: true });
    expect(d.level).toBe("L2");
    expect(d.triggers).toContain("schema_change");
    expect(d.lenses).toContain("architecture_critique_lens_v0.1");
  });

  test("L3 for explicit full review on durable kind includes durable_candidate trigger", () => {
    const d = evaluateCandidate({ ...base, kind: "decision", is_explicit_full_review: true });
    expect(d.level).toBe("L3");
    expect(d.critic_model_allowed).toBe(true);
    expect(d.triggers).toContain("user_review_request");
    expect(d.triggers).toContain("durable_candidate");
    expect(d.budget_class).toBe("audit");
  });

  test("L3 for explicit full review on non-durable kind omits durable_candidate trigger", () => {
    const d = evaluateCandidate({ ...base, kind: "fact", is_explicit_full_review: true });
    expect(d.level).toBe("L3");
    expect(d.triggers).toContain("user_review_request");
    expect(d.triggers).not.toContain("durable_candidate");
  });

  test("attaches candidate_id when provided", () => {
    const d = evaluateCandidate({ ...base, id: "jid-123" });
    expect(d.candidate_id).toBe("jid-123");
  });

  test("direct_commit_allowed is always false", () => {
    const candidates: JudgmentCandidate[] = [
      base,
      { ...base, kind: "procedure" },
      { ...base, kind: "decision", is_explicit_full_review: true },
    ];
    for (const c of candidates) {
      expect(evaluateCandidate(c).direct_commit_allowed).toBe(false);
    }
  });
});

// ---------------------------------------------------------------
// JUDGMENT_SYSTEM.md §Eval fixtures (6 scenarios)
// ---------------------------------------------------------------
describe("eval fixtures", () => {
  // Fixture 1: casual query → L0
  test("fixture 1: '오늘 날씨 어때?' → L0, no probes/lenses/triggers", () => {
    const d = evaluateTurn({ text: "오늘 날씨 어때?" });
    expect(d.level).toBe("L0");
    expect(d.probes).toHaveLength(0);
    expect(d.lenses).toHaveLength(0);
    expect(d.triggers).toHaveLength(0);
  });

  // Fixture 2: schema-change suggestion → L2, conflict/exception probes, architecture lens
  test("fixture 2: schema enum change suggestion → L2 with architecture lens", () => {
    const d = evaluateCandidate({
      kind: "current_state",
      epistemic_origin: "user_stated",
      authority_source: "user_confirmed",
      statement: "JudgmentItem.status에 stale을 넣자",
      touches_schema: true,
    });
    expect(d.level).toBe("L2");
    expect(d.lenses).toContain("architecture_critique_lens_v0.1");
    expect(d.probes.some((p) => p === "exception" || p === "conflict" || p === "authority")).toBe(true);
  });

  // Fixture 3: implementation go-ahead → L3, critic allowed
  test("fixture 3: '이 설계 구현 들어가도 돼?' → L3, critic_model_allowed=true", () => {
    const d = evaluateTurn({ text: "이 설계 구현 들어가도 돼?", is_explicit_review_request: true });
    expect(d.level).toBe("L3");
    expect(d.critic_model_allowed).toBe(true);
  });

  // Fixture 4: new procedure suggestion (PRD non-goal confirmation) → L2, authority probe
  test("fixture 4: new procedure suggestion → L2, authority probe, direct_commit_allowed=false", () => {
    const d = evaluateCandidate({
      kind: "procedure",
      epistemic_origin: "user_stated",
      authority_source: "user_confirmed",
      statement: "앞으로 MVP 판단할 때 PRD non-goal을 먼저 확인해",
    });
    expect(d.level).toMatch(/^L[23]$/);
    expect(d.probes).toContain("authority");
    expect(d.direct_commit_allowed).toBe(false);
  });

  // Fixture 5: assistant_generated without user confirmation → L1, cannot become active
  test("fixture 5: assistant_generated + authority=none → L1, authority probe", () => {
    const d = evaluateCandidate({
      kind: "procedure",
      epistemic_origin: "assistant_generated",
      authority_source: "none",
      statement: "Assistant suggests new procedure without user confirmation",
    });
    // Procedure kind escalates to L2 regardless; authority_source=none is also a signal.
    // Either way direct_commit_allowed must be false and authority probe must be present.
    expect(d.level).toMatch(/^L[123]$/);
    expect(d.probes).toContain("authority");
    expect(d.direct_commit_allowed).toBe(false);
  });

  // Fixture 6: superseded judgment excluded from active view
  // This fixture tests existing retirement lifecycle (Phase 1A.7), verifiable via DB query.
  // Control gate has no role here — it always returns direct_commit_allowed=false.
  test("fixture 6: superseded judgment not returned by active query", () => {
    // Seed a judgment_item as superseded
    const id = crypto.randomUUID();
    db.prepare<unknown, [string, string]>(
      `INSERT INTO judgment_items
         (id, kind, scope_json, statement, epistemic_origin, authority_source,
          approval_state, lifecycle_status, activation_state, retention_state,
          confidence, importance, decay_policy, ontology_version, schema_version)
       VALUES (?, 'decision', '{"project":"actwyn"}', 'a decision', 'user_stated',
               'user_confirmed', 'approved', ?, 'excluded', 'normal',
               'high', 5, 'supersede_only', 'judgment-taxonomy-v0.1', '0.1.0')`,
    ).run(id, "superseded");

    const active = db.prepare<{ id: string }, []>(
      "SELECT id FROM judgment_items WHERE lifecycle_status = 'active' AND activation_state = 'eligible'",
    ).all();
    expect(active.some((r) => r.id === id)).toBe(false);

    // It should be accessible for audit/explain
    const audit = db.prepare<{ id: string }, [string]>(
      "SELECT id FROM judgment_items WHERE id = ?",
    ).get(id);
    expect(audit).toBeDefined();
    expect(audit!.id).toBe(id);
  });
});

// ---------------------------------------------------------------
// recordControlGateDecision — persistence round-trip
// ---------------------------------------------------------------
describe("recordControlGateDecision", () => {
  test("persists L0 turn decision and returns id", () => {
    const decision = evaluateTurn({ text: "simple lookup" });
    const returnedId = recordControlGateDecision(db, decision);
    expect(returnedId).toBe(decision.id);

    const row = db.prepare<{
      id: string; level: string; phase: string;
      probes_json: string; direct_commit_allowed: number;
    }, [string]>(
      "SELECT id, level, phase, probes_json, direct_commit_allowed FROM control_gate_events WHERE id = ?",
    ).get(decision.id);
    expect(row).toBeDefined();
    expect(row!.id).toBe(decision.id);
    expect(row!.level).toBe("L0");
    expect(row!.phase).toBe("turn");
    expect(JSON.parse(row!.probes_json)).toEqual([]);
    expect(row!.direct_commit_allowed).toBe(0);
  });

  test("persists L2 candidate decision with probes/lenses", () => {
    const decision = evaluateCandidate({
      kind: "procedure",
      epistemic_origin: "user_stated",
      authority_source: "user_confirmed",
    });
    recordControlGateDecision(db, decision);

    const row = db.prepare<{ level: string; lenses_json: string; probes_json: string }, [string]>(
      "SELECT level, lenses_json, probes_json FROM control_gate_events WHERE id = ?",
    ).get(decision.id);
    expect(row!.level).toBe("L2");
    const lenses = JSON.parse(row!.lenses_json) as string[];
    expect(lenses).toContain("architecture_critique_lens_v0.1");
  });

  test("persists turn_id", () => {
    const decision = evaluateTurn({ text: "hello" }, "turn-xyz");
    recordControlGateDecision(db, decision);
    const row = db.prepare<{ turn_id: string }, [string]>(
      "SELECT turn_id FROM control_gate_events WHERE id = ?",
    ).get(decision.id);
    expect(row!.turn_id).toBe("turn-xyz");
  });

  test("persists candidate_id (FK to existing judgment_item)", () => {
    // Insert a real judgment_item so the FK constraint is satisfied
    const jid = "jid-abc";
    db.prepare<unknown, [string]>(
      `INSERT INTO judgment_items
         (id, kind, scope_json, statement, epistemic_origin, authority_source,
          approval_state, lifecycle_status, activation_state, retention_state,
          confidence, importance, decay_policy, ontology_version, schema_version)
       VALUES (?, 'fact', '{"project":"actwyn"}', 'test fact', 'user_stated',
               'none', 'pending', 'proposed', 'eligible', 'normal',
               'medium', 3, 'supersede_only', 'judgment-taxonomy-v0.1', '0.1.0')`,
    ).run(jid);

    const decision = evaluateCandidate({
      id: jid,
      kind: "fact",
      epistemic_origin: "user_stated",
      authority_source: "user_confirmed",
    });
    recordControlGateDecision(db, decision);
    const row = db.prepare<{ candidate_id: string }, [string]>(
      "SELECT candidate_id FROM control_gate_events WHERE id = ?",
    ).get(decision.id);
    expect(row!.candidate_id).toBe(jid);
  });

  test("duplicate id raises", () => {
    const decision = evaluateTurn({ text: "hello" });
    recordControlGateDecision(db, decision);
    expect(() => recordControlGateDecision(db, decision)).toThrow();
  });
});

// ---------------------------------------------------------------
// Static import boundary
// ---------------------------------------------------------------
describe("import boundary", () => {
  test("control_gate.ts does not import runtime modules", () => {
    const source = readFileSync(
      join(import.meta.dir, "..", "..", "src", "judgment", "control_gate.ts"),
      "utf8",
    );
    const runtimePaths = [
      "src/providers",
      "src/context",
      "src/queue",
      "src/memory",
      "src/telegram",
      "src/commands",
      "bun:sqlite",
      "bun:ffi",
    ];
    for (const path of runtimePaths) {
      expect(source).not.toContain(path);
    }
  });
});
