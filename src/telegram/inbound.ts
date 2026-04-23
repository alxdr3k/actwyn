// Personal Agent P0 — Telegram inbound classifier + writer.
//
// Owns:
//   - `telegram_updates.status` transitions out of `received`.
//   - Authoring of inbound `jobs` rows.
//   - Attachment metadata rows in `storage_objects` (via the
//     pure helpers in attachment_metadata.ts).
//
// Critical invariants (HLD §4.2, §7.1, §7.10):
//   1. Zero network I/O inside the inbound txn. (`classifyAndCommit`
//      takes NO HTTP client; it only reads the already-fetched
//      update payload.)
//   2. Unauthorized senders NEVER produce a `jobs` row (AC-TEL-001).
//   3. Every job carries `idempotency_key = 'telegram:' || update_id`;
//      duplicate update_ids re-delivered by Telegram do not create a
//      second row (AC-TEL-003).
//   4. Offset advance happens in the same txn as the status
//      transition(s) for that batch.
//
// The classifier is pure (data in → descriptor out). The writer
// wraps DB access and calls the classifier.

import type { DbHandle } from "~/db.ts";
import type { Redactor } from "~/observability/redact.ts";
import {
  buildStorageObjectRow,
  classifyAttachments,
  defaultStorageKey,
  type InboundAttachmentConfig,
} from "~/telegram/attachment_metadata.ts";
import type { TelegramMessage, TelegramUpdate } from "~/telegram/types.ts";

// ---------------------------------------------------------------
// Classification (pure)
// ---------------------------------------------------------------

export type SkipReason =
  | "unauthorized"
  | "unsupported_type"
  | "bootstrap_whoami_only"
  | "malformed";

export type Classification =
  | { kind: "skip"; reason: SkipReason }
  | { kind: "text"; text: string; has_attachments: boolean }
  | { kind: "command"; command: string; args: string; has_attachments: boolean }
  | { kind: "whoami_bootstrap" };

export interface ClassifyOptions {
  readonly authorized_user_ids: ReadonlySet<number>;
  readonly bootstrap_whoami: boolean;
}

/**
 * Pure classifier. Does NOT access the DB or the network.
 */
export function classifyUpdate(
  update: TelegramUpdate,
  opts: ClassifyOptions,
): Classification {
  const msg = update.message;
  if (!msg) {
    return { kind: "skip", reason: "unsupported_type" };
  }
  if (!msg.from || typeof msg.from.id !== "number") {
    return { kind: "skip", reason: "malformed" };
  }

  const authorized = opts.authorized_user_ids.has(msg.from.id);
  if (!authorized) {
    if (opts.bootstrap_whoami && isWhoamiText(msg)) {
      return { kind: "whoami_bootstrap" };
    }
    return { kind: "skip", reason: "unauthorized" };
  }

  const text = (msg.text ?? msg.caption ?? "").trim();
  const hasAttachments =
    !!(msg.photo || msg.document || msg.audio || msg.video || msg.voice);

  const cmd = parseCommand(text);
  if (cmd) {
    return {
      kind: "command",
      command: cmd.command,
      args: cmd.args,
      has_attachments: hasAttachments,
    };
  }

  if (text.length > 0 || hasAttachments) {
    return { kind: "text", text, has_attachments: hasAttachments };
  }

  return { kind: "skip", reason: "unsupported_type" };
}

function isWhoamiText(msg: TelegramMessage): boolean {
  const t = (msg.text ?? "").trim();
  return t.startsWith("/whoami");
}

function parseCommand(text: string): { command: string; args: string } | null {
  if (!text.startsWith("/")) return null;
  const head = text.split(/\s+/, 1)[0]!;
  // Strip optional `@botname` suffix.
  const command = head.split("@", 1)[0]!;
  const KNOWN = new Set<string>([
    "/status",
    "/cancel",
    "/summary",
    "/end",
    "/provider",
    "/doctor",
    "/whoami",
    "/save_last_attachment",
    "/forget_last",
    "/forget_session",
    "/forget_artifact",
    "/forget_memory",
    "/correct",
  ]);
  if (!KNOWN.has(command)) return null;
  const args = text.slice(head.length).trim();
  return { command, args };
}

// ---------------------------------------------------------------
// Writer
// ---------------------------------------------------------------

export interface InboundConfig {
  readonly authorized_user_ids: ReadonlySet<number>;
  readonly bootstrap_whoami: boolean;
  readonly attachment: InboundAttachmentConfig;
  readonly s3_bucket: string | null;
}

export interface InboundDeps {
  readonly db: DbHandle;
  readonly redactor: Redactor;
  readonly config: InboundConfig;
  readonly newId: () => string;
  readonly now: () => Date;
}

export interface ProcessedOutcome {
  readonly update_id: number;
  readonly telegram_status: "enqueued" | "skipped";
  readonly skip_reason: SkipReason | null;
  readonly job_id: string | null;
  readonly storage_object_ids: readonly string[];
}

export interface BatchResult {
  readonly processed: readonly ProcessedOutcome[];
  readonly offset_after: number;
}

const OFFSET_KEY = "telegram.next_offset";

/**
 * Reads current `telegram_next_offset` from `settings`. Returns 0
 * if unset (first run).
 */
export function readOffset(db: DbHandle): number {
  const row = db
    .prepare<{ value: string }, [string]>(
      "SELECT value FROM settings WHERE key = ?",
    )
    .get(OFFSET_KEY);
  if (!row) return 0;
  const v = Number(row.value);
  return Number.isFinite(v) && v >= 0 ? v : 0;
}

/**
 * Insert-or-no-op a received Telegram update into `telegram_updates`.
 * Returns `"inserted"` if a new row was created, `"existing"` if a
 * row with the same `update_id` already existed (retry re-delivery).
 *
 * This runs in its own single-statement txn context (caller may
 * wrap a batch in BEGIN IMMEDIATE).
 */
export function insertReceived(
  deps: InboundDeps,
  update: TelegramUpdate,
): "inserted" | "existing" {
  const rawRedacted = deps.redactor.applyToJson(update);
  const raw_update_json_redacted = JSON.stringify(rawRedacted);

  const msg = update.message;
  const res = deps.db
    .prepare<
      unknown,
      [number, string | null, string | null, string, string]
    >(
      `INSERT INTO telegram_updates(update_id, chat_id, user_id, update_type, status, raw_update_json_redacted)
       VALUES(?, ?, ?, ?, 'received', ?)
       ON CONFLICT(update_id) DO NOTHING`,
    )
    .run(
      update.update_id,
      msg?.chat?.id !== undefined ? String(msg.chat.id) : null,
      msg?.from?.id !== undefined ? String(msg.from.id) : null,
      msg ? "message" : "other",
      raw_update_json_redacted,
    );
  return (res.changes ?? 0) > 0 ? "inserted" : "existing";
}

/**
 * Process one already-inserted `received` update to a terminal
 * status (`enqueued` or `skipped`). Caller is responsible for
 * wrapping a batch in db.tx() so offset advance is atomic with the
 * batch's status transitions (HLD §7.1 step 3b).
 *
 * Returns the outcome; caller uses it to roll up counts.
 */
export function classifyAndCommit(
  deps: InboundDeps,
  update: TelegramUpdate,
): ProcessedOutcome {
  const classification = classifyUpdate(update, {
    authorized_user_ids: deps.config.authorized_user_ids,
    bootstrap_whoami: deps.config.bootstrap_whoami,
  });

  if (classification.kind === "skip") {
    markSkipped(deps, update.update_id, classification.reason);
    return {
      update_id: update.update_id,
      telegram_status: "skipped",
      skip_reason: classification.reason,
      job_id: null,
      storage_object_ids: [],
    };
  }

  if (classification.kind === "whoami_bootstrap") {
    // Bootstrap path — no job, no attachment, no provider call.
    // Actual reply is dispatched by commands/whoami at a later phase;
    // for now we record the outcome.
    markSkipped(deps, update.update_id, "bootstrap_whoami_only");
    return {
      update_id: update.update_id,
      telegram_status: "skipped",
      skip_reason: "bootstrap_whoami_only",
      job_id: null,
      storage_object_ids: [],
    };
  }

  // Authorized text or command → provider_run job.
  const msg = update.message!;
  const user_id = String(msg.from!.id);
  const chat_id = String(msg.chat.id);

  const session = ensureActiveSession(deps, { chat_id, user_id });

  const jobId = deps.newId();
  const commandField = classification.kind === "command" ? classification.command : null;
  const requestPayload = {
    command: commandField,
    args: classification.kind === "command" ? classification.args : "",
    text: classification.kind === "text" ? classification.text : "",
    has_attachments: classification.has_attachments,
  };
  const requestJson = JSON.stringify(deps.redactor.applyToJson(requestPayload));

  // `/summary` and `/end` map to summary_generation; all other
  // commands and text messages map to provider_run. The worker checks
  // request_json.command to differentiate /end (mark session ended)
  // from /summary (summary only, session stays active).
  const jobType =
    commandField === "/summary" || commandField === "/end"
      ? "summary_generation"
      : "provider_run";
  const idempotencyKey = `telegram:${update.update_id}`;

  const insertRes = deps.db
    .prepare<
      unknown,
      [string, string, string, string, string, string, string, string]
    >(
      `INSERT INTO jobs(id, status, job_type, session_id, user_id, chat_id, request_json, idempotency_key, provider)
       VALUES(?, 'queued', ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(job_type, idempotency_key) DO NOTHING`,
    )
    .run(
      jobId,
      jobType,
      session.id,
      user_id,
      chat_id,
      requestJson,
      idempotencyKey,
      "claude",
    );

  // If the job already existed (retry re-delivery), look up its id.
  let effectiveJobId = jobId;
  if ((insertRes.changes ?? 0) === 0) {
    const existing = deps.db
      .prepare<{ id: string }, [string, string]>(
        `SELECT id FROM jobs WHERE job_type = ? AND idempotency_key = ?`,
      )
      .get(jobType, idempotencyKey);
    if (existing) effectiveJobId = existing.id;
  }

  // Attachments: metadata-only insert, NO network I/O.
  const storageIds: string[] = [];
  if (classification.has_attachments) {
    const descriptors = classifyAttachments(msg);
    for (const descriptor of descriptors) {
      const objectId = deps.newId();
      const row = buildStorageObjectRow({
        storage_object_id: objectId,
        user_id,
        message_id: msg.message_id,
        descriptor,
        config: deps.config.attachment,
        filenameIsRedactionSafe: (fn) => !deps.redactor.detect(fn).matched,
        storageKey: defaultStorageKey,
        bucket: deps.config.s3_bucket,
        now: deps.now(),
      });
      deps.db
        .prepare<
          unknown,
          [
            string, // id
            string, // storage_backend
            string | null, // bucket
            string, // storage_key
            string | null, // original_filename_redacted
            string, // source_channel
            string, // source_message_id
            string, // source_job_id
            string | null, // source_external_id
            string, // artifact_type
            string, // retention_class
            string, // visibility
            string, // capture_status
            string, // status
            string | null, // capture_error_json
          ]
        >(
          `INSERT INTO storage_objects(
            id, storage_backend, bucket, storage_key,
            original_filename_redacted, source_channel, source_message_id,
            source_job_id, source_external_id, artifact_type,
            retention_class, visibility, capture_status, status, capture_error_json)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          objectId,
          row.storage_backend,
          row.bucket,
          row.storage_key,
          row.original_filename_redacted,
          row.source_channel,
          row.source_message_id,
          effectiveJobId,
          row.source_external_id,
          row.artifact_type,
          row.retention_class,
          row.visibility,
          row.capture_status,
          row.status,
          row.capture_error_json,
        );
      storageIds.push(objectId);
    }
  }

  // Mark the telegram_updates row enqueued and attach the job id.
  deps.db
    .prepare<unknown, [string, number]>(
      `UPDATE telegram_updates
       SET status = 'enqueued', job_id = ?, processed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE update_id = ?`,
    )
    .run(effectiveJobId, update.update_id);

  return {
    update_id: update.update_id,
    telegram_status: "enqueued",
    skip_reason: null,
    job_id: effectiveJobId,
    storage_object_ids: storageIds,
  };
}

function markSkipped(
  deps: InboundDeps,
  update_id: number,
  reason: SkipReason,
): void {
  deps.db
    .prepare<unknown, [string, number]>(
      `UPDATE telegram_updates
       SET status = 'skipped', skip_reason = ?, processed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE update_id = ?`,
    )
    .run(reason, update_id);
}

function ensureActiveSession(
  deps: InboundDeps,
  args: { chat_id: string; user_id: string },
): { id: string } {
  const existing = deps.db
    .prepare<{ id: string }, [string, string]>(
      `SELECT id FROM sessions WHERE chat_id = ? AND user_id = ? AND status = 'active'
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(args.chat_id, args.user_id);
  if (existing) return { id: existing.id };

  const id = deps.newId();
  deps.db
    .prepare<unknown, [string, string, string]>(
      `INSERT INTO sessions(id, chat_id, user_id) VALUES(?, ?, ?)`,
    )
    .run(id, args.chat_id, args.user_id);
  return { id };
}

// ---------------------------------------------------------------
// Batch processing (one BEGIN IMMEDIATE per batch per HLD §7.1)
// ---------------------------------------------------------------

export function processBatch(
  deps: InboundDeps,
  updates: readonly TelegramUpdate[],
): BatchResult {
  return deps.db.tx<BatchResult>(() => {
    const processed: ProcessedOutcome[] = [];
    let maxUpdateId = readOffset(deps.db) - 1;
    for (const u of updates) {
      // Insert the received row (idempotent by update_id).
      insertReceived(deps, u);
      const outcome = classifyAndCommit(deps, u);
      processed.push(outcome);
      if (u.update_id > maxUpdateId) maxUpdateId = u.update_id;
    }
    const offsetAfter = maxUpdateId + 1;
    writeOffset(deps.db, offsetAfter);
    return { processed, offset_after: offsetAfter };
  });
}

function writeOffset(db: DbHandle, value: number): void {
  db.prepare<unknown, [string, string]>(
    `INSERT INTO settings(key, value, updated_at)
     VALUES(?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(OFFSET_KEY, String(value));
}
