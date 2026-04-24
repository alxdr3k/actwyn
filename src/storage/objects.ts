// Personal Agent P0 — storage_objects row authoring helpers.
//
// Spec references:
//   - PRD §12.8.4 (S3 object key design)
//   - PRD §12.8.1 (artifact types)
//   - AC-SEC-002 (keys must match objects/{yyyy}/{mm}/{dd}/{uuid}/{sha256}.[a-z0-9]+)
//
// This module provides:
//   1. safeExtensionFromMime — maps detected MIME to a safe file extension.
//   2. generateStorageKey — composes the PRD-compliant S3 key.
//      - Provisional (pre-capture, sha256 unknown): uses "capture_pending" as
//        the sha256 segment so the key is still valid and unique.
//      - Final (post-capture): uses the real sha256.
//   3. finalizeStorageKey — convenience wrapper for the post-capture update.
//
// Keys never contain user names, filenames, chat IDs, or project names
// (PRD §12.8.4, AC-SEC-002).

// ---------------------------------------------------------------
// MIME → safe extension
// ---------------------------------------------------------------

const MIME_TO_EXT: ReadonlyMap<string, string> = new Map([
  ["image/jpeg", "jpg"],
  ["image/jpg", "jpg"],
  ["image/png", "png"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
  ["image/bmp", "bmp"],
  ["image/tiff", "tiff"],
  ["image/svg+xml", "svg"],
  ["application/pdf", "pdf"],
  ["application/json", "json"],
  ["application/zip", "zip"],
  ["application/gzip", "gz"],
  ["application/x-tar", "tar"],
  ["application/octet-stream", "bin"],
  ["text/plain", "txt"],
  ["text/html", "html"],
  ["text/csv", "csv"],
  ["text/markdown", "md"],
  ["audio/mpeg", "mp3"],
  ["audio/ogg", "ogg"],
  ["audio/wav", "wav"],
  ["audio/webm", "webm"],
  ["video/mp4", "mp4"],
  ["video/webm", "webm"],
  ["video/ogg", "ogv"],
  ["video/quicktime", "mov"],
]);

/**
 * Maps a detected MIME type to a safe, lowercase file extension with no
 * user-facing semantics (PRD §12.8.4). Unknown MIME types return "bin".
 */
export function safeExtensionFromMime(mime: string | null | undefined): string {
  if (!mime) return "bin";
  const base = mime.split(";")[0]!.trim().toLowerCase();
  return MIME_TO_EXT.get(base) ?? "bin";
}

// ---------------------------------------------------------------
// Key generation
// ---------------------------------------------------------------

const PROVISIONAL_SHA256 = "capture_pending";

/**
 * Generate a PRD §12.8.4 compliant S3 object key.
 *
 *   objects/{yyyy}/{mm}/{dd}/{object_id}/{sha256_or_provisional}.{safe_ext}
 *
 * When sha256 is omitted or null (pre-capture phase), uses the sentinel
 * value "capture_pending" so the key is still valid and unique.
 * The final key (with real sha256) is composed at capture time via
 * finalizeStorageKey().
 */
export function generateStorageKey(args: {
  readonly date: Date;
  readonly object_id: string;
  readonly sha256?: string | null;
  readonly mime_type?: string | null;
}): string {
  const d = args.date;
  const yyyy = d.getUTCFullYear().toString();
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = d.getUTCDate().toString().padStart(2, "0");
  const sha = args.sha256 ?? PROVISIONAL_SHA256;
  const ext = safeExtensionFromMime(args.mime_type ?? null);
  return `objects/${yyyy}/${mm}/${dd}/${args.object_id}/${sha}.${ext}`;
}

/**
 * Compose the FINAL key for a captured artifact. Identical to
 * generateStorageKey but requires sha256 to be present.
 */
export function finalizeStorageKey(args: {
  readonly date: Date;
  readonly object_id: string;
  readonly sha256: string;
  readonly mime_type: string | null;
}): string {
  return generateStorageKey({
    date: args.date,
    object_id: args.object_id,
    sha256: args.sha256,
    mime_type: args.mime_type,
  });
}

/**
 * Return true if a stored storage_key is the provisional pre-capture
 * sentinel (i.e. sha256 has not been computed yet).
 */
export function isProvisionalKey(storage_key: string): boolean {
  return storage_key.includes(`/${PROVISIONAL_SHA256}.`);
}
