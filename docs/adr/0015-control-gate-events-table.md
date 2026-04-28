# ADR-0015 — control_gate_events append-only ledger

- Status: accepted
- Date: 2026-04-28
- Implements: Phase 1A.8 (Control Gate local surface)
- Relates to: ADR-0012 (Authority/origin separation + metacognitive critique loop),
  ADR-0013 (Critique lens + Tension generalization),
  ADR-0014 (Bun runtime stack confirmation)
- Source: docs/JUDGMENT_SYSTEM.md §Control Gate, §P0.5 implementation scope

## Context

ADR-0012 defined the Control Gate as a four-phase control-plane evaluator
(turn / candidate / pre_context / pre_commit) that classifies each input
into a ProbeLevel (L0–L3) and emits a `ControlGateDecision`. The key
invariant is that `direct_commit_allowed` is always `false` — the gate
never grants direct commit rights.

Phase 1A.7 completed the retirement lifecycle (supersede/revoke/expire).
Phase 1A.8 implements the local-only, unregistered Control Gate surface:
types, evaluation logic, and the `control_gate_events` persistence table.

## Decision

1. **Table name**: `control_gate_events` (per `docs/JUDGMENT_SYSTEM.md`
   §Persistence — "control_gate_events 또는 control_plane_events").

2. **Append-only enforcement at SQL layer**: `BEFORE UPDATE` and
   `BEFORE DELETE` triggers that `RAISE(ABORT, ...)`. This mirrors
   the append-only contract of `judgment_events` and is consistent
   with the audit-ledger role of the table.

3. **`direct_commit_allowed` column**: stored as `INTEGER NOT NULL DEFAULT 0`
   with `CHECK(direct_commit_allowed = 0)`. Never settable to 1. This
   encodes the ADR-0012 invariant at the schema level so no application
   code can accidentally set it.

4. **enum columns**: `level` (L0/L1/L2/L3), `phase`, `budget_class`,
   `persist_policy` are all TEXT with CHECK constraints mirroring the
   TypeScript union types in `src/judgment/control_gate.ts`.

5. **Probe/lens/trigger storage**: JSON arrays (`probes_json`,
   `lenses_json`, `triggers_json`) with `json_valid()` + `json_type()`
   constraints. Avoids a separate join table for P0.5 cardinality.

6. **No runtime wiring**: `src/judgment/control_gate.ts` is a pure-TS
   module (per ADR-0014 Bun boundary). `evaluateTurn` and
   `evaluateCandidate` are not called from any runtime path. The
   `control_gate_events` table exists and is tested; no turn loop,
   provider, or context builder imports this module.

## Consequences

- `migrations/005_control_gate_events.sql` adds the table and four
  indexes (level, turn_id, candidate_id, created_at) plus two triggers.
- `expected_schema_version` in `src/main.ts` bumped from 4 to 5.
- `src/judgment/control_gate.ts` exports `ControlGateDecision`,
  `evaluateTurn`, `evaluateCandidate`, `recordControlGateDecision`.
- Tests in `test/db/control_gate_schema.test.ts` (schema/trigger) and
  `test/judgment/control_gate.test.ts` (eval logic + persistence) cover
  all 6 eval fixtures from `docs/JUDGMENT_SYSTEM.md §Eval fixtures`.
- P1+ wiring (Context Compiler integration, automatic L2/L3 escalation
  rules, Tension emission from lens) remains out of scope.
