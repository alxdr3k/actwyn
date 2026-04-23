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

/**
 * PRD §12.2 gate: long-term personal preferences must originate
 * from user_stated or user_confirmed.
 */
export function mayPromoteToLongTerm(p: Provenance, item_type: string): boolean {
  if (item_type !== "preference") return true;
  return p === "user_stated" || p === "user_confirmed";
}
