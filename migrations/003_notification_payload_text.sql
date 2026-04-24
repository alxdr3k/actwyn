-- Personal Agent P0 — migration 003_notification_payload_text.
--
-- Add payload_text column to outbound_notifications so the
-- notification_retry job can reconstruct chunk texts without
-- relying on the owning job's assistant turn (which does not
-- exist for job_accepted, recovery, or system-command
-- notifications).
--
-- The column is nullable to remain compatible with rows already
-- written by earlier code; the retry path falls back to the
-- assistant-turn heuristic when payload_text IS NULL.

ALTER TABLE outbound_notifications
  ADD COLUMN payload_text TEXT;
