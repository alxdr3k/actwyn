// Personal Agent P0 — memory_items writer with supersede semantics.
//
// Spec references:
//   - PRD Appendix D memory_items schema
//   - HLD §6.5 memory_items.status state machine
//   - DEC-007: supersede, not overwrite (tombstones)
//
// Invariants:
//   - Every new row inserted with status='active'. Superseding a
//     prior row flips the old row from 'active' to 'superseded'
//     in the SAME db.tx() as the new INSERT (HLD §6.5 invariant 2).
//   - /forget_memory moves 'active' or 'superseded' to 'revoked'
//     — tombstone only, never hard-deleted.

import type { DbHandle } from "~/db.ts";
import { mayPersistAsMemoryItem, type Provenance } from "~/memory/provenance.ts";

export type ItemType = "fact" | "preference" | "decision" | "open_task" | "caution";

export interface NewMemoryItem {
  readonly session_id: string;
  readonly project_id?: string | null;
  readonly item_type: ItemType;
  readonly content: string;
  readonly content_json?: string | null;
  readonly provenance: Provenance;
  readonly confidence: number;
  readonly source_turn_ids: readonly string[];
}

export class MemoryProvenanceError extends Error {
  override readonly name = "MemoryProvenanceError";
}

function assertMayPersistAsMemoryItem(item: NewMemoryItem): void {
  if (mayPersistAsMemoryItem(item.provenance, item.item_type)) return;
  throw new MemoryProvenanceError(
    `preferences require provenance ∈ {user_stated, user_confirmed}; got ${item.provenance}`,
  );
}

export function insertMemoryItem(
  db: DbHandle,
  id: string,
  item: NewMemoryItem,
): void {
  assertMayPersistAsMemoryItem(item);
  db.prepare<
    unknown,
    [string, string, string | null, string, string, string | null, string, number, string]
  >(
    `INSERT INTO memory_items
       (id, session_id, project_id, item_type, content, content_json,
        provenance, confidence, status, source_turn_ids)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
  ).run(
    id,
    item.session_id,
    item.project_id ?? null,
    item.item_type,
    item.content,
    item.content_json ?? null,
    item.provenance,
    item.confidence,
    JSON.stringify(item.source_turn_ids),
  );
}

/**
 * Supersede an existing memory_items row. Inserts the new row and
 * flips the old row from 'active' to 'superseded' in ONE txn.
 */
export function supersedeMemoryItem(args: {
  db: DbHandle;
  old_id: string;
  new_id: string;
  new_item: NewMemoryItem;
}): void {
  args.db.tx<void>(() => {
    const existing = args.db
      .prepare<{ status: string }, [string]>(
        "SELECT status FROM memory_items WHERE id = ?",
      )
      .get(args.old_id);
    if (!existing) {
      throw new MemoryProvenanceError(`unknown memory_items row: ${args.old_id}`);
    }
    if (existing.status !== "active") {
      // Per HLD §6.5 invariant 3: correcting a revoked id creates a
      // fresh row WITHOUT a supersedes pointer.
      insertMemoryItem(args.db, args.new_id, args.new_item);
      return;
    }
    // Flip old → superseded.
    args.db
      .prepare<unknown, [string]>(
        `UPDATE memory_items
         SET status = 'superseded',
             status_changed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ? AND status = 'active'`,
      )
      .run(args.old_id);

    // Insert new row with supersedes pointer.
    assertMayPersistAsMemoryItem(args.new_item);
    args.db
      .prepare<
        unknown,
        [string, string, string | null, string, string, string | null, string, number, string, string]
      >(
        `INSERT INTO memory_items
           (id, session_id, project_id, item_type, content, content_json,
            provenance, confidence, status, supersedes_memory_id, source_turn_ids)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(
        args.new_id,
        args.new_item.session_id,
        args.new_item.project_id ?? null,
        args.new_item.item_type,
        args.new_item.content,
        args.new_item.content_json ?? null,
        args.new_item.provenance,
        args.new_item.confidence,
        args.old_id,
        JSON.stringify(args.new_item.source_turn_ids),
      );
  });
}

/** /forget_memory — active or superseded → revoked. */
export function revokeMemoryItem(db: DbHandle, id: string): void {
  db.prepare<unknown, [string]>(
    `UPDATE memory_items
     SET status = 'revoked',
         status_changed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ? AND status IN ('active', 'superseded')`,
  ).run(id);
}
