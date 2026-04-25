// Personal Agent P0 — /save_last_attachment command.
//
// Spec references:
//   - PRD §8.1, §12.8 promotion rule
//   - DEC-013 (session → long_term promotion requires explicit
//     user intent)
//   - ADR-0006 (explicit-save-first; natural-language synonyms trigger
//     the same promotion as the slash command)
//   - HLD §5.1 writer map (commands/save_last_attachment writes
//     memory_artifact_links)
//
// Only the most recent captured attachment in the session is
// eligible. Non-captured rows are ignored (we don't promote bytes
// we don't hold).

import type { DbHandle } from "~/db.ts";

// ---------------------------------------------------------------
// Natural-language save intent detector (pure, ADR-0006)
// ---------------------------------------------------------------

export interface SaveIntent {
  readonly caption: string | null;
}

/**
 * Detect whether a free-text message expresses an explicit save
 * intent per ADR-0006. Returns null when no save phrase is found.
 * Recognises English and Korean patterns.
 */
export function parseSaveIntent(text: string): SaveIntent | null {
  const t = text.trim();
  if (!t) return null;

  // /save_last_attachment (slash command handled upstream, but kept
  // here for symmetry with parseCorrection so the dispatcher can
  // call a single entry point).
  if (/^\/save_last_attachment\b/i.test(t)) {
    const cap = t.replace(/^\/save_last_attachment\s*/i, "").trim();
    return { caption: cap || null };
  }

  // English natural language
  const EN_PATTERNS = [
    /\bsave\s+this\b/i,
    /\bkeep\s+this\b/i,
    /\bremember\s+this\s+file\b/i,
    /\bkeep\s+this\s+for\s+later\b/i,
    /\bstore\s+this\b/i,
    /\barchive\s+this\b/i,
  ];
  if (EN_PATTERNS.some((p) => p.test(t))) return { caption: null };

  // Korean natural language
  const KO_PATTERNS = [
    /이\s*파일\s*저장/,
    /저장\s*해/,
    /기억\s*해/,
    /보관\s*해/,
    /남겨\s*줘/,
  ];
  if (KO_PATTERNS.some((p) => p.test(t))) return { caption: null };

  return null;
}

export interface SaveResult {
  readonly promoted: boolean;
  readonly storage_object_id?: string;
  readonly artifact_type?: string;
  readonly memory_artifact_link_id?: string;
}

export function saveLastAttachment(args: {
  db: DbHandle;
  newId: () => string;
  session_id: string;
  caption?: string | undefined;
}): SaveResult {
  return args.db.tx<SaveResult>(() => {
    // Find the most recent captured attachment row owned by a
    // job in this session.
    const row = args.db
      .prepare<
        { id: string; artifact_type: string; storage_backend: string; status: string },
        [string]
      >(
        `SELECT so.id, so.artifact_type, so.storage_backend, so.status
         FROM storage_objects so
         JOIN jobs j ON j.id = so.source_job_id
         WHERE j.session_id = ?
           AND so.source_channel = 'telegram'
           AND so.capture_status = 'captured'
         ORDER BY so.captured_at DESC LIMIT 1`,
      )
      .get(args.session_id);
    if (!row) return { promoted: false };

    args.db
      .prepare<unknown, [string]>(
        `UPDATE storage_objects
         SET retention_class = 'long_term'
         WHERE id = ?`,
      )
      .run(row.id);

    // Review Blocker 4: promoting retention_class to long_term must enqueue
    // a storage_sync job so the uploader actually pushes the bytes to S3.
    // Without this enqueue the row stays status='pending' forever and the
    // user sees "saved" but the bytes never leave the host.
    if (row.storage_backend === "s3" && row.status === "pending") {
      args.db
        .prepare<unknown, [string, string]>(
          `INSERT INTO jobs(id, status, job_type, request_json, idempotency_key)
           VALUES(?, 'queued', 'storage_sync', '{}', ?)
           ON CONFLICT(job_type, idempotency_key) DO NOTHING`,
        )
        .run(args.newId(), `sync:${row.id}`);
    }

    // Create a memory_artifact_links row with user_stated
    // provenance (the user explicitly asked to save).
    const linkId = args.newId();
    // We need a turn to reference; pick the latest turn in this
    // session to anchor the link.
    const turn = args.db
      .prepare<{ id: string }, [string]>(
        `SELECT id FROM turns WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(args.session_id);
    if (!turn) {
      // No turn to anchor: skip link creation but keep promotion.
      return { promoted: true, storage_object_id: row.id, artifact_type: row.artifact_type };
    }
    args.db
      .prepare<unknown, [string, string, string, string | null]>(
        `INSERT INTO memory_artifact_links
           (id, storage_object_id, turn_id, relation_type, provenance, caption_or_summary)
         VALUES(?, ?, ?, 'attachment', 'user_stated', ?)`,
      )
      .run(linkId, row.id, turn.id, args.caption ?? null);

    return {
      promoted: true,
      storage_object_id: row.id,
      artifact_type: row.artifact_type,
      memory_artifact_link_id: linkId,
    };
  });
}
