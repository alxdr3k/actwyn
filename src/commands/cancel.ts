// Personal Agent P0 — /cancel command.
//
// Spec references: PRD §8.6, HLD §6.2 (queued → cancelled direct;
// running → cancelled via subprocess teardown).
//
// - For a `queued` job, this module flips the row to `cancelled`
//   atomically.
// - For a `running` job, this module signals the provided
//   AbortController (owned by the worker) so the adapter tears
//   the subprocess down; the worker then records the terminal
//   cancelled state.

import type { DbHandle } from "~/db.ts";

export type CancelOutcome =
  | { kind: "cancelled_queued"; job_id: string }
  | { kind: "cancel_signalled"; job_id: string }
  | { kind: "not_found" }
  | { kind: "terminal"; job_id: string; status: string };

export interface CancelDeps {
  /** For each running job_id, a handle to signal cancel. */
  readonly running_cancel_handles?: Map<string, AbortController>;
}

/**
 * Cancel the most recent active job in a session (provider_run)
 * unless `job_id` is explicitly provided.
 */
export function cancelJob(
  db: DbHandle,
  args: { job_id?: string; session_id?: string; deps?: CancelDeps },
): CancelOutcome {
  const row = args.job_id
    ? db.prepare<{ id: string; status: string }, [string]>(
        `SELECT id, status FROM jobs WHERE id = ?`,
      ).get(args.job_id)
    : args.session_id
      ? db
          .prepare<{ id: string; status: string }, [string]>(
            `SELECT id, status FROM jobs
             WHERE session_id = ? AND job_type = 'provider_run'
               AND status IN ('queued', 'running')
             ORDER BY created_at DESC LIMIT 1`,
          )
          .get(args.session_id)
      : null;
  if (!row) return { kind: "not_found" };

  if (row.status === "queued") {
    const res = db
      .prepare<unknown, [string]>(
        `UPDATE jobs
         SET status = 'cancelled',
             finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ? AND status = 'queued'`,
      )
      .run(row.id);
    if ((res.changes ?? 0) === 1) return { kind: "cancelled_queued", job_id: row.id };
    return { kind: "terminal", job_id: row.id, status: row.status };
  }

  if (row.status === "running") {
    const handle = args.deps?.running_cancel_handles?.get(row.id);
    handle?.abort();
    return { kind: "cancel_signalled", job_id: row.id };
  }

  return { kind: "terminal", job_id: row.id, status: row.status };
}
