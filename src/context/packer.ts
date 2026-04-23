// Personal Agent P0 — context packer.
//
// Applies the drop precedence from PRD §12.5 against a token
// budget. Drops by ascending priority: lowest-priority droppable
// slots are removed first. The non-droppable floor
// (user_message + minimal system_identity) must always fit; if
// even that exceeds the budget, we raise `prompt_overflow`.
//
// Produces a PackedContext the worker persists into
// provider_runs.injected_snapshot_json (redacted by the caller
// before persistence).

import type { ContextSlot, ContextSnapshot, SlotKey } from "~/context/builder.ts";
import { estimateTokens } from "~/context/token_estimator.ts";

export class PromptOverflowError extends Error {
  override readonly name = "PromptOverflowError";
  constructor(public readonly minimum_tokens: number, public readonly budget: number) {
    super(`minimum prompt (${minimum_tokens} tokens) exceeds budget ${budget}`);
  }
}

export interface PackConfig {
  /** Total token budget for all injected slots (excludes user message-in-budget handling). */
  readonly total_budget_tokens: number;
}

export interface PackedSlot {
  readonly key: SlotKey;
  readonly label: string;
  readonly text: string;
  readonly tokens: number;
  readonly retained: boolean;
}

export interface PackedContext {
  readonly mode: ContextSnapshot["mode"];
  readonly slots: readonly PackedSlot[];
  readonly dropped: readonly SlotKey[];
  readonly total_tokens: number;
  readonly budget: number;
}

export function pack(snapshot: ContextSnapshot, config: PackConfig): PackedContext {
  const budget = config.total_budget_tokens;
  const scored = snapshot.slots.map((s) => ({ slot: s, tokens: estimateTokens(s.text) }));

  const fixedCost = scored
    .filter(({ slot }) => !slot.droppable)
    .reduce((sum, { tokens }) => sum + tokens, 0);
  if (fixedCost > budget) {
    throw new PromptOverflowError(fixedCost, budget);
  }

  // Start with every slot retained, then drop ascending-priority
  // droppable slots until we fit.
  const retained = new Set<SlotKey>(scored.map(({ slot }) => slot.key));
  let total = scored.reduce((sum, { tokens }) => sum + tokens, 0);

  const sortedDroppable = [...scored]
    .filter(({ slot }) => slot.droppable)
    .sort((a, b) => a.slot.priority - b.slot.priority); // lowest first

  for (const item of sortedDroppable) {
    if (total <= budget) break;
    retained.delete(item.slot.key);
    total -= item.tokens;
  }

  const packedSlots: PackedSlot[] = scored.map(({ slot, tokens }) => ({
    key: slot.key,
    label: slot.label,
    text: slot.text,
    tokens,
    retained: retained.has(slot.key),
  }));

  const dropped = packedSlots.filter((s) => !s.retained).map((s) => s.key);

  return {
    mode: snapshot.mode,
    slots: packedSlots,
    dropped,
    total_tokens: total,
    budget,
  };
}

/**
 * Render the retained slots into a single prompt string suitable for
 * passing as the `message` argument to Claude in replay_mode.
 *
 * The user_message slot is placed last; all other retained slots are
 * prefixed with their label so Claude can orient itself.
 */
export function renderAsMessage(packed: PackedContext): string {
  const retained = packed.slots.filter((s) => s.retained);
  const nonUser = retained.filter((s) => s.key !== "user_message");
  const userSlot = retained.find((s) => s.key === "user_message");
  const parts: string[] = [];
  for (const s of nonUser) {
    parts.push(`[${s.label}]\n${s.text}`);
  }
  if (userSlot) parts.push(userSlot.text);
  return parts.join("\n\n");
}

/** Serialize a packed context into the `injected_snapshot_json` shape. */
export function serializeForProviderRun(packed: PackedContext): string {
  return JSON.stringify({
    mode: packed.mode,
    total_tokens: packed.total_tokens,
    budget: packed.budget,
    dropped: packed.dropped,
    slots: packed.slots
      .filter((s) => s.retained)
      .map((s) => ({
        key: s.key,
        label: s.label,
        tokens: s.tokens,
        // The text itself is NOT stored in the snapshot JSON to
        // keep the row small; the retained text is what was passed
        // into the provider request and is reconstructable from
        // the source rows.
      })),
  });
}

function _slot(s: ContextSlot): string {
  return s.key;
}
// Silence unused-import-esque warnings from exactOptionalPropertyTypes.
void _slot;
