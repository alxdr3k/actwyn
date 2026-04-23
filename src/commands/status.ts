// Personal Agent P0 — /status command.
//
// Spec: PRD §14.1 output contract (DEC-015). Must report:
//   - queue counts (queued / running / failed / interrupted)
//   - storage_sync backlog (pending / failed) using the §14.1
//     query contract — only rows that would be selected by
//     storage/sync.selectEligibleUploads, i.e. capture_status='captured',
//     retention_class-eligible, sync-eligible artifact_type.
//   - outbound notification backlog (pending / failed)
//   - attachment capture failures (separate surfacing, HLD §13.5)

import type { DbHandle } from "~/db.ts";

export interface StatusReport {
  readonly queue: { queued: number; running: number; failed: number; interrupted: number };
  readonly storage_sync: { pending: number; failed: number };
  readonly outbound_notifications: { pending: number; failed: number };
  readonly attachment_capture_failures: number;
}

export function buildStatusReport(db: DbHandle): StatusReport {
  const jobs = db
    .prepare<{ status: string; n: number }, []>(
      `SELECT status, COUNT(*) AS n FROM jobs WHERE job_type='provider_run' GROUP BY status`,
    )
    .all();
  const q = { queued: 0, running: 0, failed: 0, interrupted: 0 };
  for (const row of jobs) {
    if (row.status === "queued") q.queued = row.n;
    else if (row.status === "running") q.running = row.n;
    else if (row.status === "failed") q.failed = row.n;
    else if (row.status === "interrupted") q.interrupted = row.n;
  }

  const storage = db
    .prepare<{ status: string; n: number }, []>(
      `SELECT status, COUNT(*) AS n FROM storage_objects
       WHERE capture_status = 'captured'
         AND retention_class IN ('long_term', 'archive')
         AND storage_backend = 's3'
         AND artifact_type IN
           ('user_upload', 'generated_artifact', 'redacted_provider_transcript',
            'conversation_transcript', 'memory_snapshot', 'parser_fixture')
         AND status IN ('pending', 'failed')
       GROUP BY status`,
    )
    .all();
  const s = { pending: 0, failed: 0 };
  for (const row of storage) {
    if (row.status === "pending") s.pending = row.n;
    else if (row.status === "failed") s.failed = row.n;
  }

  const outbound = db
    .prepare<{ status: string; n: number }, []>(
      `SELECT status, COUNT(*) AS n FROM outbound_notifications
       WHERE status IN ('pending', 'failed') GROUP BY status`,
    )
    .all();
  const n = { pending: 0, failed: 0 };
  for (const row of outbound) {
    if (row.status === "pending") n.pending = row.n;
    else if (row.status === "failed") n.failed = row.n;
  }

  const captureFails = db
    .prepare<{ n: number }>(
      `SELECT COUNT(*) AS n FROM storage_objects WHERE capture_status = 'failed'`,
    )
    .get()?.n ?? 0;

  return {
    queue: q,
    storage_sync: s,
    outbound_notifications: n,
    attachment_capture_failures: captureFails,
  };
}

export function formatStatus(report: StatusReport): string {
  return [
    `queue: queued=${report.queue.queued} running=${report.queue.running} failed=${report.queue.failed} interrupted=${report.queue.interrupted}`,
    `storage_sync: pending=${report.storage_sync.pending} failed=${report.storage_sync.failed}`,
    `notifications: pending=${report.outbound_notifications.pending} failed=${report.outbound_notifications.failed}`,
    `attachment_capture_failures: ${report.attachment_capture_failures}`,
  ].join("\n");
}
