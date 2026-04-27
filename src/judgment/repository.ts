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
  type ActivationStateP05,
  type ApprovalState,
  type AuthoritySourceP05,
  type Confidence,
  type EpistemicOrigin,
  type JudgmentKind,
  type LifecycleStatus,
  type ProcedureSubtype,
  type RetentionState,
} from "~/judgment/types.ts";

import {
  isProcedureSubtype,
  validateConfidenceLabel,
  validateEpistemicOrigin,
  validateImportance,
  validateKind,
  validateNonEmptyString,
  validateOptionalNonEmptyString,
  validatePlainJsonObject,
  validateScopeJson,
  validateScopeObject,
  validateStatement,
  validateStringArray,
  validateTrustLevel,
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

// ---------------------------------------------------------------
// Phase 1A.3 — Proposal review (approve / reject)
// ---------------------------------------------------------------

export class JudgmentNotFoundError extends Error {
  readonly judgment_id: string;
  constructor(message: string, judgment_id: string) {
    super(message);
    this.name = "JudgmentNotFoundError";
    this.judgment_id = judgment_id;
  }
}

export class JudgmentStateError extends Error {
  readonly judgment_id: string;
  constructor(message: string, judgment_id: string) {
    super(message);
    this.name = "JudgmentStateError";
    this.judgment_id = judgment_id;
  }
}

// ---------------------------------------------------------------
// Review input / deps / result types
// ---------------------------------------------------------------

export interface ApproveInput {
  judgment_id: string;
  reviewer: string;
  reason?: string;
  payload?: Record<string, unknown>;
}

export interface RejectInput {
  judgment_id: string;
  reviewer: string;
  reason: string;
  payload?: Record<string, unknown>;
}

export interface ReviewDeps {
  /** Override event ID generation for deterministic tests. */
  newEventId?: () => string;
  /** Override current timestamp for deterministic tests. Must return a string. */
  nowIso?: () => string;
  /**
   * If set, throw this error after the judgment_items UPDATE but before the
   * judgment_events INSERT. Used only in tests to verify rollback behavior.
   */
  _injectEventInsertError?: Error;
}

export interface ReviewedJudgment {
  id: string;
  kind: JudgmentKind;
  statement: string;
  approval_state: ApprovalState;
  lifecycle_status: LifecycleStatus;
  activation_state: ActivationStateP05;
  retention_state: RetentionState;
  authority_source: AuthoritySourceP05;
  approved_by: string | null;
  approved_at: string | null;
  updated_at: string;
  event_type: string;
  event_id: string;
}

// ---------------------------------------------------------------
// approveProposedJudgment
// ---------------------------------------------------------------

export function approveProposedJudgment(
  db: DbHandle,
  input: ApproveInput,
  deps: ReviewDeps = {},
): ReviewedJudgment {
  if (input === null || typeof input !== "object") {
    throw new JudgmentValidationError("input must be a plain object");
  }

  assertValid(validateNonEmptyString(input.judgment_id, "judgment_id"), "judgment_id");
  const judgment_id = input.judgment_id.trim();

  assertValid(validateNonEmptyString(input.reviewer, "reviewer"), "reviewer");
  const reviewer = input.reviewer.trim();

  let reason: string | undefined;
  if (input.reason !== undefined) {
    assertValid(validateNonEmptyString(input.reason, "reason"), "reason");
    reason = input.reason.trim();
  }

  let payloadJsonObj: Record<string, unknown> | undefined;
  if (input.payload !== undefined) {
    // serializeOnce converts SyntaxError (stateful toJSON) → JudgmentValidationError.
    // validatePlainJsonObject runs structural checks (null/array/class-instance) on the
    // live value AFTER serializeOnce so we never call JSON.stringify twice.
    const payloadSerialized = serializeOnce(input.payload, "payload");
    assertValid(validatePlainJsonObject(input.payload, "payload"), "payload");
    const payloadReparsed = JSON.parse(payloadSerialized) as unknown;
    if (
      payloadReparsed === null ||
      Array.isArray(payloadReparsed) ||
      typeof payloadReparsed !== "object"
    ) {
      throw new JudgmentValidationError("payload must serialize to a plain JSON object", "payload");
    }
    payloadJsonObj = payloadReparsed as Record<string, unknown>;
  }

  const makeEventId = deps.newEventId ?? (() => crypto.randomUUID());
  const eventId = makeEventId();

  return db.tx(() => {
    const existing = db
      .prepare<
        {
          id: string;
          kind: string;
          statement: string;
          lifecycle_status: string;
          approval_state: string;
          activation_state: string;
          retention_state: string;
          authority_source: string;
        },
        [string]
      >(
        `SELECT id, kind, statement, lifecycle_status, approval_state,
                activation_state, retention_state, authority_source
         FROM judgment_items WHERE id = ?`,
      )
      .get(judgment_id);

    if (!existing) {
      throw new JudgmentNotFoundError(`judgment ${judgment_id} not found`, judgment_id);
    }

    if (
      existing.lifecycle_status !== "proposed" ||
      existing.approval_state !== "pending" ||
      existing.activation_state !== "history_only" ||
      existing.retention_state !== "normal"
    ) {
      throw new JudgmentStateError(
        `judgment ${judgment_id} cannot be approved: ` +
          `lifecycle=${existing.lifecycle_status}, approval=${existing.approval_state}, ` +
          `activation=${existing.activation_state}`,
        judgment_id,
      );
    }

    const nowIsoStr = deps.nowIso !== undefined ? deps.nowIso() : new Date().toISOString();
    if (typeof nowIsoStr !== "string") {
      throw new JudgmentValidationError("deps.nowIso must return a string");
    }

    const updateResult = db
      .prepare(
        `UPDATE judgment_items
         SET approval_state = 'approved',
             approved_by    = $reviewer,
             approved_at    = $now,
             updated_at     = $now
         WHERE id               = $id
           AND lifecycle_status  = 'proposed'
           AND approval_state    = 'pending'
           AND activation_state  = 'history_only'
           AND retention_state   = 'normal'`,
      )
      .run({ reviewer, now: nowIsoStr, id: judgment_id } as never);

    if ((updateResult as unknown as { changes: number }).changes === 0) {
      throw new JudgmentStateError(
        `judgment ${judgment_id} was modified concurrently; approve aborted`,
        judgment_id,
      );
    }

    if (deps._injectEventInsertError) {
      throw deps._injectEventInsertError;
    }

    const eventPayload: Record<string, unknown> = {
      judgment_id,
      reviewer,
      previous_approval_state: existing.approval_state,
      new_approval_state: "approved",
      previous_lifecycle_status: existing.lifecycle_status,
      new_lifecycle_status: existing.lifecycle_status,
      previous_activation_state: existing.activation_state,
      new_activation_state: existing.activation_state,
    };
    if (reason !== undefined) eventPayload.reason = reason;
    if (payloadJsonObj !== undefined) eventPayload.payload = payloadJsonObj;

    db
      .prepare(
        `INSERT INTO judgment_events (id, event_type, judgment_id, payload_json, actor)
         VALUES ($id, 'judgment.approved', $judgment_id, $payload_json, $actor)`,
      )
      .run({
        id: eventId,
        judgment_id,
        payload_json: JSON.stringify(eventPayload),
        actor: reviewer,
      } as never);

    return {
      id: existing.id,
      kind: existing.kind as JudgmentKind,
      statement: existing.statement,
      approval_state: "approved",
      lifecycle_status: existing.lifecycle_status as LifecycleStatus,
      activation_state: existing.activation_state as ActivationStateP05,
      retention_state: existing.retention_state as RetentionState,
      authority_source: existing.authority_source as AuthoritySourceP05,
      approved_by: reviewer,
      approved_at: nowIsoStr,
      updated_at: nowIsoStr,
      event_type: "judgment.approved",
      event_id: eventId,
    };
  });
}

// ---------------------------------------------------------------
// rejectProposedJudgment
// ---------------------------------------------------------------

export function rejectProposedJudgment(
  db: DbHandle,
  input: RejectInput,
  deps: ReviewDeps = {},
): ReviewedJudgment {
  if (input === null || typeof input !== "object") {
    throw new JudgmentValidationError("input must be a plain object");
  }

  assertValid(validateNonEmptyString(input.judgment_id, "judgment_id"), "judgment_id");
  const judgment_id = input.judgment_id.trim();

  assertValid(validateNonEmptyString(input.reviewer, "reviewer"), "reviewer");
  const reviewer = input.reviewer.trim();

  assertValid(validateNonEmptyString(input.reason, "reason"), "reason");
  const reason = input.reason.trim();

  let payloadJsonObj: Record<string, unknown> | undefined;
  if (input.payload !== undefined) {
    const payloadSerialized = serializeOnce(input.payload, "payload");
    assertValid(validatePlainJsonObject(input.payload, "payload"), "payload");
    const payloadReparsed = JSON.parse(payloadSerialized) as unknown;
    if (
      payloadReparsed === null ||
      Array.isArray(payloadReparsed) ||
      typeof payloadReparsed !== "object"
    ) {
      throw new JudgmentValidationError("payload must serialize to a plain JSON object", "payload");
    }
    payloadJsonObj = payloadReparsed as Record<string, unknown>;
  }

  const makeEventId = deps.newEventId ?? (() => crypto.randomUUID());
  const eventId = makeEventId();

  return db.tx(() => {
    const existing = db
      .prepare<
        {
          id: string;
          kind: string;
          statement: string;
          lifecycle_status: string;
          approval_state: string;
          activation_state: string;
          retention_state: string;
          authority_source: string;
          approved_by: string | null;
          approved_at: string | null;
        },
        [string]
      >(
        `SELECT id, kind, statement, lifecycle_status, approval_state,
                activation_state, retention_state, authority_source,
                approved_by, approved_at
         FROM judgment_items WHERE id = ?`,
      )
      .get(judgment_id);

    if (!existing) {
      throw new JudgmentNotFoundError(`judgment ${judgment_id} not found`, judgment_id);
    }

    if (
      existing.lifecycle_status !== "proposed" ||
      existing.approval_state !== "pending" ||
      existing.activation_state !== "history_only" ||
      existing.retention_state !== "normal"
    ) {
      throw new JudgmentStateError(
        `judgment ${judgment_id} cannot be rejected: ` +
          `lifecycle=${existing.lifecycle_status}, approval=${existing.approval_state}, ` +
          `activation=${existing.activation_state}`,
        judgment_id,
      );
    }

    const nowIsoStr = deps.nowIso !== undefined ? deps.nowIso() : new Date().toISOString();
    if (typeof nowIsoStr !== "string") {
      throw new JudgmentValidationError("deps.nowIso must return a string");
    }

    const updateResult = db
      .prepare(
        `UPDATE judgment_items
         SET approval_state   = 'rejected',
             lifecycle_status = 'rejected',
             activation_state = 'excluded',
             updated_at       = $now
         WHERE id               = $id
           AND lifecycle_status  = 'proposed'
           AND approval_state    = 'pending'
           AND activation_state  = 'history_only'
           AND retention_state   = 'normal'`,
      )
      .run({ now: nowIsoStr, id: judgment_id } as never);

    if ((updateResult as unknown as { changes: number }).changes === 0) {
      throw new JudgmentStateError(
        `judgment ${judgment_id} was modified concurrently; reject aborted`,
        judgment_id,
      );
    }

    if (deps._injectEventInsertError) {
      throw deps._injectEventInsertError;
    }

    const eventPayload: Record<string, unknown> = {
      judgment_id,
      reviewer,
      reason,
      previous_approval_state: existing.approval_state,
      new_approval_state: "rejected",
      previous_lifecycle_status: existing.lifecycle_status,
      new_lifecycle_status: "rejected",
      previous_activation_state: existing.activation_state,
      new_activation_state: "excluded",
    };
    if (payloadJsonObj !== undefined) eventPayload.payload = payloadJsonObj;

    db
      .prepare(
        `INSERT INTO judgment_events (id, event_type, judgment_id, payload_json, actor)
         VALUES ($id, 'judgment.rejected', $judgment_id, $payload_json, $actor)`,
      )
      .run({
        id: eventId,
        judgment_id,
        payload_json: JSON.stringify(eventPayload),
        actor: reviewer,
      } as never);

    return {
      id: existing.id,
      kind: existing.kind as JudgmentKind,
      statement: existing.statement,
      approval_state: "rejected",
      lifecycle_status: "rejected",
      activation_state: "excluded",
      retention_state: existing.retention_state as RetentionState,
      authority_source: existing.authority_source as AuthoritySourceP05,
      approved_by: existing.approved_by,
      approved_at: existing.approved_at,
      updated_at: nowIsoStr,
      event_type: "judgment.rejected",
      event_id: eventId,
    };
  });
}

// ---------------------------------------------------------------
// Phase 1A.4 — Source recording and evidence linking
// ---------------------------------------------------------------

export interface SourceInput {
  kind: string;
  locator: string;
  content_hash?: string;
  trust_level?: string;
  redacted?: boolean;
  captured_at?: string;
  payload?: Record<string, unknown>;
}

export interface SourceDeps {
  newSourceId?: () => string;
  newEventId?: () => string;
  actor?: string;
  _injectEventInsertError?: Error;
}

export interface RecordedSource {
  id: string;
  kind: string;
  locator: string;
  content_hash: string | null;
  trust_level: string;
  redacted: boolean;
  captured_at: string;
  event_type: "judgment.source.recorded";
  event_id: string;
}

export function recordJudgmentSource(
  db: DbHandle,
  input: SourceInput,
  deps: SourceDeps = {},
): RecordedSource {
  if (input === null || typeof input !== "object") {
    throw new JudgmentValidationError("input must be a plain object");
  }

  assertValid(validateNonEmptyString(input.kind, "kind"), "kind");
  const kind = input.kind.trim();

  assertValid(validateNonEmptyString(input.locator, "locator"), "locator");
  const locator = input.locator.trim();

  let contentHash: string | null = null;
  if (input.content_hash !== undefined) {
    assertValid(validateNonEmptyString(input.content_hash, "content_hash"), "content_hash");
    contentHash = input.content_hash.trim();
  }

  const trustLevelRaw = input.trust_level ?? "medium";
  assertValid(validateTrustLevel(trustLevelRaw), "trust_level");
  const trustLevel = trustLevelRaw as string;

  let redacted: boolean;
  if (input.redacted === undefined) {
    redacted = true;
  } else if (typeof input.redacted !== "boolean") {
    throw new JudgmentValidationError("redacted must be a boolean", "redacted");
  } else {
    redacted = input.redacted;
  }

  let capturedAtOverride: string | null = null;
  if (input.captured_at !== undefined) {
    assertValid(validateNonEmptyString(input.captured_at, "captured_at"), "captured_at");
    capturedAtOverride = input.captured_at.trim();
  }

  let payloadJsonObj: Record<string, unknown> | undefined;
  if (input.payload !== undefined) {
    const payloadSerialized = serializeOnce(input.payload, "payload");
    assertValid(validatePlainJsonObject(input.payload, "payload"), "payload");
    const payloadReparsed = JSON.parse(payloadSerialized) as unknown;
    if (
      payloadReparsed === null ||
      Array.isArray(payloadReparsed) ||
      typeof payloadReparsed !== "object"
    ) {
      throw new JudgmentValidationError("payload must serialize to a plain JSON object", "payload");
    }
    payloadJsonObj = payloadReparsed as Record<string, unknown>;
  }

  const makeSourceId = deps.newSourceId ?? (() => crypto.randomUUID());
  const makeEventId = deps.newEventId ?? (() => crypto.randomUUID());
  const sourceId = makeSourceId();
  const eventId = makeEventId();
  const actor = deps.actor ?? "system";

  db.tx(() => {
    db.prepare(
      `INSERT INTO judgment_sources (id, kind, locator, content_hash, trust_level, redacted, captured_at)
       VALUES ($id, $kind, $locator, $content_hash, $trust_level, $redacted,
               COALESCE($captured_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))`,
    ).run({
      id: sourceId,
      kind,
      locator,
      content_hash: contentHash,
      trust_level: trustLevel,
      redacted: redacted ? 1 : 0,
      captured_at: capturedAtOverride,
    } as never);

    if (deps._injectEventInsertError) {
      throw deps._injectEventInsertError;
    }

    const eventPayload: Record<string, unknown> = {
      source_id: sourceId,
      kind,
      locator,
      trust_level: trustLevel,
      redacted,
    };
    if (contentHash !== null) eventPayload.content_hash = contentHash;
    if (payloadJsonObj !== undefined) eventPayload.payload = payloadJsonObj;

    db.prepare(
      `INSERT INTO judgment_events (id, event_type, judgment_id, payload_json, actor)
       VALUES ($id, 'judgment.source.recorded', NULL, $payload_json, $actor)`,
    ).run({
      id: eventId,
      payload_json: JSON.stringify(eventPayload),
      actor,
    } as never);
  });

  const row = db
    .prepare<{ captured_at: string }, [string]>(
      `SELECT captured_at FROM judgment_sources WHERE id = ?`,
    )
    .get(sourceId);

  return {
    id: sourceId,
    kind,
    locator,
    content_hash: contentHash,
    trust_level: trustLevel,
    redacted,
    captured_at: row?.captured_at ?? "",
    event_type: "judgment.source.recorded",
    event_id: eventId,
  };
}

// ---------------------------------------------------------------
// Evidence link
// ---------------------------------------------------------------

export interface EvidenceLinkInput {
  judgment_id: string;
  source_id: string;
  relation: string;
  span_locator?: string;
  quote_excerpt?: string;
  rationale?: string;
  payload?: Record<string, unknown>;
}

export interface EvidenceLinkDeps {
  newLinkId?: () => string;
  newEventId?: () => string;
  actor?: string;
  _injectEventInsertError?: Error;
}

export interface LinkedEvidence {
  id: string;
  judgment_id: string;
  source_id: string;
  relation: string;
  span_locator: string | null;
  quote_excerpt: string | null;
  rationale: string | null;
  created_at: string;
  event_type: "judgment.evidence.linked";
  event_id: string;
}

export function linkJudgmentEvidence(
  db: DbHandle,
  input: EvidenceLinkInput,
  deps: EvidenceLinkDeps = {},
): LinkedEvidence {
  if (input === null || typeof input !== "object") {
    throw new JudgmentValidationError("input must be a plain object");
  }

  assertValid(validateNonEmptyString(input.judgment_id, "judgment_id"), "judgment_id");
  const judgment_id = input.judgment_id.trim();

  assertValid(validateNonEmptyString(input.source_id, "source_id"), "source_id");
  const source_id = input.source_id.trim();

  assertValid(validateNonEmptyString(input.relation, "relation"), "relation");
  const relation = input.relation.trim();

  assertValid(validateOptionalNonEmptyString(input.span_locator, "span_locator"), "span_locator");
  const spanLocator = input.span_locator !== undefined ? input.span_locator.trim() : null;

  assertValid(validateOptionalNonEmptyString(input.quote_excerpt, "quote_excerpt"), "quote_excerpt");
  const quoteExcerpt = input.quote_excerpt !== undefined ? input.quote_excerpt.trim() : null;

  assertValid(validateOptionalNonEmptyString(input.rationale, "rationale"), "rationale");
  const rationale = input.rationale !== undefined ? input.rationale.trim() : null;

  let payloadJsonObj: Record<string, unknown> | undefined;
  if (input.payload !== undefined) {
    const payloadSerialized = serializeOnce(input.payload, "payload");
    assertValid(validatePlainJsonObject(input.payload, "payload"), "payload");
    const payloadReparsed = JSON.parse(payloadSerialized) as unknown;
    if (
      payloadReparsed === null ||
      Array.isArray(payloadReparsed) ||
      typeof payloadReparsed !== "object"
    ) {
      throw new JudgmentValidationError("payload must serialize to a plain JSON object", "payload");
    }
    payloadJsonObj = payloadReparsed as Record<string, unknown>;
  }

  const makeLinkId = deps.newLinkId ?? (() => crypto.randomUUID());
  const makeEventId = deps.newEventId ?? (() => crypto.randomUUID());
  const linkId = makeLinkId();
  const eventId = makeEventId();
  const actor = deps.actor ?? "system";

  return db.tx(() => {
    const existingJudgment = db
      .prepare<
        {
          id: string;
          lifecycle_status: string;
          activation_state: string;
          retention_state: string;
        },
        [string]
      >(
        `SELECT id, lifecycle_status, activation_state, retention_state
         FROM judgment_items WHERE id = ?`,
      )
      .get(judgment_id);

    if (!existingJudgment) {
      throw new JudgmentNotFoundError(`judgment ${judgment_id} not found`, judgment_id);
    }

    // Reject deleted judgments regardless of lifecycle.
    if (existingJudgment.retention_state === "deleted") {
      throw new JudgmentStateError(
        `judgment ${judgment_id} cannot receive evidence: retention_state=deleted`,
        judgment_id,
      );
    }

    // Only proposed / history_only judgments may receive evidence in Phase 1A.4.
    // This covers rejected (lifecycle=rejected), revoked, superseded, expired, and
    // any future lifecycle that is not "proposed". Evidence links on rejected
    // judgments are disallowed — the canonical evidence relation is
    // judgment_evidence_links; rejected judgments are out of scope.
    if (
      existingJudgment.lifecycle_status !== "proposed" ||
      existingJudgment.activation_state !== "history_only"
    ) {
      throw new JudgmentStateError(
        `judgment ${judgment_id} cannot receive evidence: ` +
          `lifecycle=${existingJudgment.lifecycle_status}, activation=${existingJudgment.activation_state}`,
        judgment_id,
      );
    }

    const existingSource = db
      .prepare<{ id: string }, [string]>(`SELECT id FROM judgment_sources WHERE id = ?`)
      .get(source_id);

    if (!existingSource) {
      throw new JudgmentNotFoundError(`source ${source_id} not found`, source_id);
    }

    db.prepare(
      `INSERT INTO judgment_evidence_links
         (id, judgment_id, source_id, relation, span_locator, quote_excerpt, rationale)
       VALUES ($id, $judgment_id, $source_id, $relation, $span_locator, $quote_excerpt, $rationale)`,
    ).run({
      id: linkId,
      judgment_id,
      source_id,
      relation,
      span_locator: spanLocator,
      quote_excerpt: quoteExcerpt,
      rationale,
    } as never);

    // Update denormalized JSON arrays on judgment_items.
    // source_ids_json: unique source ids that have been linked to this judgment.
    // evidence_ids_json: unique evidence link ids for this judgment.
    // These are kept in insertion order; new ids are appended only when absent.
    // judgment_evidence_links is the canonical relation; these arrays are a
    // convenience denormalization derived from it.
    const itemArrays = db
      .prepare<{ source_ids_json: string | null; evidence_ids_json: string | null }, [string]>(
        `SELECT source_ids_json, evidence_ids_json FROM judgment_items WHERE id = ?`,
      )
      .get(judgment_id)!;

    const prevSourceIds: string[] = itemArrays.source_ids_json
      ? (JSON.parse(itemArrays.source_ids_json) as string[])
      : [];
    const prevEvidenceIds: string[] = itemArrays.evidence_ids_json
      ? (JSON.parse(itemArrays.evidence_ids_json) as string[])
      : [];

    const nextSourceIds = prevSourceIds.includes(source_id)
      ? prevSourceIds
      : [...prevSourceIds, source_id];
    const nextEvidenceIds = prevEvidenceIds.includes(linkId)
      ? prevEvidenceIds
      : [...prevEvidenceIds, linkId];

    db.prepare(
      `UPDATE judgment_items
       SET source_ids_json   = $source_ids_json,
           evidence_ids_json = $evidence_ids_json
       WHERE id = $id`,
    ).run({
      source_ids_json: JSON.stringify(nextSourceIds),
      evidence_ids_json: JSON.stringify(nextEvidenceIds),
      id: judgment_id,
    } as never);

    if (deps._injectEventInsertError) {
      throw deps._injectEventInsertError;
    }

    const eventPayload: Record<string, unknown> = {
      evidence_link_id: linkId,
      judgment_id,
      source_id,
      relation,
    };
    if (spanLocator !== null) eventPayload.span_locator = spanLocator;
    if (quoteExcerpt !== null) eventPayload.quote_excerpt = quoteExcerpt;
    if (rationale !== null) eventPayload.rationale = rationale;
    if (payloadJsonObj !== undefined) eventPayload.payload = payloadJsonObj;

    db.prepare(
      `INSERT INTO judgment_events (id, event_type, judgment_id, payload_json, actor)
       VALUES ($id, 'judgment.evidence.linked', $judgment_id, $payload_json, $actor)`,
    ).run({
      id: eventId,
      judgment_id,
      payload_json: JSON.stringify(eventPayload),
      actor,
    } as never);

    const linkRow = db
      .prepare<{ created_at: string }, [string]>(
        `SELECT created_at FROM judgment_evidence_links WHERE id = ?`,
      )
      .get(linkId)!;

    return {
      id: linkId,
      judgment_id,
      source_id,
      relation,
      span_locator: spanLocator,
      quote_excerpt: quoteExcerpt,
      rationale,
      created_at: linkRow.created_at,
      event_type: "judgment.evidence.linked",
      event_id: eventId,
    };
  });
}
