// Personal Agent — Judgment System Phase 1A.2–1A.7 typed-tool contracts.
//
// Exports narrow, unregistered tool contracts:
//   JUDGMENT_PROPOSE_TOOL        — name + description constant
//   executeJudgmentProposeTool(db, input, deps?) → ToolResult
//   JUDGMENT_APPROVE_TOOL        — name + description constant  (Phase 1A.3)
//   executeJudgmentApproveTool(db, input, deps?) → ReviewToolResult
//   JUDGMENT_REJECT_TOOL         — name + description constant  (Phase 1A.3)
//   executeJudgmentRejectTool(db, input, deps?) → ReviewToolResult
//   JUDGMENT_RECORD_SOURCE_TOOL  — name + description constant  (Phase 1A.4)
//   executeJudgmentRecordSourceTool(db, input, deps?) → SourceToolResult
//   JUDGMENT_LINK_EVIDENCE_TOOL  — name + description constant  (Phase 1A.4)
//   executeJudgmentLinkEvidenceTool(db, input, deps?) → EvidenceLinkToolResult
//   JUDGMENT_COMMIT_TOOL         — name + description constant  (Phase 1A.5)
//   executeJudgmentCommitTool(db, input, deps?) → CommitToolResult
//   JUDGMENT_QUERY_TOOL          — name + description constant  (Phase 1A.6)
//   executeJudgmentQueryTool(db, input)         → QueryToolResult
//   JUDGMENT_EXPLAIN_TOOL        — name + description constant  (Phase 1A.6)
//   executeJudgmentExplainTool(db, input)       → ExplainToolResult
//   JUDGMENT_SUPERSEDE_TOOL      — name + description constant  (Phase 1A.7)
//   executeJudgmentSupersedeTool(db, input, deps?) → SupersedeToolResult
//   JUDGMENT_REVOKE_TOOL         — name + description constant  (Phase 1A.7)
//   executeJudgmentRevokeTool(db, input, deps?) → RevokeToolResult
//   JUDGMENT_EXPIRE_TOOL         — name + description constant  (Phase 1A.7)
//   executeJudgmentExpireTool(db, input, deps?) → ExpireToolResult
//
// These tools are NOT registered anywhere. Write-path tools and other
// runtime modules must not import from this file. Exception: worker.ts
// may import executeJudgmentQueryTool and executeJudgmentExplainTool
// for Phase 1B.3 read-only Telegram commands (/judgment, /judgment_explain).
// All other imports from src/main.ts, src/providers/*, src/context/*,
// src/memory/*, src/telegram/*, or src/commands/* remain prohibited.
//
// Per ADR-0014 (P1 Bun boundary), this module has no `Bun` / `bun:*`
// runtime import. `DbHandle` is a type-only import (erased at compile time).

import type { DbHandle } from "~/db.ts";

import {
  explainJudgment,
  JudgmentNotFoundError,
  JudgmentStateError,
  JudgmentValidationError,
  approveProposedJudgment,
  commitApprovedJudgment,
  expireJudgment,
  linkJudgmentEvidence,
  proposeJudgment,
  queryJudgments,
  recordJudgmentSource,
  rejectProposedJudgment,
  revokeJudgment,
  supersedeJudgment,
  type ApproveInput,
  type CommitDeps,
  type CommitInput,
  type CommittedJudgment,
  type EvidenceLinkDeps,
  type EvidenceLinkInput,
  type ExpireDeps,
  type ExpireInput,
  type ExpireResult,
  type LinkedEvidence,
  type ProposalDeps,
  type ProposalInput,
  type ProposedJudgment,
  type QueryJudgmentsInput,
  type QueryJudgmentsResult,
  type RecordedSource,
  type RejectInput,
  type ReviewDeps,
  type ReviewedJudgment,
  type RevokeDeps,
  type RevokeInput,
  type RevokeResult,
  type SourceDeps,
  type SourceInput,
  type SupersedeDeps,
  type SupersedeInput,
  type SupersedeResult,
  type ExplainJudgmentInput,
  type JudgmentExplanation,
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

export const JUDGMENT_RECORD_SOURCE_TOOL = {
  name: "judgment.record_source" as const,
  description: "records a source row that may support later judgment evidence links",
} as const;

export const JUDGMENT_LINK_EVIDENCE_TOOL = {
  name: "judgment.link_evidence" as const,
  description:
    "links an existing judgment to an existing judgment source as evidence, without activating the judgment",
} as const;

export const JUDGMENT_COMMIT_TOOL = {
  name: "judgment.commit" as const,
  description:
    "commits an approved, evidence-linked proposed judgment as active/eligible without wiring it into runtime context",
} as const;

export const JUDGMENT_QUERY_TOOL = {
  name: "judgment.query" as const,
  description:
    "queries local judgment rows by status, kind, scope, and FTS without wiring results into runtime context",
} as const;

export const JUDGMENT_EXPLAIN_TOOL = {
  name: "judgment.explain" as const,
  description:
    "explains one local judgment by returning its evidence, sources, and lifecycle events",
} as const;

export const JUDGMENT_SUPERSEDE_TOOL = {
  name: "judgment.supersede" as const,
  description:
    "marks one active judgment as superseded by another active judgment, without wiring runtime context",
} as const;

export const JUDGMENT_REVOKE_TOOL = {
  name: "judgment.revoke" as const,
  description:
    "revokes an active judgment and excludes it from future active projections",
} as const;

export const JUDGMENT_EXPIRE_TOOL = {
  name: "judgment.expire" as const,
  description:
    "expires an active judgment and excludes it from future active projections",
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

// ---------------------------------------------------------------
// Source tool result types (Phase 1A.4)
// ---------------------------------------------------------------

export type SourceToolSuccess = {
  readonly ok: true;
  readonly source: RecordedSource;
};

export type SourceToolResult = SourceToolSuccess | ReviewToolError;

// ---------------------------------------------------------------
// Evidence-link tool result types (Phase 1A.4)
// ---------------------------------------------------------------

export type EvidenceLinkToolSuccess = {
  readonly ok: true;
  readonly evidence_link: LinkedEvidence;
};

export type EvidenceLinkToolResult = EvidenceLinkToolSuccess | ReviewToolError;

// ---------------------------------------------------------------
// Commit tool result types (Phase 1A.5)
// ---------------------------------------------------------------

export type CommitToolSuccess = {
  readonly ok: true;
  readonly judgment: CommittedJudgment;
};

export type CommitToolResult = CommitToolSuccess | ReviewToolError;

// ---------------------------------------------------------------
// Query / explain tool result types (Phase 1A.6)
// ---------------------------------------------------------------

export type QueryToolSuccess = {
  readonly ok: true;
  readonly result: QueryJudgmentsResult;
};

export type QueryToolError = {
  readonly ok: false;
  readonly error: {
    readonly code: "validation_error";
    readonly field: string | undefined;
    readonly message: string;
  };
};

export type QueryToolResult = QueryToolSuccess | QueryToolError;

export type ExplainToolSuccess = {
  readonly ok: true;
  readonly explanation: JudgmentExplanation;
};

export type ExplainToolResult = ExplainToolSuccess | ReviewToolError;

// ---------------------------------------------------------------
// Lifecycle tool result types (Phase 1A.7)
// ---------------------------------------------------------------

export type SupersedeToolSuccess = {
  readonly ok: true;
  readonly result: SupersedeResult;
};

export type SupersedeToolResult = SupersedeToolSuccess | ReviewToolError;

export type RevokeToolSuccess = {
  readonly ok: true;
  readonly result: RevokeResult;
};

export type RevokeToolResult = RevokeToolSuccess | ReviewToolError;

export type ExpireToolSuccess = {
  readonly ok: true;
  readonly result: ExpireResult;
};

export type ExpireToolResult = ExpireToolSuccess | ReviewToolError;

// Re-export input/deps types so callers import from tool.ts only.
export type {
  ProposalInput,
  ProposalDeps,
  ApproveInput,
  RejectInput,
  ReviewDeps,
  ReviewedJudgment,
  SourceInput,
  SourceDeps,
  RecordedSource,
  EvidenceLinkInput,
  EvidenceLinkDeps,
  LinkedEvidence,
  CommitInput,
  CommitDeps,
  CommittedJudgment,
  QueryJudgmentsInput,
  QueryJudgmentsResult,
  ExplainJudgmentInput,
  JudgmentExplanation,
  SupersedeInput,
  SupersedeDeps,
  SupersedeResult,
  RevokeInput,
  RevokeDeps,
  RevokeResult,
  ExpireInput,
  ExpireDeps,
  ExpireResult,
};

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

// ---------------------------------------------------------------
// Record-source executor (Phase 1A.4)
// ---------------------------------------------------------------

export function executeJudgmentRecordSourceTool(
  db: DbHandle,
  input: SourceInput,
  deps?: SourceDeps,
): SourceToolResult {
  try {
    const source = recordJudgmentSource(db, input, deps);
    return { ok: true, source };
  } catch (e) {
    return mapReviewError(e);
  }
}

// ---------------------------------------------------------------
// Link-evidence executor (Phase 1A.4)
// ---------------------------------------------------------------

export function executeJudgmentLinkEvidenceTool(
  db: DbHandle,
  input: EvidenceLinkInput,
  deps?: EvidenceLinkDeps,
): EvidenceLinkToolResult {
  try {
    const evidence_link = linkJudgmentEvidence(db, input, deps);
    return { ok: true, evidence_link };
  } catch (e) {
    return mapReviewError(e);
  }
}

// ---------------------------------------------------------------
// Commit executor (Phase 1A.5)
// ---------------------------------------------------------------

export function executeJudgmentCommitTool(
  db: DbHandle,
  input: CommitInput,
  deps?: CommitDeps,
): CommitToolResult {
  try {
    const judgment = commitApprovedJudgment(db, input, deps);
    return { ok: true, judgment };
  } catch (e) {
    return mapReviewError(e);
  }
}

// ---------------------------------------------------------------
// Query executor (Phase 1A.6)
// ---------------------------------------------------------------

export function executeJudgmentQueryTool(
  db: DbHandle,
  input?: QueryJudgmentsInput,
): QueryToolResult {
  try {
    const result = queryJudgments(db, input);
    return { ok: true, result };
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
// Explain executor (Phase 1A.6)
// ---------------------------------------------------------------

export function executeJudgmentExplainTool(
  db: DbHandle,
  input: ExplainJudgmentInput,
): ExplainToolResult {
  try {
    const explanation = explainJudgment(db, input);
    return { ok: true, explanation };
  } catch (e) {
    return mapReviewError(e);
  }
}

// ---------------------------------------------------------------
// Supersede executor (Phase 1A.7)
// ---------------------------------------------------------------

export function executeJudgmentSupersedeTool(
  db: DbHandle,
  input: SupersedeInput,
  deps?: SupersedeDeps,
): SupersedeToolResult {
  try {
    const result = supersedeJudgment(db, input, deps);
    return { ok: true, result };
  } catch (e) {
    return mapReviewError(e);
  }
}

// ---------------------------------------------------------------
// Revoke executor (Phase 1A.7)
// ---------------------------------------------------------------

export function executeJudgmentRevokeTool(
  db: DbHandle,
  input: RevokeInput,
  deps?: RevokeDeps,
): RevokeToolResult {
  try {
    const result = revokeJudgment(db, input, deps);
    return { ok: true, result };
  } catch (e) {
    return mapReviewError(e);
  }
}

// ---------------------------------------------------------------
// Expire executor (Phase 1A.7)
// ---------------------------------------------------------------

export function executeJudgmentExpireTool(
  db: DbHandle,
  input: ExpireInput,
  deps?: ExpireDeps,
): ExpireToolResult {
  try {
    const result = expireJudgment(db, input, deps);
    return { ok: true, result };
  } catch (e) {
    return mapReviewError(e);
  }
}
