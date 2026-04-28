# Data Model

> Status: thin current-state map · Owner: project lead ·
> Last updated: 2026-04-29
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
- `src/storage/objects.ts` — storage key and extension helpers only
  (`safeExtensionFromMime`, `generateStorageKey`, `finalizeStorageKey`,
  `isProvisionalKey`). Performs no SQLite reads/writes.
  `memory_artifact_links` is written by `src/commands/save.ts` and
  `src/commands/forget.ts`.
- `docs/PRD.md` Appendix D — original column contract.
- `docs/02_HLD.md` §5 — historical reasoning for writer map and
  cross-table invariants. The operative single-writer map is the
  `## Single-writer map` section in this file (below).

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
| 005     | `migrations/005_control_gate_events.sql`                |
| 006     | `migrations/006_control_gate_job_id.sql`                |

`/doctor` checks `expected_schema_version = 6` (see
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

### `judgment_*`

Migration 004 added `judgment_sources`, `judgment_items`,
`judgment_evidence_links`, `judgment_edges`, `judgment_events`, and
the external-content FTS5 table `judgment_items_fts`.
`src/judgment/repository.ts` is the sole writer for these tables and
also owns the local read-only `queryJudgments` / `explainJudgment`
surfaces.

`judgment_items` is the core row. Important CHECK-constrained enums:

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

Other table roles:

- `judgment_sources` — source rows; `kind` and evidence-link
  `relation` vocabularies remain open TEXT.
- `judgment_evidence_links` — support links from judgment rows to
  sources.
- `judgment_edges` — typed judgment-to-judgment relations; currently
  only local supersede writes are implemented.
- `judgment_events` — append-only lifecycle event log; `judgment_id`
  may be null for source-level events.
- `judgment_items_fts` — FTS5 index over `judgment_items.statement`;
  triggers keep it in sync.

Active/eligible rows can exist after the local commit operation.
`src/queue/worker.ts` has three distinct read paths for judgment rows:

- **Context injection** — reads `active`/`eligible`/`normal`/`global`/time-valid
  rows (scope_json must contain `"global":true`); injects them into every
  non-system `provider_run` turn.
- **`/judgment` command** — reads `active`/`eligible`/`normal`/time-valid rows
  without a scope filter (no `"global":true` requirement), then lists them in
  the Telegram response.
- **`/judgment_explain <id>` command** — reads a single row by ID regardless
  of scope.

Write-path tool contracts remain unregistered.

### `control_gate_events`

Migration 005 added the append-only Control Gate event ledger;
migration 006 added `job_id` attribution. `src/judgment/control_gate.ts`
is the sole writer. `direct_commit_allowed` is always 0. Runtime writes
come only from `src/queue/worker.ts` before non-system `provider_run`
jobs; system commands do not produce gate rows.

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
| `turns`                               | `src/queue/worker.ts` (provider turns + injected context turns); `src/startup/recovery.ts` (recovery assistant turn) |
| `provider_runs`                       | `src/queue/worker.ts`                                                             |
| `provider_raw_events`                 | `src/queue/worker.ts`                                                             |
| `memory_summaries`                    | `src/memory/summary.ts`                                                           |
| `memory_items` (insert)               | `src/memory/summary.ts`, `src/commands/correct.ts`                                |
| `memory_items.status`                 | `src/commands/correct.ts` (`active → superseded`), `src/commands/forget.ts` (`→ revoked`) |
| `storage_objects` (insert)            | `src/telegram/inbound.ts` (Telegram attachments, capture_status=pending); `src/queue/worker.ts` `enqueueMemorySnapshotSync` (memory_snapshot rows for `/summary` / `/end`, also enqueues the `storage_sync` job in the same txn). These are the only two `INSERT INTO storage_objects` sites in `src/`. |
| `storage_objects.status`              | `src/storage/sync.ts`, `src/commands/forget.ts` (recovery only counts `failed` / `delete_failed` rows and enqueues a `storage_sync` job; it does not update `storage_objects.status` directly) |
| `storage_objects.capture_status`      | Insert-time: `src/telegram/inbound.ts` (`pending`; oversized attachments: `failed`), `src/queue/worker.ts` memory snapshot inserts (`captured`). Post-insert transitions: `src/telegram/attachment_capture.ts` (`pending → captured` or `pending → failed`). |
| `storage_objects.retention_class`     | `src/commands/save.ts` — promotes to `long_term`. The initial `retention_class` value is set at insert time by `src/telegram/inbound.ts` / `src/queue/worker.ts`. |
| `memory_artifact_links`               | `src/commands/save.ts` (INSERT), `src/commands/forget.ts` (DELETE)                |
| `outbound_notifications` (insert)     | `src/telegram/outbound.ts`; `src/startup/recovery.ts` (recovery direct-write)    |
| `outbound_notifications.status`       | `src/telegram/outbound.ts` (rolled up from chunks)                                |
| `outbound_notification_chunks`        | `src/telegram/outbound.ts` (insert in same txn as parent + status); `src/startup/recovery.ts` (insert) |
| `allowed_users`                       | out-of-band config — not written at runtime                                       |
| `judgment_items` (insert)             | `src/judgment/repository.ts` (`proposeJudgment`) — proposal rows only. No other module may write `judgment_items` directly. |
| `judgment_items` (approve transition) | `src/judgment/repository.ts` (`approveProposedJudgment`) — sets `approval_state=approved` only. Does not activate. |
| `judgment_items` (reject transition)  | `src/judgment/repository.ts` (`rejectProposedJudgment`) — sets `approval_state=rejected` / `lifecycle_status=rejected` / `activation_state=excluded`. |
| `judgment_items` (evidence arrays)    | `src/judgment/repository.ts` (`linkJudgmentEvidence`) — updates `source_ids_json` / `evidence_ids_json` denormalized arrays only. No activation. |
| `judgment_items` (commit transition)  | `src/judgment/repository.ts` (`commitApprovedJudgment`) — sets `lifecycle_status=active` / `activation_state=eligible` / `authority_source=user_confirmed`, syncs denormalized arrays. Local unregistered write. Active/eligible rows now read by `src/queue/worker.ts` for context injection (Phase 1B.2) and Telegram read commands (Phase 1B.3). |
| `judgment_items` (supersede transition) | `src/judgment/repository.ts` (`supersedeJudgment`) — sets `lifecycle_status=superseded` / `activation_state=excluded` on old; updates `supersedes_json` / `superseded_by_json` arrays on both. Local unregistered. |
| `judgment_items` (revoke transition)  | `src/judgment/repository.ts` (`revokeJudgment`) — sets `lifecycle_status=revoked` / `activation_state=excluded`. Local unregistered. |
| `judgment_items` (expire transition)  | `src/judgment/repository.ts` (`expireJudgment`) — sets `lifecycle_status=expired` / `activation_state=excluded`, optionally sets `valid_until`. Local unregistered. |
| `judgment_sources` (insert)           | `src/judgment/repository.ts` (`recordJudgmentSource`) — local unregistered writer. No runtime path. |
| `judgment_evidence_links` (insert)    | `src/judgment/repository.ts` (`linkJudgmentEvidence`) — local unregistered writer. No runtime path. |
| `judgment_edges` (insert)             | `src/judgment/repository.ts` (`supersedeJudgment`) — inserts one edge with `relation=supersedes` (from=replacement, to=old). Local unregistered. |
| `judgment_events` (insert)            | `src/judgment/repository.ts` — `judgment.proposed`, `judgment.approved`, `judgment.rejected`, `judgment.source.recorded`, `judgment.evidence.linked`, `judgment.committed`, `judgment.superseded`, `judgment.revoked`, `judgment.expired` events only. |
| `control_gate_events` (insert)        | `src/judgment/control_gate.ts` (`recordControlGateDecision`) — append-only; BEFORE UPDATE/DELETE/INSERT triggers block mutation. Runtime caller: `src/queue/worker.ts` (Phase 1B.1, non-system `provider_run` only). `job_id` attribution implemented (migration 006, issue #45). |

Read-surface note: `src/judgment/repository.ts` also owns the local
unregistered read-only `queryJudgments` and `explainJudgment`
surfaces. They do not mutate any `judgment_*` table, do not append
`judgment_events`, and do not make judgments context-visible.

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
- A **conversational** `jobs` row with `job_type = provider_run`
  reaching `status = succeeded` has at least one
  `provider_runs.status = succeeded` and at least one assistant `turns`
  row. **Exception (system commands)**: `provider_run` jobs whose
  `request_json.command` matches a system command (e.g. `/status`,
  `/judgment`, `/judgment_explain`) are dispatched before
  `insertProviderRunStart` and produce no `provider_runs` row. Judgment
  commands additionally skip turn storage — their output is delivered
  via `outbound_notifications` only. Do not treat missing `provider_runs`
  or `turns` rows as corruption for these jobs.
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

## Naming notes (Phase 0 / 0.5 final terms)

The terminology below is the agreed final shape per the Phase 0 / 0.5
review rounds (ADR-0011 … ADR-0013, DEC-029, DEC-033, DEC-036).

**Implemented in Phase 1A schema:**

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
- `Control Gate` — **not** `Exception Probe Gate` (Round 14
  cleanup).

**Planned (not yet implemented):**

- `current_operating_view` — projection of the active judgment set
  (DEC-036); **not** "current truth". Planned derived view; not yet
  a migrated table or runtime surface.
- `Tension` — **not** `DesignTension` (ADR-0013 §Tension
  Generalization). Planned schema surface; not yet migrated.

## Derived projections (planned)

- Vector index over `judgment_items` content — derived, not
  authoritative.
- Graph view over `judgment_edges` — derived, not authoritative.

The DB remains the canonical store; vector / graph databases are
projections that may be rebuilt from the DB. Do not promote them to
source-of-truth status without an ADR.
