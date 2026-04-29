// Personal Agent P0 — memory provenance vocabulary + gates.
//
// PRD §12.2, §12.2a, §12.5, Appendix D memory_items schema.
//
// Vocabulary:
//   user_stated        — the user explicitly said it
//   user_confirmed     — user affirmed an inference
//   observed           — agent observed it from user actions
//   inferred           — agent inferred from context
//   tool_output        — came from a tool result
//   assistant_generated— assistant composed it without user confirmation

export type Provenance =
  | "user_stated"
  | "user_confirmed"
  | "observed"
  | "inferred"
  | "tool_output"
  | "assistant_generated";

export const ALL_PROVENANCE: readonly Provenance[] = [
  "user_stated",
  "user_confirmed",
  "observed",
  "inferred",
  "tool_output",
  "assistant_generated",
];

export function isValidProvenance(v: string): v is Provenance {
  return (ALL_PROVENANCE as readonly string[]).includes(v);
}

const JUDGMENT_PROPOSAL_ITEM_TYPES: readonly string[] = [
  "fact",
  "preference",
  "decision",
  "open_task",
  "current_state",
  "procedure",
  "caution",
];

/**
 * Persistence-plane gate: personal preferences persisted as memory rows must
 * originate from user_stated or user_confirmed. Other item types may still be
 * stored as memory/candidate material; this helper does not grant authority.
 */
export function mayPersistAsMemoryItem(p: Provenance, item_type: string): boolean {
  if (item_type !== "preference") return true;
  return p === "user_stated" || p === "user_confirmed";
}

/**
 * Candidate-plane gate for Judgment proposals. Provenance alone does not make
 * a candidate authoritative; approval, evidence, and commit rules decide that.
 */
export function mayProposeJudgment(_p: Provenance, item_type: string): boolean {
  return JUDGMENT_PROPOSAL_ITEM_TYPES.includes(item_type);
}

/**
 * @deprecated Use mayPersistAsMemoryItem or mayProposeJudgment so persistence
 * and behavior-baseline semantics stay separate (ADR-0017 / Q-064).
 */
export function mayPromoteToLongTerm(p: Provenance, item_type: string): boolean {
  return mayPersistAsMemoryItem(p, item_type);
}
