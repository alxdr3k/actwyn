-- Personal Agent P0 — migration 002_artifacts.
--
-- storage_objects and memory_artifact_links per PRD Appendix D.
-- Kept separate from 001_init so attachment schema can evolve
-- without touching the job ledger.
--
-- The two-phase attachment flow (PRD §13.5) is encoded at the
-- schema level:
--   * capture_status ∈ {pending, captured, failed}
--   * status (sync) meaningful only when capture_status='captured'
-- The CHECK constraints reject values outside these enums. Cross-
-- column invariants (e.g. "status transitions only when captured")
-- live in code + invariant tests, not in triggers.

-- ---------------------------------------------------------------
-- storage_objects
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS storage_objects (
  id                              TEXT PRIMARY KEY,
  storage_backend                 TEXT    NOT NULL
                                          CHECK (storage_backend IN ('s3', 'local')),
  bucket                          TEXT,
  storage_key                     TEXT    NOT NULL,
  original_filename_redacted      TEXT,
  mime_type                       TEXT,
  size_bytes                      INTEGER,
  sha256                          TEXT,
  source_channel                  TEXT    NOT NULL
                                          CHECK (source_channel IN ('telegram', 'provider', 'system')),
  source_turn_id                  TEXT,
  source_message_id               TEXT,
  source_job_id                   TEXT,
  source_external_id              TEXT,
  artifact_type                   TEXT    NOT NULL
                                          CHECK (artifact_type IN (
                                            'user_upload', 'generated_artifact',
                                            'redacted_provider_transcript',
                                            'conversation_transcript',
                                            'memory_snapshot', 'parser_fixture', 'other')),
  retention_class                 TEXT    NOT NULL
                                          CHECK (retention_class IN ('ephemeral', 'session', 'long_term', 'archive')),
  visibility                      TEXT    NOT NULL DEFAULT 'private'
                                          CHECK (visibility IN ('private')),
  capture_status                  TEXT    NOT NULL
                                          CHECK (capture_status IN ('pending', 'captured', 'failed')),
  status                          TEXT    NOT NULL
                                          CHECK (status IN (
                                            'pending', 'uploaded', 'failed',
                                            'deletion_requested', 'deleted', 'delete_failed')),
  created_at                      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  captured_at                     TEXT,
  uploaded_at                     TEXT,
  deleted_at                      TEXT,
  capture_error_json              TEXT,
  error_json                      TEXT,
  FOREIGN KEY (source_turn_id) REFERENCES turns(id),
  FOREIGN KEY (source_job_id)  REFERENCES jobs(id)
) WITHOUT ROWID;

-- PRD Appendix D: storage_key is unique within (storage_backend, bucket).
-- SQLite treats NULL as distinct in UNIQUE indices, which is what we
-- want for storage_backend='local' rows where bucket is NULL.
CREATE UNIQUE INDEX IF NOT EXISTS ux_storage_objects_backend_bucket_key
  ON storage_objects(storage_backend, bucket, storage_key);

CREATE INDEX IF NOT EXISTS idx_storage_objects_capture_status
  ON storage_objects(capture_status);

CREATE INDEX IF NOT EXISTS idx_storage_objects_status
  ON storage_objects(status);

CREATE INDEX IF NOT EXISTS idx_storage_objects_source_job
  ON storage_objects(source_job_id)
  WHERE source_job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_storage_objects_retention
  ON storage_objects(retention_class, status);

-- ---------------------------------------------------------------
-- memory_artifact_links
-- Attaches meaning to an artifact. At least one of
-- memory_summary_id or turn_id MUST be set; enforced by CHECK.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_artifact_links (
  id                      TEXT PRIMARY KEY,
  memory_summary_id       TEXT,
  turn_id                 TEXT,
  storage_object_id       TEXT    NOT NULL,
  relation_type           TEXT    NOT NULL
                                  CHECK (relation_type IN (
                                    'evidence', 'attachment', 'generated_output',
                                    'reference', 'source')),
  caption_or_summary      TEXT,
  provenance              TEXT    NOT NULL
                                  CHECK (provenance IN ('user_stated', 'user_confirmed', 'observed', 'inferred', 'tool_output', 'assistant_generated')),
  confidence              REAL
                          CHECK (confidence IS NULL OR (confidence >= 0.0 AND confidence <= 1.0)),
  created_at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (memory_summary_id IS NOT NULL OR turn_id IS NOT NULL),
  FOREIGN KEY (memory_summary_id) REFERENCES memory_summaries(id),
  FOREIGN KEY (turn_id)           REFERENCES turns(id),
  FOREIGN KEY (storage_object_id) REFERENCES storage_objects(id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_memory_artifact_links_memory
  ON memory_artifact_links(memory_summary_id)
  WHERE memory_summary_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_memory_artifact_links_turn
  ON memory_artifact_links(turn_id)
  WHERE turn_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_memory_artifact_links_storage
  ON memory_artifact_links(storage_object_id);
