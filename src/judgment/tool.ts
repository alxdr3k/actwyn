// Personal Agent — Judgment System Phase 1A.2 typed-tool contract.
//
// Exports a narrow, unregistered tool contract for judgment proposal:
//   JUDGMENT_PROPOSE_TOOL  — name + description constant
//   executeJudgmentProposeTool(db, input, deps?) → ToolResult
//
// The executor wraps `proposeJudgment` from the repository and
// converts `JudgmentValidationError` into a stable error result.
//
// This tool is NOT registered anywhere. It must not be imported from
// src/main.ts, src/providers/*, src/context/*, src/queue/worker.ts,
// src/memory/*, src/telegram/*, or src/commands/*.
//
// Per ADR-0014 (P1 Bun boundary), this module has no `Bun` / `bun:*`
// runtime import. `DbHandle` is a type-only import (erased at compile time).

import type { DbHandle } from "~/db.ts";

import {
  JudgmentValidationError,
  proposeJudgment,
  type ProposalDeps,
  type ProposalInput,
  type ProposedJudgment,
} from "~/judgment/repository.ts";

// ---------------------------------------------------------------
// Tool contract constant
// ---------------------------------------------------------------

export const JUDGMENT_PROPOSE_TOOL = {
  name: "judgment.propose" as const,
  description: "proposes a judgment candidate for later review",
} as const;

// ---------------------------------------------------------------
// Result types
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

// Re-export input/deps types so callers import from tool.ts only.
export type { ProposalInput, ProposalDeps };

// ---------------------------------------------------------------
// Executor
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
