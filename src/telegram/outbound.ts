// Personal Agent P0 — Telegram outbound notifications.
//
// Owns:
//   - outbound_notifications row (parent / logical notification).
//   - outbound_notification_chunks rows (physical Telegram messages).
//   - outbound_notifications.status transitions (derived from
//     chunk roll-up; HLD §6.3).
//
// Invariants the tests assert:
//   1. Parent row + N chunk rows are inserted ATOMICALLY in the same
//      db.tx(). Rollback removes all N+1 rows.
//   2. sendMessage is only called for chunks with
//      status IN ('pending', 'failed'). A chunk with status='sent'
//      is NEVER re-sent (AC-NOTIF-003 / AC-NOTIF-005).
//   3. Parent status derived from chunk roll-up, never mutated
//      independently.
//   4. provider_runs.status / jobs.status are NEVER modified by this
//      module (AC-STO-002, AC-NOTIF-001).

import { createHash } from "node:crypto";

import type { DbHandle } from "~/db.ts";
import type { EventEmitter } from "~/observability/events.ts";

// PRD §8.4 DEC-020.
export const DEFAULT_CHUNK_SIZE = 3800;

export type NotificationType =
  | "job_accepted"
  | "job_completed"
  | "job_failed"
  | "job_cancelled"
  | "summary"
  | "doctor";

// ---------------------------------------------------------------
// Chunk splitter (pure)
// ---------------------------------------------------------------

export function splitForTelegram(
  text: string,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
): string[] {
  const body = text ?? "";
  if (body.length === 0) return [""];
  if (body.length <= chunkSize) return [body];

  // We reserve room for the marker tail ` (i/N)` ~ 10 chars worst
  // case for N up to 999. The outer loop computes N first by a
  // pre-pass, then re-splits with the marker-adjusted width.
  const reserved = 12;
  const effective = Math.max(1, chunkSize - reserved);
  const rough = Math.ceil(body.length / effective);
  const N = rough;
  const adjusted = Math.max(1, chunkSize - suffixLength(N));

  const out: string[] = [];
  for (let i = 0; i < body.length; i += adjusted) {
    out.push(body.slice(i, i + adjusted));
  }

  // If rough miscounted (rare: body length boundary), tolerate.
  const actualN = out.length;
  return out.map((s, idx) => `${s} (${idx + 1}/${actualN})`);
}

function suffixLength(n: number): number {
  // ` (x/n)` — two digits for each side max (hundreds supported).
  return 4 + 2 * String(n).length;
}

// ---------------------------------------------------------------
// Row ids and hashes
// ---------------------------------------------------------------

export function payloadHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// ---------------------------------------------------------------
// Parent + chunk creation (single txn)
// ---------------------------------------------------------------

export interface CreateNotificationArgs {
  readonly job_id: string;
  readonly chat_id: string;
  readonly notification_type: NotificationType;
  readonly text: string;
  readonly chunk_size?: number | undefined;
}

export interface CreatedNotification {
  readonly notification_id: string;
  readonly chunk_ids: readonly string[];
  readonly chunks: readonly string[];
  readonly created: boolean; // false if duplicate (same payload_hash)
}

export function createNotificationAndChunks(args: {
  db: DbHandle;
  newId: () => string;
  args: CreateNotificationArgs;
}): CreatedNotification {
  const chunks = splitForTelegram(
    args.args.text,
    args.args.chunk_size ?? DEFAULT_CHUNK_SIZE,
  );
  const pHash = payloadHash(args.args.text);
  const notificationId = args.newId();
  const chunkIds: string[] = [];

  return args.db.tx<CreatedNotification>(() => {
    const res = args.db
      .prepare<unknown, [string, string, string, string, string, number]>(
        `INSERT INTO outbound_notifications
           (id, job_id, chat_id, notification_type, payload_hash, chunk_count, status)
         VALUES(?, ?, ?, ?, ?, ?, 'pending')
         ON CONFLICT(job_id, notification_type, payload_hash) DO NOTHING`,
      )
      .run(
        notificationId,
        args.args.job_id,
        args.args.chat_id,
        args.args.notification_type,
        pHash,
        chunks.length,
      );

    if ((res.changes ?? 0) === 0) {
      // Duplicate — return the existing parent + its chunk rows.
      const existing = args.db
        .prepare<{ id: string }, [string, string, string]>(
          `SELECT id FROM outbound_notifications
           WHERE job_id = ? AND notification_type = ? AND payload_hash = ?`,
        )
        .get(args.args.job_id, args.args.notification_type, pHash)!;
      const existingChunks = args.db
        .prepare<{ id: string }, [string]>(
          `SELECT id FROM outbound_notification_chunks
           WHERE outbound_notification_id = ? ORDER BY chunk_index ASC`,
        )
        .all(existing.id);
      return {
        notification_id: existing.id,
        chunk_ids: existingChunks.map((c) => c.id),
        chunks,
        created: false,
      };
    }

    for (let i = 0; i < chunks.length; i++) {
      const chunkId = args.newId();
      chunkIds.push(chunkId);
      const textHash = createHash("sha256").update(chunks[i]!).digest("hex");
      args.db
        .prepare<unknown, [string, string, number, number, string]>(
          `INSERT INTO outbound_notification_chunks
             (id, outbound_notification_id, chunk_index, chunk_count, payload_text_hash, status)
           VALUES(?, ?, ?, ?, ?, 'pending')`,
        )
        .run(chunkId, notificationId, i + 1, chunks.length, textHash);
    }

    return {
      notification_id: notificationId,
      chunk_ids: chunkIds,
      chunks,
      created: true,
    };
  });
}

// ---------------------------------------------------------------
// Transport
// ---------------------------------------------------------------

export interface SendMessageArgs {
  readonly chat_id: string;
  readonly text: string;
}

export interface SendMessageResult {
  readonly telegram_message_id: string;
}

export class TelegramSendError extends Error {
  constructor(
    message: string,
    public readonly retry_after_seconds?: number,
    public readonly retryable: boolean = true,
  ) {
    super(message);
    this.name = "TelegramSendError";
  }
}

export interface OutboundTransport {
  send(args: SendMessageArgs): Promise<SendMessageResult>;
}

// ---------------------------------------------------------------
// Send pass (pending + failed chunks only)
// ---------------------------------------------------------------

export interface SendOptions {
  readonly db: DbHandle;
  readonly transport: OutboundTransport;
  readonly events?: EventEmitter | undefined;
  /** Cap on per-chunk attempts before giving up on this pass (retry scheduler re-enters later). */
  readonly max_attempts_per_chunk?: number | undefined;
}

interface ChunkRow {
  id: string;
  outbound_notification_id: string;
  chunk_index: number;
  chunk_count: number;
  payload_text_hash: string;
  status: string;
  attempt_count: number;
}

export interface SendPassResult {
  readonly attempted: number;
  readonly sent: number;
  readonly failed: number;
  readonly roll_up_status: "pending" | "sent" | "failed";
}

export async function sendNotification(
  opts: SendOptions,
  notification_id: string,
  chunks: readonly string[],
): Promise<SendPassResult> {
  const db = opts.db;
  const maxAttempts = opts.max_attempts_per_chunk ?? 3;

  const parent = db
    .prepare<{ chat_id: string }, [string]>(
      `SELECT chat_id FROM outbound_notifications WHERE id = ?`,
    )
    .get(notification_id);
  if (!parent) {
    throw new Error(`notification ${notification_id} not found`);
  }

  // Pick ONLY non-terminal chunks (AC-NOTIF-005).
  const pending = db
    .prepare<ChunkRow, [string]>(
      `SELECT id, outbound_notification_id, chunk_index, chunk_count, payload_text_hash, status, attempt_count
       FROM outbound_notification_chunks
       WHERE outbound_notification_id = ? AND status IN ('pending', 'failed')
       ORDER BY chunk_index ASC`,
    )
    .all(notification_id);

  let attempted = 0;
  let sent = 0;
  let failed = 0;

  for (const chunk of pending) {
    if (chunk.attempt_count >= maxAttempts) {
      markChunkFailed(db, chunk.id, { reason: "max_attempts_exceeded" });
      failed += 1;
      continue;
    }
    const text = chunks[chunk.chunk_index - 1];
    if (text === undefined) {
      // Shouldn't happen: caller must pass the same chunk list used at creation.
      markChunkFailed(db, chunk.id, { reason: "chunk_text_missing" });
      failed += 1;
      continue;
    }
    attempted += 1;
    try {
      const res = await opts.transport.send({ chat_id: parent.chat_id, text });
      markChunkSent(db, chunk.id, res.telegram_message_id);
      sent += 1;
    } catch (e) {
      const err = e as Error & { retry_after_seconds?: number; retryable?: boolean };
      const retryable = !(e instanceof TelegramSendError && e.retryable === false);
      if (retryable) {
        markChunkPending(db, chunk.id, { error: err.message });
      } else {
        markChunkFailed(db, chunk.id, { reason: err.message });
      }
      opts.events?.warn("telegram.outbound.chunk.error", {
        notification_id,
        chunk_id: chunk.id,
        chunk_index: chunk.chunk_index,
        retryable,
      });
      // Stop the pass on a retry_after so we don't hammer the API.
      if (err.retry_after_seconds !== undefined) break;
    }
  }

  const rollUp = rollUpParent(db, notification_id);
  return { attempted, sent, failed, roll_up_status: rollUp };
}

function markChunkSent(db: DbHandle, chunkId: string, telegram_message_id: string): void {
  db.prepare<unknown, [string, string]>(
    `UPDATE outbound_notification_chunks
     SET status = 'sent',
         telegram_message_id = ?,
         attempt_count = attempt_count + 1,
         sent_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
         error_json = NULL
     WHERE id = ?`,
  ).run(telegram_message_id, chunkId);
}

function markChunkPending(db: DbHandle, chunkId: string, reason: { error: string }): void {
  db.prepare<unknown, [string, string]>(
    `UPDATE outbound_notification_chunks
     SET status = 'pending',
         attempt_count = attempt_count + 1,
         error_json = ?
     WHERE id = ?`,
  ).run(JSON.stringify(reason), chunkId);
}

function markChunkFailed(db: DbHandle, chunkId: string, reason: { reason: string }): void {
  db.prepare<unknown, [string, string]>(
    `UPDATE outbound_notification_chunks
     SET status = 'failed',
         attempt_count = attempt_count + 1,
         error_json = ?
     WHERE id = ?`,
  ).run(JSON.stringify(reason), chunkId);
}

// ---------------------------------------------------------------
// Parent roll-up — derived, never mutated independently.
// ---------------------------------------------------------------

export function rollUpParent(
  db: DbHandle,
  notification_id: string,
): "pending" | "sent" | "failed" {
  return db.tx<"pending" | "sent" | "failed">(() => {
    const stats = db
      .prepare<
        { status: string; n: number; total: number },
        [string, string]
      >(
        `SELECT status, COUNT(*) AS n,
                (SELECT COUNT(*) FROM outbound_notification_chunks WHERE outbound_notification_id = ?) AS total
         FROM outbound_notification_chunks
         WHERE outbound_notification_id = ?
         GROUP BY status`,
      )
      .all(notification_id, notification_id);

    let total = 0;
    let sent = 0;
    let failed = 0;
    let pending = 0;
    for (const s of stats) {
      total = s.total;
      if (s.status === "sent") sent = s.n;
      else if (s.status === "failed") failed = s.n;
      else if (s.status === "pending") pending = s.n;
    }

    let status: "pending" | "sent" | "failed" = "pending";
    if (total > 0 && sent === total) status = "sent";
    else if (failed > 0 && pending === 0) status = "failed";
    else status = "pending";

    if (status === "sent") {
      // Gather message ids in chunk order.
      const rows = db
        .prepare<{ telegram_message_id: string | null }, [string]>(
          `SELECT telegram_message_id FROM outbound_notification_chunks
           WHERE outbound_notification_id = ? ORDER BY chunk_index ASC`,
        )
        .all(notification_id);
      const ids = rows.map((r) => r.telegram_message_id).filter((v): v is string => v !== null);
      db.prepare<unknown, [string, string]>(
        `UPDATE outbound_notifications
         SET status = 'sent',
             sent_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
             telegram_message_ids_json = ?
         WHERE id = ?`,
      ).run(JSON.stringify(ids), notification_id);
    } else if (status === "failed") {
      db.prepare<unknown, [string]>(
        `UPDATE outbound_notifications
         SET status = 'failed',
             attempt_count = attempt_count + 1
         WHERE id = ?`,
      ).run(notification_id);
    } else {
      db.prepare<unknown, [string]>(
        `UPDATE outbound_notifications SET status = 'pending' WHERE id = ?`,
      ).run(notification_id);
    }
    return status;
  });
}

// ---------------------------------------------------------------
// Stub transport
// ---------------------------------------------------------------

export interface StubOutboundOptions {
  /** Map chunk text → behaviour. Default: all succeed. */
  readonly plan?: ReadonlyMap<string, "ok" | "fail_once" | "fail_non_retryable">;
}

export class StubOutboundTransport implements OutboundTransport {
  private calls: SendMessageArgs[] = [];
  private firstFails = new Set<string>();
  private counter = 0;
  constructor(private readonly opts: StubOutboundOptions = {}) {}

  get call_log(): readonly SendMessageArgs[] {
    return this.calls;
  }

  async send(args: SendMessageArgs): Promise<SendMessageResult> {
    this.calls.push(args);
    const plan = this.opts.plan?.get(args.text) ?? "ok";
    if (plan === "fail_non_retryable") {
      throw new TelegramSendError("bad_request", undefined, false);
    }
    if (plan === "fail_once") {
      if (!this.firstFails.has(args.text)) {
        this.firstFails.add(args.text);
        throw new TelegramSendError("transient", undefined, true);
      }
    }
    this.counter += 1;
    return { telegram_message_id: `tg-${this.counter}` };
  }

  countSendsFor(text: string): number {
    return this.calls.filter((c) => c.text === text).length;
  }
}
