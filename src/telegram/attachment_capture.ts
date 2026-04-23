// Personal Agent P0 — Telegram attachment capture pass.
//
// Runs in queue/worker BEFORE the provider adapter is invoked
// (HLD §7.2 step 3 / PRD §13.5 Phase 2). Responsibilities:
//   1. For each storage_objects row owned by the job with
//      capture_status='pending':
//      - Call Telegram getFile, download bytes, probe MIME,
//        compute sha256 and size.
//      - In a single post-capture txn, set capture_status='captured'
//        + sha256/mime/size/captured_at AND clear
//        source_external_id (PRD §13.5 retention policy).
//      - If retention_class is S3-eligible, enqueue a storage_sync job.
//   2. On failure, set capture_status='failed' with
//      capture_error_json. For non-retryable failures clear
//      source_external_id in the same txn.
//   3. The provider_run is NOT blocked by capture failure; the
//      worker keeps going with a capture-failure note so the user
//      turn still commits.
//
// The transport (getFile/download) and the MIME probe are
// injected so tests can deterministically inject failures.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { DbHandle } from "~/db.ts";
import type { EventEmitter } from "~/observability/events.ts";

// ---------------------------------------------------------------
// Transport contract
// ---------------------------------------------------------------

export interface TelegramFileHandle {
  readonly file_id: string;
  readonly file_path: string;
  readonly file_size: number | null;
}

export interface TelegramFileTransport {
  getFile(file_id: string): Promise<TelegramFileHandle>;
  download(handle: TelegramFileHandle): Promise<Uint8Array>;
}

export interface MimeProbe {
  probe(bytes: Uint8Array, hint?: string | undefined): Promise<string>;
}

// ---------------------------------------------------------------
// Capture classification
// ---------------------------------------------------------------

export type CaptureFailureReason =
  | "get_file_failed"
  | "download_failed"
  | "mime_probe_failed"
  | "oversize_at_download"
  | "hash_failed";

export type FailureCategory = "retryable" | "non_retryable";

export function classifyFailure(reason: CaptureFailureReason): FailureCategory {
  switch (reason) {
    case "oversize_at_download":
      return "non_retryable";
    case "mime_probe_failed":
      return "non_retryable";
    default:
      // network-ish failures are retryable per PRD §13.5 retention
      return "retryable";
  }
}

// ---------------------------------------------------------------
// Pure capture helper (I/O via injected deps).
// ---------------------------------------------------------------

export interface CaptureConfig {
  readonly max_download_size_bytes: number;
  /** Where to write local copies; e.g. `data/objects/{storage_object_id}` */
  local_path(storage_object_id: string): string;
}

export interface CaptureInput {
  readonly storage_object_id: string;
  readonly file_id: string;
  /** The existing sync-status we must preserve. */
  readonly current_sync_status: string;
}

export interface CaptureSuccess {
  readonly kind: "success";
  readonly storage_object_id: string;
  readonly local_path: string;
  readonly sha256: string;
  readonly mime_type: string;
  readonly size_bytes: number;
}

export interface CaptureFailure {
  readonly kind: "failure";
  readonly storage_object_id: string;
  readonly reason: CaptureFailureReason;
  readonly category: FailureCategory;
  readonly detail: string;
}

export type CaptureResult = CaptureSuccess | CaptureFailure;

export async function captureOne(args: {
  input: CaptureInput;
  transport: TelegramFileTransport;
  mime: MimeProbe;
  config: CaptureConfig;
}): Promise<CaptureResult> {
  let handle: TelegramFileHandle;
  try {
    handle = await args.transport.getFile(args.input.file_id);
  } catch (e) {
    return failure(args.input.storage_object_id, "get_file_failed", (e as Error).message);
  }

  if (handle.file_size !== null && handle.file_size > args.config.max_download_size_bytes) {
    return failure(
      args.input.storage_object_id,
      "oversize_at_download",
      `file_size=${handle.file_size} > max=${args.config.max_download_size_bytes}`,
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = await args.transport.download(handle);
  } catch (e) {
    return failure(args.input.storage_object_id, "download_failed", (e as Error).message);
  }
  if (bytes.byteLength > args.config.max_download_size_bytes) {
    return failure(
      args.input.storage_object_id,
      "oversize_at_download",
      `downloaded_size=${bytes.byteLength} > max=${args.config.max_download_size_bytes}`,
    );
  }

  let mime: string;
  try {
    mime = await args.mime.probe(bytes);
  } catch (e) {
    return failure(args.input.storage_object_id, "mime_probe_failed", (e as Error).message);
  }

  let sha: string;
  try {
    sha = sha256Hex(bytes);
  } catch (e) {
    return failure(args.input.storage_object_id, "hash_failed", (e as Error).message);
  }

  const local_path = args.config.local_path(args.input.storage_object_id);
  try {
    mkdirSync(dirname(local_path), { recursive: true });
    writeFileSync(local_path, bytes);
  } catch (e) {
    return failure(args.input.storage_object_id, "download_failed", (e as Error).message);
  }

  return {
    kind: "success",
    storage_object_id: args.input.storage_object_id,
    local_path,
    sha256: sha,
    mime_type: mime,
    size_bytes: bytes.byteLength,
  };
}

function failure(
  storage_object_id: string,
  reason: CaptureFailureReason,
  detail: string,
): CaptureFailure {
  return {
    kind: "failure",
    storage_object_id,
    reason,
    category: classifyFailure(reason),
    detail,
  };
}

export function sha256Hex(bytes: Uint8Array): string {
  const h = createHash("sha256");
  h.update(bytes);
  return h.digest("hex");
}

// ---------------------------------------------------------------
// DB commit helpers
// ---------------------------------------------------------------

export interface PendingCapture {
  readonly storage_object_id: string;
  readonly source_external_id: string;
  readonly status: string;
  readonly retention_class: string;
}

export function pendingCapturesForJob(
  db: DbHandle,
  jobId: string,
): PendingCapture[] {
  return db
    .prepare<
      {
        storage_object_id: string;
        source_external_id: string;
        status: string;
        retention_class: string;
      },
      [string]
    >(
      `SELECT id AS storage_object_id, source_external_id, status, retention_class
       FROM storage_objects
       WHERE source_job_id = ? AND capture_status = 'pending' AND source_external_id IS NOT NULL`,
    )
    .all(jobId);
}

/**
 * Apply a capture success. Sets capture_status='captured', populates
 * sha256/mime/size/captured_at, clears source_external_id per
 * PRD §13.5. If retention class is S3-eligible, enqueue a
 * storage_sync job (HLD §5.3 idempotency_key = 'sync:'||object_id).
 * Everything in one db.tx().
 */
export function commitCaptureSuccess(args: {
  db: DbHandle;
  success: CaptureSuccess;
  retention_class: string;
  newId: () => string;
  events?: EventEmitter;
}): { syncJobId: string | null } {
  return args.db.tx<{ syncJobId: string | null }>(() => {
    args.db
      .prepare<
        unknown,
        [string, string, number, string]
      >(
        `UPDATE storage_objects
         SET capture_status = 'captured',
             captured_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
             sha256 = ?,
             mime_type = ?,
             size_bytes = ?,
             source_external_id = NULL,
             capture_error_json = NULL
         WHERE id = ? AND capture_status = 'pending'`,
      )
      .run(
        args.success.sha256,
        args.success.mime_type,
        args.success.size_bytes,
        args.success.storage_object_id,
      );

    let syncJobId: string | null = null;
    if (isS3Eligible(args.retention_class)) {
      syncJobId = args.newId();
      args.db
        .prepare<
          unknown,
          [string, string, string]
        >(
          `INSERT INTO jobs(id, status, job_type, request_json, idempotency_key)
           VALUES(?, 'queued', 'storage_sync', ?, ?)
           ON CONFLICT(job_type, idempotency_key) DO NOTHING`,
        )
        .run(
          syncJobId,
          JSON.stringify({ storage_object_id: args.success.storage_object_id }),
          `sync:${args.success.storage_object_id}`,
        );
    }

    if (args.events) {
      args.events.info("storage.capture.captured", {
        storage_object_id: args.success.storage_object_id,
        size_bytes: args.success.size_bytes,
        mime_type: args.success.mime_type,
        ...(syncJobId ? { sync_job_id: syncJobId } : {}),
      });
    }
    return { syncJobId };
  });
}

/**
 * Apply a capture failure. Sets capture_status='failed' with
 * capture_error_json. For non-retryable failures, clears
 * source_external_id immediately (PRD §13.5 retention policy).
 * Retryable failures retain source_external_id for a future retry
 * pass; the retry scheduler (Phase 9+) is responsible for clearing
 * it after the retry budget is exhausted.
 */
export function commitCaptureFailure(args: {
  db: DbHandle;
  failure: CaptureFailure;
  events?: EventEmitter;
}): void {
  args.db.tx<void>(() => {
    const errorJson = JSON.stringify({
      reason: args.failure.reason,
      category: args.failure.category,
      detail_redacted: args.failure.detail.slice(0, 200),
    });
    if (args.failure.category === "non_retryable") {
      args.db
        .prepare<unknown, [string, string]>(
          `UPDATE storage_objects
           SET capture_status = 'failed',
               capture_error_json = ?,
               source_external_id = NULL
           WHERE id = ? AND capture_status = 'pending'`,
        )
        .run(errorJson, args.failure.storage_object_id);
    } else {
      args.db
        .prepare<unknown, [string, string]>(
          `UPDATE storage_objects
           SET capture_status = 'failed',
               capture_error_json = ?
           WHERE id = ? AND capture_status = 'pending'`,
        )
        .run(errorJson, args.failure.storage_object_id);
    }
    if (args.events) {
      args.events.warn("storage.capture.failed", {
        storage_object_id: args.failure.storage_object_id,
        reason: args.failure.reason,
        category: args.failure.category,
      });
    }
  });
}

function isS3Eligible(retention_class: string): boolean {
  return retention_class === "long_term" || retention_class === "archive";
}
