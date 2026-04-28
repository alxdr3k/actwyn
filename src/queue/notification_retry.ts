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
// This module owns notification retry mechanics. The worker dispatches
// claimed notification_retry jobs here, then records the job outcome.

import type { DbHandle } from "~/db.ts";
import type { EventEmitter } from "~/observability/events.ts";
import {
  rollUpParent,
  sendNotification,
  splitForTelegram,
  terminalizeExhaustedChunks,
  type OutboundTransport,
  type SendPassResult,
} from "~/telegram/outbound.ts";

export interface RetryDeps {
  readonly db: DbHandle;
  readonly transport: OutboundTransport;
  readonly events?: EventEmitter | undefined;
  readonly max_attempts_per_chunk?: number | undefined;
  readonly chunk_size?: number | undefined;
  readonly retry_job_id?: string | undefined;
}

interface NotificationToRetry {
  id: string;
  job_id: string;
  chat_id: string;
  chunk_count: number;
}

interface NotificationForLedgerRetry {
  job_id: string;
  notification_type: string;
  payload_text: string | null;
  chat_id: string;
}

export interface LedgerRetryResult {
  readonly notification_id: string;
  readonly chat_id: string;
  readonly chunks_attempted: number;
  readonly roll_up_status: "pending" | "sent" | "failed";
  readonly retry_outcome: "sent" | "retry_scheduled" | "exhausted";
  readonly retryable_chunks: number;
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

export async function retryNotificationFromLedger(
  deps: RetryDeps,
  notification_id: string,
): Promise<LedgerRetryResult | null> {
  const notif = deps.db
    .prepare<NotificationForLedgerRetry, [string]>(
      "SELECT job_id, notification_type, payload_text, chat_id FROM outbound_notifications WHERE id = ?",
    )
    .get(notification_id);
  if (!notif) return null;

  const chunks = chunksForNotification(deps.db, notif, deps.chunk_size);
  const maxAttemptsPerChunk = deps.max_attempts_per_chunk ?? 3;
  let rollUpStatus: "pending" | "sent" | "failed" = "pending";

  if (chunks.length === 0) {
    terminalizeMissingChunkText(deps.db, notification_id, maxAttemptsPerChunk);
    rollUpStatus = rollUpParent(deps.db, notification_id);
  } else {
    try {
      const sendResult = await retryNotification(deps, notification_id, chunks);
      rollUpStatus = sendResult.roll_up_status;
    } catch (e) {
      deps.events?.warn("telegram.outbound.retry_error", {
        job_id: deps.retry_job_id,
        notification_id,
        error_message: (e as Error).message,
      });
    }
  }

  let retryable = countRetryableChunks(deps.db, notification_id, maxAttemptsPerChunk);

  if (retryable === 0 && rollUpStatus !== "sent") {
    const finalized = terminalizeExhaustedChunks(deps.db, notification_id, maxAttemptsPerChunk);
    if (finalized > 0) {
      rollUpStatus = rollUpParent(deps.db, notification_id);
      retryable = countRetryableChunks(deps.db, notification_id, maxAttemptsPerChunk);
    }
  }

  const retryOutcome: LedgerRetryResult["retry_outcome"] =
    rollUpStatus === "sent"
      ? "sent"
      : retryable > 0
        ? "retry_scheduled"
        : "exhausted";

  return {
    notification_id,
    chat_id: notif.chat_id,
    chunks_attempted: chunks.length,
    roll_up_status: rollUpStatus,
    retry_outcome: retryOutcome,
    retryable_chunks: retryable,
  };
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

function chunksForNotification(
  db: DbHandle,
  notif: NotificationForLedgerRetry,
  chunkSize?: number,
): string[] {
  if (notif.payload_text !== null) {
    return splitForTelegram(notif.payload_text, chunkSize);
  }

  if (notif.notification_type !== "job_completed") {
    return [];
  }

  const turn = db
    .prepare<{ content_redacted: string }, [string]>(
      "SELECT content_redacted FROM turns WHERE job_id = ? AND role = 'assistant' ORDER BY created_at ASC LIMIT 1",
    )
    .get(notif.job_id);
  if (!turn) return [];
  return splitForTelegram(turn.content_redacted + buildJobCompletedFooter(db, notif.job_id), chunkSize);
}

function countRetryableChunks(db: DbHandle, notificationId: string, maxAttemptsPerChunk: number): number {
  const row = db
    .prepare<{ n: number }, [string, number]>(
      `SELECT COUNT(*) AS n
       FROM outbound_notification_chunks
       WHERE outbound_notification_id = ?
         AND status IN ('pending', 'failed')
         AND attempt_count < ?`,
    )
    .get(notificationId, maxAttemptsPerChunk);
  return row?.n ?? 0;
}

function terminalizeMissingChunkText(db: DbHandle, notificationId: string, maxAttemptsPerChunk: number): number {
  const res = db
    .prepare<unknown, [number, string]>(
      `UPDATE outbound_notification_chunks
       SET status = 'failed',
           attempt_count = ?,
           error_json = json_object('reason', 'chunk_text_missing')
       WHERE outbound_notification_id = ?
         AND status IN ('pending', 'failed')`,
    )
    .run(maxAttemptsPerChunk, notificationId);
  return res.changes ?? 0;
}

function buildJobCompletedFooter(db: DbHandle, jobId: string): string {
  try {
    const row = db
      .prepare<{ provider: string | null; result_json: string | null }, [string]>(
        "SELECT provider, result_json FROM jobs WHERE id = ?",
      )
      .get(jobId);
    if (!row?.result_json) return "";
    const r = JSON.parse(row.result_json) as { duration_ms?: number };
    if (r.duration_ms === undefined) return "";
    const sec = (r.duration_ms / 1000).toFixed(1);
    return `\n\n---\n${sec}s · ${row.provider ?? "claude"}`;
  } catch {
    return "";
  }
}
