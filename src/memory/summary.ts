// Personal Agent P0 — memory summary writer + auto-trigger gate.
//
// Spec references:
//   - PRD §12.3 (summary generation)
//   - PRD DEC-019 (trigger policy)
//   - AC-MEM-005 (automatic throttle: ≥ 8 new user turns since last summary)
//   - HLD §4.4 (advisory/chat lockdown for summary_generation job)
//
// This module is responsible for the DB-facing bits:
//   1. Decide whether an automatic summary should be enqueued
//      (shouldAutoTriggerSummary).
//   2. Persist a memory_summaries row when a summary completes
//      (writeSummary). Summary output stays in memory_summaries;
//      it is not automatically promoted to active memory_items.
//
// Summary generation itself (driving Claude in the advisory
// profile) lands in Phase 7's adapter: this module only consumes
// the structured output.

import type { DbHandle } from "~/db.ts";
import { mayPersistAsMemoryItem, type Provenance } from "~/memory/provenance.ts";

// ---------------------------------------------------------------
// Advisory profile prompt (PRD §12.3, HLD §11.2 step 3)
// ---------------------------------------------------------------

/**
 * System identity string for summary_generation jobs (advisory/lockdown profile).
 * Tells Claude to produce structured JSON; injected as the system_identity slot
 * in the packed context so the schema instruction always precedes the turns.
 */
export const SUMMARY_SYSTEM_IDENTITY = `actwyn session summariser (advisory profile)

Analyse the conversation below and produce a single JSON object — no prose, no markdown fences.

Required schema:
{
  "facts":        [ { "content": string, "provenance": "user_stated"|"user_confirmed"|"observed"|"inferred"|"tool_output"|"assistant_generated", "confidence": number } ],
  "preferences":  [ { "content": string, "provenance": "user_stated"|"user_confirmed"|"observed"|"inferred"|"tool_output"|"assistant_generated", "confidence": number } ],
  "decisions":    [ { "content": string, "provenance": "user_stated"|"user_confirmed"|"observed"|"inferred"|"tool_output"|"assistant_generated", "confidence": number } ],
  "open_tasks":   [ { "content": string, "provenance": "user_stated"|"user_confirmed"|"observed"|"inferred"|"tool_output"|"assistant_generated", "confidence": number } ],
  "cautions":     [ { "content": string, "provenance": "user_stated"|"user_confirmed"|"observed"|"inferred"|"tool_output"|"assistant_generated", "confidence": number } ],
  "summary_type": "session",
  "source_turn_ids": []
}

Rules:
- Only "user_stated" or "user_confirmed" items are persisted in durable personal preferences_json.
- Extracted summary items are memory-plane recall/candidate material, not an active behavioral baseline.
- confidence ∈ [0.0, 1.0].
- Omit empty arrays; use [] rather than null.
- Respond ONLY with the JSON object — no explanation.`;

export interface TriggerInput {
  readonly turns_since_last_summary: number;
  readonly transcript_estimated_tokens: number;
  readonly session_age_seconds: number;
  readonly user_turns_since_last_summary: number;
}

export interface TriggerDecision {
  readonly trigger: boolean;
  readonly reason: string;
  readonly throttle_blocked: boolean;
}

const THROTTLE_MIN_USER_TURNS = 8;
const TURN_COUNT_TRIGGER = 20;
const TOKEN_TRIGGER = 6000;
const AGE_TRIGGER_SECONDS = 24 * 60 * 60;

/**
 * Pure decision: returns whether an automatic summary should be
 * enqueued AND whether the throttle blocked a match that otherwise
 * would have triggered (for observability).
 */
export function shouldAutoTriggerSummary(input: TriggerInput): TriggerDecision {
  const matches: string[] = [];
  if (input.turns_since_last_summary >= TURN_COUNT_TRIGGER) matches.push("turn_count");
  if (input.transcript_estimated_tokens >= TOKEN_TRIGGER) matches.push("token_budget");
  if (input.session_age_seconds >= AGE_TRIGGER_SECONDS) matches.push("session_age");

  if (matches.length === 0) {
    return { trigger: false, reason: "no_trigger_match", throttle_blocked: false };
  }

  if (input.user_turns_since_last_summary < THROTTLE_MIN_USER_TURNS) {
    return {
      trigger: false,
      reason: `throttle_blocked:${matches.join(",")}`,
      throttle_blocked: true,
    };
  }

  return {
    trigger: true,
    reason: `trigger:${matches.join(",")}`,
    throttle_blocked: false,
  };
}

// ---------------------------------------------------------------
// Summary output type
// ---------------------------------------------------------------

export interface SummaryOutput {
  readonly session_id: string;
  readonly summary_type: "session" | "project" | "daily";
  readonly facts: readonly SummaryFact[];
  readonly preferences: readonly SummaryPreference[];
  readonly open_tasks: readonly SummaryOpenTask[];
  readonly decisions: readonly SummaryDecision[];
  readonly cautions: readonly SummaryCaution[];
  readonly source_turn_ids: readonly string[];
}

export interface SummaryFact {
  readonly content: string;
  readonly provenance: Provenance;
  readonly confidence: number;
}

export interface SummaryPreference {
  readonly content: string;
  readonly provenance: Provenance;
  readonly confidence: number;
}

export interface SummaryOpenTask {
  readonly content: string;
  readonly provenance: Provenance;
  readonly confidence: number;
}

export interface SummaryDecision {
  readonly content: string;
  readonly provenance: Provenance;
  readonly confidence: number;
}

export interface SummaryCaution {
  readonly content: string;
  readonly provenance: Provenance;
  readonly confidence: number;
}

// ---------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------

export class SummaryProvenanceError extends Error {
  override readonly name = "SummaryProvenanceError";
}

export interface WriteSummaryResult {
  readonly summary_id: string;
  readonly kept_preferences: number;
  readonly dropped_preferences: number;
  readonly memory_items_inserted: number;
}

export function writeSummary(args: {
  db: DbHandle;
  newId: () => string;
  summary: SummaryOutput;
}): WriteSummaryResult {
  const id = args.newId();

  // Enforce PRD §12.2 gate on preferences BEFORE persisting: any
  // preference whose provenance is not user_stated / user_confirmed
  // is dropped from the durable preferences_json. Other item types
  // remain summary-plane recall/candidate material.
  const kept: SummaryPreference[] = [];
  let dropped = 0;
  for (const p of args.summary.preferences) {
    if (mayPersistAsMemoryItem(p.provenance, "preference")) kept.push(p);
    else dropped += 1;
  }

  const provenance_json = buildProvenanceSummary({
    facts: args.summary.facts,
    preferences: kept,
    open_tasks: args.summary.open_tasks,
    decisions: args.summary.decisions,
    cautions: args.summary.cautions,
  });
  const confidence_json = buildConfidenceSummary({
    facts: args.summary.facts,
    preferences: kept,
    open_tasks: args.summary.open_tasks,
    decisions: args.summary.decisions,
    cautions: args.summary.cautions,
  });

  args.db
    .prepare<
      unknown,
      [string, string, string, string, string, string, string, string, string, string, string]
    >(
      `INSERT INTO memory_summaries
         (id, session_id, summary_type,
          facts_json, preferences_json, open_tasks_json,
          decisions_json, cautions_json,
          provenance_json, confidence_json,
          source_turn_ids)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      args.summary.session_id,
      args.summary.summary_type,
      JSON.stringify(args.summary.facts),
      JSON.stringify(kept),
      JSON.stringify(args.summary.open_tasks),
      JSON.stringify(args.summary.decisions),
      JSON.stringify(args.summary.cautions),
      provenance_json,
      confidence_json,
      JSON.stringify(args.summary.source_turn_ids),
    );

  // ADR-0017 / DEC-039: summary extraction must not directly create active
  // memory_items rows that act as a behavioral baseline. Candidate material
  // remains in memory_summaries until a future judgment proposal path exists.
  const itemsInserted = 0;

  return {
    summary_id: id,
    kept_preferences: kept.length,
    dropped_preferences: dropped,
    memory_items_inserted: itemsInserted,
  };
}

type AnyItem = { readonly provenance: Provenance; readonly confidence: number };

function buildProvenanceSummary(args: {
  facts: readonly AnyItem[];
  preferences: readonly AnyItem[];
  open_tasks: readonly AnyItem[];
  decisions: readonly AnyItem[];
  cautions: readonly AnyItem[];
}): string {
  return JSON.stringify({
    facts: args.facts.map((i) => i.provenance),
    preferences: args.preferences.map((i) => i.provenance),
    open_tasks: args.open_tasks.map((i) => i.provenance),
    decisions: args.decisions.map((i) => i.provenance),
    cautions: args.cautions.map((i) => i.provenance),
  });
}

function buildConfidenceSummary(args: {
  facts: readonly AnyItem[];
  preferences: readonly AnyItem[];
  open_tasks: readonly AnyItem[];
  decisions: readonly AnyItem[];
  cautions: readonly AnyItem[];
}): string {
  return JSON.stringify({
    facts: args.facts.map((i) => i.confidence),
    preferences: args.preferences.map((i) => i.confidence),
    open_tasks: args.open_tasks.map((i) => i.confidence),
    decisions: args.decisions.map((i) => i.confidence),
    cautions: args.cautions.map((i) => i.confidence),
  });
}
