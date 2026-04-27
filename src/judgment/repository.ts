// Personal Agent — Judgment System Phase 1A.2–1A.5 proposal/review/source/commit repository.
//
// Write surfaces:
//   proposeJudgment(db, input, deps?)           → ProposedJudgment    (Phase 1A.2)
//   approveProposedJudgment(db, input, deps?)   → ReviewedJudgment    (Phase 1A.3)
//   rejectProposedJudgment(db, input, deps?)    → ReviewedJudgment    (Phase 1A.3)
//   recordJudgmentSource(db, input, deps?)      → RecordedSource      (Phase 1A.4)
//   linkJudgmentEvidence(db, input, deps?)      → LinkedEvidence      (Phase 1A.4)
//   commitApprovedJudgment(db, input, deps?)    → CommittedJudgment   (Phase 1A.5)
//
// Each write creates/mutates rows in a single `BEGIN IMMEDIATE` transaction.
// All inputs are validated before any DB write.
//
// Per ADR-0014 (P1 Bun boundary), this module has no `Bun` / `bun:*`
// runtime import. `DbHandle` from `~/db.ts` is a type-only import
// (erased at compile time — no runtime dependency on bun:sqlite).

import type { DbHandle } from "~/db.ts";

import {
  ACTIVATION_STATES_P05,
  APPROVAL_STATES,
  AUTHORITY_SOURCES_P05,
  CONFIDENCES,
  JUDGMENT_KINDS,
  LIFECYCLE_STATUSES,
  ONTOLOGY_VERSION,
  PROCEDURE_SUBTYPES,
  RETENTION_STATES,
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
  type TrustLevel,
} from "~/judgment/types.ts";

import {
  validateBoolean,
  validateBoundedNonEmptyString,
  isProcedureSubtype,
  validateConfidenceLabel,
  validateEpistemicOrigin,
  validateEnumArrayFilter,
  validateEnumFilter,
  validateImportance,
  validateKind,
  validateLimit,
  validateNonEmptyString,
  validateOffset,
  validateOptionalNonEmptyString,
  validateOrderBy,
  validatePlainJsonObject,
  validatePlainObjectInput,
  validateScopeContains,
  validateScopeJson,
  validateScopeObject,
  validateStatement,
  validateStringArray,
  validateTrustLevel,
  type ValidationResult,
} from "~/judgment/validators.ts";

// ---------------------------------------------------------------
// Phase 1A.6 — `statement_match` length cap.
//
// FTS5 phrase queries are bound parameters (no SQL injection), but a
// caller can still pressure the FTS tokenizer / BM25 ranker / SQLite
// allocator with extremely long inputs. 512 characters comfortably
// accommodates a few search terms in any language while keeping the
// per-query cost bounded.
// ---------------------------------------------------------------
const JUDGMENT_STATEMENT_MATCH_MAX_LENGTH = 512;

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

type JsonObject = Record<string, unknown>;
type JsonArrayOrObject = JsonObject | unknown[];

function parsePersistedJson(raw: string, field: string, owner: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new JudgmentValidationError(`${owner} has malformed ${field}`, field);
  }
}

function parsePersistedObject(raw: string, field: string, owner: string): JsonObject {
  const parsed = parsePersistedJson(raw, field, owner);
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new JudgmentValidationError(`${owner} ${field} must be a JSON object`, field);
  }
  return parsed as JsonObject;
}

function parsePersistedStringArray(
  raw: string | null,
  field: string,
  owner: string,
): string[] {
  if (raw === null) return [];
  const parsed = parsePersistedJson(raw, field, owner);
  if (!Array.isArray(parsed)) {
    throw new JudgmentValidationError(`${owner} ${field} must be a JSON array`, field);
  }
  const validation = validateStringArray(parsed, field);
  if (!validation.ok) {
    throw new JudgmentValidationError(validation.reason, field);
  }
  return parsed as string[];
}

function parsePersistedJsonValue(
  raw: string | null,
  field: string,
  owner: string,
): JsonArrayOrObject | null {
  if (raw === null) return null;
  const parsed = parsePersistedJson(raw, field, owner);
  if (parsed === null || typeof parsed !== "object") {
    throw new JudgmentValidationError(
      `${owner} ${field} must be a JSON object or array`,
      field,
    );
  }
  return parsed as JsonArrayOrObject;
}

function jsonStableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => jsonStableStringify(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${jsonStableStringify(record[key])}`)
    .join(",")}}`;
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  return jsonStableStringify(left) === jsonStableStringify(right);
}

function matchesScopeContains(
  scope: JsonObject,
  scopeContains: JsonObject | undefined,
): boolean {
  if (scopeContains === undefined) return true;
  for (const [key, expectedValue] of Object.entries(scopeContains)) {
    if (!Object.prototype.hasOwnProperty.call(scope, key)) {
      return false;
    }
    if (!jsonValuesEqual(scope[key], expectedValue)) {
      return false;
    }
  }
  return true;
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

    // Only normal-retention judgments may receive evidence.
    // archived and deleted judgments are rejected, as are any future non-normal values.
    if (existingJudgment.retention_state !== "normal") {
      throw new JudgmentStateError(
        `judgment ${judgment_id} cannot receive evidence: retention_state=${existingJudgment.retention_state}`,
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
           evidence_ids_json = $evidence_ids_json,
           updated_at        = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
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

// ---------------------------------------------------------------
// Phase 1A.5 — Commit / activation
// ---------------------------------------------------------------

export interface CommitInput {
  judgment_id: string;
  committer: string;
  reason: string;
  payload?: Record<string, unknown>;
}

export interface CommitDeps {
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

export interface CommittedJudgment {
  id: string;
  kind: JudgmentKind;
  statement: string;
  approval_state: ApprovalState;
  lifecycle_status: LifecycleStatus;
  activation_state: ActivationStateP05;
  retention_state: RetentionState;
  authority_source: AuthoritySourceP05;
  updated_at: string;
  event_type: "judgment.committed";
  event_id: string;
  evidence_link_ids: string[];
  source_ids: string[];
}

export function commitApprovedJudgment(
  db: DbHandle,
  input: CommitInput,
  deps: CommitDeps = {},
): CommittedJudgment {
  if (input === null || typeof input !== "object") {
    throw new JudgmentValidationError("input must be a plain object");
  }

  assertValid(validateNonEmptyString(input.judgment_id, "judgment_id"), "judgment_id");
  const judgment_id = input.judgment_id.trim();

  assertValid(validateNonEmptyString(input.committer, "committer"), "committer");
  const committer = input.committer.trim();

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
          source_ids_json: string | null;
          evidence_ids_json: string | null;
        },
        [string]
      >(
        `SELECT id, kind, statement, lifecycle_status, approval_state,
                activation_state, retention_state, authority_source,
                source_ids_json, evidence_ids_json
         FROM judgment_items WHERE id = ?`,
      )
      .get(judgment_id);

    if (!existing) {
      throw new JudgmentNotFoundError(`judgment ${judgment_id} not found`, judgment_id);
    }

    // Only proposed/approved/history_only/normal judgments may be committed.
    if (
      existing.lifecycle_status !== "proposed" ||
      existing.approval_state !== "approved" ||
      existing.activation_state !== "history_only" ||
      existing.retention_state !== "normal"
    ) {
      throw new JudgmentStateError(
        `judgment ${judgment_id} cannot be committed: ` +
          `lifecycle=${existing.lifecycle_status}, approval=${existing.approval_state}, ` +
          `activation=${existing.activation_state}, retention=${existing.retention_state}`,
        judgment_id,
      );
    }

    const owner = `judgment ${judgment_id}`;
    const existingSourceIds = parsePersistedStringArray(
      existing.source_ids_json,
      "source_ids_json",
      owner,
    );
    const existingEvidenceIds = parsePersistedStringArray(
      existing.evidence_ids_json,
      "evidence_ids_json",
      owner,
    );

    // Compute canonical evidence links from the relation table, but preserve the
    // existing validated denormalized array order where possible. This keeps the
    // committed audit order aligned with the evidence-link insertion order.
    const evidenceLinkRows = db
      .prepare<{ id: string; source_id: string }, [string]>(
        `SELECT id, source_id FROM judgment_evidence_links
         WHERE judgment_id = ?
         ORDER BY created_at ASC, id ASC`,
      )
      .all(judgment_id);

    if (evidenceLinkRows.length === 0) {
      throw new JudgmentStateError(
        `judgment ${judgment_id} cannot be committed: no evidence links exist`,
        judgment_id,
      );
    }

    const evidenceLinkRowById = new Map<string, { id: string; source_id: string }>();
    const linkedSourceIds = new Set<string>();

    for (const row of evidenceLinkRows) {
      evidenceLinkRowById.set(row.id, row);

      // Verify every linked source exists.
      const sourceExists = db
        .prepare<{ id: string }, [string]>(`SELECT id FROM judgment_sources WHERE id = ?`)
        .get(row.source_id);
      if (!sourceExists) {
        throw new JudgmentStateError(
          `judgment ${judgment_id} has evidence link referencing missing source ${row.source_id}`,
          judgment_id,
        );
      }

      linkedSourceIds.add(row.source_id);
    }

    // Collect canonical arrays: preserve the validated existing denormalized order,
    // then append any missing ids from the canonical relation.
    const evidenceLinkIds: string[] = [];
    const seenEvidenceLinkIds = new Set<string>();

    for (const evidenceId of existingEvidenceIds) {
      const row = evidenceLinkRowById.get(evidenceId);
      if (!row) {
        throw new JudgmentValidationError(
          `judgment ${judgment_id} evidence_ids_json references missing evidence link ${evidenceId}`,
          "evidence_ids_json",
        );
      }
      evidenceLinkIds.push(evidenceId);
      seenEvidenceLinkIds.add(evidenceId);
    }

    for (const row of evidenceLinkRows) {
      if (seenEvidenceLinkIds.has(row.id)) continue;
      evidenceLinkIds.push(row.id);
      seenEvidenceLinkIds.add(row.id);
    }

    const sourceIds: string[] = [];
    const seenSourceIds = new Set<string>();

    for (const sourceId of existingSourceIds) {
      if (!linkedSourceIds.has(sourceId)) {
        throw new JudgmentValidationError(
          `judgment ${judgment_id} source_ids_json references unlinked source ${sourceId}`,
          "source_ids_json",
        );
      }
      if (seenSourceIds.has(sourceId)) continue;
      seenSourceIds.add(sourceId);
      sourceIds.push(sourceId);
    }

    for (const evidenceId of evidenceLinkIds) {
      const row = evidenceLinkRowById.get(evidenceId)!;
      if (seenSourceIds.has(row.source_id)) continue;
      seenSourceIds.add(row.source_id);
      sourceIds.push(row.source_id);
    }

    const nowIsoStr = deps.nowIso !== undefined ? deps.nowIso() : new Date().toISOString();
    if (typeof nowIsoStr !== "string") {
      throw new JudgmentValidationError("deps.nowIso must return a string");
    }

    // Sync canonical arrays and transition state atomically.
    const updateResult = db
      .prepare(
        `UPDATE judgment_items
         SET lifecycle_status   = 'active',
             activation_state   = 'eligible',
             authority_source   = 'user_confirmed',
             source_ids_json    = $source_ids_json,
             evidence_ids_json  = $evidence_ids_json,
             updated_at         = $now
         WHERE id               = $id
           AND lifecycle_status  = 'proposed'
           AND approval_state    = 'approved'
           AND activation_state  = 'history_only'
           AND retention_state   = 'normal'`,
      )
      .run({
        source_ids_json: JSON.stringify(sourceIds),
        evidence_ids_json: JSON.stringify(evidenceLinkIds),
        now: nowIsoStr,
        id: judgment_id,
      } as never);

    if ((updateResult as unknown as { changes: number }).changes === 0) {
      throw new JudgmentStateError(
        `judgment ${judgment_id} was modified concurrently; commit aborted`,
        judgment_id,
      );
    }

    if (deps._injectEventInsertError) {
      throw deps._injectEventInsertError;
    }

    const eventPayload: Record<string, unknown> = {
      judgment_id,
      committer,
      reason,
      previous_lifecycle_status: existing.lifecycle_status,
      new_lifecycle_status: "active",
      previous_activation_state: existing.activation_state,
      new_activation_state: "eligible",
      previous_authority_source: existing.authority_source,
      new_authority_source: "user_confirmed",
      approval_state: existing.approval_state,
      evidence_link_ids: evidenceLinkIds,
      source_ids: sourceIds,
    };
    if (payloadJsonObj !== undefined) eventPayload.payload = payloadJsonObj;

    db
      .prepare(
        `INSERT INTO judgment_events (id, event_type, judgment_id, payload_json, actor)
         VALUES ($id, 'judgment.committed', $judgment_id, $payload_json, $actor)`,
      )
      .run({
        id: eventId,
        judgment_id,
        payload_json: JSON.stringify(eventPayload),
        actor: committer,
      } as never);

    return {
      id: existing.id,
      kind: existing.kind as JudgmentKind,
      statement: existing.statement,
      approval_state: existing.approval_state as ApprovalState,
      lifecycle_status: "active",
      activation_state: "eligible",
      retention_state: existing.retention_state as RetentionState,
      authority_source: "user_confirmed",
      updated_at: nowIsoStr,
      event_type: "judgment.committed",
      event_id: eventId,
      evidence_link_ids: evidenceLinkIds,
      source_ids: sourceIds,
    };
  });
}

// ---------------------------------------------------------------
// Phase 1A.6 — Read-only query / explain
// ---------------------------------------------------------------

export type JudgmentQueryOrderBy =
  | "updated_at_desc"
  | "created_at_desc"
  | "importance_desc"
  | "confidence_desc"
  | "statement_asc";

const JUDGMENT_QUERY_ORDER_BYS: readonly JudgmentQueryOrderBy[] = [
  "updated_at_desc",
  "created_at_desc",
  "importance_desc",
  "confidence_desc",
  "statement_asc",
] as const;

interface JudgmentReadRow {
  id: string;
  kind: string;
  statement: string;
  confidence: string;
  importance: number;
  scope_json: string;
  epistemic_origin: string;
  authority_source: string;
  approval_state: string;
  lifecycle_status: string;
  activation_state: string;
  retention_state: string;
  procedure_subtype: string | null;
  source_ids_json: string | null;
  evidence_ids_json: string | null;
  created_at: string;
  updated_at: string;
  revisit_at: string | null;
  valid_from: string | null;
  valid_until: string | null;
  supersedes_json: string | null;
  superseded_by_json: string | null;
  would_change_if_json: string | null;
  missing_evidence_json: string | null;
  review_trigger_json: string | null;
}

interface JudgmentSourceRow {
  id: string;
  kind: string;
  locator: string;
  content_hash: string | null;
  trust_level: string;
  redacted: number;
  captured_at: string;
}

interface JudgmentEvidenceLinkRow {
  id: string;
  judgment_id: string;
  source_id: string;
  relation: string;
  span_locator: string | null;
  quote_excerpt: string | null;
  rationale: string | null;
  created_at: string;
}

interface JudgmentEventRow {
  id: string;
  event_type: string;
  actor: string;
  created_at: string;
  payload_json: string;
}

export interface QueryJudgmentsInput {
  kind?: string;
  kinds?: string[];
  lifecycle_status?: string;
  lifecycle_statuses?: string[];
  approval_state?: string;
  approval_states?: string[];
  activation_state?: string;
  activation_states?: string[];
  retention_state?: string;
  retention_states?: string[];
  authority_source?: string;
  authority_sources?: string[];
  confidence?: string;
  confidences?: string[];
  procedure_subtype?: string;
  statement_match?: string;
  scope_contains?: Record<string, unknown>;
  include_history?: boolean;
  include_evidence?: boolean;
  limit?: number;
  offset?: number;
  order_by?: string;
}

export interface JudgmentQuerySourceSummary {
  id: string;
  kind: string;
  locator: string;
  trust_level: TrustLevel;
  redacted: boolean;
}

export interface JudgmentQueryEvidenceLinkSummary {
  id: string;
  source_id: string;
  relation: string;
  span_locator: string | null;
  quote_excerpt: string | null;
}

export interface QueriedJudgment {
  id: string;
  kind: JudgmentKind;
  statement: string;
  confidence: Confidence;
  importance: number;
  scope: JsonObject;
  epistemic_origin: EpistemicOrigin;
  authority_source: AuthoritySourceP05;
  approval_state: ApprovalState;
  lifecycle_status: LifecycleStatus;
  activation_state: ActivationStateP05;
  retention_state: RetentionState;
  procedure_subtype: ProcedureSubtype | null;
  source_ids: string[];
  evidence_ids: string[];
  created_at: string;
  updated_at: string;
  revisit_at: string | null;
  valid_from: string | null;
  valid_until: string | null;
  evidence_count?: number;
  source_count?: number;
  sources?: JudgmentQuerySourceSummary[];
  evidence_links?: JudgmentQueryEvidenceLinkSummary[];
}

export interface QueryJudgmentsResult {
  items: QueriedJudgment[];
  limit: number;
  offset: number;
  returned: number;
  has_more: boolean;
}

export interface ExplainJudgmentInput {
  judgment_id: string;
  include_events?: boolean;
  include_sources?: boolean;
  include_payloads?: boolean;
}

export interface ExplainedJudgment {
  id: string;
  kind: JudgmentKind;
  statement: string;
  confidence: Confidence;
  importance: number;
  scope: JsonObject;
  epistemic_origin: EpistemicOrigin;
  authority_source: AuthoritySourceP05;
  approval_state: ApprovalState;
  lifecycle_status: LifecycleStatus;
  activation_state: ActivationStateP05;
  retention_state: RetentionState;
  procedure_subtype: ProcedureSubtype | null;
  source_ids: string[];
  evidence_ids: string[];
  created_at: string;
  updated_at: string;
  valid_from: string | null;
  valid_until: string | null;
  revisit_at: string | null;
}

export interface ExplainedEvidenceLink {
  id: string;
  judgment_id: string;
  source_id: string;
  relation: string;
  span_locator: string | null;
  quote_excerpt: string | null;
  rationale: string | null;
  created_at: string;
}

export interface ExplainedSource {
  id: string;
  kind: string;
  locator: string;
  content_hash: string | null;
  trust_level: TrustLevel;
  redacted: boolean;
  captured_at: string;
}

export interface JudgmentWhyEntry {
  source_id: string;
  evidence_link_id: string;
  relation: string;
  source_kind: string;
  locator: string;
  trust_level: TrustLevel;
  quote_excerpt: string | null;
  span_locator: string | null;
  rationale: string | null;
}

export interface JudgmentEventSummary {
  id: string;
  event_type: string;
  actor: string;
  created_at: string;
  payload?: unknown;
}

export interface JudgmentExplanation {
  judgment: ExplainedJudgment;
  why: JudgmentWhyEntry[];
  evidence_links: ExplainedEvidenceLink[];
  sources: ExplainedSource[];
  events: JudgmentEventSummary[];
  would_change_if: JsonArrayOrObject | null;
  missing_evidence: JsonArrayOrObject | null;
  review_trigger: JsonArrayOrObject | null;
  supersedes: string[];
  superseded_by: string[];
}

// Internal normalized representation. Each filter is required-but-nullable
// (`T | undefined`) rather than `?: T` because `normalizeQueryInput` builds
// the object as a single literal and `exactOptionalPropertyTypes: true`
// rejects assigning `undefined` to a `?:` field. Treating absence as an
// explicit `undefined` is closer to how this struct is consumed: the
// SQL builder always reads every field and emits a clause only when the
// value is defined, so making the slot mandatory helps reviewers see at
// a glance which fields the builder must consider.
interface NormalizedQueryInput {
  kinds: string[] | undefined;
  lifecycle_statuses: string[] | undefined;
  approval_states: string[] | undefined;
  activation_states: string[] | undefined;
  retention_states: string[] | undefined;
  authority_sources: string[] | undefined;
  confidences: string[] | undefined;
  procedure_subtype: string | undefined;
  statement_match: string | undefined;
  scope_contains: JsonObject | undefined;
  include_history: boolean;
  include_evidence: boolean;
  limit: number;
  offset: number;
  order_by: JudgmentQueryOrderBy;
}

const JUDGMENT_QUERY_SELECT = `
  SELECT id, kind, statement, confidence, importance, scope_json,
         epistemic_origin, authority_source, approval_state,
         lifecycle_status, activation_state, retention_state,
         procedure_subtype, source_ids_json, evidence_ids_json,
         created_at, updated_at, revisit_at, valid_from, valid_until,
         supersedes_json, superseded_by_json,
         would_change_if_json, missing_evidence_json, review_trigger_json
  FROM judgment_items
`;

function assertExclusiveFilter(
  singularValue: unknown,
  pluralValue: unknown,
  singularField: string,
  pluralField: string,
): void {
  if (singularValue !== undefined && pluralValue !== undefined) {
    throw new JudgmentValidationError(
      `${singularField} and ${pluralField} must not both be supplied`,
      singularField,
    );
  }
}

function normalizeEnumFilterSet(
  singularValue: unknown,
  pluralValue: unknown,
  singularField: string,
  pluralField: string,
  allowed: readonly string[],
): string[] | undefined {
  assertExclusiveFilter(singularValue, pluralValue, singularField, pluralField);
  if (singularValue !== undefined) {
    assertValid(
      validateEnumFilter(singularValue, singularField, allowed),
      singularField,
    );
    return [singularValue as string];
  }
  if (pluralValue !== undefined) {
    assertValid(
      validateEnumArrayFilter(pluralValue, pluralField, allowed),
      pluralField,
    );
    return [...(pluralValue as string[])];
  }
  return undefined;
}

// Exhaustive key sets for strict-mode input validation.
// Any unknown key is immediately rejected with JudgmentValidationError so
// callers cannot pass stale or mistyped fields and silently get default
// behavior (e.g. { filter: "active" } would be silently ignored without this).
const QUERY_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "kind", "kinds",
  "lifecycle_status", "lifecycle_statuses",
  "approval_state", "approval_states",
  "activation_state", "activation_states",
  "retention_state", "retention_states",
  "authority_source", "authority_sources",
  "confidence", "confidences",
  "procedure_subtype",
  "statement_match",
  "scope_contains",
  "include_history",
  "include_evidence",
  "limit",
  "offset",
  "order_by",
]);

const EXPLAIN_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "judgment_id",
  "include_events",
  "include_sources",
  "include_payloads",
]);

function normalizeQueryInput(input: QueryJudgmentsInput | undefined): NormalizedQueryInput {
  if (input === undefined) {
    return {
      kinds: undefined,
      lifecycle_statuses: undefined,
      approval_states: undefined,
      activation_states: undefined,
      retention_states: undefined,
      authority_sources: undefined,
      confidences: undefined,
      procedure_subtype: undefined,
      statement_match: undefined,
      scope_contains: undefined,
      include_history: false,
      include_evidence: false,
      limit: 20,
      offset: 0,
      order_by: "updated_at_desc",
    };
  }

  assertValid(validatePlainObjectInput(input, "input"), "input");

  for (const key of Object.keys(input)) {
    if (!QUERY_ALLOWED_KEYS.has(key)) {
      throw new JudgmentValidationError(
        `queryJudgments: unknown field '${key}'`,
        key,
      );
    }
  }

  if (input.include_history !== undefined) {
    assertValid(validateBoolean(input.include_history, "include_history"), "include_history");
  }
  if (input.include_evidence !== undefined) {
    assertValid(validateBoolean(input.include_evidence, "include_evidence"), "include_evidence");
  }
  if (input.limit !== undefined) {
    assertValid(validateLimit(input.limit), "limit");
  }
  if (input.offset !== undefined) {
    assertValid(validateOffset(input.offset), "offset");
  }
  if (input.order_by !== undefined) {
    assertValid(
      validateOrderBy(input.order_by, JUDGMENT_QUERY_ORDER_BYS),
      "order_by",
    );
  }

  let statementMatch: string | undefined;
  if (input.statement_match !== undefined) {
    assertValid(
      validateBoundedNonEmptyString(
        input.statement_match,
        "statement_match",
        JUDGMENT_STATEMENT_MATCH_MAX_LENGTH,
      ),
      "statement_match",
    );
    statementMatch = (input.statement_match as string).trim();
  }

  let scopeContains: JsonObject | undefined;
  if (input.scope_contains !== undefined) {
    assertValid(validateScopeContains(input.scope_contains), "scope_contains");
    const normalizedJson = serializeOnce(input.scope_contains, "scope_contains");
    scopeContains = parsePersistedObject(
      normalizedJson,
      "scope_contains",
      "query input",
    );
  }

  const kinds = normalizeEnumFilterSet(
    input.kind,
    input.kinds,
    "kind",
    "kinds",
    JUDGMENT_KINDS,
  );
  const lifecycleStatuses = normalizeEnumFilterSet(
    input.lifecycle_status,
    input.lifecycle_statuses,
    "lifecycle_status",
    "lifecycle_statuses",
    LIFECYCLE_STATUSES,
  );
  const approvalStates = normalizeEnumFilterSet(
    input.approval_state,
    input.approval_states,
    "approval_state",
    "approval_states",
    APPROVAL_STATES,
  );
  const activationStates = normalizeEnumFilterSet(
    input.activation_state,
    input.activation_states,
    "activation_state",
    "activation_states",
    ACTIVATION_STATES_P05,
  );
  const retentionStates = normalizeEnumFilterSet(
    input.retention_state,
    input.retention_states,
    "retention_state",
    "retention_states",
    RETENTION_STATES,
  );
  const authoritySources = normalizeEnumFilterSet(
    input.authority_source,
    input.authority_sources,
    "authority_source",
    "authority_sources",
    AUTHORITY_SOURCES_P05,
  );
  const confidences = normalizeEnumFilterSet(
    input.confidence,
    input.confidences,
    "confidence",
    "confidences",
    CONFIDENCES,
  );

  let procedureSubtype: string | undefined;
  if (input.procedure_subtype !== undefined) {
    assertValid(
      validateEnumFilter(
        input.procedure_subtype,
        "procedure_subtype",
        PROCEDURE_SUBTYPES,
      ),
      "procedure_subtype",
    );
    procedureSubtype = input.procedure_subtype;
  }

  return {
    kinds,
    lifecycle_statuses: lifecycleStatuses,
    approval_states: approvalStates,
    activation_states: activationStates,
    retention_states: retentionStates,
    authority_sources: authoritySources,
    confidences,
    procedure_subtype: procedureSubtype,
    statement_match: statementMatch,
    scope_contains: scopeContains,
    include_history: input.include_history ?? false,
    include_evidence: input.include_evidence ?? false,
    limit: input.limit ?? 20,
    offset: input.offset ?? 0,
    order_by: (input.order_by ?? "updated_at_desc") as JudgmentQueryOrderBy,
  };
}

function buildOrderByClause(orderBy: JudgmentQueryOrderBy): string {
  switch (orderBy) {
    case "updated_at_desc":
      return "ORDER BY updated_at DESC, id ASC";
    case "created_at_desc":
      return "ORDER BY created_at DESC, id ASC";
    case "importance_desc":
      return "ORDER BY importance DESC, updated_at DESC, id ASC";
    case "confidence_desc":
      return `ORDER BY CASE confidence
        WHEN 'high' THEN 3
        WHEN 'medium' THEN 2
        WHEN 'low' THEN 1
        ELSE 0
      END DESC, updated_at DESC, id ASC`;
    case "statement_asc":
      return "ORDER BY statement ASC, id ASC";
  }
}

function toFtsPhraseQuery(input: string): string {
  return `"${input.replaceAll("\"", "\"\"")}"`;
}

function mapRowToQueriedJudgment(row: JudgmentReadRow): QueriedJudgment {
  const owner = `judgment ${row.id}`;
  return {
    id: row.id,
    kind: row.kind as JudgmentKind,
    statement: row.statement,
    confidence: row.confidence as Confidence,
    importance: row.importance,
    scope: parsePersistedObject(row.scope_json, "scope_json", owner),
    epistemic_origin: row.epistemic_origin as EpistemicOrigin,
    authority_source: row.authority_source as AuthoritySourceP05,
    approval_state: row.approval_state as ApprovalState,
    lifecycle_status: row.lifecycle_status as LifecycleStatus,
    activation_state: row.activation_state as ActivationStateP05,
    retention_state: row.retention_state as RetentionState,
    procedure_subtype: row.procedure_subtype as ProcedureSubtype | null,
    source_ids: parsePersistedStringArray(row.source_ids_json, "source_ids_json", owner),
    evidence_ids: parsePersistedStringArray(row.evidence_ids_json, "evidence_ids_json", owner),
    created_at: row.created_at,
    updated_at: row.updated_at,
    revisit_at: row.revisit_at,
    valid_from: row.valid_from,
    valid_until: row.valid_until,
  };
}

function mapRowToExplainedJudgment(row: JudgmentReadRow): ExplainedJudgment {
  const summary = mapRowToQueriedJudgment(row);
  return {
    id: summary.id,
    kind: summary.kind,
    statement: summary.statement,
    confidence: summary.confidence,
    importance: summary.importance,
    scope: summary.scope,
    epistemic_origin: summary.epistemic_origin,
    authority_source: summary.authority_source,
    approval_state: summary.approval_state,
    lifecycle_status: summary.lifecycle_status,
    activation_state: summary.activation_state,
    retention_state: summary.retention_state,
    procedure_subtype: summary.procedure_subtype,
    source_ids: summary.source_ids,
    evidence_ids: summary.evidence_ids,
    created_at: summary.created_at,
    updated_at: summary.updated_at,
    valid_from: summary.valid_from,
    valid_until: summary.valid_until,
    revisit_at: summary.revisit_at,
  };
}

function getSourceRowById(db: DbHandle, sourceId: string, judgmentId: string): JudgmentSourceRow {
  const source = db
    .prepare<JudgmentSourceRow, [string]>(
      `SELECT id, kind, locator, content_hash, trust_level, redacted, captured_at
       FROM judgment_sources WHERE id = ?`,
    )
    .get(sourceId);
  if (!source) {
    throw new JudgmentValidationError(
      `judgment ${judgmentId} references missing source ${sourceId}`,
      "source_id",
    );
  }
  assertValid(validateTrustLevel(source.trust_level), "trust_level");
  return source;
}

function loadEvidenceBundle(
  db: DbHandle,
  judgmentId: string,
  hints: {
    sourceIds?: string[];
    evidenceIds?: string[];
  } = {},
): {
  evidence_links: ExplainedEvidenceLink[];
  sources: ExplainedSource[];
  why: JudgmentWhyEntry[];
} {
  const linkRows = db
    .prepare<JudgmentEvidenceLinkRow, [string]>(
      `SELECT id, judgment_id, source_id, relation, span_locator,
              quote_excerpt, rationale, created_at
       FROM judgment_evidence_links
       WHERE judgment_id = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(judgmentId);

  const linkRowMap = new Map<string, JudgmentEvidenceLinkRow>();
  for (const link of linkRows) {
    linkRowMap.set(link.id, link);
  }

  const orderedLinkRows: JudgmentEvidenceLinkRow[] = [];
  const seenLinkIds = new Set<string>();

  for (const evidenceId of hints.evidenceIds ?? []) {
    const link = linkRowMap.get(evidenceId);
    if (!link) {
      throw new JudgmentValidationError(
        `judgment ${judgmentId} evidence_ids_json references missing evidence link ${evidenceId}`,
        "evidence_ids_json",
      );
    }
    orderedLinkRows.push(link);
    seenLinkIds.add(evidenceId);
  }

  for (const link of linkRows) {
    if (seenLinkIds.has(link.id)) continue;
    orderedLinkRows.push(link);
  }

  const linkedSourceIds = new Set(orderedLinkRows.map((link) => link.source_id));
  const sourceOrder: string[] = [];
  const seenSourceIds = new Set<string>();

  for (const sourceId of hints.sourceIds ?? []) {
    if (!linkedSourceIds.has(sourceId)) {
      throw new JudgmentValidationError(
        `judgment ${judgmentId} source_ids_json references unlinked source ${sourceId}`,
        "source_ids_json",
      );
    }
    if (seenSourceIds.has(sourceId)) continue;
    sourceOrder.push(sourceId);
    seenSourceIds.add(sourceId);
  }

  for (const link of orderedLinkRows) {
    if (seenSourceIds.has(link.source_id)) continue;
    sourceOrder.push(link.source_id);
    seenSourceIds.add(link.source_id);
  }

  const sourceMap = new Map<string, ExplainedSource>();
  for (const sourceId of sourceOrder) {
    const source = getSourceRowById(db, sourceId, judgmentId);
    sourceMap.set(sourceId, {
      id: source.id,
      kind: source.kind,
      locator: source.locator,
      content_hash: source.content_hash,
      trust_level: source.trust_level as TrustLevel,
      redacted: source.redacted === 1,
      captured_at: source.captured_at,
    });
  }

  const evidenceLinks = orderedLinkRows.map((link) => ({
    id: link.id,
    judgment_id: link.judgment_id,
    source_id: link.source_id,
    relation: link.relation,
    span_locator: link.span_locator,
    quote_excerpt: link.quote_excerpt,
    rationale: link.rationale,
    created_at: link.created_at,
  }));

  const sources = sourceOrder
    .map((sourceId) => sourceMap.get(sourceId))
    .filter((source): source is ExplainedSource => source !== undefined);

  const why = orderedLinkRows.map((link) => {
    const source = sourceMap.get(link.source_id);
    if (!source) {
      throw new JudgmentValidationError(
        `judgment ${judgmentId} references missing source ${link.source_id}`,
        "source_id",
      );
    }
    return {
      source_id: link.source_id,
      evidence_link_id: link.id,
      relation: link.relation,
      source_kind: source.kind,
      locator: source.locator,
      trust_level: source.trust_level,
      quote_excerpt: link.quote_excerpt,
      span_locator: link.span_locator,
      rationale: link.rationale,
    };
  });

  return { evidence_links: evidenceLinks, sources, why };
}

// Batch-load compact evidence + source metadata for a page of query results.
// Two queries total regardless of page size:
//   1. judgment_evidence_links WHERE judgment_id IN (...)
//   2. judgment_sources WHERE id IN (... unique source ids ...)
// This replaces the per-item O(N) loadEvidenceBundle calls that
// include_evidence=true previously issued for each queried judgment.
function batchLoadEvidenceBundles(
  db: DbHandle,
  items: QueriedJudgment[],
): (QueriedJudgment & {
  evidence_count: number;
  source_count: number;
  sources: JudgmentQuerySourceSummary[];
  evidence_links: JudgmentQueryEvidenceLinkSummary[];
})[] {
  if (items.length === 0) return [];

  // Batch 1 — evidence links
  const judgmentIds = items.map((item) => item.id);
  const linkBindings: Record<string, unknown> = {};
  const linkPlaceholders = judgmentIds.map((id, i) => {
    linkBindings[`jid${i}`] = id;
    return `$jid${i}`;
  });
  const linkRows = db
    .prepare<JudgmentEvidenceLinkRow>(
      `SELECT id, judgment_id, source_id, relation, span_locator,
              quote_excerpt, rationale, created_at
       FROM judgment_evidence_links
       WHERE judgment_id IN (${linkPlaceholders.join(", ")})
       ORDER BY judgment_id ASC, created_at ASC, id ASC`,
    )
    .all(linkBindings as never);

  // Group links by judgment_id, collect unique source IDs
  const linksByJudgment = new Map<string, JudgmentEvidenceLinkRow[]>();
  const allSourceIds = new Set<string>();
  for (const link of linkRows) {
    const existing = linksByJudgment.get(link.judgment_id) ?? [];
    existing.push(link);
    linksByJudgment.set(link.judgment_id, existing);
    allSourceIds.add(link.source_id);
  }

  // Batch 2 — sources (only if there are any)
  const sourceMap = new Map<string, JudgmentSourceRow>();
  if (allSourceIds.size > 0) {
    const srcIds = [...allSourceIds];
    const srcBindings: Record<string, unknown> = {};
    const srcPlaceholders = srcIds.map((id, i) => {
      srcBindings[`sid${i}`] = id;
      return `$sid${i}`;
    });
    const sourceRows = db
      .prepare<JudgmentSourceRow>(
        `SELECT id, kind, locator, content_hash, trust_level, redacted, captured_at
         FROM judgment_sources
         WHERE id IN (${srcPlaceholders.join(", ")})`,
      )
      .all(srcBindings as never);
    for (const src of sourceRows) {
      sourceMap.set(src.id, src);
    }
  }

  // Assemble per-item compact bundles
  return items.map((item) => {
    const links = linksByJudgment.get(item.id) ?? [];

    // Denormalized consistency checks — mirrors loadEvidenceBundle behavior so
    // queryJudgments(include_evidence=true) and explainJudgment throw the same
    // errors for the same corrupted rows rather than silently diverging.
    //
    // 1. Every ID in evidence_ids_json must map to an actual link row.
    const linkById = new Map(links.map((l) => [l.id, l]));
    for (const evidenceId of item.evidence_ids) {
      if (!linkById.has(evidenceId)) {
        throw new JudgmentValidationError(
          `judgment ${item.id} evidence_ids_json references missing evidence link ${evidenceId}`,
          "evidence_ids_json",
        );
      }
    }

    // 2. Every source in source_ids_json must be referenced by at least one link.
    const linkedSourceIds = new Set(links.map((l) => l.source_id));
    for (const sourceId of item.source_ids) {
      if (!linkedSourceIds.has(sourceId)) {
        throw new JudgmentValidationError(
          `judgment ${item.id} source_ids_json references unlinked source ${sourceId}`,
          "source_ids_json",
        );
      }
    }

    // Apply denormalized evidence_ids ordering — mirrors loadEvidenceBundle hint
    // ordering so queryJudgments(include_evidence=true) and explainJudgment
    // return links/sources in the same order for the same judgment.
    const orderedLinks: JudgmentEvidenceLinkRow[] = [];
    const seenOrderedLinkIds = new Set<string>();
    // 1. Honor evidence_ids_json order first.
    for (const evidenceId of item.evidence_ids) {
      const link = linkById.get(evidenceId);
      // Existence already validated above; skip duplicates in the denormalized array.
      if (link && !seenOrderedLinkIds.has(evidenceId)) {
        orderedLinks.push(link);
        seenOrderedLinkIds.add(evidenceId);
      }
    }
    // 2. Append any links not yet referenced by evidence_ids_json (DB-ordered fallback).
    for (const link of links) {
      if (!seenOrderedLinkIds.has(link.id)) {
        orderedLinks.push(link);
        seenOrderedLinkIds.add(link.id);
      }
    }

    // Apply denormalized source_ids ordering — same strategy.
    const seenSourceIds = new Set<string>();
    const sources: JudgmentQuerySourceSummary[] = [];
    // 1. source_ids_json order first.
    for (const sourceId of item.source_ids) {
      if (seenSourceIds.has(sourceId)) continue;
      seenSourceIds.add(sourceId);
      const src = sourceMap.get(sourceId);
      if (!src) {
        throw new JudgmentValidationError(
          `judgment ${item.id} references missing source ${sourceId}`,
          "source_id",
        );
      }
      assertValid(validateTrustLevel(src.trust_level), "trust_level");
      sources.push({
        id: src.id,
        kind: src.kind,
        locator: src.locator,
        trust_level: src.trust_level as TrustLevel,
        redacted: src.redacted === 1,
      });
    }
    // 2. Append any sources from links not yet in source_ids_json.
    for (const link of orderedLinks) {
      if (seenSourceIds.has(link.source_id)) continue;
      seenSourceIds.add(link.source_id);
      const src = sourceMap.get(link.source_id);
      if (!src) {
        throw new JudgmentValidationError(
          `judgment ${item.id} references missing source ${link.source_id}`,
          "source_id",
        );
      }
      assertValid(validateTrustLevel(src.trust_level), "trust_level");
      sources.push({
        id: src.id,
        kind: src.kind,
        locator: src.locator,
        trust_level: src.trust_level as TrustLevel,
        redacted: src.redacted === 1,
      });
    }
    const evidenceLinks: JudgmentQueryEvidenceLinkSummary[] = orderedLinks.map((l) => ({
      id: l.id,
      source_id: l.source_id,
      relation: l.relation,
      span_locator: l.span_locator,
      quote_excerpt: l.quote_excerpt,
    }));
    return {
      ...item,
      evidence_count: orderedLinks.length,
      source_count: sources.length,
      sources,
      evidence_links: evidenceLinks,
    };
  });
}

function loadEvents(
  db: DbHandle,
  judgmentId: string,
  includePayloads: boolean,
): JudgmentEventSummary[] {
  const eventRows = db
    .prepare<JudgmentEventRow, [string]>(
      `SELECT id, event_type, actor, created_at, payload_json
       FROM judgment_events
       WHERE judgment_id = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(judgmentId);

  return eventRows.map((row) => {
    if (!includePayloads) {
      return {
        id: row.id,
        event_type: row.event_type,
        actor: row.actor,
        created_at: row.created_at,
      };
    }
    return {
      id: row.id,
      event_type: row.event_type,
      actor: row.actor,
      created_at: row.created_at,
      payload: parsePersistedJson(
        row.payload_json,
        "payload_json",
        `judgment event ${row.id}`,
      ),
    };
  });
}

export function queryJudgments(
  db: DbHandle,
  input?: QueryJudgmentsInput,
): QueryJudgmentsResult {
  const normalized = normalizeQueryInput(input);

  const bindings: Record<string, unknown> = {};
  let bindIndex = 0;
  const bind = (value: unknown): string => {
    const name = `p${bindIndex}`;
    bindings[name] = value;
    bindIndex += 1;
    return `$${name}`;
  };

  const where: string[] = [];

  const appendInFilter = (column: string, values: string[] | undefined): void => {
    if (!values || values.length === 0) return;
    const placeholders = values.map((value) => bind(value)).join(", ");
    where.push(`${column} IN (${placeholders})`);
  };

  appendInFilter("kind", normalized.kinds);
  appendInFilter("approval_state", normalized.approval_states);
  appendInFilter("authority_source", normalized.authority_sources);
  appendInFilter("confidence", normalized.confidences);

  if (normalized.procedure_subtype !== undefined) {
    where.push(`procedure_subtype = ${bind(normalized.procedure_subtype)}`);
  }

  if (normalized.statement_match !== undefined) {
    where.push(
      `fts_rowid IN (
         SELECT rowid FROM judgment_items_fts
         WHERE judgment_items_fts MATCH ${bind(toFtsPhraseQuery(normalized.statement_match))}
       )`,
    );
  }

  if (normalized.include_history) {
    appendInFilter("lifecycle_status", normalized.lifecycle_statuses);
    appendInFilter("activation_state", normalized.activation_states);
    appendInFilter("retention_state", normalized.retention_states);

    const hasHistoryStatusFilter =
      normalized.lifecycle_statuses !== undefined ||
      normalized.activation_states !== undefined ||
      normalized.retention_states !== undefined;

    const explicitlyRequestsDeleted =
      normalized.retention_states !== undefined &&
      normalized.retention_states.includes("deleted");

    if (!hasHistoryStatusFilter) {
      where.push(`retention_state != ${bind("deleted")}`);
    } else if (normalized.retention_states === undefined && !explicitlyRequestsDeleted) {
      where.push(`retention_state != ${bind("deleted")}`);
    }
  } else {
    where.push(`lifecycle_status = ${bind("active")}`);
    where.push(`activation_state = ${bind("eligible")}`);
    where.push(`retention_state = ${bind("normal")}`);
    appendInFilter("lifecycle_status", normalized.lifecycle_statuses);
    appendInFilter("activation_state", normalized.activation_states);
    appendInFilter("retention_state", normalized.retention_states);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const orderClause = buildOrderByClause(normalized.order_by);

  let sliced: QueriedJudgment[];
  let has_more: boolean;

  if (normalized.scope_contains === undefined) {
    // Fast path: no in-memory filtering needed.
    // Push LIMIT/OFFSET into SQL so SQLite returns only the rows the
    // caller actually wants — no unbounded in-memory scan.
    // Fetch limit+1 rows so we can determine has_more without a
    // separate COUNT(*) query.
    const limitSql = `LIMIT ${bind(normalized.limit + 1)} OFFSET ${bind(normalized.offset)}`;
    const sql = `${JUDGMENT_QUERY_SELECT} ${whereClause} ${orderClause} ${limitSql}`;
    const rows = db.prepare<JudgmentReadRow>(sql).all(bindings as never);
    has_more = rows.length > normalized.limit;
    sliced = rows.slice(0, normalized.limit).map(mapRowToQueriedJudgment);
  } else {
    // Slow path: scope_contains requires in-memory JSON containment
    // filtering after the SQL fetch, so LIMIT/OFFSET cannot be pushed
    // down. Callers should narrow the result set with other SQL-level
    // filters (kind, lifecycle_status, etc.) to keep the fetch bounded.
    const sql = `${JUDGMENT_QUERY_SELECT} ${whereClause} ${orderClause}`;
    const rows = db.prepare<JudgmentReadRow>(sql).all(bindings as never);
    const filtered = rows
      .map((row) => mapRowToQueriedJudgment(row))
      .filter((item) => matchesScopeContains(item.scope, normalized.scope_contains));
    has_more = filtered.length > normalized.offset + normalized.limit;
    sliced = filtered.slice(normalized.offset, normalized.offset + normalized.limit);
  }

  const items = normalized.include_evidence
    ? batchLoadEvidenceBundles(db, sliced)
    : sliced;

  return {
    items,
    limit: normalized.limit,
    offset: normalized.offset,
    returned: items.length,
    has_more,
  };
}

export function explainJudgment(
  db: DbHandle,
  input: ExplainJudgmentInput,
): JudgmentExplanation {
  assertValid(validatePlainObjectInput(input, "input"), "input");

  for (const key of Object.keys(input)) {
    if (!EXPLAIN_ALLOWED_KEYS.has(key)) {
      throw new JudgmentValidationError(
        `explainJudgment: unknown field '${key}'`,
        key,
      );
    }
  }

  assertValid(validateNonEmptyString(input.judgment_id, "judgment_id"), "judgment_id");

  if (input.include_events !== undefined) {
    assertValid(validateBoolean(input.include_events, "include_events"), "include_events");
  }
  if (input.include_sources !== undefined) {
    assertValid(validateBoolean(input.include_sources, "include_sources"), "include_sources");
  }
  if (input.include_payloads !== undefined) {
    assertValid(validateBoolean(input.include_payloads, "include_payloads"), "include_payloads");
  }

  const judgmentId = input.judgment_id.trim();
  const includeEvents = input.include_events ?? true;
  const includeSources = input.include_sources ?? true;
  const includePayloads = input.include_payloads ?? false;

  const row = db
    .prepare<JudgmentReadRow, [string]>(
      `${JUDGMENT_QUERY_SELECT} WHERE id = ?`,
    )
    .get(judgmentId);

  if (!row) {
    throw new JudgmentNotFoundError(`judgment ${judgmentId} not found`, judgmentId);
  }

  if (row.retention_state === "deleted") {
    throw new JudgmentStateError(
      `judgment ${judgmentId} cannot be explained: retention_state=deleted`,
      judgmentId,
    );
  }

  const owner = `judgment ${judgmentId}`;
  const judgment = mapRowToExplainedJudgment(row);
  const evidenceBundle = loadEvidenceBundle(db, judgmentId, {
    sourceIds: judgment.source_ids,
    evidenceIds: judgment.evidence_ids,
  });

  return {
    judgment,
    why: evidenceBundle.why,
    evidence_links: evidenceBundle.evidence_links,
    sources: includeSources ? evidenceBundle.sources : [],
    events: includeEvents
      ? loadEvents(db, judgmentId, includePayloads)
      : [],
    would_change_if: parsePersistedJsonValue(
      row.would_change_if_json,
      "would_change_if_json",
      owner,
    ),
    missing_evidence: parsePersistedJsonValue(
      row.missing_evidence_json,
      "missing_evidence_json",
      owner,
    ),
    review_trigger: parsePersistedJsonValue(
      row.review_trigger_json,
      "review_trigger_json",
      owner,
    ),
    supersedes: parsePersistedStringArray(row.supersedes_json, "supersedes_json", owner),
    superseded_by: parsePersistedStringArray(
      row.superseded_by_json,
      "superseded_by_json",
      owner,
    ),
  };
}
