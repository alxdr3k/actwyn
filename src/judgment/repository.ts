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
  validateKind,
  validateScopeJson,
  validateScopeObject,
  validateStatement,
  validateStringArray,
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

/** Serialize `v` to a JSON string exactly once, throwing JudgmentValidationError on failure. */
function serializeOnce(v: unknown, field: string): string {
  let raw: string | undefined;
  try {
    raw = JSON.stringify(v);
  } catch (e) {
    throw new JudgmentValidationError(
      `${field} cannot be serialized to JSON: ${(e as Error).message}`,
      field,
    );
  }
  if (typeof raw !== "string") {
    throw new JudgmentValidationError(`${field} cannot be serialized to a JSON string`, field);
  }
  return raw;
}

// ---------------------------------------------------------------
// proposeJudgment
// ---------------------------------------------------------------

export function proposeJudgment(
  db: DbHandle,
  input: ProposalInput,
  deps: ProposalDeps = {},
): ProposedJudgment {
  // Guard against null / non-object input (untyped tool payloads can be any value).
  // Without this, accessing input.kind on null throws a TypeError that bypasses
  // JudgmentValidationError and escapes executeJudgmentProposeTool as an uncaught exception.
  if (input === null || typeof input !== "object") {
    throw new JudgmentValidationError("input must be a plain object");
  }

  // --- Validate scalar fields ---
  assertValid(validateKind(input.kind), "kind");
  assertValid(validateStatement(input.statement), "statement");
  assertValid(validateEpistemicOrigin(input.epistemic_origin), "epistemic_origin");
  assertValid(validateConfidenceLabel(input.confidence), "confidence");

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

  // Guard optional string fields against runtime misuse (e.g. untyped tool input).
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

  // --- Serialize JSON fields once; validate the serialized strings ---
  // Serializing before validation (and reusing the same string for the DB write) closes the
  // TOCTOU gap: a stateful toJSON() could return a valid shape the first time and
  // undefined/scalar the second, causing a raw SQLiteError or a corrupted column value.

  // scope: structural check first (rejects class instances like Map/Date via proto check),
  // then serialize once and re-validate the string form.  The proto check is necessary
  // because validateScopeJson alone accepts class instances that serialize to '{}' (e.g.
  // new Map()), which would persist '{}' while returning the live instance — diverging
  // stored vs. returned data.
  assertValid(validateScopeObject(input.scope), "scope");
  const scopeJson = serializeOnce(input.scope, "scope");
  assertValid(validateScopeJson(scopeJson), "scope");

  // source_ids / evidence_ids: validate live element types, then serialize once and
  // re-validate element types on the reparsed array to catch toJSON mutations.
  let sourceIdsJson: string | null = null;
  let sourceIdsParsed: string[] | null = null;
  if (input.source_ids != null) {
    assertValid(validateStringArray(input.source_ids, "source_ids"), "source_ids");
    const raw = serializeOnce(input.source_ids, "source_ids");
    const reparsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(reparsed)) {
      throw new JudgmentValidationError("source_ids must serialize to a JSON array", "source_ids");
    }
    assertValid(validateStringArray(reparsed, "source_ids"), "source_ids");
    sourceIdsJson = raw;
    sourceIdsParsed = reparsed as string[];
  }

  let evidenceIdsJson: string | null = null;
  let evidenceIdsParsed: string[] | null = null;
  if (input.evidence_ids != null) {
    assertValid(validateStringArray(input.evidence_ids, "evidence_ids"), "evidence_ids");
    const raw = serializeOnce(input.evidence_ids, "evidence_ids");
    const reparsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(reparsed)) {
      throw new JudgmentValidationError("evidence_ids must serialize to a JSON array", "evidence_ids");
    }
    assertValid(validateStringArray(reparsed, "evidence_ids"), "evidence_ids");
    evidenceIdsJson = raw;
    evidenceIdsParsed = reparsed as string[];
  }

  // metacognitive fields: serialize once, verify reparsed shape is object or array.
  let wouldChangeIfJson: string | null = null;
  if (input.would_change_if !== undefined) {
    const raw = serializeOnce(input.would_change_if, "would_change_if");
    const reparsed = JSON.parse(raw) as unknown;
    if (reparsed === null || typeof reparsed !== "object") {
      throw new JudgmentValidationError("would_change_if must serialize to a JSON object or array", "would_change_if");
    }
    wouldChangeIfJson = raw;
  }

  let missingEvidenceJson: string | null = null;
  if (input.missing_evidence !== undefined) {
    const raw = serializeOnce(input.missing_evidence, "missing_evidence");
    const reparsed = JSON.parse(raw) as unknown;
    if (reparsed === null || typeof reparsed !== "object") {
      throw new JudgmentValidationError("missing_evidence must serialize to a JSON object or array", "missing_evidence");
    }
    missingEvidenceJson = raw;
  }

  let reviewTriggerJson: string | null = null;
  if (input.review_trigger !== undefined) {
    const raw = serializeOnce(input.review_trigger, "review_trigger");
    const reparsed = JSON.parse(raw) as unknown;
    if (reparsed === null || typeof reparsed !== "object") {
      throw new JudgmentValidationError("review_trigger must serialize to a JSON object or array", "review_trigger");
    }
    reviewTriggerJson = raw;
  }

  // --- Prepare remaining values ---
  const makeId = deps.newId ?? (() => crypto.randomUUID());
  const id = makeId();
  const eventId = crypto.randomUUID();
  const actor = deps.actor ?? "system";
  const trimmedStatement = input.statement.trim();
  const importance = input.importance ?? 3;

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
    if (sourceIdsParsed != null) eventPayload.source_ids = sourceIdsParsed;
    if (evidenceIdsParsed != null) eventPayload.evidence_ids = evidenceIdsParsed;

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
    scope: JSON.parse(scopeJson) as Record<string, unknown>,
    lifecycle_status: "proposed",
    approval_state: "pending",
    activation_state: "history_only",
    retention_state: "normal",
    authority_source: "none",
    decay_policy: "supersede_only",
    ontology_version: ONTOLOGY_VERSION,
    schema_version: SCHEMA_VERSION,
    procedure_subtype: procedureSubtype,
    source_ids: sourceIdsParsed,
    evidence_ids: evidenceIdsParsed,
    created_at: row?.created_at ?? "",
    updated_at: row?.updated_at ?? "",
  };
}
