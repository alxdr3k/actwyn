// Personal Agent P0 — storage sync worker.
//
// Spec references:
//   - PRD §12.8, §14.1 storage_sync query contract
//   - HLD §4.8, §6.4, §7.6, §12 (sync state machine + error
//     classification)
//   - AC-STO-002 / AC-STO-006 (storage failure does NOT roll back
//     owning provider_run)
//
// Responsibilities:
//   1. pending → uploaded: find storage_objects rows with
//      capture_status='captured' AND status='pending' AND
//      retention_class ∈ {long_term, archive}, read their local
//      bytes, and PUT to S3.
//   2. failed → pending: retry scheduler moves eligible `failed`
//      rows back to `pending` so they are picked up on the next
//      sync pass (HLD §6.4, HLD §4.8 invariant 2).
//   3. deletion_requested → deleted|delete_failed: DELETE to S3.
//
// Error classification (HLD §12.3):
//   - S3TransportError.category === 'retryable':  pending → failed
//   - S3TransportError.category === 'non_retryable': pending → failed
//     (same state; distinction is that operator decides when /
//     whether to re-queue. In P0 we surface both via /doctor and
//     apply max_attempts.)
//
// The sync worker never touches provider_runs.status or jobs.status.

import type { DbHandle } from "~/db.ts";
import type { EventEmitter } from "~/observability/events.ts";
import { localExists, readLocal, removeLocal } from "~/storage/local.ts";
import type { S3Transport } from "~/storage/s3.ts";
import { S3TransportError } from "~/storage/s3.ts";

export interface SyncConfig {
  readonly max_attempts: number;
  /** Map storage_object_id → local path (same mapping used at capture time). */
  readonly local_path: (storage_object_id: string) => string;
}

export interface SyncDeps {
  readonly db: DbHandle;
  readonly transport: S3Transport;
  readonly events?: EventEmitter | undefined;
  readonly config: SyncConfig;
}

interface EligibleUploadRow {
  id: string;
  storage_backend: string;
  bucket: string | null;
  storage_key: string;
  retention_class: string;
  mime_type: string | null;
  error_json: string | null;
  attempt_count_json: string | null;
}

interface EligibleDeletionRow {
  id: string;
  bucket: string | null;
  storage_key: string;
  storage_backend: string;
}

// ---------------------------------------------------------------
// Query contract (PRD §14.1): eligible = captured AND retention
// S3-eligible AND status='pending'. artifact_type filter guards
// against syncing metadata-only row types.
// ---------------------------------------------------------------

export function selectEligibleUploads(db: DbHandle): EligibleUploadRow[] {
  return db
    .prepare<EligibleUploadRow, []>(
      `SELECT id, storage_backend, bucket, storage_key, retention_class,
              mime_type, error_json,
              NULL AS attempt_count_json
       FROM storage_objects
       WHERE capture_status = 'captured'
         AND status = 'pending'
         AND retention_class IN ('long_term', 'archive')
         AND storage_backend = 's3'
         AND artifact_type IN
           ('user_upload', 'generated_artifact', 'redacted_provider_transcript',
            'conversation_transcript', 'memory_snapshot', 'parser_fixture')`,
    )
    .all();
}

export function selectEligibleDeletions(db: DbHandle): EligibleDeletionRow[] {
  return db
    .prepare<EligibleDeletionRow, []>(
      `SELECT id, bucket, storage_key, storage_backend
       FROM storage_objects
       WHERE status = 'deletion_requested'`,
    )
    .all();
}

// ---------------------------------------------------------------
// Upload pass: pending → uploaded OR pending → failed.
// ---------------------------------------------------------------

export interface UploadPassResult {
  readonly attempted: number;
  readonly uploaded: number;
  readonly failed: number;
  readonly local_missing: number;
}

export async function runUploadPass(deps: SyncDeps): Promise<UploadPassResult> {
  const rows = selectEligibleUploads(deps.db);
  let uploaded = 0;
  let failed = 0;
  let local_missing = 0;

  for (const row of rows) {
    if (row.storage_backend !== "s3" || row.bucket === null) {
      markUploadFailed(deps, row.id, "not_s3_eligible");
      failed += 1;
      continue;
    }
    const path = deps.config.local_path(row.id);
    if (!localExists(path)) {
      markUploadFailed(deps, row.id, "local_missing");
      local_missing += 1;
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = readLocal(path);
    } catch (e) {
      markUploadFailed(deps, row.id, `local_read_failed:${(e as Error).message}`);
      failed += 1;
      continue;
    }
    try {
      await deps.transport.put({
        bucket: row.bucket,
        key: row.storage_key,
        bytes,
        ...(row.mime_type ? { content_type: row.mime_type } : {}),
      });
      markUploaded(deps, row.id);
      uploaded += 1;
    } catch (e) {
      const cat = e instanceof S3TransportError ? e.category : "retryable";
      markUploadFailed(deps, row.id, `${cat}:${(e as Error).message}`);
      failed += 1;
    }
  }

  return { attempted: rows.length, uploaded, failed, local_missing };
}

function markUploaded(deps: SyncDeps, id: string): void {
  deps.db.prepare<unknown, [string]>(
    `UPDATE storage_objects
     SET status = 'uploaded',
         uploaded_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
         error_json = NULL
     WHERE id = ? AND status = 'pending'`,
  ).run(id);
  deps.events?.info("storage.sync.uploaded", { storage_object_id: id });
}

function markUploadFailed(deps: SyncDeps, id: string, detail: string): void {
  // `attempts` counts total upload attempts on this row. Incremented
  // here (not in the scheduler), so exhaustion semantics are:
  //   attempts >= max_attempts → exhausted, scheduler will NOT re-pend.
  const existing = deps.db
    .prepare<{ error_json: string | null }, [string]>(
      "SELECT error_json FROM storage_objects WHERE id = ?",
    )
    .get(id);
  const attempts = parseAttempts(existing?.error_json ?? null) + 1;
  const error_json = JSON.stringify({
    detail,
    ts: new Date().toISOString(),
    attempts,
  });
  deps.db.prepare<unknown, [string, string]>(
    `UPDATE storage_objects
     SET status = 'failed',
         error_json = ?
     WHERE id = ? AND status = 'pending'`,
  ).run(error_json, id);
  deps.events?.warn("storage.sync.upload_failed", {
    storage_object_id: id,
    detail,
    attempts,
  });
}

// ---------------------------------------------------------------
// Retry scheduler: failed → pending for rows under max_attempts.
// Uses a per-row counter embedded in error_json.attempts.
// ---------------------------------------------------------------

export function runRetryScheduler(deps: SyncDeps): { repended: number; exhausted: number } {
  // Bump each failed row back to pending ONCE per scheduler tick.
  // Callers typically call this every N seconds; the next sync pass
  // then attempts them. Exhaustion policy is applied before the
  // flip: if attempts >= max_attempts, leave it failed.
  const rows = deps.db
    .prepare<{ id: string; error_json: string | null }, []>(
      `SELECT id, error_json FROM storage_objects WHERE status = 'failed' AND capture_status = 'captured'`,
    )
    .all();
  let repended = 0;
  let exhausted = 0;
  for (const r of rows) {
    const attempts = parseAttempts(r.error_json);
    if (attempts >= deps.config.max_attempts) {
      exhausted += 1;
      continue;
    }
    // Don't mutate the attempts counter here; markUploadFailed owns it.
    deps.db.prepare<unknown, [string]>(
      `UPDATE storage_objects
       SET status = 'pending'
       WHERE id = ? AND status = 'failed'`,
    ).run(r.id);
    repended += 1;
  }
  return { repended, exhausted };
}

function parseAttempts(error_json: string | null): number {
  if (!error_json) return 0;
  try {
    const obj = JSON.parse(error_json);
    const v = obj.attempts;
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------
// Deletion pass: deletion_requested → deleted|delete_failed.
// ---------------------------------------------------------------

export interface DeletePassResult {
  readonly attempted: number;
  readonly deleted: number;
  readonly delete_failed: number;
  readonly local_only_deleted: number;
}

export async function runDeletePass(deps: SyncDeps): Promise<DeletePassResult> {
  const rows = selectEligibleDeletions(deps.db);
  let deleted = 0;
  let delete_failed = 0;
  let local_only_deleted = 0;

  for (const row of rows) {
    // Local-only / session artifact: never had an S3 key OR
    // storage_backend='local'. Transition directly to deleted
    // after local cleanup succeeds (HLD §12.6).
    if (row.storage_backend !== "s3" || !row.bucket) {
      const path = deps.config.local_path(row.id);
      if (localExists(path)) removeLocal(path);
      deps.db.prepare<unknown, [string]>(
        `UPDATE storage_objects
         SET status = 'deleted',
             deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
             result_json_overridden = NULL
         WHERE id = ? AND status = 'deletion_requested'`.replace(
           ",\n             result_json_overridden = NULL",
           "",
         ),
      ).run(row.id);
      // Tag the audit detail in error_json (re-using the column as
      // a catch-all audit store; HLD §12.6).
      deps.db.prepare<unknown, [string, string]>(
        `UPDATE storage_objects SET error_json = ? WHERE id = ?`,
      ).run(JSON.stringify({ local_only_delete: true }), row.id);
      local_only_deleted += 1;
      deleted += 1;
      continue;
    }

    try {
      await deps.transport.delete({ bucket: row.bucket, key: row.storage_key });
      const path = deps.config.local_path(row.id);
      if (localExists(path)) removeLocal(path);
      deps.db.prepare<unknown, [string]>(
        `UPDATE storage_objects
         SET status = 'deleted',
             deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
             error_json = NULL
         WHERE id = ? AND status = 'deletion_requested'`,
      ).run(row.id);
      deleted += 1;
    } catch (e) {
      const err = JSON.stringify({
        reason: (e as Error).message,
        ts: new Date().toISOString(),
      });
      deps.db.prepare<unknown, [string, string]>(
        `UPDATE storage_objects
         SET status = 'delete_failed',
             error_json = ?
         WHERE id = ? AND status = 'deletion_requested'`,
      ).run(err, row.id);
      delete_failed += 1;
    }
  }
  return {
    attempted: rows.length,
    deleted,
    delete_failed,
    local_only_deleted,
  };
}
