// Personal Agent P0 — /forget_* commands.
//
// Spec references:
//   - PRD §8.1 (command list)
//   - DEC-006 (tombstone semantics; never hard-delete)
//   - HLD §6.4 (storage_objects.status — deletion_requested path)
//   - HLD §6.5 (memory_items.status — active|superseded → revoked)
//   - HLD §12.6 (delete path: sets deletion_requested, sync pass
//     issues S3 DELETE; local-only artifacts may go directly to
//     deleted once local cleanup succeeds)
//
// None of these commands call S3 directly. The sync worker
// (src/storage/sync.ts) sees the deletion_requested rows on its
// next pass.

import type { DbHandle } from "~/db.ts";
import { revokeMemoryItem } from "~/memory/items.ts";

export interface ForgetResult {
  readonly affected: number;
  readonly ids: readonly string[];
}

/**
 * /forget_artifact <id> — sets a specific storage_objects row to
 * deletion_requested; also removes any memory_artifact_links that
 * reference it (they are the "meaning" attached to the bytes and
 * should go away with the bytes — HLD §5.1 writer map).
 */
export function forgetArtifact(db: DbHandle, storage_object_id: string): ForgetResult {
  return db.tx<ForgetResult>(() => {
    const res = db
      .prepare<unknown, [string]>(
        `UPDATE storage_objects
         SET status = 'deletion_requested'
         WHERE id = ? AND status NOT IN ('deleted', 'delete_failed', 'deletion_requested')`,
      )
      .run(storage_object_id);
    if ((res.changes ?? 0) === 0) {
      return { affected: 0, ids: [] };
    }
    db.prepare<unknown, [string]>(
      `DELETE FROM memory_artifact_links WHERE storage_object_id = ?`,
    ).run(storage_object_id);
    return { affected: 1, ids: [storage_object_id] };
  });
}

/**
 * /forget_memory <id> — tombstone a memory_items row. active or
 * superseded → revoked. Idempotent.
 */
export function forgetMemory(db: DbHandle, memory_id: string): ForgetResult {
  const before = db
    .prepare<{ status: string }, [string]>(
      `SELECT status FROM memory_items WHERE id = ?`,
    )
    .get(memory_id);
  if (!before) return { affected: 0, ids: [] };
  revokeMemoryItem(db, memory_id);
  const after = db
    .prepare<{ status: string }, [string]>(
      `SELECT status FROM memory_items WHERE id = ?`,
    )
    .get(memory_id);
  const changed = before.status !== "revoked" && after?.status === "revoked";
  return {
    affected: changed ? 1 : 0,
    ids: changed ? [memory_id] : [],
  };
}

/**
 * /forget_session — revoke the current session's memory_summaries
 * promotion candidates and the active memory_items authored in
 * that session. storage_objects remain untouched (users use
 * /forget_artifact for that).
 */
export function forgetSession(db: DbHandle, session_id: string): ForgetResult {
  return db.tx<ForgetResult>(() => {
    const items = db
      .prepare<{ id: string }, [string]>(
        `SELECT id FROM memory_items WHERE session_id = ? AND status IN ('active', 'superseded')`,
      )
      .all(session_id);
    for (const row of items) {
      revokeMemoryItem(db, row.id);
    }
    return { affected: items.length, ids: items.map((r) => r.id) };
  });
}

/**
 * /forget_last — revoke the most recent memory_artifact_link (for
 * an attachment save) OR the most recent memory_items row in the
 * session. Semantics: "undo my last remember/save action".
 */
export function forgetLast(db: DbHandle, session_id: string): ForgetResult {
  return db.tx<ForgetResult>(() => {
    // Prefer the newest memory_artifact_links row if present —
    // /save_last_attachment writes one of these. Unlink by
    // deleting the link; the storage_objects row itself is kept
    // unless the user also runs /forget_artifact.
    const link = db
      .prepare<{ id: string; storage_object_id: string }, [string]>(
        `SELECT mal.id, mal.storage_object_id
         FROM memory_artifact_links mal
         WHERE mal.turn_id IN (SELECT id FROM turns WHERE session_id = ?)
         ORDER BY mal.created_at DESC LIMIT 1`,
      )
      .get(session_id);
    if (link) {
      db.prepare<unknown, [string]>(
        `DELETE FROM memory_artifact_links WHERE id = ?`,
      ).run(link.id);
      return { affected: 1, ids: [link.id] };
    }
    const latest = db
      .prepare<{ id: string }, [string]>(
        `SELECT id FROM memory_items
         WHERE session_id = ? AND status = 'active'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(session_id);
    if (!latest) return { affected: 0, ids: [] };
    revokeMemoryItem(db, latest.id);
    return { affected: 1, ids: [latest.id] };
  });
}
