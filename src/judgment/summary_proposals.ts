// Personal Agent — summary output to Judgment proposal bridge.
//
// JDG-1C.2a: structured `summary_generation` output can create
// proposed judgments. This module deliberately stops at proposal:
// it does not approve, link evidence, commit, activate, or register
// provider tools.

import type { DbHandle } from "~/db.ts";
import type { SummaryOutput } from "~/memory/summary.ts";
import { executeJudgmentProposeTool, type ProposalInput } from "~/judgment/tool.ts";
import type { Confidence, JudgmentKind } from "~/judgment/types.ts";

type SummaryProposalItemType =
  | "fact"
  | "preference"
  | "decision"
  | "open_task"
  | "caution";

type SummaryProposalItem = {
  readonly item_type: SummaryProposalItemType;
  readonly kind: JudgmentKind;
  readonly content: unknown;
  readonly provenance: unknown;
  readonly confidence: unknown;
};

export interface ProposeSummaryJudgmentsArgs {
  readonly db: DbHandle;
  readonly summary_id: string;
  readonly summary: SummaryOutput;
}

export interface ProposeSummaryJudgmentsDeps {
  readonly newId?: () => string;
  readonly actor?: string;
  readonly nowIso?: () => string;
}

export interface SummaryJudgmentProposalError {
  readonly item_type: SummaryProposalItemType;
  readonly statement: string;
  readonly message: string;
}

export interface ProposeSummaryJudgmentsResult {
  readonly proposed: number;
  readonly skipped: number;
  readonly judgment_ids: readonly string[];
  readonly judgments: readonly SummaryProposedJudgment[];
  readonly errors: readonly SummaryJudgmentProposalError[];
}

export interface SummaryProposedJudgment {
  readonly id: string;
  readonly kind: JudgmentKind;
  readonly statement: string;
}

export function proposeJudgmentsFromSummary(
  args: ProposeSummaryJudgmentsArgs,
  deps: ProposeSummaryJudgmentsDeps = {},
): ProposeSummaryJudgmentsResult {
  const judgments: SummaryProposedJudgment[] = [];
  const errors: SummaryJudgmentProposalError[] = [];
  const observedAt = deps.nowIso?.();

  for (const item of summaryProposalItems(args.summary)) {
    const statement = typeof item.content === "string" ? item.content.trim() : "";
    if (statement.length === 0) {
      errors.push({
        item_type: item.item_type,
        statement,
        message: "summary item content must be a non-empty string",
      });
      continue;
    }

    const input: ProposalInput = {
      kind: item.kind,
      statement,
      epistemic_origin: typeof item.provenance === "string" ? item.provenance : "",
      confidence: confidenceLabel(item.confidence),
      scope: {
        global: true,
        source: "summary_generation",
        session_id: args.summary.session_id,
        summary_id: args.summary_id,
        summary_type: args.summary.summary_type,
        summary_item_type: item.item_type,
      },
      importance: 3,
      missing_evidence: {
        reason: "auto_proposed_from_summary",
        summary_id: args.summary_id,
        source_turn_ids: args.summary.source_turn_ids,
      },
      review_trigger: {
        trigger: "summary_generation",
        summary_id: args.summary_id,
        summary_item_type: item.item_type,
        source_turn_ids: args.summary.source_turn_ids,
      },
      ...(observedAt ? { observed_at: observedAt } : {}),
    };

    const proposalDeps = {
      actor: deps.actor ?? "summary_generation",
      ...(deps.newId ? { newId: deps.newId } : {}),
    };
    const result = executeJudgmentProposeTool(args.db, input, proposalDeps);
    if (result.ok) {
      judgments.push({
        id: result.judgment.id,
        kind: result.judgment.kind,
        statement: result.judgment.statement,
      });
    } else {
      errors.push({
        item_type: item.item_type,
        statement,
        message: result.error.message,
      });
    }
  }

  return {
    proposed: judgments.length,
    skipped: errors.length,
    judgment_ids: judgments.map((j) => j.id),
    judgments,
    errors,
  };
}

function summaryProposalItems(summary: SummaryOutput): SummaryProposalItem[] {
  return [
    ...summary.facts.map((item) => ({ ...item, item_type: "fact" as const, kind: "fact" as const })),
    ...summary.preferences.map((item) => ({
      ...item,
      item_type: "preference" as const,
      kind: "preference" as const,
    })),
    ...summary.decisions.map((item) => ({
      ...item,
      item_type: "decision" as const,
      kind: "decision" as const,
    })),
    ...summary.open_tasks.map((item) => ({
      ...item,
      item_type: "open_task" as const,
      kind: "current_state" as const,
    })),
    ...summary.cautions.map((item) => ({
      ...item,
      item_type: "caution" as const,
      kind: "caution" as const,
    })),
  ];
}

function confidenceLabel(confidence: unknown): Confidence {
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
    return "medium";
  }
  if (confidence >= 0.8) return "high";
  if (confidence >= 0.5) return "medium";
  return "low";
}
