// Context Compiler v0 — Stage 4 (not yet wired into worker.ts).
//
// Centralizes read-only DB retrieval and packing that currently
// lives in worker.ts buildContextForRun / resume-mode judgment refresh.
// The compiler is pure aside from DB reads; callers apply redaction.
//
// replay_mode: fetches turns + memory_items + latest summary + global
//   eligible judgments (unless skipJudgments), builds and packs full context.
// resume_mode: Claude already holds history via --resume; inject only a
//   fresh judgment_active block + user_message (empty if no judgments).

import type { DbHandle } from "~/db.ts";
import {
  buildContext,
  type JudgmentItemSlot,
  type MemoryItemSlot,
  type TurnSlot,
} from "~/context/builder.ts";
import {
  pack,
  PromptOverflowError,
  renderAsMessage,
  serializeForProviderRun,
} from "~/context/packer.ts";

export { PromptOverflowError };

export type CompileMode = "replay_mode" | "resume_mode";

export interface CompileInput {
  readonly db: DbHandle;
  readonly sessionId: string | null | undefined;
  readonly mode: CompileMode;
  readonly userMessage: string;
  readonly systemIdentity?: string | undefined;
  /**
   * When true, skip active-judgment injection.
   * Set for summary_generation to prevent durable judgments from
   * being persisted into memory_summaries as conversation-derived facts.
   */
  readonly skipJudgments?: boolean | undefined;
  readonly tokenBudget?: number | undefined;
}

export interface CompileResult {
  /** Full rendered message text passed to the provider. */
  readonly packedMessage: string;
  /** JSON metadata for provider_runs.injected_snapshot_json (pre-redaction). */
  readonly injectedSnapshotJson: string;
}

const DEFAULT_BUDGET = 6000;
const DEFAULT_IDENTITY = "actwyn personal agent";

function queryRecentTurns(db: DbHandle, sessionId: string): TurnSlot[] {
  return db
    .prepare<TurnSlot, [string]>(
      `SELECT id, role, content_redacted, created_at
       FROM turns
       WHERE session_id = ?
       ORDER BY created_at DESC
       LIMIT 20`,
    )
    .all(sessionId)
    .reverse();
}

function queryActiveMemoryItems(db: DbHandle, sessionId: string): MemoryItemSlot[] {
  return db
    .prepare<MemoryItemSlot, [string]>(
      `SELECT id, content, provenance, confidence, status
       FROM memory_items
       WHERE session_id = ? AND status = 'active'
       ORDER BY created_at DESC
       LIMIT 50`,
    )
    .all(sessionId);
}

interface SummaryRow {
  readonly facts_json: string | null;
  readonly open_tasks_json: string | null;
  readonly created_at: string;
}

function buildSummaryText(row: SummaryRow): string {
  const parts: string[] = [`[요약 기준: ${row.created_at}]`];
  if (row.facts_json) {
    try {
      const facts = JSON.parse(row.facts_json) as Array<{ content: string }>;
      if (facts.length > 0) parts.push(`사실: ${facts.map((f) => f.content).join("; ")}`);
    } catch { /* ignore malformed JSON */ }
  }
  if (row.open_tasks_json) {
    try {
      const tasks = JSON.parse(row.open_tasks_json) as Array<{ content: string }>;
      if (tasks.length > 0) parts.push(`미결: ${tasks.map((t) => t.content).join("; ")}`);
    } catch { /* ignore */ }
  }
  return parts.join("\n");
}

function queryLatestSummary(db: DbHandle, sessionId: string): string | undefined {
  const row = db
    .prepare<SummaryRow, [string]>(
      `SELECT facts_json, open_tasks_json, created_at
       FROM memory_summaries
       WHERE session_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get(sessionId);
  return row ? buildSummaryText(row) : undefined;
}

function queryActiveGlobalJudgments(db: DbHandle): JudgmentItemSlot[] {
  return db
    .prepare<JudgmentItemSlot, []>(
      `SELECT id, kind, statement, authority_source, confidence
       FROM judgment_items
       WHERE lifecycle_status = 'active'
         AND activation_state = 'eligible'
         AND retention_state = 'normal'
         AND json_extract(scope_json, '$.global') = 1
         AND (valid_from IS NULL OR valid_from <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         AND (valid_until IS NULL OR valid_until > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ORDER BY importance DESC, created_at DESC
       LIMIT 20`,
    )
    .all();
}

/**
 * Compile and pack context for a provider run.
 *
 * Throws `PromptOverflowError` if the minimum non-droppable slots
 * (user_message + system_identity) exceed the token budget.
 * Callers are responsible for applying redaction to the returned strings.
 */
export function compile(input: CompileInput): CompileResult {
  const { db, sessionId, mode, userMessage } = input;
  const systemIdentity = input.systemIdentity ?? DEFAULT_IDENTITY;
  const tokenBudget = input.tokenBudget ?? DEFAULT_BUDGET;
  const skipJudgments = input.skipJudgments ?? false;

  if (!sessionId) {
    return {
      packedMessage: userMessage,
      injectedSnapshotJson: JSON.stringify({ mode, session_id: "" }),
    };
  }

  const judgments = skipJudgments ? [] : queryActiveGlobalJudgments(db);

  if (mode === "resume_mode") {
    // Resume: Claude holds history; inject only fresh judgment_active + user_message.
    // judgment_active is droppable — pack() drops it under budget pressure without
    // throwing. PromptOverflowError only fires when the non-droppable minimum
    // (user_message + system_identity) itself overflows; that is a genuine budget
    // violation and must propagate, not be swallowed into a bare-message fallback.
    if (judgments.length === 0) {
      return {
        packedMessage: userMessage,
        injectedSnapshotJson: JSON.stringify({ mode, session_id: sessionId }),
      };
    }
    const snap = buildContext({
      mode: "resume_mode",
      user_message: userMessage,
      system_identity: systemIdentity,
      judgment_items: judgments,
    });
    const packed = pack(snap, { total_budget_tokens: tokenBudget });
    return {
      packedMessage: renderAsMessage(packed),
      injectedSnapshotJson: serializeForProviderRun(packed),
    };
  }

  // replay_mode: full context
  const turns = queryRecentTurns(db, sessionId);
  const memItems = queryActiveMemoryItems(db, sessionId);
  const summary = queryLatestSummary(db, sessionId);

  const snap = buildContext({
    mode: "replay_mode",
    user_message: userMessage,
    system_identity: systemIdentity,
    recent_turns: turns,
    memory_items: memItems,
    ...(judgments.length > 0 ? { judgment_items: judgments } : {}),
    ...(summary ? { current_session_summary: summary } : {}),
  });

  const packed = pack(snap, { total_budget_tokens: tokenBudget });
  return {
    packedMessage: renderAsMessage(packed),
    injectedSnapshotJson: serializeForProviderRun(packed),
  };
}
