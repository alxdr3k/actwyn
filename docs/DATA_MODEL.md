# Data Model

> Status: thin current-state map · Owner: project lead ·
> Last updated: 2026-04-26
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
| 004     | `migrations/004_judgment_skeleton.sql`                  |

`/doctor` checks `expected_schema_version = 4` (see
`src/main.ts`). Bumping the schema requires updating that constant
in lockstep with a new migration.

## Currently implemented schema

### `allowed_users`

Config-driven; not mutated at runtime. Typically one row in P0.

### `settings`

Opaque key/value store. Notable keys:

- `telegram.next_offset` — long-poll offset. The canonical settings
  key is `telegram.next_offset` (with a dot), defined as
  `OFFSET_KEY` in `src/telegram/inbound.ts` and read by
  `src/startup/recovery.ts`. Some prose docs (HLD §5, code comments)
  still refer to it as `telegram_next_offset`; treat the dot form as
  authoritative for SQL queries / manual repair.
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
  shapes used in code today (HLD §5.3 prose lists the same families
  but with stale spellings; the runtime is authoritative):
  - `'telegram:' || update_id`
    (`src/telegram/inbound.ts`)
  - `'summary:' || session_id || ':' || user_trigger_epoch`
    (`src/commands/summary.ts`)
  - `'end:' || session_id`
    (`src/commands/summary.ts`)
  - `'sync:' || storage_object_id`
    (`src/telegram/attachment_capture.ts` + `src/storage/sync.ts`)
  - `'notif-retry:' || notification_id`, optionally suffixed with
    `':from:' || from_job_id` when re-enqueued by a newer job
    (`enqueueNotificationRetryJob` in `src/queue/worker.ts`,
    `src/startup/recovery.ts`)

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

### `judgment_*` (Phase 1A schema skeleton — not wired into runtime)

Migration 004 (`migrations/004_judgment_skeleton.sql`) added the
following tables and an FTS5 virtual table per ADR-0009 ..
ADR-0013 and `docs/JUDGMENT_SYSTEM.md`. They are **schema only**:
no module under `src/` writes to them, no typed tool exists, and
no Control Gate or Context Compiler reads from them. Future
runtime writers will live under `src/judgment/*`.

#### `judgment_sources`

One row per ingested source (turn / attachment / external / tool
output / ...). `kind` is intentionally free-form TEXT; the source
taxonomy is still emerging in Phase 1A and we do not want every
new ingestion path to require a migration.

- `trust_level ∈ { low, medium, high }`.
- `redacted ∈ { 0, 1 }` — boolean carried as INTEGER.

#### `judgment_items`

The core judgment row. Shape follows
`docs/JUDGMENT_SYSTEM.md` §SQL schema sketch (P0.5) with the
P0.5 enum subsets enforced as DB-level CHECK constraints:

- `kind ∈ { fact, preference, decision, current_state, procedure, caution }` (DEC-023).
- `epistemic_origin ∈ { observed, user_stated, user_confirmed, inferred, assistant_generated, tool_output }` (ADR-0012, ADR-0013).
- `authority_source ∈ { none, user_confirmed }` (DEC-029).
- `approval_state ∈ { not_required, pending, approved, rejected }`.
- `lifecycle_status ∈ { proposed, active, rejected, revoked, superseded, expired }` (DEC-033).
- `activation_state ∈ { eligible, history_only, excluded }` (DEC-033, P0.5 subset).
- `retention_state ∈ { normal, archived, deleted }` (DEC-033).
- `confidence ∈ { low, medium, high }`.
- `importance` is INTEGER 1..5.
- `decay_policy ∈ { none, supersede_only }` (DEC-027, P0.5 subset).
- `procedure_subtype ∈ { skill, policy, preference_adaptation, safety_rule, workflow_rule }` or NULL (DEC-034).
- `ontology_version` and `schema_version` are NOT NULL (DEC-028).
- `scope_json` and the `*_json` columns are guarded by
  `json_valid(...)` CHECK constraints.

This is the only `judgment_*` table that does **not** use
`WITHOUT ROWID`. It declares an explicit
`fts_rowid INTEGER PRIMARY KEY` column to give the
external-content FTS5 virtual table (`judgment_items_fts`) a
stable rowid alias that survives `VACUUM` / compaction. The
application-facing identifier is `id TEXT NOT NULL UNIQUE`; FK
references from sibling tables target that column. See migration
004's header comment for the full rationale.

#### `judgment_evidence_links`

Many-to-many link from a `judgment_items` row to the
`judgment_sources` rows that support it. `relation` is open
TEXT (vocabulary still emerging).

#### `judgment_edges`

Typed relations between two `judgment_items` rows (supports /
contradicts / refines / ...). `relation` is open TEXT.

#### `judgment_events`

Append-only event log for judgment lifecycle changes.
`event_type` is open TEXT; `payload_json` is guarded by
`json_valid(...)`. `judgment_id` is nullable because some
events are not tied to a single row.

#### `judgment_items_fts`

External-content FTS5 virtual table over
`judgment_items.statement` (tokenizer `unicode61`). Three
triggers (`judgment_items_fts_ai` / `_au` / `_ad`) keep the
index in sync on every INSERT / UPDATE / DELETE on the content
table. Tested under `bun:sqlite` in
`test/db/judgment_schema.test.ts`.

## Single-writer map

Each table has one writer module. Other modules must route through
the owner instead of mutating the table directly. This is the
operative summary for AI agents; `docs/02_HLD.md` §5.1 has the full
reasoning.

| Table                                 | Writer                                                                            |
| ------------------------------------- | --------------------------------------------------------------------------------- |
| `telegram_updates`                    | `src/telegram/poller.ts`, `src/telegram/inbound.ts`                               |
| `settings['telegram.next_offset']`    | `src/telegram/inbound.ts` (advances inside the inbound txn); `src/startup/recovery.ts` (offset fast-forward at boot) |
| `jobs` (insert)                       | `src/telegram/inbound.ts` (`provider_run`); `src/commands/summary.ts` (`summary_generation`); `src/commands/save.ts`, `src/commands/forget.ts` (`storage_sync` for save / delete); `src/telegram/attachment_capture.ts` (`storage_sync` post-capture); `src/queue/worker.ts` (`storage_sync` for memory_snapshot, `notification_retry`); `src/startup/recovery.ts` (`storage_sync` recovery sweep, `notification_retry` for restart-recovery turn). `src/telegram/outbound.ts` does **not** write `jobs`. |
| `jobs.status` (transitions)           | `src/queue/worker.ts`, `src/startup/recovery.ts`, `src/commands/cancel.ts`        |
| `sessions`                            | `src/telegram/inbound.ts` (create), `src/memory/summary.ts` (`/end`)              |
| `turns`                               | `src/providers/claude.ts`                                                         |
| `provider_runs`                       | `src/providers/claude.ts`                                                         |
| `provider_raw_events`                 | `src/providers/claude.ts`                                                         |
| `memory_summaries`                    | `src/memory/summary.ts`                                                           |
| `memory_items` (insert)               | `src/memory/summary.ts`, `src/commands/correct.ts`                                |
| `memory_items.status`                 | `src/commands/correct.ts` (`active → superseded`), `src/commands/forget.ts` (`→ revoked`) |
| `storage_objects` (insert)            | `src/telegram/inbound.ts` (Telegram attachments, capture_status=pending); `src/queue/worker.ts` `enqueueMemorySnapshotSync` (memory_snapshot rows for `/summary` / `/end`, also enqueues the `storage_sync` job in the same txn). These are the only two `INSERT INTO storage_objects` sites in `src/`. |
| `storage_objects.status`              | `src/storage/sync.ts`, `src/commands/forget.ts` (recovery only counts `failed` / `delete_failed` rows and enqueues a `storage_sync` job; it does not update `storage_objects.status` directly) |
| `memory_artifact_links`               | `src/memory/summary.ts`, `src/commands/save.ts`, `src/commands/forget.ts`         |
| `outbound_notifications` (insert)     | `src/queue/worker.ts`, `src/commands/*`                                           |
| `outbound_notifications.status`       | `src/telegram/outbound.ts` (rolled up from chunks)                                |
| `outbound_notification_chunks`        | `src/queue/worker.ts`, `src/commands/*` (insert in same txn as parent), `src/telegram/outbound.ts` (status) |
| `allowed_users`                       | out-of-band config — not written at runtime                                       |

## Cross-table invariants

These are enforced in code + invariant tests, not in SQL triggers.
The full list lives in `docs/02_HLD.md` §5.2; the most common ones
to keep in mind:

- `settings['telegram.next_offset']` is advanced **only after** the
  transaction that recorded the matching `telegram_updates` rows
  has committed.
- Every `telegram_updates.status = enqueued` row that came from the
  regular inbound path has a `jobs` row whose
  `idempotency_key = 'telegram:' || update_id`. **Exception**:
  `/cancel` is a control-plane action — `classifyAndCommit` in
  `src/telegram/inbound.ts` marks the update `enqueued`, returns an
  `instant_response`, and intentionally **does not** insert a
  `jobs` row (`job_id = null`). When debugging or backfilling, do
  not assume every `enqueued` update joins to a `telegram:*` job.
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

## Judgment System schema (Phase 1A.1 schema skeleton landed; runtime not wired)

The DB-native AI-first Judgment System direction defines a separate
schema family. As of migration 004, **the five `judgment_*` tables
and the FTS5 virtual table exist in `migrations/`**; the remaining
control-plane / tensions / reflection rows below are still
documentation only. Names and constraints come from the Phase 0 /
0.5 design records that landed on `main` as ADR-0009 … ADR-0013
plus `docs/JUDGMENT_SYSTEM.md` (per DEC-037, that spec is a
historical architectural record, not implementation authority).

| Table                                        | Purpose                                                              | Status (2026-04-27)                                                          |
| -------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `judgment_sources`                           | Source of a judgment fragment (turn, attachment, external).          | schema implemented in migration 004; no runtime writer.                       |
| `judgment_items`                             | Atomic judgment rows (the Judgment System analogue of memory_items). | schema implemented in migration 004; no runtime writer / typed tool.         |
| `judgment_evidence_links`                    | Links between judgments and supporting evidence rows.                | schema implemented in migration 004; no runtime writer.                       |
| `judgment_edges`                             | Typed relations between judgments (supports, contradicts, refines).  | schema implemented in migration 004; no runtime writer.                       |
| `judgment_events`                            | Append-only event log for judgment lifecycle changes.                | schema implemented in migration 004; no runtime writer.                       |
| `judgment_items_fts`                         | FTS5 external-content index over `judgment_items.statement`.          | schema implemented in migration 004; sync triggers tested.                   |
| `control_gate_events` / `control_plane_events` | Control Gate decisions per query (table name itself is open per Phase 1A scope). | **planned** (`docs/JUDGMENT_SYSTEM.md` §Implementation Readiness; ADR-0012). |
| `tensions`                                   | Telemetry for unresolved tension between judgments / sources.        | **planned** (`docs/JUDGMENT_SYSTEM.md` §Critique Lens + Tension Generalization; ADR-0013). |
| `reflection_triage_events`                   | Reflection / triage outcomes feeding back into judgments.            | **planned** (`docs/JUDGMENT_SYSTEM.md` §Metacognitive Critique Loop; ADR-0012, ADR-0013). |

For the implemented rows: the schema is in place but no module
writes to them, no typed tool exists, no Control Gate or Context
Compiler reads them. Future runtime writers will live under
`src/judgment/*`. Do not migrate `memory_summaries` / `memory_items`
data into them — Q-027 stays open and ADR-0009 commits to the
"분리" starting point.

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
