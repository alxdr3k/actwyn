// Personal Agent P0 — /summary and /end.
//
// Spec: PRD §8.1, §12.3 / DEC-019. Both commands enqueue a
// `summary_generation` job whose handling (Claude under the
// advisory profile) lives in providers/claude + memory/summary.
// /summary and /end bypass the auto-trigger throttle because
// they are explicit user actions.
//
// /end additionally marks sessions.status='ended' after the
// summary is written; the worker drives that transition from
// the summary job's terminal commit (not from this command).

import type { DbHandle } from "~/db.ts";

export interface EnqueueSummaryArgs {
  readonly db: DbHandle;
  readonly newId: () => string;
  readonly session_id: string;
  readonly chat_id: string;
  readonly user_id: string;
  readonly trigger: "explicit_summary" | "explicit_end" | "auto";
}

export interface EnqueueResult {
  readonly job_id: string;
  readonly already_queued: boolean;
}

export function enqueueSummaryJob(args: EnqueueSummaryArgs): EnqueueResult {
  const jobId = args.newId();
  // Idempotency key per HLD §5.3:
  //   /summary: 'summary:' || session_id || ':' || user_trigger_epoch
  //   /end:     'end:' || session_id
  const epoch = Math.floor(Date.now() / 1000);
  const idempotencyKey =
    args.trigger === "explicit_end"
      ? `end:${args.session_id}`
      : `summary:${args.session_id}:${epoch}`;

  const request_json = JSON.stringify({
    trigger: args.trigger,
    session_id: args.session_id,
  });

  const res = args.db
    .prepare<
      unknown,
      [string, string, string, string, string, string]
    >(
      `INSERT INTO jobs
         (id, status, job_type, session_id, user_id, chat_id, request_json,
          idempotency_key, provider, safe_retry, max_attempts)
       VALUES(?, 'queued', 'summary_generation', ?, ?, ?, ?, ?, 'claude', 1, 2)
       ON CONFLICT(job_type, idempotency_key) DO NOTHING`,
    )
    .run(jobId, args.session_id, args.user_id, args.chat_id, request_json, idempotencyKey);

  if ((res.changes ?? 0) === 0) {
    const existing = args.db
      .prepare<{ id: string }, [string, string]>(
        `SELECT id FROM jobs WHERE job_type = ? AND idempotency_key = ?`,
      )
      .get("summary_generation", idempotencyKey)!;
    return { job_id: existing.id, already_queued: true };
  }
  return { job_id: jobId, already_queued: false };
}

export function endSession(db: DbHandle, session_id: string): void {
  db.prepare<unknown, [string]>(
    `UPDATE sessions
     SET status = 'ended',
         ended_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ? AND status = 'active'`,
  ).run(session_id);
}
