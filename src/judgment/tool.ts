// Personal Agent — Judgment System Phase 1A.2/1A.3 typed-tool contracts.
//
// Exports narrow, unregistered tool contracts:
//   JUDGMENT_PROPOSE_TOOL  — name + description constant
//   executeJudgmentProposeTool(db, input, deps?) → ToolResult
//   JUDGMENT_APPROVE_TOOL  — name + description constant  (Phase 1A.3)
//   executeJudgmentApproveTool(db, input, deps?) → ReviewToolResult
//   JUDGMENT_REJECT_TOOL   — name + description constant  (Phase 1A.3)
//   executeJudgmentRejectTool(db, input, deps?) → ReviewToolResult
//
// These tools are NOT registered anywhere. They must not be imported from
// src/main.ts, src/providers/*, src/context/*, src/queue/worker.ts,
// src/memory/*, src/telegram/*, or src/commands/*.
//
// Per ADR-0014 (P1 Bun boundary), this module has no `Bun` / `bun:*`
// runtime import. `DbHandle` is a type-only import (erased at compile time).

import type { DbHandle } from "~/db.ts";

import {
  JudgmentNotFoundError,
  JudgmentStateError,
  JudgmentValidationError,
  approveProposedJudgment,
  proposeJudgment,
  rejectProposedJudgment,
  type ApproveInput,
  type ProposalDeps,
  type ProposalInput,
  type ProposedJudgment,
  type RejectInput,
  type ReviewDeps,
  type ReviewedJudgment,
} from "~/judgment/repository.ts";

// ---------------------------------------------------------------
// Tool contract constants
// ---------------------------------------------------------------

export const JUDGMENT_PROPOSE_TOOL = {
  name: "judgment.propose" as const,
  description: "proposes a judgment candidate for later review",
} as const;

export const JUDGMENT_APPROVE_TOOL = {
  name: "judgment.approve" as const,
  description:
    "approves a proposed judgment for later activation review, without activating it",
} as const;

export const JUDGMENT_REJECT_TOOL = {
  name: "judgment.reject" as const,
  description:
    "rejects a proposed judgment and excludes it from activation/context use",
} as const;

// ---------------------------------------------------------------
// Propose tool result types
// ---------------------------------------------------------------

export type ToolSuccess = {
  readonly ok: true;
  readonly judgment: ProposedJudgment;
};

export type ToolError = {
  readonly ok: false;
  readonly error: {
    readonly code: "validation_error";
    // string | undefined (not optional) so exactOptionalPropertyTypes is satisfied.
    readonly field: string | undefined;
    readonly message: string;
  };
};

export type ToolResult = ToolSuccess | ToolError;

// ---------------------------------------------------------------
// Review tool result types (Phase 1A.3)
// ---------------------------------------------------------------

export type ReviewToolErrorCode = "validation_error" | "not_found" | "invalid_state";

export type ReviewToolError = {
  readonly ok: false;
  readonly error: {
    readonly code: ReviewToolErrorCode;
    readonly field: string | undefined;
    readonly message: string;
  };
};

export type ReviewToolSuccess = {
  readonly ok: true;
  readonly judgment: ReviewedJudgment;
};

export type ReviewToolResult = ReviewToolSuccess | ReviewToolError;

// Re-export input/deps types so callers import from tool.ts only.
export type { ProposalInput, ProposalDeps, ApproveInput, RejectInput, ReviewDeps, ReviewedJudgment };

// ---------------------------------------------------------------
// Propose executor
// ---------------------------------------------------------------

export function executeJudgmentProposeTool(
  db: DbHandle,
  input: ProposalInput,
  deps?: ProposalDeps,
): ToolResult {
  try {
    const judgment = proposeJudgment(db, input, deps);
    return { ok: true, judgment };
  } catch (e) {
    if (e instanceof JudgmentValidationError) {
      return {
        ok: false,
        error: {
          code: "validation_error",
          field: e.field,
          message: e.message,
        },
      };
    }
    throw e;
  }
}

// ---------------------------------------------------------------
// Review error mapper (Phase 1A.3)
// ---------------------------------------------------------------

function mapReviewError(e: unknown): ReviewToolError {
  if (e instanceof JudgmentValidationError) {
    return {
      ok: false,
      error: { code: "validation_error", field: e.field, message: e.message },
    };
  }
  if (e instanceof JudgmentNotFoundError) {
    return {
      ok: false,
      error: { code: "not_found", field: undefined, message: e.message },
    };
  }
  if (e instanceof JudgmentStateError) {
    return {
      ok: false,
      error: { code: "invalid_state", field: undefined, message: e.message },
    };
  }
  throw e;
}

// ---------------------------------------------------------------
// Approve executor (Phase 1A.3)
// ---------------------------------------------------------------

export function executeJudgmentApproveTool(
  db: DbHandle,
  input: ApproveInput,
  deps?: ReviewDeps,
): ReviewToolResult {
  try {
    const judgment = approveProposedJudgment(db, input, deps);
    return { ok: true, judgment };
  } catch (e) {
    return mapReviewError(e);
  }
}

// ---------------------------------------------------------------
// Reject executor (Phase 1A.3)
// ---------------------------------------------------------------

export function executeJudgmentRejectTool(
  db: DbHandle,
  input: RejectInput,
  deps?: ReviewDeps,
): ReviewToolResult {
  try {
    const judgment = rejectProposedJudgment(db, input, deps);
    return { ok: true, judgment };
  } catch (e) {
    return mapReviewError(e);
  }
}
