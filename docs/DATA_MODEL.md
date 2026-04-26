# Data Model

> Status: thin current-state map · Owner: project lead ·
> Last updated: 2026-04-27
>
> This file is a human-readable map. It is **not** authoritative.
> The authoritative schema lives in `migrations/*.sql` and the
> code under `src/db/` and `src/storage/`. PRD Appendix D records
> the original column-by-column contract for the implemented
> tables. `docs/JUDGMENT_SYSTEM.md` records the architectural
> commitment for the planned Judgment System schema (per DEC-037,
> that document is a historical record and not implementation
> authority).

## Source of truth

- `migrations/*.sql` — SQL definitions, CHECK constraints, indices.
- `src/db.ts`, `src/db/migrator.ts` — pragma setup and migration
  runner (`schema.migrations.<NNN>` keys in `settings`).
- `src/storage/objects.ts` — row builders / readers for
  `storage_objects` and `memory_artifact_links`.
- `docs/PRD.md` Appendix D — original column contract.
- `docs/02_HLD.md` §5 — writer map, cross-table invariants,
  idempotency keys.

If this document and the migrations disagree, the migrations win and
this document is stale and should be patched.

## Migration ordering

Forward-only, contiguous from version 1. Gaps are refused at boot
(`src/db/migrator.ts`). Applied versions are recorded under
`settings.key = 'schema.migrations.<NNN>'`.

| Version | File                                                    |
| ------- | ------------------------------------------------------- |
| 001     | `migrations/001_init.sql`                               |
| 002     | `migrations/002_artifacts.sql`                          |
| 003     | `migrations/003_notification_payload_text.sql`          |

`/doctor` checks `expected_schema_version = 3` (see
`src/main.ts`). Bumping the schema requires updating that constant
in lockstep with a new migration.

## Currently implemented schema

### `allowed_users`

Config-driven; not mutated at runtime. Typically one row in P0.

### `settings`

Opaque key/value store. Notable keys:

- `telegram_next_offset` — long-poll offset (writer:
  `src/telegram/poller.ts`).
- `bootstrap_whoami.expires_at` — DEC-009 30-minute auto-expiry.
- `schema.migrations.<NNN>` — applied migration markers.

### `telegram_updates`

Inbound update ledger.

- `status ∈ { received, enqueued, skipped, failed }`.
- `update_id` is the Telegram-side primary key (also used as
  idempotency root for inbound jobs).

### `sessions`

One row per user-visible "conversation window". Created on first
inbound after `/end` or cold boot.

- `status ∈ { active, ended }`.

### `jobs`

Durable job queue.

- `status ∈ { queued, running, succeeded, failed, cancelled, interrupted }`.
- `job_type ∈ { provider_run, summary_generation, storage_sync, notification_retry }`.
- `(job_type, idempotency_key)` is globally unique. Idempotency-key
  shapes per HLD §5.3:
  - `'telegram:' || update_id`
  - `'summary:' || session_id || ':' || user_trigger_epoch`
  - `'end:' || session_id`
  - `'sync:' || storage_object_id`
  - `'notify:' || outbound_notification_id`

### `provider_runs`

One row per Claude subprocess execution. A single `jobs` row may own
multiple `provider_runs` (e.g. resume failure → replay retry).

- `provider ∈ { claude, fake }`.
- `context_packing_mode ∈ { resume_mode, replay_mode }`.
- `status ∈ { started, succeeded, failed, cancelled, interrupted }`.
- `parser_status ∈ { parsed, fallback_used, parse_error }`.

### `provider_raw_events`

One row per redacted line emitted by the subprocess. Ordered by
`(provider_run_id, event_index)`.

- `redaction_applied = 1` invariant: no unredacted bytes persisted.

### `turns`

User / assistant / system turns.

- `role ∈ { user, assistant, system }`.
- `content_redacted` is always the output of
  `src/observability/redact.ts`.

### `outbound_notifications` and `outbound_notification_chunks`

Two-level notification ledger.

- `notification_type ∈ { job_accepted, job_completed, job_failed, job_cancelled, summary, doctor }`.
- Roll-up `status ∈ { pending, sent, failed }`; per-chunk status
  drives the retry pass (chunk 3 failing must not resend chunks 1–2).
- `payload_text` (added by migration 003) lets the retry path
  reconstruct chunk text without depending on an assistant turn.

### `memory_summaries`

Session / project / daily summary snapshots with provenance and
confidence JSON columns.

- `summary_type ∈ { session, project, daily }`.

### `memory_items`

Atomic memory rows with explicit supersede semantics.

- `item_type ∈ { fact, preference, decision, open_task, caution }`.
- `provenance ∈ { user_stated, user_confirmed, observed, inferred, tool_output, assistant_generated }`.
- `status ∈ { active, superseded, revoked }`.
- `supersedes_memory_id` chains corrections.

### `storage_objects`

Two-phase attachment / artifact ledger.

- `storage_backend ∈ { s3, local }`.
- `source_channel ∈ { telegram, provider, system }`.
- `artifact_type ∈ { user_upload, generated_artifact, redacted_provider_transcript, conversation_transcript, memory_snapshot, parser_fixture, other }`.
- `retention_class ∈ { ephemeral, session, long_term, archive }`.
- `capture_status ∈ { pending, captured, failed }` (Phase 1
  metadata vs Phase 2 byte capture).
- `status ∈ { pending, uploaded, failed, deletion_requested, deleted, delete_failed }` (S3 sync status, meaningful only when
  `capture_status = 'captured'`).

### `memory_artifact_links`

Attaches meaning to an artifact.

- `relation_type ∈ { evidence, attachment, generated_output, reference, source }`.
- CHECK requires `memory_summary_id` or `turn_id` to be non-null.

## Cross-table invariants

These are enforced in code + invariant tests, not in SQL triggers.
The full list lives in `docs/02_HLD.md` §5.2; the most common ones
to keep in mind:

- `settings.telegram_next_offset` is advanced **only after** the
  transaction that recorded the matching `telegram_updates` rows
  has committed.
- Every `telegram_updates.status = enqueued` row has a `jobs` row
  whose `idempotency_key = 'telegram:' || update_id`.
- A `jobs` row with `job_type = provider_run` reaching
  `status = succeeded` has at least one `provider_runs.status = succeeded`
  and at least one assistant `turns` row.
- `memory_artifact_links` with `memory_summary_id != null` requires
  the linked `storage_objects` row to satisfy
  `retention_class = 'long_term' AND status = 'uploaded'`.
- Any persisted row in `provider_raw_events`,
  `telegram_updates.raw_update_json_redacted`, or
  `turns.*_redacted` has `redaction_applied = true` and is free of
  the patterns named in PRD §15.

## Migration policy

- Schema changes require a new migration file
  `migrations/<NNN>_<slug>.sql`. Versions are contiguous from 001.
- The migration runner refuses gaps. Do not skip a number; do not
  rename a previously released migration.
- Bump `expected_schema_version` in `src/main.ts` together with the
  migration so `/doctor` flags drift.
- Update this document and `docs/CODE_MAP.md` in the same PR.
- A schema change is an architecture-level event for the affected
  table. If the table is new or its semantics change, add an ADR.

## Planned Judgment System schema (not implemented)

The DB-native AI-first Judgment System direction defines a separate
schema family. None of these tables exist in `migrations/` today.
Names and constraints come from the Phase 0 / 0.5 design records
that landed on `main` as ADR-0009 … ADR-0013 plus
`docs/JUDGMENT_SYSTEM.md` (per DEC-037, that spec is a historical
architectural record, not implementation authority).

| Planned table                                | Purpose                                                              | Source of truth for the planned shape                            |
| -------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `judgment_sources`                           | Source of a judgment fragment (turn, attachment, external).          | `docs/JUDGMENT_SYSTEM.md` §SQL schema sketch (P0.5); ADR-0009.   |
| `judgment_items`                             | Atomic judgment rows (the Judgment System analogue of memory_items). | `docs/JUDGMENT_SYSTEM.md` §Core data model + §SQL schema sketch. |
| `judgment_evidence_links`                    | Links between judgments and supporting evidence rows.                | `docs/JUDGMENT_SYSTEM.md` §SQL schema sketch.                    |
| `judgment_edges`                             | Typed relations between judgments (supports, contradicts, refines).  | `docs/JUDGMENT_SYSTEM.md` §Core data model + §SQL schema sketch. |
| `judgment_events`                            | Append-only event log for judgment lifecycle changes.                | `docs/JUDGMENT_SYSTEM.md` §SQL schema sketch.                    |
| `control_gate_events` / `control_plane_events` | Control Gate decisions per query (table name itself is open per Phase 1A scope). | `docs/JUDGMENT_SYSTEM.md` §Implementation Readiness; ADR-0012. |
| `tensions`                                   | Telemetry for unresolved tension between judgments / sources.        | `docs/JUDGMENT_SYSTEM.md` §Critique Lens + Tension Generalization; ADR-0013. |
| `reflection_triage_events`                   | Reflection / triage outcomes feeding back into judgments.            | `docs/JUDGMENT_SYSTEM.md` §Metacognitive Critique Loop; ADR-0012, ADR-0013. |

Until these are introduced via real migrations and supporting code,
treat them as documentation only. Do not seed them in tests, do not
write code that depends on them, and do not migrate
`memory_summaries` / `memory_items` data into them.

Q-027 (`memory_items` ↔ `judgment_items` 관계) is open. ADR-0009
commits to "분리" as the Phase 0 starting point; the implementation
salvage audit (future task) will decide whether existing memory
schema is KEEP / ADAPT / REPLACE / DELETE.

## Naming notes (Phase 0 / 0.5 final terms)

When the Judgment System schema lands, the terminology below is the
agreed final shape per the Phase 0 / 0.5 review rounds (ADR-0011 …
ADR-0013, DEC-029, DEC-033, DEC-036):

- `epistemic_origin` — **not** `epistemic_status` (ADR-0012,
  ADR-0013).
- `authority_source` — separate axis from `epistemic_origin`
  (ADR-0012).
- `lifecycle_status` — judgment truth lifecycle axis (ADR-0013,
  DEC-033).
- `activation_state` — whether a judgment is currently a workspace
  candidate (ADR-0013, DEC-033).
- `retention_state` — durable retention / exposure policy
  (ADR-0013, DEC-033).
- `current_operating_view` — projection of the active judgment set
  (DEC-036); **not** "current truth".
- `Tension` — **not** `DesignTension` (ADR-0013 §Tension
  Generalization).
- `Control Gate` — **not** `Exception Probe Gate` (Round 14
  cleanup).

Use these names from the start when implementing Phase 1A schema so
later renames are not needed.

## Derived projections (planned)

- Vector index over `judgment_items` content — derived, not
  authoritative.
- Graph view over `judgment_edges` — derived, not authoritative.

The DB remains the canonical store; vector / graph databases are
projections that may be rebuilt from the DB. Do not promote them to
source-of-truth status without an ADR.
