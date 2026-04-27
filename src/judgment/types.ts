// Personal Agent — Judgment System Phase 1A.1 enum surfaces.
//
// This module is the single source of truth for the literal sets
// that mirror the CHECK constraints on `judgment_items` and its
// sibling tables (see `migrations/004_judgment_skeleton.sql`).
// Validators in `src/judgment/validators.ts` and any future
// runtime code that constructs judgment rows MUST import the
// arrays / types from this file rather than re-declaring them.
//
// Per ADR-0014 (P1 Bun boundary), this module is pure
// TypeScript — no `Bun` API import, no `bun:*` import — so the
// types stay portable for tooling, codegen, and future tests
// running outside the Bun harness.

// ---------------------------------------------------------------
// kind (DEC-023, P0.5 — 6 values)
// ---------------------------------------------------------------
export const JUDGMENT_KINDS = [
  "fact",
  "preference",
  "decision",
  "current_state",
  "procedure",
  "caution",
] as const;
export type JudgmentKind = (typeof JUDGMENT_KINDS)[number];

// ---------------------------------------------------------------
// epistemic_origin (ADR-0012 / ADR-0013 — 6 values)
// ---------------------------------------------------------------
export const EPISTEMIC_ORIGINS = [
  "observed",
  "user_stated",
  "user_confirmed",
  "inferred",
  "assistant_generated",
  "tool_output",
] as const;
export type EpistemicOrigin = (typeof EPISTEMIC_ORIGINS)[number];

// ---------------------------------------------------------------
// authority_source (ADR-0012, DEC-029, P0.5 — 2 values)
// `system_authored` / `maintainer_approved` are P1+.
// ---------------------------------------------------------------
export const AUTHORITY_SOURCES_P05 = ["none", "user_confirmed"] as const;
export type AuthoritySourceP05 = (typeof AUTHORITY_SOURCES_P05)[number];

// ---------------------------------------------------------------
// approval_state (ADR-0013 — 4 values)
// ---------------------------------------------------------------
export const APPROVAL_STATES = [
  "not_required",
  "pending",
  "approved",
  "rejected",
] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];

// ---------------------------------------------------------------
// lifecycle_status (ADR-0013, DEC-033 — 6 values)
// ---------------------------------------------------------------
export const LIFECYCLE_STATUSES = [
  "proposed",
  "active",
  "rejected",
  "revoked",
  "superseded",
  "expired",
] as const;
export type LifecycleStatus = (typeof LIFECYCLE_STATUSES)[number];

// ---------------------------------------------------------------
// activation_state (ADR-0013, DEC-033, P0.5 — 3 values)
// `dormant` / `stale` etc. are P1+.
// ---------------------------------------------------------------
export const ACTIVATION_STATES_P05 = [
  "eligible",
  "history_only",
  "excluded",
] as const;
export type ActivationStateP05 = (typeof ACTIVATION_STATES_P05)[number];

// ---------------------------------------------------------------
// retention_state (ADR-0013, DEC-033 — 3 values)
// ---------------------------------------------------------------
export const RETENTION_STATES = ["normal", "archived", "deleted"] as const;
export type RetentionState = (typeof RETENTION_STATES)[number];

// ---------------------------------------------------------------
// confidence (3-level label, ADR-0011)
// ---------------------------------------------------------------
export const CONFIDENCES = ["low", "medium", "high"] as const;
export type Confidence = (typeof CONFIDENCES)[number];

// ---------------------------------------------------------------
// trust_level (judgment_sources column — same value set as
// confidence but semantically distinct: describes how much the
// agent trusts the ingestion source, not the judgment itself).
// ---------------------------------------------------------------
export const TRUST_LEVELS = ["low", "medium", "high"] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];

// ---------------------------------------------------------------
// decay_policy (ADR-0011, DEC-027, P0.5 — 2 values)
// `time_decay` / `verification_decay` / `event_driven` are P1+.
// ---------------------------------------------------------------
export const DECAY_POLICIES_P05 = ["none", "supersede_only"] as const;
export type DecayPolicyP05 = (typeof DECAY_POLICIES_P05)[number];

// ---------------------------------------------------------------
// procedure_subtype (DEC-034 — 5 values)
// Default `skill` is applied at the application layer when
// `kind = 'procedure'`; the column itself is nullable in 004.
// ---------------------------------------------------------------
export const PROCEDURE_SUBTYPES = [
  "skill",
  "policy",
  "preference_adaptation",
  "safety_rule",
  "workflow_rule",
] as const;
export type ProcedureSubtype = (typeof PROCEDURE_SUBTYPES)[number];

// ---------------------------------------------------------------
// Default version constants (DEC-028).
//
// Phase 1A.1 ships with `judgment-taxonomy-v0.1` ontology and
// `0.1.0` schema. These are the values that callers should
// stamp onto newly minted judgment rows when no migration step
// has yet rewritten them.
// ---------------------------------------------------------------
export const ONTOLOGY_VERSION = "judgment-taxonomy-v0.1";
export const SCHEMA_VERSION = "0.1.0";
