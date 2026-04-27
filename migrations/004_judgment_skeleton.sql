-- Personal Agent — migration 004_judgment_skeleton.
--
-- Phase 1A.1 schema-only addition for the DB-native AI-first
-- Judgment System direction (ADR-0009 .. ADR-0013 +
-- docs/JUDGMENT_SYSTEM.md). This migration is purely additive —
-- no existing table is altered, no existing row is touched.
--
-- Decisions reflected (DEC-### in docs/08_DECISION_REGISTER.md):
--   * DEC-023 — `judgment_items.kind` P0.5 enum: 6 values
--               (fact / preference / decision / current_state /
--               procedure / caution).
--   * DEC-027 — `decay_policy` P0.5 enum: 2 values (`none`,
--               `supersede_only`). The remaining 3
--               (time_decay / verification_decay / event_driven)
--               are P1+.
--   * DEC-028 — `ontology_version` and `schema_version` are
--               mandatory (NOT NULL) on every judgment_items row.
--   * DEC-029 — `authority_source` P0.5 enum: 2 values (`none`,
--               `user_confirmed`). `system_authored` /
--               `maintainer_approved` etc. are P1+.
--   * DEC-033 — 3-axis status surface: lifecycle_status /
--               activation_state / retention_state. The legacy
--               single `status` column is intentionally absent.
--   * DEC-034 — `procedure_subtype` 5-enum
--               (skill / policy / preference_adaptation /
--               safety_rule / workflow_rule). Default `skill`
--               applied at the application layer when `kind =
--               'procedure'`; the column itself is nullable here
--               because most rows are not procedures.
--
-- Rowid + FTS5 design choice
-- ---------------------------------------------------------------
-- SQLite external-content FTS5 (`content='judgment_items'`,
-- `content_rowid='rowid'`) requires the content table to expose a
-- usable rowid. A `WITHOUT ROWID` table cannot be used as the
-- content table.
--
-- We declare `judgment_items` with `id TEXT PRIMARY KEY` and
-- *without* the `WITHOUT ROWID` clause. SQLite therefore gives
-- the table an implicit auto-rowid that the FTS5 virtual table
-- can index against, while `id` remains the application-facing
-- primary key.
--
-- The four sibling tables (`judgment_sources`,
-- `judgment_evidence_links`, `judgment_edges`, `judgment_events`)
-- are not FTS-content sources, so they keep the project's
-- existing `WITHOUT ROWID` style for parity with 001_init.
--
-- The three triggers below (insert / update / delete) keep
-- `judgment_items_fts` in sync with `judgment_items.statement`
-- under the standard external-content pattern documented at
-- https://www.sqlite.org/fts5.html#external_content_tables.
--
-- Out of scope for this migration (deferred to a separate
-- Phase 1A PR):
--   * control_plane_events / control_gate_events
--   * tensions
--   * reflection_triage_events
--   * any migration of memory_items / memory_summaries data into
--     judgment_items (Q-027 stays open; ADR-0009 commits to the
--     "분리" starting point and Phase 1A.1 keeps memory and
--     judgment as separate tables).

-- ---------------------------------------------------------------
-- judgment_sources
--
-- One row per ingested source from which one or more
-- `judgment_items` may be derived. `kind` is intentionally left
-- without a CHECK because the source-kind taxonomy is still
-- emerging in Phase 1A — we do not want every new ingestion path
-- (turn / attachment / external_url / tool_output / manual /
-- ...) to require a schema migration.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS judgment_sources (
  id              TEXT PRIMARY KEY,
  kind            TEXT    NOT NULL,
  locator         TEXT    NOT NULL,
  content_hash    TEXT,
  trust_level     TEXT    NOT NULL DEFAULT 'medium'
                          CHECK (trust_level IN ('low', 'medium', 'high')),
  redacted        INTEGER NOT NULL DEFAULT 1
                          CHECK (redacted IN (0, 1)),
  captured_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_judgment_sources_kind
  ON judgment_sources(kind);

-- ---------------------------------------------------------------
-- judgment_items
--
-- The core row of the Judgment System. Shape follows
-- docs/JUDGMENT_SYSTEM.md §SQL schema sketch (P0.5) plus the
-- P0.5 enum subsets cited above.
--
-- NOTE: this table deliberately does NOT use `WITHOUT ROWID`
-- because the `judgment_items_fts` external-content FTS5 virtual
-- table needs a stable rowid on the content table. See header
-- comment for the full rationale.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS judgment_items (
  id                   TEXT PRIMARY KEY,

  kind                 TEXT    NOT NULL
                               CHECK (kind IN (
                                 'fact', 'preference', 'decision',
                                 'current_state', 'procedure', 'caution')),
  scope_json           TEXT    NOT NULL
                               CHECK (json_valid(scope_json)),
  statement            TEXT    NOT NULL
                               CHECK (length(statement) > 0),

  -- Origin axis (ADR-0012, ADR-0013): "where did this content
  -- come from?". `decided` / `deprecated` / `system_authored`
  -- belong to other axes.
  epistemic_origin     TEXT    NOT NULL
                               CHECK (epistemic_origin IN (
                                 'observed', 'user_stated', 'user_confirmed',
                                 'inferred', 'assistant_generated', 'tool_output')),

  -- Authority axis (ADR-0012). P0.5 subset per DEC-029.
  authority_source     TEXT    NOT NULL DEFAULT 'none'
                               CHECK (authority_source IN ('none', 'user_confirmed')),

  -- Approval workflow only (ADR-0013). `active` / `proposed` /
  -- `accepted` belong to lifecycle_status.
  approval_state       TEXT    NOT NULL DEFAULT 'pending'
                               CHECK (approval_state IN (
                                 'not_required', 'pending', 'approved', 'rejected')),
  approved_by          TEXT,
  approved_at          TEXT,

  -- 3-axis status surface (ADR-0013, DEC-033).
  lifecycle_status     TEXT    NOT NULL DEFAULT 'proposed'
                               CHECK (lifecycle_status IN (
                                 'proposed', 'active', 'rejected',
                                 'revoked', 'superseded', 'expired')),
  activation_state     TEXT    NOT NULL DEFAULT 'eligible'
                               CHECK (activation_state IN (
                                 'eligible', 'history_only', 'excluded')),
  retention_state      TEXT    NOT NULL DEFAULT 'normal'
                               CHECK (retention_state IN (
                                 'normal', 'archived', 'deleted')),

  confidence           TEXT    NOT NULL DEFAULT 'medium'
                               CHECK (confidence IN ('low', 'medium', 'high')),
  importance           INTEGER NOT NULL DEFAULT 3
                               CHECK (importance BETWEEN 1 AND 5),

  -- Decay policy (ADR-0011, DEC-027). P0.5 subset.
  decay_policy         TEXT    NOT NULL DEFAULT 'supersede_only'
                               CHECK (decay_policy IN ('none', 'supersede_only')),

  -- Volatility hint (ADR-0011). Nullable in P0.5; resolved
  -- against kind/domain defaults at the validator layer (Q-041).
  -- No CHECK — vocabulary still emerging.
  volatility           TEXT,

  -- Versioning (ADR-0011, DEC-028). ontology + schema mandatory.
  ontology_version     TEXT    NOT NULL,
  schema_version       TEXT    NOT NULL,
  policy_version       TEXT,
  projection_version   TEXT,

  -- Procedure-only subtype (DEC-034). Nullable; if set, must be
  -- one of the 5 P0.5 values. Application layer enforces the
  -- "default 'skill' when kind='procedure'" rule.
  procedure_subtype    TEXT
                       CHECK (procedure_subtype IS NULL
                              OR procedure_subtype IN (
                                'skill', 'policy', 'preference_adaptation',
                                'safety_rule', 'workflow_rule')),

  -- Time fields (ADR-0011 §시간 필드 8개). created_at /
  -- updated_at are mandatory; the rest are nullable.
  created_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  observed_at          TEXT,
  valid_from           TEXT,
  valid_until          TEXT,
  revisit_at           TEXT,
  last_verified_at     TEXT,
  last_used_at         TEXT,
  last_relevant_at     TEXT,

  -- Relation arrays as JSON (SQLite simplicity). Each column is
  -- nullable; when non-null, must be valid JSON.
  source_ids_json      TEXT
                       CHECK (source_ids_json IS NULL OR json_valid(source_ids_json)),
  evidence_ids_json    TEXT
                       CHECK (evidence_ids_json IS NULL OR json_valid(evidence_ids_json)),
  supersedes_json      TEXT
                       CHECK (supersedes_json IS NULL OR json_valid(supersedes_json)),
  superseded_by_json   TEXT
                       CHECK (superseded_by_json IS NULL OR json_valid(superseded_by_json)),

  -- Metacognitive fields (ADR-0010). Optional in P0.5.
  would_change_if_json  TEXT
                        CHECK (would_change_if_json IS NULL OR json_valid(would_change_if_json)),
  missing_evidence_json TEXT
                        CHECK (missing_evidence_json IS NULL OR json_valid(missing_evidence_json)),
  review_trigger_json   TEXT
                        CHECK (review_trigger_json IS NULL OR json_valid(review_trigger_json))
);
-- NOTE: no `WITHOUT ROWID` here — see header comment (FTS5).

CREATE INDEX IF NOT EXISTS idx_judgment_items_kind
  ON judgment_items(kind);
CREATE INDEX IF NOT EXISTS idx_judgment_items_lifecycle_status
  ON judgment_items(lifecycle_status);
CREATE INDEX IF NOT EXISTS idx_judgment_items_activation_state
  ON judgment_items(activation_state);
CREATE INDEX IF NOT EXISTS idx_judgment_items_retention_state
  ON judgment_items(retention_state);
CREATE INDEX IF NOT EXISTS idx_judgment_items_authority_source
  ON judgment_items(authority_source);
CREATE INDEX IF NOT EXISTS idx_judgment_items_approval_state
  ON judgment_items(approval_state);
CREATE INDEX IF NOT EXISTS idx_judgment_items_created_at
  ON judgment_items(created_at);
CREATE INDEX IF NOT EXISTS idx_judgment_items_updated_at
  ON judgment_items(updated_at);
CREATE INDEX IF NOT EXISTS idx_judgment_items_revisit_at
  ON judgment_items(revisit_at) WHERE revisit_at IS NOT NULL;

-- ---------------------------------------------------------------
-- judgment_evidence_links
--
-- Many-to-many link between a judgment and the source rows that
-- support it. `relation` vocabulary (supports / refutes /
-- contextualizes / ...) is still emerging — no CHECK in P0.5.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS judgment_evidence_links (
  id              TEXT PRIMARY KEY,
  judgment_id     TEXT    NOT NULL,
  source_id       TEXT    NOT NULL,
  relation        TEXT    NOT NULL,
  span_locator    TEXT,
  quote_excerpt   TEXT,
  rationale       TEXT,
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (judgment_id) REFERENCES judgment_items(id),
  FOREIGN KEY (source_id)   REFERENCES judgment_sources(id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_judgment_evidence_links_judgment
  ON judgment_evidence_links(judgment_id);
CREATE INDEX IF NOT EXISTS idx_judgment_evidence_links_source
  ON judgment_evidence_links(source_id);

-- ---------------------------------------------------------------
-- judgment_edges
--
-- Typed relations between two judgments (supports / contradicts /
-- refines / ...). Open vocabulary in P0.5.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS judgment_edges (
  id                  TEXT PRIMARY KEY,
  from_judgment_id    TEXT    NOT NULL,
  to_judgment_id      TEXT    NOT NULL,
  relation            TEXT    NOT NULL,
  created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (from_judgment_id) REFERENCES judgment_items(id),
  FOREIGN KEY (to_judgment_id)   REFERENCES judgment_items(id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_judgment_edges_from
  ON judgment_edges(from_judgment_id);
CREATE INDEX IF NOT EXISTS idx_judgment_edges_to
  ON judgment_edges(to_judgment_id);

-- ---------------------------------------------------------------
-- judgment_events
--
-- Append-only event log for judgment lifecycle changes. Some
-- events are not tied to a specific judgment row, so
-- `judgment_id` is nullable. `event_type` vocabulary is open.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS judgment_events (
  id              TEXT PRIMARY KEY,
  event_type      TEXT    NOT NULL,
  judgment_id     TEXT,
  payload_json    TEXT    NOT NULL CHECK (json_valid(payload_json)),
  actor           TEXT    NOT NULL,
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (judgment_id) REFERENCES judgment_items(id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_judgment_events_judgment
  ON judgment_events(judgment_id) WHERE judgment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_judgment_events_created_at
  ON judgment_events(created_at);

-- ---------------------------------------------------------------
-- judgment_items_fts (FTS5 virtual table over `statement`)
--
-- External-content table backed by `judgment_items.rowid`. The
-- three triggers below keep the FTS index consistent with the
-- content table on every INSERT / UPDATE / DELETE.
-- ---------------------------------------------------------------
CREATE VIRTUAL TABLE IF NOT EXISTS judgment_items_fts
  USING fts5(statement, content='judgment_items', content_rowid='rowid', tokenize='unicode61');

CREATE TRIGGER IF NOT EXISTS judgment_items_fts_ai
AFTER INSERT ON judgment_items BEGIN
  INSERT INTO judgment_items_fts(rowid, statement)
  VALUES (new.rowid, new.statement);
END;

CREATE TRIGGER IF NOT EXISTS judgment_items_fts_ad
AFTER DELETE ON judgment_items BEGIN
  INSERT INTO judgment_items_fts(judgment_items_fts, rowid, statement)
  VALUES ('delete', old.rowid, old.statement);
END;

CREATE TRIGGER IF NOT EXISTS judgment_items_fts_au
AFTER UPDATE ON judgment_items BEGIN
  INSERT INTO judgment_items_fts(judgment_items_fts, rowid, statement)
  VALUES ('delete', old.rowid, old.statement);
  INSERT INTO judgment_items_fts(rowid, statement)
  VALUES (new.rowid, new.statement);
END;
