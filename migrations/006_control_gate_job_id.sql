-- Personal Agent — migration 006_control_gate_job_id.
--
-- Adds job_id attribution to control_gate_events rows.
-- Resolves GitHub issue #45.
--
-- Purely additive: one ALTER TABLE ADD COLUMN + one partial UNIQUE index.
-- Existing rows get job_id = NULL (nullable — rows written before
-- this migration have no job context).
--
-- Upgrade-boundary note: jobs that wrote a gate row under schema 5
-- (job_id = NULL) and are retried after this migration will insert a
-- new row with job_id set; the old NULL row does not conflict.
-- The application checks for in-flight provider_run jobs at boot time
-- (before migrate()) and aborts with an error if any are found in
-- running/queued state. See src/main.ts assertNoPendingProviderRunsBeforeMigration006().

ALTER TABLE control_gate_events
  ADD COLUMN job_id TEXT;

-- Partial unique index: enforces one turn-phase row per job.
-- Rows where job_id IS NULL or phase != 'turn' are not constrained.
CREATE UNIQUE INDEX IF NOT EXISTS idx_control_gate_events_job_turn
  ON control_gate_events(job_id)
  WHERE job_id IS NOT NULL AND phase = 'turn';

-- Non-unique lookup index for other phases.
CREATE INDEX IF NOT EXISTS idx_control_gate_events_job_id
  ON control_gate_events(job_id) WHERE job_id IS NOT NULL;
