// Personal Agent P0 — notification_retry driver.
//
// Selects outbound_notification_chunks rows with
// status IN ('pending', 'failed') whose retry budget is not
// exhausted, re-invokes the transport for them, and lets the
// parent status roll up from the chunk ledger (HLD §6.3).
//
// MUST NOT mutate:
//   - provider_runs.status
//   - jobs.status (beyond the retry job's own lifecycle)
//
// This module implements the "notification_retry" job-type handler.
// The worker dispatches to it when it claims a storage/retry job;
// the handler also stands alone for targeted tests.

import type { DbHandle } from "~/db.ts";
import type { EventEmitter } from "~/observability/events.ts";
import {
  rollUpParent,
  sendNotification,
  type OutboundTransport,
  type SendPassResult,
} from "~/telegram/outbound.ts";

export interface RetryDeps {
  readonly db: DbHandle;
  readonly transport: OutboundTransport;
  readonly events?: EventEmitter | undefined;
  readonly max_attempts_per_chunk?: number;
}

interface NotificationToRetry {
  id: string;
  job_id: string;
  chat_id: string;
  chunk_count: number;
}

/**
 * Retry one notification's outstanding chunks. The caller provides
 * the (ordered) chunk texts matching what was persisted at creation
 * time. Callers that do not retain chunk text should use
 * retryWithRecoveredText() which reconstructs chunks from the owning
 * turns row — not implemented in Phase 5 because the worker always
 * holds the response in memory at notification time.
 */
export async function retryNotification(
  deps: RetryDeps,
  notification_id: string,
  chunks: readonly string[],
): Promise<SendPassResult> {
  return sendNotification(
    {
      db: deps.db,
      transport: deps.transport,
      events: deps.events,
      max_attempts_per_chunk: deps.max_attempts_per_chunk ?? 3,
    },
    notification_id,
    chunks,
  );
}

/**
 * Retry every notification that has at least one non-terminal chunk.
 * The caller passes a lookup from notification_id → chunks so the
 * retry pass is self-contained (worker re-derives chunks from the
 * turns row when needed).
 */
export async function retryAllPending(
  deps: RetryDeps,
  chunkLookup: (notification_id: string) => readonly string[] | null,
): Promise<{ notifications: number; sent: number; failed: number }> {
  const rows = deps.db
    .prepare<NotificationToRetry, []>(
      `SELECT id, job_id, chat_id, chunk_count
       FROM outbound_notifications
       WHERE status IN ('pending', 'failed')`,
    )
    .all();

  let sent = 0;
  let failed = 0;
  for (const n of rows) {
    const chunks = chunkLookup(n.id);
    if (!chunks) continue;
    const res = await retryNotification(deps, n.id, chunks);
    sent += res.sent;
    failed += res.failed;
  }
  return { notifications: rows.length, sent, failed };
}

/** Helper for operators: ensure the parent status matches the chunk ledger. */
export function reconcileRollUp(db: DbHandle, notification_id: string): "pending" | "sent" | "failed" {
  return rollUpParent(db, notification_id);
}
