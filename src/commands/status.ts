// Personal Agent P0 — /status command.
//
// Spec: PRD §14.1 output contract (DEC-015). Must report:
//   - overall status (OK | degraded | issue)
//   - session_id short (first 6 chars)
//   - provider + packing_mode from last provider_run
//   - queue counts (running / queued)
//   - post-processing: notifications + storage_sync backlogs
//   - S3 health (ok | degraded | unknown)
//   - last completed relative time
//   - last issue (optional, redacted)
//
// The storage_sync backlog query contract (§14.1): only rows with
//   capture_status='captured', retention_class-eligible,
//   sync-eligible artifact_type count toward the backlog.

import type { DbHandle } from "~/db.ts";

export interface StatusContext {
  readonly session_id?: string | null;
  readonly chat_id?: string | null;
  readonly s3_health?: "ok" | "degraded" | "unknown";
  readonly now?: () => Date;
}

export interface StatusReport {
  readonly queue: { queued: number; running: number; failed: number; interrupted: number };
  readonly storage_sync: { pending: number; failed: number };
  readonly outbound_notifications: { pending: number; failed: number };
  readonly attachment_capture_failures: number;
  readonly overall_status: "OK" | "degraded" | "issue";
  readonly session_id_short: string | null;
  readonly provider: string | null;
  readonly packing_mode: "resume_mode" | "replay_mode" | null;
  readonly last_completed_rel: string | null;
  readonly last_issue: string | null;
  readonly s3_health: "ok" | "degraded" | "unknown";
}

export function buildStatusReport(db: DbHandle, ctx: StatusContext = {}): StatusReport {
  const now = ctx.now ? ctx.now() : new Date();

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

  // Session context: provider + packing_mode from the most recent provider_run.
  let provider: string | null = null;
  let packingMode: "resume_mode" | "replay_mode" | null = null;
  if (ctx.session_id) {
    const run = db
      .prepare<{ provider: string; context_packing_mode: string }, [string]>(
        `SELECT provider, context_packing_mode
         FROM provider_runs
         WHERE session_id = ?
         ORDER BY started_at DESC LIMIT 1`,
      )
      .get(ctx.session_id);
    if (run) {
      provider = run.provider;
      packingMode = run.context_packing_mode as "resume_mode" | "replay_mode";
    }
  }

  // Last completed job.
  const lastDone = db
    .prepare<{ finished_at: string }, []>(
      `SELECT finished_at FROM jobs
       WHERE status = 'succeeded' AND finished_at IS NOT NULL
       ORDER BY finished_at DESC LIMIT 1`,
    )
    .get();
  const lastCompletedRel = lastDone
    ? relativeTime(now, lastDone.finished_at)
    : null;

  // Last issue (last failed job error).
  const lastFailed = db
    .prepare<{ error_json: string | null }, []>(
      `SELECT error_json FROM jobs
       WHERE status = 'failed' AND finished_at IS NOT NULL
       ORDER BY finished_at DESC LIMIT 1`,
    )
    .get();
  let lastIssue: string | null = null;
  if (lastFailed?.error_json) {
    try {
      const e = JSON.parse(lastFailed.error_json) as Record<string, unknown>;
      const msg = (e.message ?? e.error_message ?? e.recovery_note ?? "") as string;
      lastIssue = msg.slice(0, 80) || null;
    } catch {
      lastIssue = lastFailed.error_json.slice(0, 80);
    }
  }

  // Overall status.
  let overall: "OK" | "degraded" | "issue" = "OK";
  if (q.failed > 0 || q.interrupted > 0 || n.failed > 0 || captureFails > 0) {
    overall = "issue";
  } else if (s.failed > 0 || s.pending > 0 || n.pending > 0) {
    overall = "degraded";
  }

  return {
    queue: q,
    storage_sync: s,
    outbound_notifications: n,
    attachment_capture_failures: captureFails,
    overall_status: overall,
    session_id_short: ctx.session_id ? ctx.session_id.slice(0, 6) : null,
    provider,
    packing_mode: packingMode,
    last_completed_rel: lastCompletedRel,
    last_issue: lastIssue,
    s3_health: ctx.s3_health ?? "unknown",
  };
}

export function formatStatus(report: StatusReport): string {
  const lines: string[] = [];
  lines.push(`상태: ${report.overall_status}`);
  lines.push(`session: ${report.session_id_short ?? "—"}`);
  const providerStr = report.provider ?? "claude";
  const modeStr = report.packing_mode ?? "replay_mode";
  lines.push(`provider: ${providerStr} · packing_mode: ${modeStr}`);
  lines.push(`queue: running ${report.queue.running}/1 · queued ${report.queue.queued}`);
  lines.push(
    `post-processing: notifications pending ${report.outbound_notifications.pending} · storage_sync pending ${report.storage_sync.pending} · failed ${report.storage_sync.failed}`,
  );
  lines.push(`S3: ${report.s3_health}`);
  lines.push(`last completed: ${report.last_completed_rel ?? "—"}`);
  if (report.last_issue) {
    lines.push(`last issue: ${report.last_issue}`);
  }
  return lines.join("\n");
}

function relativeTime(now: Date, isoTs: string): string {
  const diffMs = now.getTime() - new Date(isoTs).getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}
