// Personal Agent — Judgment System Phase 1A.1 validators.
//
// Pure-TS, dependency-free helpers. Each `is*` function is a
// type guard over the corresponding literal array in
// `./types.ts`. The `validate*` helpers return a tagged result
// (`{ ok: true } | { ok: false; reason: string }`) so callers
// can compose validation without try/catch.
//
// Per ADR-0014 (P1 Bun boundary), this module imports nothing
// from `Bun` or `bun:*` — it is intentionally portable.

import {
  ACTIVATION_STATES_P05,
  APPROVAL_STATES,
  AUTHORITY_SOURCES_P05,
  CONFIDENCES,
  DECAY_POLICIES_P05,
  EPISTEMIC_ORIGINS,
  JUDGMENT_KINDS,
  LIFECYCLE_STATUSES,
  PROCEDURE_SUBTYPES,
  RETENTION_STATES,
  TRUST_LEVELS,
  type ActivationStateP05,
  type ApprovalState,
  type AuthoritySourceP05,
  type Confidence,
  type DecayPolicyP05,
  type EpistemicOrigin,
  type JudgmentKind,
  type LifecycleStatus,
  type ProcedureSubtype,
  type RetentionState,
  type TrustLevel,
} from "~/judgment/types.ts";

export type ValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

// ---------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------

export function isJudgmentKind(value: unknown): value is JudgmentKind {
  return (
    typeof value === "string" &&
    (JUDGMENT_KINDS as readonly string[]).includes(value)
  );
}

export function isEpistemicOrigin(value: unknown): value is EpistemicOrigin {
  return (
    typeof value === "string" &&
    (EPISTEMIC_ORIGINS as readonly string[]).includes(value)
  );
}

export function isAuthoritySourceP05(
  value: unknown,
): value is AuthoritySourceP05 {
  return (
    typeof value === "string" &&
    (AUTHORITY_SOURCES_P05 as readonly string[]).includes(value)
  );
}

export function isApprovalState(value: unknown): value is ApprovalState {
  return (
    typeof value === "string" &&
    (APPROVAL_STATES as readonly string[]).includes(value)
  );
}

export function isLifecycleStatus(value: unknown): value is LifecycleStatus {
  return (
    typeof value === "string" &&
    (LIFECYCLE_STATUSES as readonly string[]).includes(value)
  );
}

export function isActivationStateP05(
  value: unknown,
): value is ActivationStateP05 {
  return (
    typeof value === "string" &&
    (ACTIVATION_STATES_P05 as readonly string[]).includes(value)
  );
}

export function isRetentionState(value: unknown): value is RetentionState {
  return (
    typeof value === "string" &&
    (RETENTION_STATES as readonly string[]).includes(value)
  );
}

export function isConfidence(value: unknown): value is Confidence {
  return (
    typeof value === "string" &&
    (CONFIDENCES as readonly string[]).includes(value)
  );
}

export function isDecayPolicyP05(value: unknown): value is DecayPolicyP05 {
  return (
    typeof value === "string" &&
    (DECAY_POLICIES_P05 as readonly string[]).includes(value)
  );
}

export function isProcedureSubtype(value: unknown): value is ProcedureSubtype {
  return (
    typeof value === "string" &&
    (PROCEDURE_SUBTYPES as readonly string[]).includes(value)
  );
}

// ---------------------------------------------------------------
// Field validators (return tagged result)
// ---------------------------------------------------------------

/** A `statement` must be a non-empty string after trimming. */
export function validateStatement(s: unknown): ValidationResult {
  if (typeof s !== "string") {
    return { ok: false, reason: "statement must be a string" };
  }
  if (s.trim().length === 0) {
    return { ok: false, reason: "statement must be non-empty after trim" };
  }
  return { ok: true };
}

/**
 * `scope_json` must parse and yield a plain object — not array,
 * not null, not primitive. Mirrors the `json_valid()` CHECK plus
 * the application-level shape requirement.
 */
export function validateScopeJson(s: unknown): ValidationResult {
  if (typeof s !== "string") {
    return { ok: false, reason: "scope_json must be a string" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch (e) {
    return {
      ok: false,
      reason: `scope_json is not valid JSON: ${(e as Error).message}`,
    };
  }
  if (parsed === null) {
    return { ok: false, reason: "scope_json must not be null" };
  }
  if (Array.isArray(parsed)) {
    return { ok: false, reason: "scope_json must not be an array" };
  }
  if (typeof parsed !== "object") {
    return {
      ok: false,
      reason: `scope_json must be an object, got ${typeof parsed}`,
    };
  }
  return { ok: true };
}

/** `importance` must be an integer in [1, 5]. */
export function validateImportance(n: unknown): ValidationResult {
  if (typeof n !== "number" || !Number.isFinite(n)) {
    return { ok: false, reason: "importance must be a finite number" };
  }
  if (!Number.isInteger(n)) {
    return { ok: false, reason: "importance must be an integer" };
  }
  if (n < 1 || n > 5) {
    return { ok: false, reason: "importance must be between 1 and 5" };
  }
  return { ok: true };
}

/** Alias for `isConfidence` returning the tagged-result shape. */
export function validateConfidenceLabel(s: unknown): ValidationResult {
  if (isConfidence(s)) return { ok: true };
  return { ok: false, reason: "confidence must be one of low / medium / high" };
}

export function validateKind(v: unknown): ValidationResult {
  if (isJudgmentKind(v)) return { ok: true };
  return {
    ok: false,
    reason: `kind must be one of ${JUDGMENT_KINDS.join(", ")}`,
  };
}

export function validateEpistemicOrigin(v: unknown): ValidationResult {
  if (isEpistemicOrigin(v)) return { ok: true };
  return {
    ok: false,
    reason: `epistemic_origin must be one of ${EPISTEMIC_ORIGINS.join(", ")}`,
  };
}

/**
 * `scope` at the application layer must be a plain object — not null,
 * not an array, not a primitive, and not a class instance (e.g. Date,
 * Map, Set). Class instances serialize differently to JSON (Date becomes
 * a string scalar, Map becomes {}) which would corrupt the stored shape
 * and make `judgment.scope` differ from what was persisted.
 * Unlike `validateScopeJson`, this takes the live object directly.
 */
export function validateScopeObject(v: unknown): ValidationResult {
  if (v === null) {
    return { ok: false, reason: "scope must not be null" };
  }
  if (Array.isArray(v)) {
    return { ok: false, reason: "scope must not be an array" };
  }
  if (typeof v !== "object") {
    return { ok: false, reason: `scope must be a plain object, got ${typeof v}` };
  }
  // Reject class instances: only plain objects ({} or Object.create(null)) allowed.
  const proto = Object.getPrototypeOf(v) as unknown;
  if (proto !== Object.prototype && proto !== null) {
    return { ok: false, reason: "scope must be a plain object, not a class instance" };
  }
  let scopeSerialized: string | undefined;
  try {
    scopeSerialized = JSON.stringify(v);
  } catch (e) {
    return {
      ok: false,
      reason: `scope cannot be serialized to JSON: ${(e as Error).message}`,
    };
  }
  // JSON.stringify returns undefined when toJSON() returns undefined — not a storable string.
  if (typeof scopeSerialized !== "string") {
    return { ok: false, reason: "scope cannot be serialized to a JSON string" };
  }
  // Re-parse to verify the stored shape is still a plain object (not a scalar).
  // An object with toJSON() returning a scalar would corrupt scope_json if accepted.
  const scopeReparsed = JSON.parse(scopeSerialized) as unknown;
  if (scopeReparsed === null || Array.isArray(scopeReparsed) || typeof scopeReparsed !== "object") {
    return { ok: false, reason: "scope must serialize to a JSON object, not a scalar or array" };
  }
  return { ok: true };
}

/**
 * Verify a string array stays a JSON array after serialization.
 * An array with a custom `toJSON()` (e.g. `toJSON() { return undefined; }`)
 * would cause `JSON.stringify` to return `undefined` or a scalar, silently
 * dropping the column value or corrupting its shape in SQLite.
 * Call this after `validateStringArray` has confirmed element types.
 */
export function validateStringArraySerialization(
  v: string[],
  fieldName: string,
): ValidationResult {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(v);
  } catch (e) {
    return {
      ok: false,
      reason: `${fieldName} cannot be serialized to JSON: ${(e as Error).message}`,
    };
  }
  if (typeof serialized !== "string") {
    return { ok: false, reason: `${fieldName} cannot be serialized to a JSON string` };
  }
  const reparsed = JSON.parse(serialized) as unknown;
  if (!Array.isArray(reparsed)) {
    return { ok: false, reason: `${fieldName} must serialize to a JSON array` };
  }
  // Re-validate element types on the reparsed array: toJSON() could return [1, 2]
  // (valid array, wrong element types) and those non-string IDs would be stored.
  return validateStringArray(reparsed, fieldName);
}

/** Every element must be a non-empty string. */
export function validateStringArray(
  v: unknown,
  fieldName: string,
): ValidationResult {
  if (!Array.isArray(v)) {
    return { ok: false, reason: `${fieldName} must be an array` };
  }
  for (let i = 0; i < v.length; i++) {
    if (typeof v[i] !== "string" || (v[i] as string).length === 0) {
      return {
        ok: false,
        reason: `${fieldName}[${i}] must be a non-empty string`,
      };
    }
  }
  return { ok: true };
}

/**
 * A value must be a non-empty string after trimming. Parametrized by field name.
 */
export function validateNonEmptyString(value: unknown, fieldName: string): ValidationResult {
  if (typeof value !== "string") {
    return { ok: false, reason: `${fieldName} must be a string` };
  }
  if (value.trim().length === 0) {
    return { ok: false, reason: `${fieldName} must be non-empty after trim` };
  }
  return { ok: true };
}

/**
 * A payload must be a plain JSON object: not null, not array, not class
 * instance, and must serialize back to a JSON object (not a scalar). This
 * rejects raw JSON strings, Date instances, Map instances, and objects with
 * a toJSON() that returns a non-object.
 */
export function validatePlainJsonObject(value: unknown, fieldName: string): ValidationResult {
  if (value === null) {
    return { ok: false, reason: `${fieldName} must not be null` };
  }
  if (Array.isArray(value)) {
    return { ok: false, reason: `${fieldName} must not be an array` };
  }
  if (typeof value !== "object") {
    return { ok: false, reason: `${fieldName} must be a plain object, got ${typeof value}` };
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) {
    return { ok: false, reason: `${fieldName} must be a plain object, not a class instance` };
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (e) {
    return {
      ok: false,
      reason: `${fieldName} cannot be serialized to JSON: ${(e as Error).message}`,
    };
  }
  if (typeof serialized !== "string") {
    return { ok: false, reason: `${fieldName} cannot be serialized to a JSON string` };
  }
  const reparsed = JSON.parse(serialized) as unknown;
  if (reparsed === null || Array.isArray(reparsed) || typeof reparsed !== "object") {
    return { ok: false, reason: `${fieldName} must serialize to a JSON object` };
  }
  return { ok: true };
}

export function isTrustLevel(value: unknown): value is TrustLevel {
  return (
    typeof value === "string" &&
    (TRUST_LEVELS as readonly string[]).includes(value)
  );
}

/** `trust_level` must be one of low / medium / high. */
export function validateTrustLevel(v: unknown): ValidationResult {
  if (isTrustLevel(v)) return { ok: true };
  return { ok: false, reason: "trust_level must be one of low / medium / high" };
}

/**
 * When defined, value must be a non-empty string after trimming.
 * Returns ok:true for undefined (field is absent).
 */
export function validateOptionalNonEmptyString(
  value: unknown,
  fieldName: string,
): ValidationResult {
  if (value === undefined) return { ok: true };
  return validateNonEmptyString(value, fieldName);
}

/**
 * Like `validateNonEmptyString`, but also rejects strings whose length
 * exceeds `maxLength`. The cap is checked **before** trimming so that a
 * caller cannot smuggle an unbounded string by padding it with whitespace
 * (the trimmed result would be short, but the parser/allocator pressure
 * is on the raw input).
 *
 * Used for free-text search inputs that flow into FTS5 phrase queries —
 * SQLite FTS5 has soft and implementation-defined upper bounds on token
 * stream size, and very long phrases can pressure the parser and the
 * BM25 ranker. The caller should pick a cap that matches the search use
 * case (a couple of search terms, not paragraphs).
 */
export function validateBoundedNonEmptyString(
  value: unknown,
  fieldName: string,
  maxLength: number,
): ValidationResult {
  if (typeof value !== "string") {
    return { ok: false, reason: `${fieldName} must be a string` };
  }
  if (value.length > maxLength) {
    return {
      ok: false,
      reason: `${fieldName} must be at most ${maxLength} characters`,
    };
  }
  if (value.trim().length === 0) {
    return { ok: false, reason: `${fieldName} must be non-empty after trim` };
  }
  return { ok: true };
}

/**
 * `v` must be a JSON-serializable object or array, and must still be an
 * object or array **after** serialization. This catches class instances such
 * as `new Date()` (which serializes to a string scalar) and objects that
 * override `toJSON()` to return a primitive — both would corrupt the stored
 * column if accepted and then persisted.
 */
export function validateJsonValue(v: unknown): ValidationResult {
  if (v === null || typeof v !== "object") {
    return { ok: false, reason: "value must be a JSON object or array" };
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(v);
  } catch (e) {
    return {
      ok: false,
      reason: `value cannot be serialized to JSON: ${(e as Error).message}`,
    };
  }
  // JSON.stringify returns undefined when toJSON() returns undefined — guard before JSON.parse.
  if (typeof serialized !== "string") {
    return { ok: false, reason: "value cannot be serialized to a JSON string" };
  }
  // Re-parse to verify the top-level shape is still an object or array.
  // Class instances like Date serialize to a string scalar; objects with
  // toJSON() returning a scalar would also fail here.
  const reparsed = JSON.parse(serialized) as unknown;
  if (reparsed === null || typeof reparsed !== "object") {
    return {
      ok: false,
      reason: "value must serialize to a JSON object or array, not a scalar",
    };
  }
  return { ok: true };
}

/**
 * A top-level input must be a plain object (or Object.create(null)),
 * not null, not an array, and not a class instance.
 */
export function validatePlainObjectInput(
  value: unknown,
  fieldName: string,
): ValidationResult {
  if (value === null) {
    return { ok: false, reason: `${fieldName} must not be null` };
  }
  if (Array.isArray(value)) {
    return { ok: false, reason: `${fieldName} must not be an array` };
  }
  if (typeof value !== "object") {
    return { ok: false, reason: `${fieldName} must be a plain object, got ${typeof value}` };
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) {
    return { ok: false, reason: `${fieldName} must be a plain object, not a class instance` };
  }
  return { ok: true };
}

/** When defined, value must be a boolean. */
export function validateBoolean(value: unknown, fieldName: string): ValidationResult {
  if (typeof value !== "boolean") {
    return { ok: false, reason: `${fieldName} must be a boolean` };
  }
  return { ok: true };
}

/**
 * Validate one enum string against a fixed literal set.
 * `allowedLabel` should be human-readable, e.g. "low / medium / high".
 */
export function validateEnumFilter(
  value: unknown,
  fieldName: string,
  allowed: readonly string[],
  allowedLabel = allowed.join(" / "),
): ValidationResult {
  if (typeof value !== "string") {
    return { ok: false, reason: `${fieldName} must be one of ${allowedLabel}` };
  }
  if (!allowed.includes(value)) {
    return { ok: false, reason: `${fieldName} must be one of ${allowedLabel}` };
  }
  return { ok: true };
}

/**
 * Validate a non-empty array of enum strings.
 */
export function validateEnumArrayFilter(
  value: unknown,
  fieldName: string,
  allowed: readonly string[],
  allowedLabel = allowed.join(" / "),
): ValidationResult {
  if (!Array.isArray(value)) {
    return { ok: false, reason: `${fieldName} must be a non-empty array` };
  }
  if (value.length === 0) {
    return { ok: false, reason: `${fieldName} must be a non-empty array` };
  }
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== "string" || !allowed.includes(value[i] as string)) {
      return {
        ok: false,
        reason: `${fieldName}[${i}] must be one of ${allowedLabel}`,
      };
    }
  }
  return { ok: true };
}

export function validateLimit(value: unknown): ValidationResult {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ok: false, reason: "limit must be an integer between 1 and 100" };
  }
  if (!Number.isInteger(value)) {
    return { ok: false, reason: "limit must be an integer between 1 and 100" };
  }
  if (value < 1 || value > 100) {
    return { ok: false, reason: "limit must be an integer between 1 and 100" };
  }
  return { ok: true };
}

export function validateOffset(value: unknown): ValidationResult {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ok: false, reason: "offset must be an integer greater than or equal to 0" };
  }
  if (!Number.isInteger(value)) {
    return { ok: false, reason: "offset must be an integer greater than or equal to 0" };
  }
  if (value < 0) {
    return { ok: false, reason: "offset must be an integer greater than or equal to 0" };
  }
  return { ok: true };
}

export function validateOrderBy(
  value: unknown,
  allowed: readonly string[],
): ValidationResult {
  return validateEnumFilter(value, "order_by", allowed, allowed.join(" / "));
}

export function validateScopeContains(value: unknown): ValidationResult {
  return validatePlainJsonObject(value, "scope_contains");
}
