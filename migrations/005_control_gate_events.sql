-- Personal Agent — migration 005_control_gate_events.
--
-- Phase 1A.8 schema addition for the Control Gate evaluation ledger.
-- Purely additive — no existing table is altered.
--
-- Decisions reflected:
--   ADR-0012 — Authority/origin separation + metacognitive critique loop
--   ADR-0015 — control_gate_events append-only ledger (this PR)
--   docs/JUDGMENT_SYSTEM.md §Control Gate
--
-- The table is append-only. BEFORE UPDATE and BEFORE DELETE
-- triggers enforce immutability at the SQL layer.

-- ---------------------------------------------------------------
-- control_gate_events
--
-- Append-only ledger of ControlGateDecision rows evaluated during
-- turn / candidate / pre_context / pre_commit gate phases.
-- `direct_commit_allowed` is always 0 — hardcoded invariant
-- enforced by a CHECK constraint.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS control_gate_events (
  id                    TEXT    NOT NULL PRIMARY KEY,

  -- Gate phase: when in the pipeline was the gate evaluated
  phase                 TEXT    NOT NULL
                                CHECK (phase IN ('turn', 'candidate', 'pre_context', 'pre_commit')),

  -- Optional back-links to the entity being evaluated
  turn_id               TEXT,
  candidate_id          TEXT    REFERENCES judgment_items(id),

  -- Gate output
  level                 TEXT    NOT NULL CHECK (level IN ('L0', 'L1', 'L2', 'L3')),

  -- JSON arrays — must be valid JSON
  probes_json           TEXT    NOT NULL DEFAULT '[]'
                                CHECK (json_valid(probes_json) AND json_type(probes_json) = 'array'),
  lenses_json           TEXT    NOT NULL DEFAULT '[]'
                                CHECK (json_valid(lenses_json) AND json_type(lenses_json) = 'array'),
  triggers_json         TEXT    NOT NULL DEFAULT '[]'
                                CHECK (json_valid(triggers_json) AND json_type(triggers_json) = 'array'),

  budget_class          TEXT    NOT NULL
                                CHECK (budget_class IN ('tiny', 'normal', 'deep', 'audit')),
  critic_model_allowed  INTEGER NOT NULL DEFAULT 0
                                CHECK (critic_model_allowed IN (0, 1)),
  persist_policy        TEXT    NOT NULL
                                CHECK (persist_policy IN ('none', 'summary', 'full')),

  -- Immutability invariant — always 0, ADR-0012
  direct_commit_allowed INTEGER NOT NULL DEFAULT 0
                                CHECK (direct_commit_allowed = 0),

  created_at            TEXT    NOT NULL
                                DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) WITHOUT ROWID;

-- ---------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_control_gate_events_level
  ON control_gate_events(level);

CREATE INDEX IF NOT EXISTS idx_control_gate_events_turn_id
  ON control_gate_events(turn_id) WHERE turn_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_control_gate_events_candidate_id
  ON control_gate_events(candidate_id) WHERE candidate_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_control_gate_events_created_at
  ON control_gate_events(created_at);

-- ---------------------------------------------------------------
-- Append-only triggers
-- ---------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS control_gate_events_no_update
BEFORE UPDATE ON control_gate_events
BEGIN
  SELECT RAISE(ABORT, 'control_gate_events is append-only: UPDATE not allowed');
END;

CREATE TRIGGER IF NOT EXISTS control_gate_events_no_delete
BEFORE DELETE ON control_gate_events
BEGIN
  SELECT RAISE(ABORT, 'control_gate_events is append-only: DELETE not allowed');
END;

-- SQLite INSERT OR REPLACE bypasses BEFORE DELETE triggers via the REPLACE
-- conflict resolution algorithm. Block it explicitly with a BEFORE INSERT
-- check so the append-only guarantee holds even against OR REPLACE callers.
CREATE TRIGGER IF NOT EXISTS control_gate_events_no_replace
BEFORE INSERT ON control_gate_events
WHEN EXISTS (SELECT 1 FROM control_gate_events WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'control_gate_events is append-only: duplicate id insert not allowed');
END;
