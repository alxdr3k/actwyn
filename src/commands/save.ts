// Personal Agent P0 — /save_last_attachment command.
//
// Spec references:
//   - PRD §8.1, §12.8 promotion rule
//   - DEC-013 (session → long_term promotion requires explicit
//     user intent)
//   - HLD §5.1 writer map (commands/save_last_attachment writes
//     memory_artifact_links)
//
// Only the most recent captured attachment in the session is
// eligible. Non-captured rows are ignored (we don't promote bytes
// we don't hold).

import type { DbHandle } from "~/db.ts";

export interface SaveResult {
  readonly promoted: boolean;
  readonly storage_object_id?: string;
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
      .prepare<{ id: string }, [string]>(
        `SELECT so.id
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
      return { promoted: true, storage_object_id: row.id };
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
      memory_artifact_link_id: linkId,
    };
  });
}
