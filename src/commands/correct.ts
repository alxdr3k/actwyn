// Personal Agent P0 — /correct command + natural-language match.
//
// Spec references:
//   - PRD §8.1 (/correct <id>)
//   - PRD §12.2a (corrections via supersede)
//   - DEC-007 (supersede, not overwrite)
//   - HLD §6.5 (memory_items.status: active → superseded in the
//     same txn as the new row's INSERT)
//
// This module is thin: supersede semantics live in
// src/memory/items.ts; this file adds (1) natural-language
// parsing ("정정: X가 아니라 Y야" / "not X but Y" / "correction: ...")
// and (2) a convenience entry point for the command dispatcher.

import type { DbHandle } from "~/db.ts";
import { supersedeMemoryItem, type NewMemoryItem } from "~/memory/items.ts";

export interface CorrectArgs {
  readonly old_id: string;
  readonly new_id: string;
  readonly new_item: NewMemoryItem;
}

export function correctMemory(db: DbHandle, args: CorrectArgs): void {
  supersedeMemoryItem({
    db,
    old_id: args.old_id,
    new_id: args.new_id,
    new_item: args.new_item,
  });
}

// ---------------------------------------------------------------
// Natural-language detectors (pure)
// ---------------------------------------------------------------

export interface ParsedCorrection {
  readonly old_hint: string; // the "wrong" value the user wants replaced
  readonly new_value: string; // the corrected value
}

/**
 * Parse "정정: X가 아니라 Y야" or "not X but Y" shapes. Returns
 * null if no correction phrase is present. The caller is
 * responsible for mapping `old_hint` to a memory_items.id (fuzzy
 * match), which is outside the scope of this pure parser.
 */
export function parseCorrection(text: string): ParsedCorrection | null {
  const t = text.trim();
  // Korean: "정정: X가/이 아니라 Y야/이야"
  const ko = /^정정[:：]\s*([^가이]+?)(?:가|이)\s*아니라\s*(.+?)\s*(?:야|이야|다|입니다)?\.?$/;
  const km = ko.exec(t);
  if (km) {
    return { old_hint: km[1]!.trim(), new_value: km[2]!.trim() };
  }
  // English: "not X but Y" / "correction: ... not X but Y"
  const en = /\b(?:correction[:：]\s*)?not\s+(.+?)\s+but\s+(.+?)\.?$/i;
  const em = en.exec(t);
  if (em) {
    return { old_hint: em[1]!.trim(), new_value: em[2]!.trim() };
  }
  return null;
}
