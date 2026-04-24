// Personal Agent P0 — pure attachment-metadata helpers.
//
// This module is the ONLY place inbound-side attachment logic
// lives. It is deliberately pure: no SQL, no network, no file
// I/O. The inbound writer (src/telegram/inbound.ts) calls these
// helpers to construct storage_objects row shapes *inside* the
// inbound txn.
//
// PRD §13.5 Phase 1 + HLD §9.3 Phase 1:
//   - Classify the Telegram attachment.
//   - If the Telegram update itself already tells us file_size is
//     above the configured cap, mark the row capture_status='failed'
//     with reason 'oversize_inbound' — still no network I/O.
//   - Otherwise: capture_status='pending', source_external_id=file_id.
//
// MUST NOT: call getFile, download bytes, or probe MIME.

import { generateStorageKey } from "~/storage/objects.ts";
import type {
  TelegramAudio,
  TelegramDocument,
  TelegramMessage,
  TelegramPhotoSize,
  TelegramVideo,
  TelegramVoice,
} from "~/telegram/types.ts";

export type AttachmentKind = "photo" | "document" | "audio" | "video" | "voice";

/**
 * Classified attachment descriptor. Redaction-safe: claimed mime
 * and filename are stored in `raw_claimed_*` fields that the
 * inbound writer must pass through the redactor before persisting.
 */
export interface AttachmentDescriptor {
  readonly kind: AttachmentKind;
  readonly file_id: string;
  readonly file_unique_id: string;
  readonly claimed_mime_type: string | null;
  readonly claimed_size_bytes: number | null;
  readonly claimed_filename: string | null;
}

export interface InboundAttachmentConfig {
  /** Hard cap from the inbound payload; rows with claimed_size above this are flagged oversize. */
  readonly max_inbound_size_bytes: number;
}

export interface InboundAttachmentRow {
  readonly storage_backend: "s3" | "local";
  readonly bucket: string | null;
  readonly storage_key: string;
  readonly source_channel: "telegram";
  readonly source_message_id: string;
  readonly source_external_id: string | null;
  readonly artifact_type: "user_upload";
  readonly retention_class: "session";
  readonly visibility: "private";
  readonly capture_status: "pending" | "failed";
  readonly status: "pending";
  readonly capture_error_json: string | null;
  readonly original_filename_redacted: string | null;
  readonly mime_type: string | null;
  readonly size_bytes: number | null;
}

export interface StorageKeyArgs {
  readonly user_id: string;
  readonly object_id: string;
  readonly kind: AttachmentKind;
  /** Creation timestamp used for the date hierarchy in the key (PRD §12.8.4). */
  readonly date?: Date | undefined;
}

// ---------------------------------------------------------------
// Classification
// ---------------------------------------------------------------

export function classifyAttachments(
  message: TelegramMessage,
): AttachmentDescriptor[] {
  const out: AttachmentDescriptor[] = [];

  if (message.photo && message.photo.length > 0) {
    const best = pickLargestPhoto(message.photo);
    out.push({
      kind: "photo",
      file_id: best.file_id,
      file_unique_id: best.file_unique_id,
      claimed_mime_type: null, // Telegram doesn't send it for photos.
      claimed_size_bytes: best.file_size ?? null,
      claimed_filename: null,
    });
  }

  if (message.document) {
    out.push(fromDocument(message.document));
  }

  if (message.audio) {
    out.push(fromAudio(message.audio));
  }

  if (message.video) {
    out.push(fromVideo(message.video));
  }

  if (message.voice) {
    out.push(fromVoice(message.voice));
  }

  return out;
}

function pickLargestPhoto(
  sizes: readonly TelegramPhotoSize[],
): TelegramPhotoSize {
  let best = sizes[0]!;
  let bestArea = best.width * best.height;
  for (const s of sizes.slice(1)) {
    const a = s.width * s.height;
    if (a > bestArea) {
      best = s;
      bestArea = a;
    }
  }
  return best;
}

function fromDocument(d: TelegramDocument): AttachmentDescriptor {
  return {
    kind: "document",
    file_id: d.file_id,
    file_unique_id: d.file_unique_id,
    claimed_mime_type: d.mime_type ?? null,
    claimed_size_bytes: d.file_size ?? null,
    claimed_filename: d.file_name ?? null,
  };
}

function fromAudio(a: TelegramAudio): AttachmentDescriptor {
  return {
    kind: "audio",
    file_id: a.file_id,
    file_unique_id: a.file_unique_id,
    claimed_mime_type: a.mime_type ?? null,
    claimed_size_bytes: a.file_size ?? null,
    claimed_filename: a.title ?? null,
  };
}

function fromVideo(v: TelegramVideo): AttachmentDescriptor {
  return {
    kind: "video",
    file_id: v.file_id,
    file_unique_id: v.file_unique_id,
    claimed_mime_type: v.mime_type ?? null,
    claimed_size_bytes: v.file_size ?? null,
    claimed_filename: null,
  };
}

function fromVoice(v: TelegramVoice): AttachmentDescriptor {
  return {
    kind: "voice",
    file_id: v.file_id,
    file_unique_id: v.file_unique_id,
    claimed_mime_type: v.mime_type ?? null,
    claimed_size_bytes: v.file_size ?? null,
    claimed_filename: null,
  };
}

// ---------------------------------------------------------------
// Row construction
// ---------------------------------------------------------------

export function buildStorageObjectRow(args: {
  storage_object_id: string;
  user_id: string;
  message_id: number;
  descriptor: AttachmentDescriptor;
  config: InboundAttachmentConfig;
  /** Filename is only persisted (redacted) if the redactor clears it. */
  filenameIsRedactionSafe: (filename: string) => boolean;
  /** Storage-key builder; §12.8.4 canonical pattern. */
  storageKey: (args: StorageKeyArgs) => string;
  bucket: string | null;
  /** Timestamp for the date hierarchy in the provisional key. Defaults to now(). */
  now?: Date | undefined;
}): InboundAttachmentRow {
  const { descriptor, config } = args;
  const oversize =
    descriptor.claimed_size_bytes !== null &&
    descriptor.claimed_size_bytes > config.max_inbound_size_bytes;

  const capture_status: "pending" | "failed" = oversize ? "failed" : "pending";
  const capture_error_json = oversize
    ? JSON.stringify({
        reason: "oversize_inbound",
        claimed_size_bytes: descriptor.claimed_size_bytes,
        max_inbound_size_bytes: config.max_inbound_size_bytes,
      })
    : null;

  const filename =
    descriptor.claimed_filename &&
    args.filenameIsRedactionSafe(descriptor.claimed_filename)
      ? descriptor.claimed_filename
      : null;

  // storage_backend defaults to 's3' for session attachments to
  // match PRD §12.8.3 (session attachments are S3-eligible only
  // after user save). The actual upload is gated by retention
  // class + storage/sync, so choosing 's3' here is about the key
  // namespace, not about where it lives yet.
  const storage_backend = args.bucket !== null ? "s3" : "local";
  const bucket = storage_backend === "s3" ? args.bucket : null;
  const key = args.storageKey({
    user_id: args.user_id,
    object_id: args.storage_object_id,
    kind: descriptor.kind,
    date: args.now,
  });

  return {
    storage_backend,
    bucket,
    storage_key: key,
    source_channel: "telegram",
    source_message_id: String(args.message_id),
    // source_external_id is cleared for oversize-inbound rows too
    // — we won't be calling getFile on them, so there is no
    // legitimate need to keep the Telegram file_id around.
    source_external_id: oversize ? null : descriptor.file_id,
    artifact_type: "user_upload",
    retention_class: "session",
    visibility: "private",
    capture_status,
    status: "pending",
    capture_error_json,
    original_filename_redacted: filename,
    // claimed mime/size are PROBE data; we never trust them as
    // ground truth, so we leave the authoritative columns NULL
    // until the capture pass (Phase 4) writes real values.
    mime_type: null,
    size_bytes: null,
  };
}

/**
 * PRD §12.8.4 provisional key (pre-capture, sha256 not yet known).
 * Format: objects/{yyyy}/{mm}/{dd}/{object_id}/capture_pending.bin
 * The key is finalized (sha256 inserted) by commitCaptureSuccess in
 * src/telegram/attachment_capture.ts.
 */
export function defaultStorageKey(args: StorageKeyArgs): string {
  return generateStorageKey({
    date: args.date ?? new Date(),
    object_id: args.object_id,
    // sha256 omitted → provisional sentinel key
  });
}
