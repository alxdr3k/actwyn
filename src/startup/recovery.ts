// Personal Agent P0 — startup recovery.
//
// Spec references:
//   - HLD §15 (boot sequence; running → interrupted, safe_retry
//     re-queue, orphan sweep, boot doctor)
//   - DEC-016 (user-visible restart messaging)
//   - PRD §8.4 (restart messages)
//
// This module runs ONCE on boot, BEFORE the queue/worker loop
// starts accepting new jobs. Every step is idempotent so that a
// crash during recovery is recoverable on the next boot.

import type { DbHandle } from "~/db.ts";
import type { EventEmitter } from "~/observability/events.ts";

export interface RecoveryResult {
  readonly interrupted: readonly InterruptedSummary[];
  readonly requeued: readonly string[];
  readonly remained_interrupted: readonly string[];
  readonly orphans_killed: readonly number[];
  readonly offset_fast_forward: number | null;
}

export interface InterruptedSummary {
  readonly job_id: string;
  readonly job_type: string;
  readonly previous_status: "running";
  readonly safe_retry: boolean;
  readonly attempts: number;
  readonly max_attempts: number;
  readonly user_visible: boolean;
}

export interface RecoveryOptions {
  /** Strategy for orphan process sweep. In tests, defaults to no-op. */
  readonly kill_orphan?: (pgid: number) => "alive_killed" | "already_gone";
  readonly events?: EventEmitter | undefined;
  readonly now?: () => Date;
}

interface RunningJobRow {
  id: string;
  job_type: string;
  safe_retry: number;
  attempts: number;
  max_attempts: number;
  session_id: string | null;
  chat_id: string | null;
}

interface InterruptedProviderRun {
  id: string;
  job_id: string;
  process_group_id: number | null;
}

export function runStartupRecovery(
  db: DbHandle,
  opts: RecoveryOptions = {},
): RecoveryResult {
  const now = opts.now ?? (() => new Date());
  const running = db
    .prepare<RunningJobRow, []>(
      `SELECT id, job_type, safe_retry, attempts, max_attempts, session_id, chat_id
       FROM jobs WHERE status = 'running'`,
    )
    .all();

  const interrupted: InterruptedSummary[] = [];
  const requeued: string[] = [];
  const stayed: string[] = [];

  db.tx<void>(() => {
    for (const r of running) {
      // Running → interrupted.
      db.prepare<unknown, [string, string]>(
        `UPDATE jobs
         SET status = 'interrupted',
             finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
             error_json = ?
         WHERE id = ? AND status = 'running'`,
      ).run(
        JSON.stringify({
          recovery_note: "restarted_mid_run",
          recorded_at: now().toISOString(),
        }),
        r.id,
      );

      const safe = r.safe_retry === 1 && r.attempts < r.max_attempts;
      interrupted.push({
        job_id: r.id,
        job_type: r.job_type,
        previous_status: "running",
        safe_retry: safe,
        attempts: r.attempts,
        max_attempts: r.max_attempts,
        user_visible: !!r.chat_id,
      });

      if (safe) {
        // interrupted → queued in the same txn. `attempts` stays
        // where it was — we do not charge an attempt for an OS-
        // level interruption (HLD §15.3 guarantee 2).
        db.prepare<unknown, [string]>(
          `UPDATE jobs
           SET status = 'queued',
               started_at = NULL,
               finished_at = NULL
           WHERE id = ? AND status = 'interrupted'`,
        ).run(r.id);
        requeued.push(r.id);
        // DEC-016: notify user that the interrupted job will be retried.
        if (r.chat_id) {
          enqueueRecoveryNotification(db, r.id, r.chat_id, r.session_id, "job_accepted",
            "중단된 작업을 복구해 다시 실행합니다.", `restart-safe-${r.id}`);
        }
      } else {
        stayed.push(r.id);
        // DEC-016: notify user that the interrupted job will NOT be retried.
        if (r.chat_id) {
          enqueueRecoveryNotification(db, r.id, r.chat_id, r.session_id, "job_failed",
            "작업이 중단되어 자동 재시도하지 않았습니다.", `restart-${r.id}`);
        }
      }
    }
  });

  // Orphan sweep (outside the txn — kill(2) is unrelated to DB state).
  const orphans: number[] = [];
  if (opts.kill_orphan && interrupted.length > 0) {
    const ids = interrupted.map((i) => i.job_id);
    const placeholders = ids.map(() => "?").join(",");
    const pruns = db
      .prepare<InterruptedProviderRun, string[]>(
        `SELECT id, job_id, process_group_id
         FROM provider_runs
         WHERE job_id IN (${placeholders}) AND process_group_id IS NOT NULL`,
      )
      .all(...ids);
    for (const p of pruns) {
      if (p.process_group_id === null) continue;
      const outcome = opts.kill_orphan(p.process_group_id);
      if (outcome === "alive_killed") {
        orphans.push(p.process_group_id);
      }
    }
  }

  // Offset sanity — fast-forward if, impossibly, the stored offset
  // is behind the smallest update_id still pending classification.
  const min = db
    .prepare<{ min_update: number | null }>(
      `SELECT MIN(update_id) AS min_update FROM telegram_updates WHERE status = 'received'`,
    )
    .get();
  const current = db
    .prepare<{ value: string }, [string]>(
      `SELECT value FROM settings WHERE key = ?`,
    )
    .get("telegram.next_offset");
  const currentVal = current ? Number(current.value) : 0;
  let offset_fast_forward: number | null = null;
  if (min?.min_update !== null && min !== null && min.min_update !== undefined) {
    const minUpdate = min.min_update as number;
    if (currentVal > minUpdate + 1) {
      // already ahead — nothing to do.
    } else if (currentVal < minUpdate) {
      // This would be an invariant violation; we fix-forward.
      db.prepare<unknown, [string, string]>(
        `INSERT INTO settings(key, value, updated_at)
         VALUES(?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                        updated_at = excluded.updated_at`,
      ).run("telegram.next_offset", String(minUpdate));
      offset_fast_forward = minUpdate;
    }
  }

  opts.events?.info("startup.recovery.done", {
    interrupted: interrupted.length,
    requeued: requeued.length,
    remained_interrupted: stayed.length,
    orphans_killed: orphans.length,
    ...(offset_fast_forward !== null ? { offset_fast_forward } : {}),
  });

  return {
    interrupted,
    requeued,
    remained_interrupted: stayed,
    orphans_killed: orphans,
    offset_fast_forward,
  };
}

function enqueueRecoveryNotification(
  db: DbHandle,
  jobId: string,
  chatId: string,
  sessionId: string | null,
  notifType: "job_accepted" | "job_failed",
  text: string,
  payloadHash: string,
): void {
  const notifId = `notif-restart-${jobId}-${notifType}`;
  const turnId = crypto.randomUUID();

  if (sessionId) {
    db.prepare<unknown, [string, string, string, string]>(
      `INSERT INTO turns(id, session_id, job_id, role, content_redacted, redaction_applied)
       VALUES(?, ?, ?, 'assistant', ?, 0)
       ON CONFLICT DO NOTHING`,
    ).run(turnId, sessionId, jobId, text);
  }

  db.prepare<unknown, [string, string, string, string, string, number, string]>(
    `INSERT INTO outbound_notifications
       (id, job_id, chat_id, notification_type, payload_hash, chunk_count, status, payload_text)
     VALUES(?, ?, ?, ?, ?, ?, 'pending', ?)
     ON CONFLICT(job_id, notification_type, payload_hash) DO NOTHING`,
  ).run(notifId, jobId, chatId, notifType, payloadHash, 1, text);

  db.prepare<unknown, [string, string, string]>(
    `INSERT INTO outbound_notification_chunks
       (id, outbound_notification_id, chunk_index, chunk_count, payload_text_hash, status)
     VALUES(?, ?, 1, 1, ?, 'pending')
     ON CONFLICT(outbound_notification_id, chunk_index) DO NOTHING`,
  ).run(`${notifId}-c1`, notifId, payloadHash);

  const retryJobId = crypto.randomUUID();
  db.prepare<unknown, [string, string, string, string]>(
    `INSERT INTO jobs(id, status, job_type, chat_id, request_json, idempotency_key)
     VALUES(?, 'queued', 'notification_retry', ?, ?, ?)
     ON CONFLICT(job_type, idempotency_key) DO NOTHING`,
  ).run(
    retryJobId,
    chatId,
    JSON.stringify({ notification_id: notifId }),
    `notif-retry:${notifId}`,
  );
}
