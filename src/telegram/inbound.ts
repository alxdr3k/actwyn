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
import { parseSaveIntent } from "~/commands/save.ts";
import { parseCorrection } from "~/commands/correct.ts";
import { cancelJob } from "~/commands/cancel.ts";
import type { StorageCapacityReport } from "~/storage/capacity.ts";

// ---------------------------------------------------------------
// Classification (pure)
// ---------------------------------------------------------------

export type SkipReason =
  | "unauthorized"
  | "unsupported_type"
  | "unsupported_chat_type"
  | "bootstrap_whoami_only"
  | "malformed";

export type Classification =
  | { kind: "skip"; reason: SkipReason }
  | { kind: "text"; text: string; has_attachments: boolean; explicit_save_intent?: boolean }
  | { kind: "command"; command: string; args: string; has_attachments: boolean }
  | { kind: "unknown_command"; command: string }
  | { kind: "whoami_bootstrap" }
  | { kind: "nl_correction"; old_hint: string; new_value: string; original_text: string };

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

  // Review Blocker 7: P0 only supports 1:1 DMs. Reject group / supergroup /
  // channel chats even when sent by the authorized user, so we never persist
  // messages from other participants as agent context.
  const chatType = msg.chat?.type;
  if (chatType !== undefined && chatType !== "private") {
    return { kind: "skip", reason: "unsupported_chat_type" };
  }

  const text = (msg.text ?? msg.caption ?? "").trim();
  const hasAttachments =
    !!(msg.photo || msg.document || msg.audio || msg.video || msg.voice);

  const cmd = parseCommand(text);
  if (cmd) {
    if ("unknown" in cmd) {
      // Unknown slash command — do not forward to provider.
      return { kind: "unknown_command", command: cmd.unknown };
    }
    return {
      kind: "command",
      command: cmd.command,
      args: cmd.args,
      has_attachments: hasAttachments,
    };
  }

  // Natural-language save intent (ADR-0006): "save this", "저장해", etc.
  // Parse even when attachments are present — a caption like "이 사진 저장해줘"
  // alongside a photo is the primary real-world case for long_term retention.
  // When hasAttachments, the save intent is carried through request_payload so
  // the inbound writer can set retention_class='long_term' at insert time.
  const saveIntent = parseSaveIntent(text);
  if (saveIntent && !hasAttachments) {
    return {
      kind: "command",
      command: "/save_last_attachment",
      args: saveIntent.caption ?? "",
      has_attachments: false,
    };
  }

  // Natural-language correction intent (DEC-007 / US-09): "정정: X가 아니라 Y야", "not X but Y".
  const correction = !hasAttachments ? parseCorrection(text) : null;
  if (correction) {
    return {
      kind: "nl_correction",
      old_hint: correction.old_hint,
      new_value: correction.new_value,
      original_text: text,
    };
  }

  if (text.length > 0 || hasAttachments) {
    return {
      kind: "text",
      text,
      has_attachments: hasAttachments,
      ...(hasAttachments && saveIntent ? { explicit_save_intent: true } : {}),
    };
  }

  return { kind: "skip", reason: "unsupported_type" };
}

function isWhoamiText(msg: TelegramMessage): boolean {
  const t = (msg.text ?? "").trim();
  return t.startsWith("/whoami");
}

const KNOWN_COMMANDS = new Set<string>([
  "/new",
  "/chat",
  "/help",
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
  // Phase 1B.3 — Judgment System read commands
  "/judgment",
  "/judgment_explain",
  // Phase 1B.4 — Judgment System write commands
  "/judgment_propose",
  "/judgment_approve",
  "/judgment_reject",
  "/judgment_source",
  "/judgment_link",
  "/judgment_commit",
]);

function parseCommand(text: string): { command: string; args: string } | { unknown: string } | null {
  if (!text.startsWith("/")) return null;
  const head = text.split(/\s+/, 1)[0]!;
  // Strip optional `@botname` suffix.
  const command = head.split("@", 1)[0]!;
  if (!KNOWN_COMMANDS.has(command)) {
    // Unknown slash command — return a sentinel so the caller can
    // send a help response without forwarding to the provider.
    return { unknown: command };
  }
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
  readonly storage_capacity_check?: () => StorageCapacityReport;
}

export interface InboundDeps {
  readonly db: DbHandle;
  readonly redactor: Redactor;
  readonly config: InboundConfig;
  readonly newId: () => string;
  readonly now: () => Date;
  /**
   * Shared AbortController registry from the worker.
   * When present, /cancel is handled immediately in the inbound path
   * (control-plane semantics) rather than queued as a regular job.
   * This lets /cancel abort a running provider_run without waiting for
   * the queue to drain.
   */
  readonly cancel_handles?: Map<string, AbortController> | undefined;
}

export interface ProcessedOutcome {
  readonly update_id: number;
  readonly telegram_status: "enqueued" | "skipped";
  readonly skip_reason: SkipReason | null;
  readonly job_id: string | null;
  readonly storage_object_ids: readonly string[];
  /**
   * Set when /cancel is handled immediately in the inbound path
   * (control-plane). The poller sends this notification outside the
   * DB txn so the zero-network-IO invariant in classifyAndCommit is
   * preserved.
   */
  readonly instant_response?: { chat_id: string; text: string } | undefined;
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

export type InsertReceivedResult =
  | { kind: "inserted" }
  | { kind: "existing"; existing_status: "received" | "enqueued" | "skipped" | "failed"; job_id: string | null; skip_reason: SkipReason | null };

/**
 * Insert-or-no-op a received Telegram update into `telegram_updates`.
 *
 * Review Blocker 6: duplicate deliveries must not re-run side effects
 * (session creation, attachment rows, NL intent parsing). When the row
 * already exists AND its status is terminal (`enqueued`|`skipped`), the
 * caller treats this as a no-op rather than re-processing.
 *
 * This runs in its own single-statement txn context (caller may
 * wrap a batch in BEGIN IMMEDIATE).
 */
export function insertReceived(
  deps: InboundDeps,
  update: TelegramUpdate,
): InsertReceivedResult {
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
  if ((res.changes ?? 0) > 0) return { kind: "inserted" };

  const existing = deps.db
    .prepare<
      { status: "received" | "enqueued" | "skipped" | "failed"; job_id: string | null; skip_reason: SkipReason | null },
      [number]
    >(`SELECT status, job_id, skip_reason FROM telegram_updates WHERE update_id = ?`)
    .get(update.update_id);
  return {
    kind: "existing",
    existing_status: existing?.status ?? "received",
    job_id: existing?.job_id ?? null,
    skip_reason: existing?.skip_reason ?? null,
  };
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

  // Control-plane: /cancel is handled immediately without going through the
  // job queue. This lets it abort a running provider_run that is blocking the
  // single-concurrency worker — a queued cancel job would be processed only
  // after the provider_run finishes, defeating its purpose.
  if (classification.kind === "command" && classification.command === "/cancel") {
    const outcome = cancelJob(deps.db, {
      session_id: session.id,
      deps: { running_cancel_handles: deps.cancel_handles },
    });
    let responseText: string;
    switch (outcome.kind) {
      case "cancelled_queued":
        responseText = `취소됐습니다 (job_id=${outcome.job_id}).`;
        break;
      case "cancel_signalled":
        responseText = `실행 중인 작업에 취소 신호를 보냈습니다 (job_id=${outcome.job_id}).`;
        break;
      case "cancel_unavailable":
        responseText = `실행 중인 작업을 이 프로세스에서 취소할 수 없습니다 (job_id=${outcome.job_id}). /status 로 상태를 확인하세요.`;
        break;
      case "not_found":
        responseText = "취소할 활성 작업이 없습니다.";
        break;
      case "terminal":
        responseText = `작업은 이미 종료됐습니다 (status=${outcome.status}).`;
        break;
    }
    deps.db
      .prepare<unknown, [number]>(
        `UPDATE telegram_updates
         SET status = 'enqueued', processed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE update_id = ?`,
      )
      .run(update.update_id);
    return {
      update_id: update.update_id,
      telegram_status: "enqueued",
      skip_reason: null,
      job_id: null,
      storage_object_ids: [],
      instant_response: { chat_id, text: responseText },
    };
  }

  // Unknown slash command: send a help hint and skip job creation.
  // A typo like "/foobar" must not be forwarded to the provider.
  if (classification.kind === "unknown_command") {
    deps.db
      .prepare<unknown, [number]>(
        `UPDATE telegram_updates
         SET status = 'skipped', skip_reason = 'unsupported_type',
             processed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE update_id = ?`,
      )
      .run(update.update_id);
    return {
      update_id: update.update_id,
      telegram_status: "skipped",
      skip_reason: null,
      job_id: null,
      storage_object_ids: [],
      instant_response: {
        chat_id,
        text: `알 수 없는 명령입니다: ${classification.command}. /help를 확인하세요.`,
      },
    };
  }

  // NL correction: try to resolve old_hint → memory item ID (DEC-007 / US-09).
  // Falls back to regular text if no matching memory item is found.
  let resolvedClassification: typeof classification = classification;
  if (classification.kind === "nl_correction") {
    const match = deps.db
      .prepare<{ id: string }, [string, string]>(
        `SELECT id FROM memory_items
         WHERE session_id = ? AND status = 'active'
           AND content LIKE ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(session.id, `%${classification.old_hint}%`);
    if (match) {
      resolvedClassification = {
        kind: "command",
        command: "/correct",
        args: `${match.id} ${classification.new_value}`,
        has_attachments: false,
      };
    } else {
      resolvedClassification = {
        kind: "text",
        text: classification.original_text,
        has_attachments: false,
      };
    }
  }

  const jobId = deps.newId();
  // resolvedClassification is always "command" or "text" here (nl_correction was resolved above).
  const isCmd = resolvedClassification.kind === "command";
  const isTxt = resolvedClassification.kind === "text";
  const commandField = isCmd ? (resolvedClassification as { command: string }).command : null;
  const requestPayload = {
    command: commandField,
    args: isCmd ? (resolvedClassification as { args: string }).args : "",
    text: isTxt ? (resolvedClassification as { text: string }).text : "",
    has_attachments: (resolvedClassification as { has_attachments?: boolean }).has_attachments ?? false,
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
      `INSERT INTO jobs(id, status, job_type, session_id, user_id, chat_id, request_json,
                        idempotency_key, provider, safe_retry, max_attempts)
       VALUES(?, 'queued', ?, ?, ?, ?, ?, ?, ?, 1, 2)
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

  // explicit_save_intent: caption alongside attachment said "저장해줘" etc.
  // Promote all attachments in this message to long_term at insert time so
  // they are eligible for S3 sync immediately after capture.
  const explicitSaveIntent =
    resolvedClassification.kind === "text" &&
    (resolvedClassification as { explicit_save_intent?: boolean }).explicit_save_intent === true;
  const capacity =
    explicitSaveIntent && deps.config.storage_capacity_check
      ? deps.config.storage_capacity_check()
      : null;
  const longTermAllowed = !capacity || capacity.long_term_writes_allowed;

  // Attachments: metadata-only insert, NO network I/O.
  const storageIds: string[] = [];
  if (requestPayload.has_attachments) {
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
      // Override retention_class when caption expressed explicit save intent.
      const retentionClass = explicitSaveIntent && longTermAllowed ? "long_term" : row.retention_class;
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
          retentionClass,
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
    ...(explicitSaveIntent && !longTermAllowed && capacity
      ? {
          instant_response: {
            chat_id,
            text:
              "첨부파일은 받았지만 디스크 용량 임계치 때문에 long_term 저장은 보류했습니다. " +
              `현재 상태: ${capacity.detail}`,
          },
        }
      : {}),
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
      const inserted = insertReceived(deps, u);
      // Review Blocker 6: for a duplicate update whose previous processing
      // already reached a terminal status, do NOT re-run classifyAndCommit.
      // Re-running would: create duplicate storage_objects (new UUIDs each
      // time bypass the jobs idempotency guard), re-trigger NL intent side
      // effects, and reset the already-set job_id on the row.
      //
      // Follow-up review note: only `enqueued` and `skipped` are durably
      // terminal. `failed` is a recovery state — a duplicate delivery for
      // a previously-failed row MUST go back through classifyAndCommit so
      // the operator (or Telegram retrying the same update_id) can pick
      // it up. Otherwise updates can be silently dropped after partial
      // recovery. `received` likewise means the prior pass crashed before
      // committing; reprocessing is correct.
      if (
        inserted.kind === "existing" &&
        (inserted.existing_status === "enqueued" || inserted.existing_status === "skipped")
      ) {
        processed.push({
          update_id: u.update_id,
          telegram_status: inserted.existing_status,
          skip_reason: inserted.skip_reason,
          job_id: inserted.job_id,
          storage_object_ids: [],
        });
        if (u.update_id > maxUpdateId) maxUpdateId = u.update_id;
        continue;
      }
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
