// Personal Agent — Judgment System Phase 1A.2 proposal repository.
//
// Exposes a single narrow write surface:
//   proposeJudgment(db, input, deps?) → ProposedJudgment
//
// Creates one `judgment_items` row + one `judgment_events` row in a
// single `BEGIN IMMEDIATE` transaction. All inputs are validated
// before any DB write.
//
// The inserted row is forced to:
//   lifecycle_status = proposed
//   approval_state   = pending
//   activation_state = history_only  ← NOT the DB default ('eligible')
//   retention_state  = normal
//   authority_source = none
//   decay_policy     = supersede_only
//
// Per ADR-0014 (P1 Bun boundary), this module has no `Bun` / `bun:*`
// runtime import. `DbHandle` from `~/db.ts` is a type-only import
// (erased at compile time — no runtime dependency on bun:sqlite).

import type { DbHandle } from "~/db.ts";

import {
  ONTOLOGY_VERSION,
  PROCEDURE_SUBTYPES,
  SCHEMA_VERSION,
  type Confidence,
  type EpistemicOrigin,
  type JudgmentKind,
  type ProcedureSubtype,
} from "~/judgment/types.ts";

import {
  isProcedureSubtype,
  validateConfidenceLabel,
  validateEpistemicOrigin,
  validateImportance,
  validateJsonValue,
  validateKind,
  validateScopeObject,
  validateStatement,
  validateStringArray,
  validateStringArraySerialization,
  type ValidationResult,
} from "~/judgment/validators.ts";

// ---------------------------------------------------------------
// Validation error
// ---------------------------------------------------------------

export class JudgmentValidationError extends Error {
  // string | undefined (not optional) so exactOptionalPropertyTypes is satisfied.
  readonly field: string | undefined;
  constructor(message: string, field?: string) {
    super(message);
    this.name = "JudgmentValidationError";
    this.field = field;
  }
}

// ---------------------------------------------------------------
// Input / deps / result types
// ---------------------------------------------------------------

export interface ProposalInput {
  kind: string;
  statement: string;
  epistemic_origin: string;
  confidence: string;
  scope: Record<string, unknown>;
  importance?: number;
  procedure_subtype?: string;
  source_ids?: string[];
  evidence_ids?: string[];
  would_change_if?: unknown;
  missing_evidence?: unknown;
  review_trigger?: unknown;
  observed_at?: string;
  valid_from?: string;
  valid_until?: string;
  revisit_at?: string;
  last_verified_at?: string;
  volatility?: string;
}

export interface ProposalDeps {
  /** Override ID generation for deterministic tests (judgment item ID only). */
  newId?: () => string;
  /** Actor to stamp on `judgment_events`. Default: "system". */
  actor?: string;
  /**
   * If set, throw this error inside the transaction after the
   * `judgment_items` insert but before the `judgment_events` insert.
   * Used only in tests to verify rollback behavior without monkeypatching.
   */
  _injectEventInsertError?: Error;
}

export interface ProposedJudgment {
  id: string;
  kind: JudgmentKind;
  statement: string;
  epistemic_origin: EpistemicOrigin;
  confidence: Confidence;
  importance: number;
  scope: Record<string, unknown>;
  lifecycle_status: "proposed";
  approval_state: "pending";
  activation_state: "history_only";
  retention_state: "normal";
  authority_source: "none";
  decay_policy: "supersede_only";
  ontology_version: string;
  schema_version: string;
  procedure_subtype: ProcedureSubtype | null;
  source_ids: string[] | null;
  evidence_ids: string[] | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------

function assertValid(result: ValidationResult, field: string): void {
  if (!result.ok) {
    throw new JudgmentValidationError(result.reason, field);
  }
}

// ---------------------------------------------------------------
// proposeJudgment
// ---------------------------------------------------------------

export function proposeJudgment(
  db: DbHandle,
  input: ProposalInput,
  deps: ProposalDeps = {},
): ProposedJudgment {
  // --- Validate all inputs before any DB write ---
  assertValid(validateKind(input.kind), "kind");
  assertValid(validateStatement(input.statement), "statement");
  assertValid(validateEpistemicOrigin(input.epistemic_origin), "epistemic_origin");
  assertValid(validateConfidenceLabel(input.confidence), "confidence");
  assertValid(validateScopeObject(input.scope), "scope");

  if (input.importance !== undefined) {
    assertValid(validateImportance(input.importance), "importance");
  }

  let procedureSubtype: ProcedureSubtype | null = null;
  if (input.kind === "procedure") {
    if (input.procedure_subtype === undefined) {
      procedureSubtype = "skill";
    } else if (!isProcedureSubtype(input.procedure_subtype)) {
      throw new JudgmentValidationError(
        `procedure_subtype must be one of ${PROCEDURE_SUBTYPES.join(", ")}`,
        "procedure_subtype",
      );
    } else {
      procedureSubtype = input.procedure_subtype as ProcedureSubtype;
    }
  } else if (input.procedure_subtype !== undefined) {
    throw new JudgmentValidationError(
      'procedure_subtype is only valid when kind is "procedure"',
      "procedure_subtype",
    );
  }

  if (input.source_ids !== undefined) {
    assertValid(validateStringArray(input.source_ids, "source_ids"), "source_ids");
    assertValid(validateStringArraySerialization(input.source_ids, "source_ids"), "source_ids");
  }
  if (input.evidence_ids !== undefined) {
    assertValid(validateStringArray(input.evidence_ids, "evidence_ids"), "evidence_ids");
    assertValid(validateStringArraySerialization(input.evidence_ids, "evidence_ids"), "evidence_ids");
  }
  if (input.would_change_if !== undefined) {
    assertValid(validateJsonValue(input.would_change_if), "would_change_if");
  }
  if (input.missing_evidence !== undefined) {
    assertValid(validateJsonValue(input.missing_evidence), "missing_evidence");
  }
  if (input.review_trigger !== undefined) {
    assertValid(validateJsonValue(input.review_trigger), "review_trigger");
  }

  // Guard optional string fields against runtime misuse (e.g. untyped tool input).
  // Without this check, a non-string would cause a TypeError inside db.tx(), which
  // would bypass JudgmentValidationError and surface as an unhandled throw from
  // executeJudgmentProposeTool instead of the documented { ok: false, error } shape.
  for (const [field, val] of [
    ["observed_at", input.observed_at],
    ["valid_from", input.valid_from],
    ["valid_until", input.valid_until],
    ["revisit_at", input.revisit_at],
    ["last_verified_at", input.last_verified_at],
    ["volatility", input.volatility],
  ] as Array<[string, unknown]>) {
    if (val !== undefined && typeof val !== "string") {
      throw new JudgmentValidationError(`${field} must be a string`, field);
    }
  }

  // --- Prepare serialized values ---
  const makeId = deps.newId ?? (() => crypto.randomUUID());
  const id = makeId();
  const eventId = crypto.randomUUID();
  const actor = deps.actor ?? "system";
  const trimmedStatement = input.statement.trim();
  const importance = input.importance ?? 3;
  const scopeJson = JSON.stringify(input.scope);
  const sourceIdsJson = input.source_ids != null ? JSON.stringify(input.source_ids) : null;
  const evidenceIdsJson = input.evidence_ids != null ? JSON.stringify(input.evidence_ids) : null;
  const wouldChangeIfJson =
    input.would_change_if !== undefined ? JSON.stringify(input.would_change_if) : null;
  const missingEvidenceJson =
    input.missing_evidence !== undefined ? JSON.stringify(input.missing_evidence) : null;
  const reviewTriggerJson =
    input.review_trigger !== undefined ? JSON.stringify(input.review_trigger) : null;

  // --- DB writes in a single transaction ---
  db.tx(() => {
    db.prepare(
      `INSERT INTO judgment_items (
         id, kind, scope_json, statement, epistemic_origin,
         authority_source, approval_state, lifecycle_status,
         activation_state, retention_state,
         confidence, importance, decay_policy, procedure_subtype,
         ontology_version, schema_version,
         source_ids_json, evidence_ids_json,
         would_change_if_json, missing_evidence_json, review_trigger_json,
         observed_at, valid_from, valid_until, revisit_at, last_verified_at,
         volatility
       ) VALUES (
         $id, $kind, $scope_json, $statement, $epistemic_origin,
         'none', 'pending', 'proposed',
         'history_only', 'normal',
         $confidence, $importance, 'supersede_only', $procedure_subtype,
         $ontology_version, $schema_version,
         $source_ids_json, $evidence_ids_json,
         $would_change_if_json, $missing_evidence_json, $review_trigger_json,
         $observed_at, $valid_from, $valid_until, $revisit_at, $last_verified_at,
         $volatility
       )`,
    ).run({
      id,
      kind: input.kind,
      scope_json: scopeJson,
      statement: trimmedStatement,
      epistemic_origin: input.epistemic_origin,
      confidence: input.confidence,
      importance,
      procedure_subtype: procedureSubtype,
      ontology_version: ONTOLOGY_VERSION,
      schema_version: SCHEMA_VERSION,
      source_ids_json: sourceIdsJson,
      evidence_ids_json: evidenceIdsJson,
      would_change_if_json: wouldChangeIfJson,
      missing_evidence_json: missingEvidenceJson,
      review_trigger_json: reviewTriggerJson,
      observed_at: input.observed_at ?? null,
      valid_from: input.valid_from ?? null,
      valid_until: input.valid_until ?? null,
      revisit_at: input.revisit_at ?? null,
      last_verified_at: input.last_verified_at ?? null,
      volatility: input.volatility ?? null,
    } as never);

    if (deps._injectEventInsertError) {
      throw deps._injectEventInsertError;
    }

    const eventPayload: Record<string, unknown> = {
      judgment_id: id,
      kind: input.kind,
      epistemic_origin: input.epistemic_origin,
      confidence: input.confidence,
    };
    if (input.source_ids != null) eventPayload.source_ids = input.source_ids;
    if (input.evidence_ids != null) eventPayload.evidence_ids = input.evidence_ids;

    db.prepare(
      `INSERT INTO judgment_events (id, event_type, judgment_id, payload_json, actor)
       VALUES ($id, 'judgment.proposed', $judgment_id, $payload_json, $actor)`,
    ).run({
      id: eventId,
      judgment_id: id,
      payload_json: JSON.stringify(eventPayload),
      actor,
    } as never);
  });

  // --- Read back DB-generated timestamps ---
  const row = db
    .prepare<{ created_at: string; updated_at: string }, [string]>(
      `SELECT created_at, updated_at FROM judgment_items WHERE id = ?`,
    )
    .get(id);

  return {
    id,
    kind: input.kind as JudgmentKind,
    statement: trimmedStatement,
    epistemic_origin: input.epistemic_origin as EpistemicOrigin,
    confidence: input.confidence as Confidence,
    importance,
    scope: input.scope,
    lifecycle_status: "proposed",
    approval_state: "pending",
    activation_state: "history_only",
    retention_state: "normal",
    authority_source: "none",
    decay_policy: "supersede_only",
    ontology_version: ONTOLOGY_VERSION,
    schema_version: SCHEMA_VERSION,
    procedure_subtype: procedureSubtype,
    source_ids: input.source_ids ?? null,
    evidence_ids: input.evidence_ids ?? null,
    created_at: row?.created_at ?? "",
    updated_at: row?.updated_at ?? "",
  };
}
