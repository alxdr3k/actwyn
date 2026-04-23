-- Personal Agent P0 — migration 001_init.
--
-- Creates the base tables defined in PRD Appendix D *except*
-- storage_objects / memory_artifact_links, which live in
-- migration 002_artifacts.sql (so attachment schema can evolve
-- independently of job-ledger schema).
--
-- Indices listed are those called out in HLD §5.1 writer map and
-- §5.3 idempotency keys, plus any uniqueness required by the
-- state-machine invariants in HLD §6.
--
-- Foreign keys are declared but NOT relied on as an enforcement
-- mechanism. `PRAGMA foreign_keys = ON` is set by `src/db.ts` at
-- open-time; tests verify that the cascade path is legal.
--
-- CHECK constraints encode the enum surfaces (PRD Appendix D
-- `status`/`role`/etc.) so the DB rejects values that would
-- bypass the state machines at the writer layer.

-- ---------------------------------------------------------------
-- allowed_users
-- Config-driven (HLD §5.1). Not mutated at runtime. In P0 this
-- typically contains exactly one row for the solo user.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS allowed_users (
  user_id         TEXT PRIMARY KEY,
  note            TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) WITHOUT ROWID;

-- ---------------------------------------------------------------
-- settings
-- Opaque key/value store. `telegram_next_offset` lives here and is
-- written only by telegram/poller (HLD §5.1, §9.5).
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  key             TEXT PRIMARY KEY,
  value           TEXT NOT NULL,
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) WITHOUT ROWID;

-- ---------------------------------------------------------------
-- telegram_updates
-- PRD Appendix D. `update_id` is the unique idempotency key that
-- makes re-delivery of the same Telegram update a no-op.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS telegram_updates (
  update_id                   INTEGER PRIMARY KEY,
  chat_id                     TEXT,
  user_id                     TEXT,
  update_type                 TEXT,
  status                      TEXT    NOT NULL
                                      CHECK (status IN ('received', 'enqueued', 'skipped', 'failed')),
  skip_reason                 TEXT,
  job_id                      TEXT,
  raw_update_json_redacted    TEXT    NOT NULL,
  created_at                  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  processed_at                TEXT
);

CREATE INDEX IF NOT EXISTS idx_telegram_updates_status
  ON telegram_updates(status);

CREATE INDEX IF NOT EXISTS idx_telegram_updates_job_id
  ON telegram_updates(job_id) WHERE job_id IS NOT NULL;

-- ---------------------------------------------------------------
-- sessions
-- One chat session per user-visible "conversation window". A new
-- session is created on first inbound after /end or on cold boot.
-- HLD §5.2 invariant 7 requires turns.session_id and
-- memory_summaries.session_id to resolve here.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,
  chat_id         TEXT    NOT NULL,
  user_id         TEXT    NOT NULL,
  project_id      TEXT,
  status          TEXT    NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'ended')),
  started_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ended_at        TEXT
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_sessions_chat_status
  ON sessions(chat_id, status);

-- ---------------------------------------------------------------
-- jobs
-- PRD Appendix D. `(job_type, idempotency_key)` is globally
-- unique — HLD §5.3 lists the five deterministic key shapes.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jobs (
  id                TEXT PRIMARY KEY,
  status            TEXT    NOT NULL
                            CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted')),
  job_type          TEXT    NOT NULL
                            CHECK (job_type IN ('provider_run', 'summary_generation', 'storage_sync', 'notification_retry')),
  priority          INTEGER NOT NULL DEFAULT 0,
  scheduled_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_at        TEXT,
  finished_at       TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0,
  max_attempts      INTEGER NOT NULL DEFAULT 1,
  provider          TEXT,
  session_id        TEXT,
  user_id           TEXT,
  chat_id           TEXT,
  request_json      TEXT    NOT NULL,
  result_json       TEXT,
  error_json        TEXT,
  idempotency_key   TEXT    NOT NULL,
  safe_retry        INTEGER NOT NULL DEFAULT 0
                            CHECK (safe_retry IN (0, 1)),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
) WITHOUT ROWID;

CREATE UNIQUE INDEX IF NOT EXISTS ux_jobs_job_type_idem_key
  ON jobs(job_type, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_jobs_status_sched
  ON jobs(status, scheduled_at);

CREATE INDEX IF NOT EXISTS idx_jobs_session
  ON jobs(session_id) WHERE session_id IS NOT NULL;

-- ---------------------------------------------------------------
-- provider_runs
-- One row per provider subprocess execution (HLD §5.2 invariant 8:
-- one jobs row may own multiple provider_runs over its lifetime,
-- e.g. a failed resume + a replay_mode retry).
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS provider_runs (
  id                          TEXT PRIMARY KEY,
  job_id                      TEXT    NOT NULL,
  session_id                  TEXT    NOT NULL,
  provider                    TEXT    NOT NULL
                                      CHECK (provider IN ('claude', 'fake')),
  provider_session_id         TEXT,
  context_packing_mode        TEXT    NOT NULL
                                      CHECK (context_packing_mode IN ('resume_mode', 'replay_mode')),
  status                      TEXT    NOT NULL
                                      CHECK (status IN ('started', 'succeeded', 'failed', 'cancelled', 'interrupted')),
  argv_json_redacted          TEXT    NOT NULL,
  cwd                         TEXT    NOT NULL,
  process_id                  INTEGER,
  process_group_id            INTEGER,
  provider_version            TEXT,
  injected_snapshot_json      TEXT    NOT NULL,
  usage_json                  TEXT,
  parser_status               TEXT    NOT NULL
                                      CHECK (parser_status IN ('parsed', 'fallback_used', 'parse_error')),
  error_type                  TEXT,
  started_at                  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at                 TEXT,
  FOREIGN KEY (job_id)     REFERENCES jobs(id),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_provider_runs_job
  ON provider_runs(job_id);

CREATE INDEX IF NOT EXISTS idx_provider_runs_session
  ON provider_runs(session_id);

-- ---------------------------------------------------------------
-- provider_raw_events
-- One row per redacted line emitted by the provider subprocess.
-- (event_index, provider_run_id) is the natural ordering.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS provider_raw_events (
  id                  TEXT PRIMARY KEY,
  provider_run_id     TEXT    NOT NULL,
  event_index         INTEGER NOT NULL,
  stream              TEXT    NOT NULL
                              CHECK (stream IN ('stdout', 'stderr')),
  redacted_payload    TEXT    NOT NULL,
  redaction_applied   INTEGER NOT NULL
                              CHECK (redaction_applied IN (0, 1)),
  parser_status       TEXT    NOT NULL
                              CHECK (parser_status IN ('unparsed', 'parsed', 'fallback_used', 'parse_error')),
  created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (provider_run_id) REFERENCES provider_runs(id)
) WITHOUT ROWID;

CREATE UNIQUE INDEX IF NOT EXISTS ux_provider_raw_events_run_idx
  ON provider_raw_events(provider_run_id, event_index);

-- ---------------------------------------------------------------
-- turns
-- One row per user/assistant/system turn. `role = 'assistant'`
-- rows satisfying HLD §5.2 invariant 3 are the authoritative
-- transcript. `content_redacted` is ALWAYS the output of
-- observability/redact; raw content never reaches this table.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS turns (
  id                  TEXT PRIMARY KEY,
  session_id          TEXT    NOT NULL,
  job_id              TEXT,
  provider_run_id     TEXT,
  role                TEXT    NOT NULL
                              CHECK (role IN ('user', 'assistant', 'system')),
  content_redacted    TEXT    NOT NULL,
  redaction_applied   INTEGER NOT NULL
                              CHECK (redaction_applied IN (0, 1)),
  created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (session_id)      REFERENCES sessions(id),
  FOREIGN KEY (job_id)          REFERENCES jobs(id),
  FOREIGN KEY (provider_run_id) REFERENCES provider_runs(id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_turns_session_created
  ON turns(session_id, created_at);

CREATE INDEX IF NOT EXISTS idx_turns_job
  ON turns(job_id) WHERE job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_turns_role
  ON turns(role);

-- ---------------------------------------------------------------
-- outbound_notifications
-- Roll-up row; one per logical notification. Per-chunk ledger
-- lives in outbound_notification_chunks below.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outbound_notifications (
  id                          TEXT PRIMARY KEY,
  job_id                      TEXT    NOT NULL,
  chat_id                     TEXT    NOT NULL,
  notification_type           TEXT    NOT NULL
                                      CHECK (notification_type IN (
                                        'job_accepted', 'job_completed', 'job_failed',
                                        'job_cancelled', 'summary', 'doctor')),
  payload_hash                TEXT    NOT NULL,
  chunk_count                 INTEGER NOT NULL CHECK (chunk_count >= 1),
  status                      TEXT    NOT NULL
                                      CHECK (status IN ('pending', 'sent', 'failed')),
  telegram_message_ids_json   TEXT,
  attempt_count               INTEGER NOT NULL DEFAULT 0,
  error_json                  TEXT,
  created_at                  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  sent_at                     TEXT,
  FOREIGN KEY (job_id) REFERENCES jobs(id)
) WITHOUT ROWID;

-- HLD §6.3 duplicate prevention (best-effort) key.
CREATE UNIQUE INDEX IF NOT EXISTS ux_outbound_notifications_dedupe
  ON outbound_notifications(job_id, notification_type, payload_hash);

CREATE INDEX IF NOT EXISTS idx_outbound_notifications_status
  ON outbound_notifications(status);

-- ---------------------------------------------------------------
-- outbound_notification_chunks
-- One row per physical Telegram message. Chunk 3 failing must not
-- cause chunks 1–2 to resend; the retry pass selects rows with
-- status IN ('pending', 'failed') (PRD Appendix D invariants).
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outbound_notification_chunks (
  id                          TEXT PRIMARY KEY,
  outbound_notification_id    TEXT    NOT NULL,
  chunk_index                 INTEGER NOT NULL CHECK (chunk_index >= 1),
  chunk_count                 INTEGER NOT NULL CHECK (chunk_count >= 1),
  payload_text_hash           TEXT    NOT NULL,
  status                      TEXT    NOT NULL
                                      CHECK (status IN ('pending', 'sent', 'failed')),
  telegram_message_id         TEXT,
  attempt_count               INTEGER NOT NULL DEFAULT 0,
  error_json                  TEXT,
  sent_at                     TEXT,
  created_at                  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (outbound_notification_id) REFERENCES outbound_notifications(id)
) WITHOUT ROWID;

CREATE UNIQUE INDEX IF NOT EXISTS ux_chunks_notification_index
  ON outbound_notification_chunks(outbound_notification_id, chunk_index);

CREATE INDEX IF NOT EXISTS idx_chunks_status
  ON outbound_notification_chunks(status);

-- ---------------------------------------------------------------
-- memory_summaries
-- Session/project-level summary snapshots. Appendix D columns.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_summaries (
  id                  TEXT PRIMARY KEY,
  session_id          TEXT    NOT NULL,
  summary_type        TEXT    NOT NULL
                              CHECK (summary_type IN ('session', 'project', 'daily')),
  facts_json          TEXT,
  preferences_json    TEXT,
  open_tasks_json     TEXT,
  decisions_json      TEXT,
  cautions_json       TEXT,
  provenance_json     TEXT,
  confidence_json     TEXT,
  source_turn_ids     TEXT,
  created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  storage_key         TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_memory_summaries_session_created
  ON memory_summaries(session_id, created_at);

-- ---------------------------------------------------------------
-- memory_items
-- Atomic memory rows with explicit supersede semantics.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_items (
  id                      TEXT PRIMARY KEY,
  session_id              TEXT    NOT NULL,
  project_id              TEXT,
  item_type               TEXT    NOT NULL
                                  CHECK (item_type IN ('fact', 'preference', 'decision', 'open_task', 'caution')),
  content                 TEXT    NOT NULL,
  content_json            TEXT,
  provenance              TEXT    NOT NULL
                                  CHECK (provenance IN ('user_stated', 'user_confirmed', 'observed', 'inferred', 'tool_output', 'assistant_generated')),
  confidence              REAL    NOT NULL
                                  CHECK (confidence >= 0.0 AND confidence <= 1.0),
  status                  TEXT    NOT NULL
                                  CHECK (status IN ('active', 'superseded', 'revoked')),
  supersedes_memory_id    TEXT,
  source_turn_ids         TEXT    NOT NULL,
  created_at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  status_changed_at       TEXT,
  FOREIGN KEY (session_id)           REFERENCES sessions(id),
  FOREIGN KEY (supersedes_memory_id) REFERENCES memory_items(id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_memory_items_session_status
  ON memory_items(session_id, status);

CREATE INDEX IF NOT EXISTS idx_memory_items_supersedes
  ON memory_items(supersedes_memory_id)
  WHERE supersedes_memory_id IS NOT NULL;
