// Personal Agent — Judgment System Phase 1A.8 Control Gate evaluator.
//
// Surfaces:
//   evaluateTurn(input)                      → ControlGateDecision  (Phase 1A.8)
//   evaluateCandidate(candidate)             → ControlGateDecision  (Phase 1A.8)
//   recordControlGateDecision(db, decision)  → id                   (Phase 1A.8)
//
// Per ADR-0014 (P1 Bun boundary), this module has no `Bun` / `bun:*`
// runtime import. `DbHandle` from `~/db.ts` is a type-only import.
//
// Per ADR-0012, `direct_commit_allowed` is ALWAYS false.
// Default gate level is L0. L3 requires explicit user escalation in P0.5.

import type { DbHandle } from "~/db.ts";

import type { AuthoritySourceP05, EpistemicOrigin, JudgmentKind } from "~/judgment/types.ts";

// ---------------------------------------------------------------
// Probe level
// ---------------------------------------------------------------
export const PROBE_LEVELS = ["L0", "L1", "L2", "L3"] as const;
export type ProbeLevel = (typeof PROBE_LEVELS)[number];

// ---------------------------------------------------------------
// Probe types (what aspects are examined at L1/L2/L3)
// ---------------------------------------------------------------
export const PROBE_TYPES = [
  "exception",
  "evidence",
  "authority",
  "freshness",
  "conflict",
  "safety",
  "workflow_friction",
  "cost",
  "eval",
  "scope",
] as const;
export type ProbeType = (typeof PROBE_TYPES)[number];

// ---------------------------------------------------------------
// Lens IDs (P0.5: one lens defined)
// ---------------------------------------------------------------
export const LENS_IDS = ["architecture_critique_lens_v0.1"] as const;
export type LensId = (typeof LENS_IDS)[number];

// ---------------------------------------------------------------
// Trigger codes (JUDGMENT_SYSTEM.md §Gate triggers — 7 triggers)
// ---------------------------------------------------------------
export const TRIGGER_CODES = [
  "user_review_request",  // 1. User explicitly requests review/critique
  "durable_candidate",    // 2. Candidate is durable (judgment/procedure/policy/ADR)
  "schema_change",        // 3. Change touches schema/enum/lifecycle/authority
  "doubt_signal",         // 4. User emits doubt signal
  "decision_conflict",    // 5. Candidate conflicts with existing decision/ADR/DEC
  "high_cost",            // 6. High token cost / workflow friction
  "eval_failure",         // 7. Eval/telemetry shows failure
] as const;
export type TriggerCode = (typeof TRIGGER_CODES)[number];

// ---------------------------------------------------------------
// Budget class (L0=tiny … L3=audit)
// ---------------------------------------------------------------
export const BUDGET_CLASSES = ["tiny", "normal", "deep", "audit"] as const;
export type BudgetClass = (typeof BUDGET_CLASSES)[number];

// ---------------------------------------------------------------
// Persist policy
// ---------------------------------------------------------------
export const PERSIST_POLICIES = ["none", "summary", "full"] as const;
export type PersistPolicy = (typeof PERSIST_POLICIES)[number];

// ---------------------------------------------------------------
// ControlGateDecision — the canonical output type
// (mirrors JUDGMENT_SYSTEM.md §Control Gate)
// ---------------------------------------------------------------
export type ControlGateDecision = {
  readonly id: string;
  readonly turn_id?: string;
  readonly candidate_id?: string;
  readonly phase: "turn" | "candidate" | "pre_context" | "pre_commit";
  readonly level: ProbeLevel;
  readonly probes: readonly ProbeType[];
  readonly lenses: readonly LensId[];
  readonly triggers: readonly TriggerCode[];
  readonly budget_class: BudgetClass;
  readonly critic_model_allowed: boolean;
  readonly persist_policy: PersistPolicy;
  readonly direct_commit_allowed: false;
  readonly created_at: string;
};

// ---------------------------------------------------------------
// Input types
// ---------------------------------------------------------------
export type TurnInput = {
  text: string;
  is_explicit_review_request?: boolean;
  is_doubt_signal?: boolean;
};

export type JudgmentCandidate = {
  id?: string;
  kind: JudgmentKind;
  epistemic_origin: EpistemicOrigin;
  authority_source: AuthoritySourceP05;
  statement?: string;
  is_explicit_full_review?: boolean;
  touches_schema?: boolean;
};

// ---------------------------------------------------------------
// Level → budget_class / persist_policy helpers
// ---------------------------------------------------------------
function budgetFor(level: ProbeLevel): BudgetClass {
  if (level === "L0") return "tiny";
  if (level === "L1") return "normal";
  if (level === "L2") return "deep";
  return "audit";
}

function persistFor(level: ProbeLevel): PersistPolicy {
  if (level === "L0" || level === "L1") return "none";
  if (level === "L2") return "summary";
  return "full";
}

function makeDecision(
  overrides: Partial<ControlGateDecision> & Pick<ControlGateDecision, "phase" | "level">,
): ControlGateDecision {
  const { phase, level } = overrides;
  return {
    id: crypto.randomUUID(),
    phase,
    level,
    probes: overrides.probes ?? [],
    lenses: overrides.lenses ?? [],
    triggers: overrides.triggers ?? [],
    budget_class: budgetFor(level),
    critic_model_allowed: level === "L3",
    persist_policy: persistFor(level),
    direct_commit_allowed: false,
    created_at: new Date().toISOString(),
    ...(overrides.turn_id != null ? { turn_id: overrides.turn_id } : {}),
    ...(overrides.candidate_id != null ? { candidate_id: overrides.candidate_id } : {}),
  };
}

// ---------------------------------------------------------------
// evaluateTurn
//
// Default: L0. Escalation rules (P0.5):
//   - is_explicit_review_request → L3
//   - is_doubt_signal            → L1
// ---------------------------------------------------------------
export function evaluateTurn(input: TurnInput, turnId?: string): ControlGateDecision {
  if (input.is_explicit_review_request) {
    return makeDecision({
      phase: "turn",
      level: "L3",
      probes: ["authority"],
      triggers: ["user_review_request"],
      ...(turnId != null ? { turn_id: turnId } : {}),
    });
  }
  if (input.is_doubt_signal) {
    return makeDecision({
      phase: "turn",
      level: "L1",
      triggers: ["doubt_signal"],
      ...(turnId != null ? { turn_id: turnId } : {}),
    });
  }
  return makeDecision({
    phase: "turn",
    level: "L0",
    ...(turnId != null ? { turn_id: turnId } : {}),
  });
}

// ---------------------------------------------------------------
// evaluateCandidate
//
// Default: L0. Escalation rules (P0.5):
//   - is_explicit_full_review                        → L3
//   - kind ∈ {decision, current_state, procedure}    → L2
//   - touches_schema                                  → L2
//   - epistemic_origin=assistant_generated +
//     authority_source=none                           → L1 (authority probe)
// ---------------------------------------------------------------
export function evaluateCandidate(
  candidate: JudgmentCandidate,
): ControlGateDecision {
  const durableKinds: JudgmentKind[] = ["decision", "current_state", "procedure"];

  if (candidate.is_explicit_full_review) {
    return makeDecision({
      phase: "candidate",
      level: "L3",
      probes: ["authority", "conflict"],
      triggers: ["user_review_request", "durable_candidate"],
      ...(candidate.id != null ? { candidate_id: candidate.id } : {}),
    });
  }

  if (durableKinds.includes(candidate.kind) || candidate.touches_schema) {
    const triggers: TriggerCode[] = ["durable_candidate"];
    if (candidate.touches_schema) triggers.push("schema_change");
    const lenses: LensId[] = ["architecture_critique_lens_v0.1"];
    return makeDecision({
      phase: "candidate",
      level: "L2",
      probes: ["authority", "conflict"],
      lenses,
      triggers,
      ...(candidate.id != null ? { candidate_id: candidate.id } : {}),
    });
  }

  if (
    candidate.epistemic_origin === "assistant_generated" &&
    candidate.authority_source === "none"
  ) {
    return makeDecision({
      phase: "candidate",
      level: "L1",
      probes: ["authority"],
      triggers: ["durable_candidate"],
      ...(candidate.id != null ? { candidate_id: candidate.id } : {}),
    });
  }

  return makeDecision({
    phase: "candidate",
    level: "L0",
    ...(candidate.id != null ? { candidate_id: candidate.id } : {}),
  });
}

// ---------------------------------------------------------------
// recordControlGateDecision
//
// Persists a ControlGateDecision to control_gate_events.
// Returns the inserted row id.
// ---------------------------------------------------------------
export function recordControlGateDecision(
  db: DbHandle,
  decision: ControlGateDecision,
): string {
  db.prepare<unknown, [string, string, string | null, string | null, string, string, string, string, string, number, string, number, string]>(
    `INSERT INTO control_gate_events
       (id, phase, turn_id, candidate_id, level,
        probes_json, lenses_json, triggers_json,
        budget_class, critic_model_allowed, persist_policy,
        direct_commit_allowed, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    decision.id,
    decision.phase,
    decision.turn_id ?? null,
    decision.candidate_id ?? null,
    decision.level,
    JSON.stringify(decision.probes),
    JSON.stringify(decision.lenses),
    JSON.stringify(decision.triggers),
    decision.budget_class,
    decision.critic_model_allowed ? 1 : 0,
    decision.persist_policy,
    0,
    decision.created_at,
  );
  return decision.id;
}
