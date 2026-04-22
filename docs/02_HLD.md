# Personal Agent P0 — High-Level Design

> Status: draft · Owner: project lead · Last updated: 2026-04-22
>
> This is the **thin** HLD whose job is to unblock P0 implementation, per
> `docs/00_PROJECT_DELIVERY_PLAYBOOK.md` §5.2. It is deliberately not a
> complete architecture reference. It fixes the four things that cause
> the most damage when left undefined: **module boundaries**,
> **state machines**, **core flows**, and **failure/recovery behavior**.
> Anything not required to begin P0 implementation is out of scope.

References that this document takes as already-decided:

- `docs/PRD.md` — what is being built (scope, acceptance criteria,
  security, data tables).
- `docs/00_PROJECT_DELIVERY_PLAYBOOK.md` — how the project is delivered.

---

## 1. Overview

The Personal Agent is a single-user Telegram runtime that routes inbound
DMs to a Claude Code subprocess and returns the result asynchronously.
The runtime is built on Bun + TypeScript and runs as a single systemd
service on a Hetzner CX22 host. SQLite (WAL) is the source of truth for
all state; Hetzner Object Storage (S3-compatible) is an asynchronous
archive for durable artifacts (PRD §12.8).

From the outside the system looks simple. Internally it is a small
number of cooperating state machines:

```
Telegram long-poll  ──┐
                      │
                      ▼
              telegram_updates        (status machine 1)
                      │
                      ▼
                    jobs              (status machine 2)
                      │           ┌──────────────┐
                      ▼           │              ▼
          provider_runs + turns   │   outbound_notifications   (machine 3)
                      │           │              │
                      ▼           │              ▼
             storage_objects      │           Telegram send
                      │ (status machine 4)
                      ▼
             S3 (Hetzner Object Storage)
```

Everything else (context packer, memory summary generator, `/doctor`,
redactor) is support infrastructure for those four state machines.

### Goals of this HLD

1. Name every module, the tables it writes, and the state transitions
   it owns.
2. Define each state machine's transitions as `(from, to, trigger,
   transaction, side effects, retry, user-visible notification)`.
3. Describe the core flows as sequences over those state machines.
4. Call out every failure mode the implementation must handle on day
   one.

### Non-goals of this HLD

- Implementation-level API surface per function.
- Exhaustive error taxonomy beyond what the state machines name.
- P1/P2 features: multi-user, webhooks, vector retrieval, auto-routing,
  Obsidian write-back, human-approval UI, etc.
- Performance tuning and capacity planning beyond timeout budgets.

---

## 2. P0 Scope Recap

This HLD covers only what is required to satisfy the P0 acceptance
criteria enumerated in PRD §17 and tested in
[`docs/06_ACCEPTANCE_TESTS.md`](./06_ACCEPTANCE_TESTS.md), with a
Claude-only provider on a single CX22 host. "P0 done" is defined by
the acceptance-test file, not by a fixed numeric AC range.

In scope for P0:

- Single authorized Telegram user, long-polling only.
- One provider (`claude`), stream-json parsing, subprocess lifecycle.
- Durable job queue (SQLite) with crash-safe recovery at startup.
- Outbound notification retry with at-least-once semantics.
- Telegram attachment capture into `storage_objects` per PRD §13.5.
- Memory summary generation (`/summary`, `/end`) with provenance.
- Asynchronous S3 sync of memory snapshots, transcripts, and promoted
  artifacts per PRD §12.8.
- Redaction applied **before** persistence per PRD §15, §14.3.
- `/doctor` smoke test covering every external dependency.

Out of scope for P0 (tracked for later):

- Anything listed in PRD §5 "Non-goals".
- Long-term memory retrieval / vector index.
- Multiple concurrent provider jobs.
- Automated promotion of artifacts to `long_term` without user intent.

---

## 3. Runtime Architecture

### 3.1 Deployment shape

One process, one user, one DB file, one S3 bucket. systemd restarts the
service on crash. The process spawns short-lived Claude subprocesses per
`provider_run` job.

```
systemd unit (single service)
└── Bun main process
    ├── Telegram long-poll loop
    ├── Job worker loop
    ├── Notification retry loop
    ├── Storage sync loop
    └── spawns: Claude Code CLI (per provider_run, detached process group)

SQLite (WAL)             — state of record
Local FS (data/)         — temp files, redacted transcripts, memory md/jsonl
Hetzner Object Storage   — durable artifact mirror (async)
```

Concurrency model:

- At most **one** `provider_run` job runs at a time (PRD §5). The
  worker loop serializes provider execution.
- `notification_retry` and `storage_sync` loops run concurrently with
  the worker; they do not hold DB transactions across I/O.
- The Telegram long-poll loop is its own coroutine; it writes to
  `telegram_updates` and enqueues jobs, never blocks on provider
  execution.

### 3.2 Component map

| Component                | Implements                                 | Owns                                           |
| ------------------------ | ------------------------------------------ | ---------------------------------------------- |
| `telegram/poller`        | long-poll + offset advance                 | `telegram_updates.status`                      |
| `telegram/inbound`       | parse update → enqueue job                 | `jobs.status` transition `→ queued` (inbound)  |
| `telegram/outbound`      | `sendMessage` executor                     | `outbound_notifications.status`                |
| `queue/worker`           | claim job → dispatch by `job_type`         | `jobs.status` transitions `queued ↔ running …` |
| `providers/claude`       | spawn + stream-json + resume/replay        | `provider_runs`, `provider_raw_events`         |
| `context/builder+packer` | assemble prompt inputs per §12.4–12.5      | read-only                                      |
| `memory/summary`         | `/summary`, `/end` summary generation      | `memory_summaries`                             |
| `storage/local`          | local FS writes and reads                  | filesystem layout                              |
| `storage/sync`           | S3 upload retry + `storage_objects` sync   | `storage_objects.status`                       |
| `observability/redact`   | redaction pipeline (§13 of this doc)       | redaction boundary                             |
| `commands/*`             | `/status`, `/cancel`, `/summary`, `/end`,  | command-specific jobs + notifications          |
|                          | `/doctor`, `/provider`, `/whoami`          |                                                |
| `startup/recovery`       | startup reconciliation (§15 of this doc)   | `jobs`, `storage_objects` on-boot transitions  |

Every row of the "Owns" column is a single-writer responsibility: if
another component needs to change that state, it goes through the
owner.

---

## 4. Module Boundaries

Each module below lists **purpose**, **inputs**, **outputs**, **owned
tables / state transitions**, and **invariants**. An invariant is a
statement that must be true regardless of code path; it is the thing a
ledger integration test (playbook §8.1) asserts against.

### 4.1 `telegram/poller`

- **Purpose**: run the long-poll loop against the Telegram Bot API and
  record every inbound update.
- **Inputs**: `TELEGRAM_BOT_TOKEN`, `telegram_next_offset` (persisted
  in `settings`), `allowed_user_ids` (config).
- **Outputs**: new rows in `telegram_updates`; updated
  `telegram_next_offset`.
- **Owns**: `telegram_updates.status` transitions into `received` and
  the initial `skipped` path; owns `telegram_next_offset`.
- **Invariants**:
  1. `telegram_next_offset` is advanced **only after** the transaction
     that inserted/updated the corresponding `telegram_updates` rows
     has committed.
  2. A `telegram_updates` row exists for every update the system has
     acknowledged at the Telegram API level.
  3. `telegram_updates.update_id` is unique; duplicates from retry do
     not create duplicate rows.

### 4.2 `telegram/inbound`

- **Purpose**: classify an inbound update (text, command, attachment,
  unauthorized, malformed) and enqueue the appropriate job.
- **Inputs**: `telegram_updates` rows with `status = received`.
- **Outputs**: `jobs` rows (typically `provider_run`, but also command
  jobs), optional `storage_objects` rows for attachments, updates to
  `telegram_updates.status` (→ `enqueued` | `skipped` | `failed`).
- **Owns**: `telegram_updates.status` transitions from `received`;
  authoring of `jobs` rows for inbound traffic.
- **Invariants**:
  1. Unauthorized updates are resolved to `telegram_updates.status =
     skipped` with a non-null `skip_reason` and never produce a
     `jobs` row (AC-TEL-001).
  2. Every `jobs` row created by the inbound path carries an
     `idempotency_key` derived from `telegram_updates.update_id`; a
     replayed update does not produce a second job (AC-TEL-003).
  3. An attachment is recorded in `storage_objects` *before* any
     `turns` or memory reference points to it; retention class
     defaults to `session` (PRD §12.8.3, §13.5).
  4. The inbound transaction inserts attachment metadata only
     (`capture_status = 'pending'`, `source_external_id` = Telegram
     `file_id`). It **never** performs Telegram `getFile`, a file
     download, a MIME probe, or any other network / filesystem I/O.
     Byte capture runs in a separate transaction after the inbound
     commit (§7.2, §9.3, §7.10 transaction boundaries).

### 4.3 `queue/worker`

- **Purpose**: claim the next executable `jobs` row, dispatch by
  `job_type`, and drive its lifecycle to a terminal state.
- **Inputs**: `jobs` rows with `status = queued`.
- **Outputs**: status transitions on the claimed job; creation of
  `provider_runs`, `turns`, `outbound_notifications`, and
  `storage_objects` rows through the appropriate sub-modules.
- **Owns**: `jobs.status` transitions `queued → running → (succeeded |
  failed | cancelled | interrupted)`.
- **Invariants**:
  1. Claim is a single atomic SQLite transaction: the read-and-update
     that moves a row from `queued` to `running` cannot lose or
     double-claim a row.
  2. Only **one** `provider_run` job may be in `status = running` at
     any time.
  3. The worker never leaves a job indefinitely in `running` after
     its owner process exits; §15 recovery reconciles.

### 4.4 `providers/claude`

- **Purpose**: execute a single Claude Code CLI subprocess for a
  `provider_run` job, parse `stream-json`, persist turns, capture raw
  events.
- **Inputs**: packed prompt + metadata from `context/*`; session-id
  decision (resume vs replay) from `memory/summary`; subprocess
  configuration from config module.
- **Outputs**: `provider_runs` row, `provider_raw_events` rows,
  `turns` rows, optional `storage_objects` for generated artifacts.
- **Owns**: subprocess process group (§14); `provider_runs` record;
  stream parsing and parser-fallback decision.
- **Invariants**:
  1. Subprocess is spawned detached with a known process group id;
     the adapter always knows how to kill it.
  2. Raw events are written to `provider_raw_events` only with
     `redaction_applied = true`; no unredacted raw bytes are
     persisted in P0 (PRD §13.4).
  3. A successful run produces at least one assistant `turns` row
     whose text has been normalized via the documented
     `stream-json → final_text` path (AC-PROV-005).

### 4.5 `telegram/outbound`

- **Purpose**: deliver user-visible Telegram messages for job
  lifecycle events (`job_accepted`, `job_completed`, `job_failed`,
  `job_cancelled`, `summary`, `doctor`).
- **Inputs**: `outbound_notifications` rows with `status = pending`.
- **Outputs**: Telegram `sendMessage` calls; updates to the row's
  `status`, `attempt_count`, `telegram_message_ids_json`, `sent_at`,
  `error_json`.
- **Owns**: `outbound_notifications.status`.
- **Invariants**:
  1. A given `(job_id, notification_type, payload_hash)` triple
     produces at most one `outbound_notifications` row; retries reuse
     that row.
  2. `status = sent` is terminal; the `notification_retry` loop never
     re-sends a `sent` notification.
  3. Delivery is at-least-once; duplicates are minimized but not
     proven impossible (PRD §13.3).

### 4.6 `context/builder` and `context/packer`

- **Purpose**: assemble the prompt inputs per PRD §12.4–12.5 and pack
  them into the provider request under the token budget.
- **Inputs**: current session, `memory_summaries`, recent `turns`,
  `injected_memory` candidates, user message, config budgets.
- **Outputs**: a packed `AgentRequest` (PRD Appendix B) plus a
  structured record of what was injected (for observability).
- **Owns**: no tables; this module is read-only against SQLite.
- **Invariants**:
  1. In `resume_mode`, recent turns are **not** replayed into the
     prompt; only a delta summary + user message is sent.
  2. In `replay_mode`, recent N turns are included and
     `provider_runs.context_packing_mode` records `replay_mode`.
  3. Token estimation follows PRD §12.6 (overestimate, never
     underestimate).

### 4.7 `memory/summary`

- **Purpose**: generate session summaries on `/summary` and `/end`,
  with provenance + confidence per PRD §12.2–12.3.
- **Inputs**: selected `source_turn_ids`, current session metadata,
  summary schema.
- **Outputs**: `memory_summaries` row, local memory markdown/jsonl
  file, `storage_sync` job (optional) to mirror to S3.
- **Owns**: authoring of `memory_summaries` rows and local memory
  files.
- **Invariants**:
  1. Summary generation runs under Claude's advisory/chat lockdown
     profile (`--tools ""`, `--permission-mode dontAsk`) — no file
     edit, no shell, no interactive prompt (AC-PROV-003, PRD §12.3).
  2. Long-term personal preferences require `provenance ∈
     {user_stated, user_confirmed}` (PRD §12.2).

### 4.8 `storage/local` and `storage/sync`

- **Purpose**: `storage/local` handles local FS reads/writes;
  `storage/sync` drives the async S3 mirror for eligible artifacts.
- **Inputs**: `storage_objects` rows with `status = pending` and a
  retention class that requires S3; configuration for bucket,
  endpoint, credentials.
- **Outputs**: S3 objects; status transitions on `storage_objects`.
- **Owns**: `storage_objects.status`; S3 `PUT`/`DELETE` calls.
- **Invariants**:
  1. `storage_sync` is the only writer that advances
     `storage_objects.status` to `uploaded`.
  2. `storage_sync` failure does not roll back any `provider_run`
     success; it only re-pends the row (PRD §16.4, AC-STO-002, AC-STO-006).
  3. S3 object keys follow the PRD §12.8.4 pattern and never carry
     user-facing semantics.

### 4.9 `observability/redact`

- **Purpose**: apply the documented redaction transforms to every
  payload that crosses the persistence boundary.
- **Inputs**: arbitrary strings/JSON objects heading to SQLite, local
  files, logs, or S3.
- **Outputs**: redacted versions of those payloads; detection of
  high-risk patterns used by the attachment policy (PRD §12.8.3).
- **Owns**: the redaction boundary (§13 of this doc).
- **Invariants**:
  1. No Telegram token, S3 key, provider auth token, or API-key
     pattern appears in any post-redaction store (AC-SEC-001, PRD §15).
  2. Redaction runs **before** persistence, not during retrieval.

### 4.10 `commands/*`

- **Purpose**: implement `/status`, `/cancel`, `/summary`, `/end`,
  `/provider`, `/doctor`, `/whoami` per PRD §7, §8.1.
- **Inputs**: classified command from `telegram/inbound`.
- **Outputs**: command-specific side effects (status queries, cancel
  signals to subprocess, summary jobs, doctor report) and
  `outbound_notifications` rows.
- **Owns**: command semantics and the transitions those commands
  trigger on other machines (e.g. `/cancel` drives `jobs.status` from
  `running → cancelled`).
- **Invariants**:
  1. `/cancel` is idempotent: issuing it on a non-running job is a
     no-op with a user-visible acknowledgment.
  2. `/whoami` is the only command that produces any response for an
     unauthorized user, and only when `BOOTSTRAP_WHOAMI=true`
     (AC-TEL-001).

### 4.11 `startup/recovery`

- **Purpose**: at process boot, reconcile any state left mid-
  transition by the previous run.
- **Inputs**: SQLite state on disk.
- **Outputs**: status transitions on `jobs`, `storage_objects`,
  possibly `outbound_notifications`; operator-visible doctor entries.
- **Owns**: the one-time startup transitions listed in §15.
- **Invariants**:
  1. After recovery completes, no job is left in `running` with a
     dead owner process.
  2. After recovery completes, `telegram_next_offset` points at an
     offset consistent with the `telegram_updates` ledger.

### 4.12 Interaction rules between modules

- A module never mutates another module's owned status directly; it
  enqueues a job or inserts a notification that the owning module
  will process.
- Every write that crosses a durability boundary (DB, local file, S3)
  passes through the redactor first.
- Every subprocess spawn passes through `providers/claude` (or the
  summary variant of the adapter for the lockdown profile). No other
  module spawns Claude directly.

---

## 5. Data Model

The authoritative schema lives in **PRD Appendix D**. This section does
not restate it; it records the **HLD-level invariants** and the
**writer map** that the schema alone does not capture.

### 5.1 Writer map

Single-writer responsibility per table. A module not listed as a writer
does not issue `INSERT` / `UPDATE` / `DELETE` on that table.

| Table                    | Writer                                         |
| ------------------------ | ---------------------------------------------- |
| `telegram_updates`       | `telegram/poller`, `telegram/inbound`          |
| `settings` (offset)      | `telegram/poller`                              |
| `jobs` (insert)          | `telegram/inbound`, `commands/*`, `memory/summary`, `storage/sync`, `telegram/outbound` |
| `jobs.status` (transitions) | `queue/worker`, `startup/recovery`, `commands/cancel` |
| `sessions`               | `telegram/inbound` (create), `memory/summary` (update on `/end`) |
| `turns`                  | `providers/claude`                             |
| `provider_runs`          | `providers/claude`                             |
| `provider_raw_events`    | `providers/claude`                             |
| `memory_summaries`       | `memory/summary`                               |
| `memory_items` (insert)  | `memory/summary` (from summary output), `commands/correct` (user corrections) |
| `memory_items.status` (transitions) | `commands/correct` (`active → superseded`), `commands/forget_memory` (`active | superseded → revoked`) |
| `storage_objects` (insert) | `telegram/inbound` (attachments), `providers/claude` (generated artifacts), `memory/summary` (snapshots), `storage/local` (transcripts) |
| `storage_objects.status` (transitions) | `storage/sync` (`pending ↔ failed`, `→ uploaded`, `deletion_requested → deleted | delete_failed`), `startup/recovery`, `commands/forget_artifact` (`→ deletion_requested`) |
| `memory_artifact_links`  | `memory/summary`, `commands/save_last_attachment`, `commands/forget_artifact` (delete) |
| `outbound_notifications` (insert) | `queue/worker`, `commands/*`          |
| `outbound_notifications.status` | `telegram/outbound` (derived roll-up from `outbound_notification_chunks`) |
| `outbound_notification_chunks` (insert) | `queue/worker`, `commands/*` (in the same txn that inserts the parent `outbound_notifications` row) |
| `outbound_notification_chunks.status` | `telegram/outbound` |
| `allowed_users`          | out-of-band (config); not written at runtime   |

### 5.2 Cross-table invariants

These are statements that must hold across more than one table. Each
one should have a ledger integration test (playbook §8.2).

1. **Offset ↔ ledger**: `settings.telegram_next_offset` is ≤ one past
   the max `update_id` that has reached a committed
   `telegram_updates` row.
2. **Update ↔ job**: every `telegram_updates` row with `status =
   enqueued` has a corresponding `jobs` row whose
   `idempotency_key = 'telegram:' || update_id`.
3. **Job ↔ run ↔ turns**: a `jobs` row with `job_type = provider_run`
   that reaches `status = succeeded` has at least one `provider_runs`
   row and at least one `turns` row with `role = 'assistant'`
   belonging to the same `job_id`.
4. **Notification ↔ job**: every `outbound_notifications` row's
   `job_id` references a real `jobs.id`; the `notification_type` is
   consistent with the owning job's terminal status (e.g.
   `job_completed` only on `succeeded`).
5. **Artifact ↔ link**: `memory_artifact_links` with
   `memory_summary_id != null` requires the referenced
   `storage_objects` row to satisfy
   `retention_class = 'long_term' AND status = 'uploaded'` (PRD
   §12.8, Appendix D invariants).
6. **Redaction boundary**: any row in `provider_raw_events`,
   `telegram_updates.raw_update_json_redacted`, or
   `turns.*_redacted` has `redaction_applied = true` (where the
   column exists) and is free of the patterns named in PRD §15.
7. **Session scope**: `turns.session_id` and
   `memory_summaries.session_id` resolve to a real `sessions.id`
   from the same `chat_id`.
8. **Status source-of-truth split**: `jobs.status` is the
   orchestration source of truth (claimed, running, retried,
   done). `provider_runs.status` is the subprocess-execution
   source of truth (started, succeeded, failed, interrupted,
   cancelled). The two are related but not equivalent:
   - A single `jobs` row of type `provider_run` can own **multiple**
     `provider_runs` rows over its lifetime (e.g. a failed
     `resume_mode` attempt followed by a `replay_mode` retry on the
     same `jobs.id`, per §6.2 resume-fallback transition).
   - `jobs.status = succeeded` requires **at least one**
     `provider_runs.status = succeeded` for the same `job_id`, in
     addition to invariant 3 above.
   - `provider_runs.status = failed` does **not** by itself imply
     `jobs.status = failed`; the worker may re-queue the same job
     in a different `context_packing_mode`.
   - `storage_sync` and `notification_retry` outcomes **never**
     mutate `provider_runs.status` (PRD AC-STO-002, AC-STO-006, AC-MEM-003).

### 5.3 Idempotency keys

| Source                             | `idempotency_key`                                        |
| ---------------------------------- | -------------------------------------------------------- |
| Telegram update → job              | `'telegram:' || update_id`                               |
| `/summary` command                 | `'summary:' || session_id || ':' || user_trigger_epoch`  |
| `/end` command                     | `'end:' || session_id`                                   |
| `storage_sync` job                 | `'sync:' || storage_object_id`                           |
| `notification_retry` job           | `'notify:' || outbound_notification_id`                  |

A job `INSERT` on a duplicate `idempotency_key` is a no-op; the
existing row is returned. This is the mechanism that makes retried
Telegram updates, retried summaries, and retried syncs safe.

The no-op rule applies to `INSERT` only. In-place mutations of an
existing `jobs` row (e.g. `running → queued` resume-fallback
in §8.2, `interrupted → queued` at boot) reuse the same row and
the same `idempotency_key`; they are not inserts and therefore
are not subject to this rule.

### 5.4 Time

All timestamps are UTC, stored as SQLite `DATETIME` (ISO-8601 text in
practice). Local-timezone formatting only happens at presentation
(user-visible Telegram messages, `/status` output). No business logic
branches on local time.

---

## 6. State Machines

This is the critical section of the HLD. For each state machine we
list the states, the transitions as `(from, to, trigger, transaction,
side effects, retry, user-visible notification)`, and the invariants
that implementation and tests must hold.

### 6.1 `telegram_updates.status`

```
                      ┌─────────────┐
                      │  received   │ (poller insert, initial)
                      └──────┬──────┘
                             │
              ┌──────────────┼──────────────────┐
              ▼              ▼                  ▼
         enqueued         skipped            failed
         (job created)   (not processed)   (persisting failed)
```

States: `received`, `enqueued`, `skipped`, `failed`.

Transitions:

| From       | To        | Trigger                                            | Transaction                                        | Side effects                                              | Retry                                 | User-visible notification          |
| ---------- | --------- | -------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------- | ------------------------------------- | ---------------------------------- |
| —          | `received`| Poller pulled a new update from `getUpdates`.      | Inside the same txn that persists the row.         | Insert row; do **not** yet advance offset.                | N/A (new row).                        | None.                              |
| `received` | `enqueued`| `telegram/inbound` classified the update and created a `jobs` row. | Single txn with the `jobs` insert + `telegram_updates.status` update + offset advance for *that batch*. | `jobs` row created; `telegram_next_offset` advanced.      | On crash before commit: the same update is delivered again (idempotent by `update_id`). | Typically `job_accepted` via `outbound_notifications`. |
| `received` | `skipped` | Update is unauthorized, unsupported type, or malformed. | Same txn style as above.                         | `skip_reason` set; no `jobs` row; offset advanced.        | No retry.                             | None, except `/whoami` with `BOOTSTRAP_WHOAMI=true`. |
| `received` | `failed`  | Persistence-layer error while processing (e.g. DB disk full). | Partial: `status = failed` is attempted; if that also fails, the update remains `received` and will be re-delivered. | Operator-visible log + doctor flag. | Process is retried by the poller on next cycle; human intervention if persistent. | Optional admin notice (future). |

Invariants:

1. Offset advance is committed **in the same transaction** as the
   `status` transition out of `received` for the updates in that
   batch. Never advance first.
2. A `received` row that survives across restarts is a valid state;
   recovery re-runs `telegram/inbound` against it.
3. `failed` is never a terminal success; it either resolves to
   `enqueued`/`skipped` on retry or surfaces via `/doctor`.

### 6.2 `jobs.status`

```
                 ┌──────────┐
                 │  queued  │
                 └────┬─────┘
                      │
                      ▼
                 ┌──────────┐
         ┌──────►│ running  │◄──────┐
         │       └────┬─────┘       │
         │            │             │
         │    ┌───────┼───────┐     │
         │    ▼       ▼       ▼     │
         │ succeeded failed cancelled
         │            │             │
         │            │             │
         │       (terminal)         │
         │                          │
         │                          │
         │       ┌──────────────┐   │
         │       │ interrupted  │◄──┤ (on boot, if owner died)
         │       └──────┬───────┘   │
         │              │           │
         └──────────────┘ (re-queue if safe_retry)
                         (stay interrupted otherwise)
```

States: `queued`, `running`, `succeeded`, `failed`, `cancelled`,
`interrupted`.

Transitions:

| From         | To            | Trigger                                                         | Transaction                              | Side effects                                                              | Retry                                           | User-visible notification       |
| ------------ | ------------- | --------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------- |
| —            | `queued`      | Job row inserted (inbound, command, summary, sync, notify).     | Atomic with the enqueuing operation.     | `scheduled_at` set.                                                       | Duplicate `idempotency_key` returns existing.   | Optionally `job_accepted`.      |
| `queued`     | `running`     | Worker claim.                                                   | `BEGIN IMMEDIATE` → single-row update.   | `started_at` set; `attempts += 1`.                                         | Claim is atomic; no double-claim possible.      | Depends on job type.            |
| `running`    | `succeeded`   | Job logic completed successfully (e.g. provider returned final text, summary generated, sync uploaded). | After all downstream writes commit. | `finished_at`, `result_json` set; `outbound_notifications` `job_completed` inserted. | N/A.                                            | `job_completed`.                |
| `running`    | `failed`      | Job logic errored and is not retryable (or budget exhausted).   | After error capture.                     | `finished_at`, `error_json` set.                                          | Determined at transition time: `safe_retry` + `attempts < max_attempts` re-queues via separate transition. | `job_failed` with summary.      |
| `running`    | `cancelled`   | `/cancel` command received; subprocess teardown confirmed.      | After process group kill returns.        | `finished_at`, `cancelled_after_start` flag if side effects possible.     | N/A.                                            | `job_cancelled`.                |
| `running`    | `interrupted` | Process restart detected a stale `running` row at boot (§15).   | Single txn at boot.                      | `finished_at` = now; note added.                                          | If `safe_retry`: transition `interrupted → queued` in same boot pass. | Admin notice; `job_failed` only if terminal. |
| `queued`     | `cancelled`   | `/cancel` on a not-yet-running job.                             | Atomic single-row update.                | `finished_at` set.                                                        | N/A.                                            | `job_cancelled`.                |
| `interrupted`| `queued`      | Recovery decided to re-queue (`safe_retry = true`).             | Same boot txn as the `running → interrupted` that preceded it. | `attempts` unchanged; may be rate-capped.                                 | Normal worker flow from here.                   | Optional admin notice.          |
| `running`    | `queued`      | Resume-fallback: Claude `--resume` failed mid-run; worker flips the same job into `replay_mode` without inserting a new row (§8.2). | Single txn: update `status`, set `request_json.context_packing_mode = 'replay_mode'`, set `result_json.resume_failed = true`; the failed provider attempt is recorded in a separate `provider_runs` row with `status = failed, error_type = 'resume_failed'`. | `attempts` unchanged; `idempotency_key` unchanged (no new insert, so §5.3 no-op rule does not apply). | Next worker claim runs `replay_mode`; normal failure semantics apply from there. | None (user still waiting). |

Invariants:

1. Only `queue/worker` (or `startup/recovery` on boot) moves `queued
   ↔ running ↔ *`. `commands/cancel` may directly transition a
   `queued` job to `cancelled` (no running process to kill).
2. `running → succeeded` is only allowed after all of: the
   provider's final text is persisted in `turns`, the
   `provider_runs` row is closed, and an `outbound_notifications`
   row for `job_completed` has been inserted (not yet `sent`).
3. No job stays in `running` across a process restart: boot
   reconciles to `interrupted`.
4. `cancelled_after_start = true` is required when the subprocess
   had started and may have produced side effects before the kill.

### 6.3 `outbound_notifications.status`

```
                ┌──────────┐
                │ pending  │◄────────┐
                └────┬─────┘         │
                     │               │
               ┌─────┼──────┐        │
               ▼            ▼        │
             sent         failed ────┘
           (terminal)   (retry loop)
```

States: `pending`, `sent`, `failed`.

`outbound_notifications.status` is a **roll-up** of the per-chunk
ledger in `outbound_notification_chunks` (PRD Appendix D). Every
logical notification has `chunk_count ≥ 1` chunk rows inserted
atomically with the parent row; `telegram/outbound` operates on
chunk rows, and the parent's `status` is derived:

- parent `sent` iff every chunk row has `status = 'sent'`;
- parent `failed` iff at least one chunk reached non-retryable
  `failed` and no chunk is still `pending`;
- parent `pending` otherwise.

Retry semantics live at the chunk level: `notification_retry`
selects chunk rows with `status IN ('pending', 'failed')` whose
retry budget is not exhausted; a chunk with `status = 'sent'` is
**never** resent. This is what makes mid-stream failure
(e.g. chunks 1–2 sent, chunk 3 failed) safe to retry without
re-sending the earlier chunks to the user (PRD §8.4, AC-NOTIF-003).

Transitions (parent row, derived):

| From      | To        | Trigger                                            | Transaction                                    | Side effects                                                 | Retry                                                   | User-visible notification |
| --------- | --------- | -------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------- | ------------------------- |
| —         | `pending` | Row inserted (by worker on terminal transition, by command, by summary). | Atomic with the chunk-row inserts.             | Payload computed, `payload_hash` set; `chunk_count` chunk rows inserted with `status = 'pending'`. | Duplicate `(job_id, notification_type, payload_hash)` → no new row. | N/A.                      |
| `pending` | `sent`    | Last remaining chunk row reached `sent`.           | Same txn as the last chunk transition.         | `sent_at` set; `telegram_message_ids_json` populated from chunk rows in order. | Terminal.                                               | The chunk messages themselves. |
| `pending` | `failed`  | Retry budget exhausted on at least one chunk and no chunk is still `pending`. | Same txn as the last chunk transition. | `error_json` summarises the worst chunk failure; `attempt_count` reflects notification-level passes. | Manual / operator requeue; doctor flags.                | Admin notice only.        |
| `failed`  | `pending` | `notification_retry` decided to reattempt at least one `failed` chunk. | Same txn as the chunk `failed → pending` flip. | Notification-level `attempt_count` incremented. Already-`sent` chunks are not touched. | Bounded by `max_attempts`.                              | N/A.                      |

Invariants:

1. `sent` is terminal and cannot be reverted.
2. Duplicate prevention is best-effort via `(job_id,
   notification_type, payload_hash)`. At-least-once delivery may
   produce rare duplicates; callers must tolerate.
3. A `provider_run` at `succeeded` is never rolled back because of
   any notification outcome (PRD §13.3).

### 6.4 `storage_objects.status`

```
                ┌──────────┐
                │ pending  │◄────────┐
                └────┬─────┘         │
                     │               │
                ┌────┼────┐          │
                ▼         ▼          │
            uploaded   failed ───────┘
                │    (retry loop via storage_sync)
                │
                ▼
         deletion_requested
                │
          ┌─────┴─────┐
          ▼           ▼
       deleted   delete_failed
```

States: `pending`, `uploaded`, `failed`, `deletion_requested`,
`deleted`, `delete_failed`. All deletions are soft in SQLite;
S3 object deletion (when applicable) is driven by `storage/sync`.

`storage_objects.status` is the **sync** state machine and is only
meaningful when `capture_status = 'captured'` (PRD Appendix D
capture invariants). For Telegram attachments the row spends its
first life inside `capture_status = pending` (no network I/O in
the inbound txn); the sync machine below is entered only after the
worker's capture pass (§7.2 step 3) commits
`capture_status = captured`. Rows whose retention class is
S3-ineligible (`ephemeral`, `session` without promotion) stay in
`status = pending` forever — this is expected, not a backlog.

Transitions:

| From                  | To                    | Trigger                                                          | Transaction                              | Side effects                                                                                            | Retry                                                      | User-visible notification |
| --------------------- | --------------------- | ---------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------- |
| —                     | `pending`             | Artifact captured (attachment, generated, snapshot).             | Atomic with the insert.                  | Local file written; `storage_key` computed; `storage_sync` job enqueued for eligible retention classes. | N/A.                                                       | N/A.                      |
| `pending`             | `uploaded`            | S3 `PUT` succeeded (`storage/sync`).                             | Single-row update after S3 returns OK.   | `uploaded_at` set.                                                                                      | Terminal unless `deletion_requested` is later applied.     | N/A.                      |
| `pending`             | `failed`              | S3 `PUT` failed non-transiently or budget exhausted.             | Single-row update.                       | `error_json` set.                                                                                       | `storage/sync` may later move `failed → pending` again.    | Admin notice only.        |
| `failed`              | `pending`             | Retry scheduler decided to reattempt.                            | Single-row update.                       | —                                                                                                       | Bounded by `max_attempts` per attempt.                     | N/A.                      |
| `uploaded` / `pending`| `deletion_requested`  | `/forget_artifact <id>` or revoked `long_term` promotion.        | Single-row update + sync job enqueued.   | `deleted_at` not yet set; S3 `DELETE` scheduled.                                                        | N/A.                                                       | Command acknowledgment.   |
| `deletion_requested`  | `deleted`             | S3 `DELETE` succeeded (or `storage_backend = local` so only local file removed). | Single-row update.                       | `deleted_at` set; local file removed; `memory_artifact_links` rows that reference this row removed in the same txn. | Terminal.                                                  | Optional admin acknowledgment. |
| `deletion_requested`  | `delete_failed`       | S3 `DELETE` failed non-transiently (credentials / not-found race / network). | Single-row update.                       | `error_json` set; local file retained for inspection.                                                    | Not auto-retried; surfaces via `/doctor` for operator.     | Admin notice.             |

Invariants:

1. `uploaded` is the only state that satisfies the `long_term`
   preconditions in §5.2 invariant 5.
2. A `failed` row is never silently dropped; either it reaches
   `uploaded` via retry, `deletion_requested` via user forget,
   or it surfaces via `/doctor`.
3. `deleted` is a soft-delete marker. Hard row-level deletion is
   out of scope for P0; ops can reverse via `deletion_requested
   → pending` if the object is still retrievable.
4. `delete_failed` requires operator action. `storage/sync` does
   not auto-retry these; it records the error and moves on.
5. `ephemeral` artifacts never reach `uploaded`; they live and
   die in the local FS.
6. Entry into this sync machine (any transition with `From = —`
   or `pending → …`) requires `capture_status = 'captured'` for
   the same row. `storage/sync` must filter on that column when
   selecting candidates; a `capture_status = 'failed'` row is
   never synced.

### 6.5 `memory_items.status`

```
                 ┌─────────┐
                 │ active  │
                 └────┬────┘
                      │
               ┌──────┼──────┐
               ▼             ▼
         superseded      revoked
             │               │
             ▼               │
         revoked ◄───────────┘
           (terminal tombstone)
```

States: `active`, `superseded`, `revoked`. All transitions are
single-row updates; there is no hard delete in P0.

Transitions:

| From          | To            | Trigger                                                 | Transaction                                   | Side effects                                                         | Retry | User-visible notification       |
| ------------- | ------------- | ------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------- | ----- | ------------------------------- |
| —             | `active`      | `memory/summary` promotes a summary item; or `commands/correct` inserts a correction. | Atomic with the insert.                       | `source_turn_ids` populated.                                         | N/A.  | Footer line in the owning reply. |
| `active`      | `superseded`  | `commands/correct` inserted a new row whose `supersedes_memory_id` points here. | Same txn as the new row's `INSERT`.           | `status_changed_at` set.                                             | N/A.  | Footer `정정함: <old> → <new>`. |
| `active`      | `revoked`     | `/forget_memory <id>` or `/forget_session`.             | Single-row update.                            | `status_changed_at` set.                                             | N/A.  | Command acknowledgment.          |
| `superseded`  | `revoked`     | `/forget_memory <id>` on a superseded row.              | Single-row update.                            | `status_changed_at` set.                                             | N/A.  | Command acknowledgment.          |

Invariants:

1. Only `status = active` items are eligible for injection via
   `context/packer` (HLD §10.3 drop order always skips
   non-active).
2. A new `active` row with `supersedes_memory_id = X` must flip
   `X` from `active` to `superseded` in the **same transaction**
   that inserts the new row. This is the "supersede, not
   overwrite" guarantee referenced by PRD §12.2a and
   DEC-007.
3. `revoked` is terminal. A later correction attempt against a
   revoked id creates a fresh `active` row (no `supersedes`
   pointer) and logs the event.
4. `long_term` personal preferences (per PRD §12.2) require
   `provenance ∈ {user_stated, user_confirmed}`. Items that do
   not meet this rule are never promoted out of the session
   summary, regardless of `status`.

### 6.6 Interactions between machines (summary)

- `telegram_updates → enqueued` is the **only** legitimate creator of
  a `provider_run` job from the inbound path.
- `jobs → succeeded` is the **only** trigger that inserts a
  `job_completed` row in `outbound_notifications`.
- `outbound_notifications` outcomes never feed back to `jobs`.
- `storage_objects` outcomes never feed back to `jobs` either; they
  surface via `/doctor` and admin notices only.

These "no feedback" edges are the reason the system is recoverable:
failures in downstream machines cannot poison upstream state.

---

## 7. Core Flows

Flows are described at sequence-level. Each flow lists the **happy
path** first, then the **failure modes** we handle at P0. All of these
are test targets for playbook §8.2 coverage.

### 7.1 Inbound update → job queue

Happy path:

1. `telegram/poller` calls `getUpdates(offset, timeout)`.
2. For each returned update:
   a. Redact → insert `telegram_updates` row with `status = received`.
3. In a single transaction per batch:
   a. For each `received` row: `telegram/inbound` classifies it
      (authorized check, attachment handling, command detection) and
      either
      - inserts a `jobs` row + moves `telegram_updates` to
        `enqueued`, or
      - sets `telegram_updates.status = skipped` with a reason.
   b. Advance `settings.telegram_next_offset` to `max(update_id) + 1`.
4. Commit.

Attachment handling in this transaction is metadata-only: if the
update carries a photo / document / audio / video, classify it and
insert a `storage_objects` row with `capture_status = pending` and
`source_external_id` set to the Telegram `file_id`. Do **not**
call `getFile`, do **not** download bytes, and do **not** probe
MIME in this transaction; capture runs in §7.2.

Failure modes:

- Crash between step 2 and step 3: the updates reappear on next
  poll, keyed by `update_id`; no duplicate rows.
- Crash between step 3a and step 3b (same txn): the txn rolls back
  entirely; the update reappears on next poll.
- Inbound classifier throws for a single update: that row moves to
  `failed`, other rows in the batch still advance normally; offset
  advances only past the ones that reached a final status.

### 7.2 Worker loop → provider run

Happy path:

1. `queue/worker` polls `jobs` for the next `queued, scheduled_at <=
   now, job_type = provider_run`.
2. Worker claims atomically: `UPDATE ... SET status='running',
   started_at=now, attempts=attempts+1 WHERE id=? AND
   status='queued'`. This claim is its own short transaction; no
   network I/O inside it (§7.10 transaction boundaries).
3. **Attachment capture pass** (outside the claim transaction):
   for each `storage_objects` row tied to this job with
   `capture_status = pending`:
   a. Call Telegram `getFile`, download bytes to the local store,
      detect MIME, compute `sha256`, measure `size_bytes`.
   b. In a single capture transaction, set
      `capture_status = captured`, `captured_at = now`, and
      populate `sha256` / `mime_type` / `size_bytes`. Enqueue a
      `storage_sync` job only if the retention class is S3-eligible.
   c. On download / probe failure: in a single transaction set
      `capture_status = failed` with `capture_error_json`. The
      `provider_run` continues; the user turn records that capture
      failed so the user can retry (PRD §13.5).
4. Worker loads the `sessions` row and decides `resume_mode` vs
   `replay_mode` (§10).
5. `context/builder` + `context/packer` assemble the prompt,
   injecting attachment metadata only for rows with
   `capture_status = captured` (failed captures surface as a
   user-visible note instead of bytes).
6. `providers/claude` spawns the subprocess (§14), streams events,
   writes `provider_raw_events` (redacted) and `turns` as it goes.
7. On subprocess exit code 0 with a valid final event: worker
   commits `status = succeeded`, `finished_at`, `result_json`, and
   inserts `outbound_notifications` row `job_completed`.
8. `telegram/outbound` sends the notification and moves it to
   `sent`.

Failure modes:

- Claim contention (shouldn't happen with a single worker, but
  guard anyway): the atomic update simply affects 0 rows; worker
  backs off.
- Subprocess non-zero exit with final text still present: parser
  fallback path (PRD §16.3) produces a best-effort `turns` row and
  the job transitions to `succeeded` or `failed` per the adapter's
  decision, with `result_json` recording the parser status.
- Subprocess timeout (`max_runtime`): SIGTERM → grace → SIGKILL on
  the process group (§14); job moves to `failed` with a timeout
  error; notification `job_failed` is sent.
- Mid-run crash of the host: recovery at boot finds `running` →
  `interrupted`; if `safe_retry`, re-queue; else notify.

### 7.3 Provider stream → turns + notifications

Happy path:

1. Adapter reads stream-json lines from the subprocess.
2. Each line is redacted, then inserted into `provider_raw_events`
   (single transaction per line is fine).
3. Assistant output chunks are aggregated by the adapter; the final
   text event produces one `turns` row with `role='assistant'`.
4. Tool events are recorded in `provider_raw_events` only (P0 does
   not enable tools by policy; any tool event is an anomaly and is
   logged).
5. On end-of-stream, the adapter signals the worker which completes
   the `running → succeeded` transition.

Failure modes:

- Malformed stream-json line: redact and persist raw line with
  `parser_status = parse_error`; continue reading; fallback path
  kicks in at end.
- Stream silence beyond `stall_timeout`: treated as subprocess
  hang, same handling as 7.2 timeout.
- Partial final: if final event is missing but `parser_fallback`
  (PRD §16.3) can reconstruct, job may still succeed; otherwise it
  fails.

### 7.4 `/cancel`

Happy path:

1. `commands/cancel` reads the target job id (most recent
   `running` job for the user by default).
2. If `status = queued`: single-row update `→ cancelled`; enqueue
   `job_cancelled` notification.
3. If `status = running`: signal `providers/claude` to begin
   teardown (§14): SIGTERM to the process group → grace →
   SIGKILL.
4. Once the subprocess has exited, worker transitions `running →
   cancelled` with `cancelled_after_start = true` if any `turns` or
   `provider_raw_events` were written.
5. Enqueue `job_cancelled` notification.

Failure modes:

- Cancel on a job already in a terminal state: no-op; respond with
  an acknowledgment that the job was already in that state.
- Subprocess fails to die within the kill budget: systemd
  `KillMode=control-group` is the last resort; `/doctor` flags the
  condition.

### 7.5 `/summary` and `/end`

`/summary` produces a summary of the current session without ending
it. `/end` produces a summary and closes the session.

Happy path (shared):

1. `commands/summary` or `commands/end` enqueues a
   `summary_generation` job with `idempotency_key` per §5.3.
2. Worker picks it up; `memory/summary` calls the Claude adapter
   under the **advisory/chat lockdown profile** (`--tools ""`,
   `--permission-mode dontAsk`, PRD §12.3).
3. Summary output is validated against the schema; a
   `memory_summaries` row is inserted; a local memory
   markdown/jsonl file is written; `storage_sync` job is enqueued
   to mirror to S3.
4. `outbound_notifications` row `summary` is inserted and sent.
5. On `/end`: the session is marked ended; the next user DM will
   start a new `session_id`.

Failure modes:

- Summary subprocess produces malformed JSON: retry once with a
  stricter schema reminder; if it still fails, record the raw in
  `provider_raw_events` and respond with a user-visible error.
- `storage_sync` for the snapshot fails: summary itself still
  succeeds; sync job retries independently.
- `/end` called with an empty session: produce a minimal summary
  (no preferences, no decisions) and still close the session.

### 7.6 Storage sync (S3 mirror)

Happy path:

1. `storage/sync` picks the next `storage_objects` row with
   `status = pending` and an S3-eligible retention class.
2. Read local file → compute/verify `sha256` → compose object key.
3. `PUT` via `Bun.S3Client` to Hetzner Object Storage.
4. On success: update `storage_objects.status = uploaded`,
   `uploaded_at` set.

Failure modes:

- Transient network/credential error: row moves to `failed` with
  `error_json`; retry scheduler eventually moves it back to
  `pending`.
- Credential revoked for extended period: `/doctor` surfaces the
  condition; runs continue to succeed (PRD AC-STO-001).
- Local file missing (disk cleaned up, bug): record a permanent
  `failed`; do not retry; admin must resolve.

### 7.7 Notification retry

Happy path:

1. `notification_retry` job scans `outbound_notification_chunks`
   with `status IN ('pending', 'failed')` that are within the
   per-chunk retry budget, ordered by parent
   `outbound_notification_id` and `chunk_index`.
2. For each eligible chunk, `telegram/outbound` attempts
   `sendMessage` for that single chunk only.
3. On success: chunk `status = sent`, `telegram_message_id`
   recorded. In the same transaction, if this was the last
   remaining chunk for its parent, flip the parent row to `sent`
   and populate `telegram_message_ids_json`.
4. On non-retryable error: chunk `status = failed` with
   `error_json`. Parent row's `status` is re-derived (`failed`
   iff no chunk is still `pending`, otherwise remains `pending`).

Correctness rule: a chunk with `status = 'sent'` is **never**
selected for retry. If chunks 1–2 are sent and chunk 3 fails, the
retry loop sends only chunk 3; the user does not receive chunks 1–2
again because of this retry path.

Failure modes:

- Telegram outage: chunks stay `pending` / move to `failed`; next
  retry cycle picks them up; `storage_sync` and `provider_run`
  remain unaffected.
- Message formatting issue for a single chunk (e.g. payload too
  large after a formatting bug): treat as non-retryable for that
  chunk; record in `error_json`. Other chunks in the same
  notification proceed independently.

### 7.8 Redaction boundary (flow view)

See §13 for the boundary rule. Viewed as a flow:

```
Any raw input
  ├─ Telegram update payload
  ├─ Claude stream-json line (stdout/stderr)
  ├─ User message
  └─ Filenames, captions
        │
        ▼
    observability/redact  (PRD §15 patterns + PRD §12.8.3 secret detector)
        │
        ▼
    Any durable store
  ├─ SQLite tables
  ├─ Local filesystem
  └─ S3 objects
```

Failure mode: a redaction bypass is **Sev-A** (playbook §11.4). The
recovery path is stop, identify affected rows, redact/delete, fix
the code path, add a regression test.

### 7.9 Startup recovery

See §15 for details. As a flow:

1. Open DB, confirm schema.
2. `jobs`: `running → interrupted` for any rows left running.
3. For each `interrupted` job: if `safe_retry`, re-queue; else
   leave as `interrupted` and emit `job_failed` notification.
4. `storage_objects`: no automatic state change; `storage_sync`
   picks up `pending`/`failed` rows normally.
5. Orphan subprocess sweep (best-effort, Linux procfs).
6. Emit a boot-time doctor summary.

Failure modes: if recovery itself fails (e.g. DB unreadable),
systemd restarts the service; if it keeps failing, the service
enters failed state and the operator is alerted out-of-band.

### 7.10 Transaction boundaries

This section is binding. SQLite transactions in this system must
be short and must never perform any I/O that can block, fail
independently, or race with other writers. That rule is what
keeps the Telegram offset ledger durable, the `jobs` claim
exclusive, and the `storage_sync` / `notification_retry` machines
independent.

Every committing transaction in P0 belongs to one of the
following named classes. No transaction may span more than one
class. No code path may open a transaction not listed here.

**T1 — Inbound ingest** (`telegram/inbound` per §7.1):
- Insert `telegram_updates` row(s), classify, insert attachment
  `storage_objects` rows with `capture_status = 'pending'`, insert
  `jobs` row(s), advance `settings.telegram_next_offset`.
- Prohibited inside T1: Telegram `getFile`, any HTTP call, any
  file I/O beyond SQLite, MIME sniffing of bytes, provider
  subprocess spawn, `sendMessage`, S3 `PUT`/`DELETE`, logger
  sinks that block on network.

**T2 — Worker claim** (`queue/worker` per §7.2 step 2):
- Single-row atomic `UPDATE` that moves a `jobs` row from
  `queued → running` and increments `attempts`.
- Prohibited inside T2: anything except that one `UPDATE`. No
  context packing, no provider spawn, no notification write.

**T3 — Attachment capture commit** (§7.2 step 3):
- Per attachment: after the out-of-transaction `getFile` +
  download + hash + MIME probe have succeeded, a single
  transaction sets `capture_status = 'captured'`, populates
  `sha256` / `mime_type` / `size_bytes` / `captured_at`, and
  (only if retention is S3-eligible) inserts a `storage_sync`
  job.
- Prohibited: any further network I/O; any mutation to
  `provider_runs`, `turns`, or `outbound_notifications`.

**T4 — Provider raw event append** (§7.3):
- One transaction per stream-json line: redact → insert
  `provider_raw_events` row. Kept per-line on purpose so parse
  failures mid-stream don't lose already-captured events.
- Prohibited: `sendMessage`, S3 I/O, waiting on `proc.exited`.

**T5 — Provider run completion** (§7.2 step 7):
- Close out the `provider_runs` row (`status = succeeded|failed`,
  `usage_json`, `parser_status`, `finished_at`), insert the final
  assistant `turns` row, flip the owning `jobs` row to `succeeded`
  (or `failed`), insert the parent `outbound_notifications` row
  and its `chunk_count` `outbound_notification_chunks` rows with
  `status = 'pending'`.
- Prohibited: Telegram `sendMessage` (that's T7), S3 I/O.

**T6 — Resume-fallback flip** (§6.2 resume-fallback transition):
- Same-row mutation on a `jobs` row: `status = 'queued'`,
  `request_json.context_packing_mode = 'replay_mode'`,
  `result_json.resume_failed = true`; plus the
  `provider_runs` row for the failed attempt is closed with
  `status = 'failed', error_type = 'resume_failed'`.
- Prohibited: inserting a new `jobs` row (§5.3); touching
  `attempts`; sending a notification.

**T7 — Outbound chunk delivery** (§7.7):
- After a successful `sendMessage` for one chunk: set
  `outbound_notification_chunks.status = 'sent'`,
  `telegram_message_id`, `sent_at`; if this was the last chunk,
  derive parent `outbound_notifications.status = 'sent'` and
  populate `telegram_message_ids_json`.
- Prohibited: Telegram `sendMessage` (that already happened
  outside the transaction); mutating `provider_runs` or `jobs`.

**T8 — Storage sync commit** (§7.6):
- After a successful S3 `PUT` / `DELETE` outside the transaction:
  flip `storage_objects.status` (`pending → uploaded`,
  `deletion_requested → deleted`) and set timestamps.
- Prohibited: S3 I/O inside the transaction; mutation of
  `provider_runs` or `jobs` (PRD AC-STO-002, AC-STO-006).

**T9 — Startup recovery** (§7.9 / §15):
- Single boot transaction: `running → interrupted` for every
  stale `jobs` row; for each, decide `interrupted → queued` in
  the same transaction per `safe_retry`.
- Prohibited: spawning subprocesses; sending notifications;
  S3 I/O.

Cross-class prohibitions (apply everywhere):

- No transaction opens a subprocess or waits on one (`proc.exited`
  is always awaited outside a transaction).
- No transaction performs Telegram HTTP calls, S3 calls, or blocks
  on a logger sink that hits the network.
- No transaction spans two core flows (e.g. inbound ingest and
  worker claim are always separate transactions, even if a future
  optimisation tempts otherwise).

Code review and tests should treat any transaction that violates
the above as a defect regardless of whether the current behaviour
looks correct.

---

## 8. Provider Adapter Design

P0 ships exactly one provider adapter: `providers/claude`. Other
providers (`gemini`, `codex`, `ollama`) exist only as interface
placeholders per PRD §5.

### 8.1 Invocation profiles

Two distinct profiles, both through the same adapter:

| Profile                     | Used by               | Claude flags (indicative)                                     | Tools allowed |
| --------------------------- | --------------------- | ------------------------------------------------------------- | ------------- |
| **Conversational** (P0 default) | Inbound chat `provider_run` | `--session-id`/`--resume` per §10.2; `--output-format stream-json`; permission lockdown per spike §6.1.5. | None in P0.   |
| **Advisory/chat lockdown**  | `summary_generation`  | Same plus explicit `--tools ""` and `--permission-mode dontAsk`. | None.         |

P0 policy: both profiles run with **no tools enabled**. Any future
tool enablement is a PRD change (playbook §13).

### 8.2 Resume vs replay

Two context-packing modes; the decision is made by
`context/builder` (§10.2) and recorded on the `provider_runs` row.

- `resume_mode`: we hold a valid `provider_session_id` for the
  session and Claude's `--resume` is expected to succeed. We send
  only the user message + compact injected context.
- `replay_mode`: we do not hold a valid `provider_session_id` (new
  session, or previous session broken). We send the current session
  summary + recent N turns + user message.

Rules:

1. The adapter always records which mode was used, which flags were
   passed, and the resulting `provider_session_id` returned by
   Claude.
2. A failed `--resume` (session not found on Claude's side) does
   **not** silently fall back mid-call. The adapter exits,
   records a `provider_runs` row with
   `status = failed, error_type = 'resume_failed'`, and the worker
   retries the **same** `jobs` row in `replay_mode`. Concretely, in
   a single transaction:
   - `jobs.status` transitions `running → queued` via the
     resume-fallback path (§6.2 transition "resume fallback").
   - `jobs.request_json.context_packing_mode` is set to
     `replay_mode`; `jobs.result_json.resume_failed = true` for
     observability.
   - `attempts` is not incremented for the fallback; the next
     worker claim increments it normally.
   No new job is inserted and `idempotency_key` is unchanged —
   the §5.3 duplicate-insert no-op rule is irrelevant because the
   existing row is mutated in place. This keeps replay/resume
   semantics testable (playbook §6.1.6).
3. Resume must not double-answer: if the adapter detects the stream
   is replaying an already-persisted assistant turn, it treats it
   as an anomaly and logs it (spike §6.1.6 precondition).

### 8.3 Stream-json parser

Input: one JSON object per line on stdout. Output: a structured
stream of events:

- `assistant_text_chunk` — partial assistant text; aggregated.
- `assistant_final` — end of assistant message, carries final text.
- `tool_call` / `tool_result` — recorded raw; P0 does not act on
  them.
- `error` — adapter transitions to the error path.
- `meta` — carries session id, usage, etc.

Parser policy:

1. Every line is redacted **before** parsing succeeds or fails;
   persistence of `provider_raw_events.redacted_payload` does not
   depend on parse success.
2. Unknown event types are persisted raw (redacted) with
   `parser_status = unparsed`; the adapter does not raise on them.
3. If the final event is missing but accumulated chunks can be
   joined into a coherent final, the fallback path produces a
   `turns` row with a note; `parser_status = fallback_used`.

### 8.4 Subprocess configuration

Every spawn passes:

- `cwd` from the per-request allowlist (PRD §15).
- `env` limited to the minimum required for Claude (no secrets we
  don't intend).
- `detached: true` and a known `process.pid` / process group
  (§14).
- `stdin` closed or a small known input; adapter writes the
  packed prompt and signals EOF.
- `stdout` / `stderr` captured and redacted line-by-line.
- Runtime caps: `max_runtime`, `max_output_bytes`,
  `max_prompt_bytes` (PRD §15).

### 8.5 Artifact capture

A `generated_artifact` (e.g. a file Claude produced during a
run) is captured by the adapter only if the stream surfaces a
usable reference. In P0 with tools disabled, this is rare; the
adapter does not scrape the filesystem looking for artifacts.

When captured: write local file → `storage_objects` insert
(`artifact_type = generated_artifact`, `retention_class =
session` by default) → optional `storage_sync` enqueue per
policy.

### 8.6 Parser fixtures

Every event shape the adapter depends on has a **fixture** under
`test/fixtures/claude-stream-json/`. A spike update that changes
Claude's event shape (spike §6.1.4) requires updating the
fixtures and re-running ledger integration tests.

---

## 9. Telegram Inbound / Outbound Design

### 9.1 Long-poll loop

Configuration:

- `allowed_updates = ["message"]`.
- `timeout` configurable; default in the 25–30s range.
- `offset = telegram_next_offset`.

Loop behavior:

1. Call `getUpdates`.
2. If non-empty: per §7.1, redact → insert → classify → commit
   batch → advance offset.
3. If empty or timeout: immediately re-call.
4. On API-level error: backoff (exponential, capped), record in
   `/doctor`.

Flood control: the loop honors Telegram's 429 / `retry_after` in
`sendMessage` responses; `getUpdates` failures also backoff.

### 9.2 Inbound classification

Order of checks (first match wins):

1. **Authorization**: `from.user_id ∈ allowed_user_ids`? If not:
   `skipped` with reason `unauthorized`. Exception:
   `BOOTSTRAP_WHOAMI=true` + `/whoami` content → special path
   returns user_id/chat_id only.
2. **Update type**: only `message` in P0; anything else:
   `skipped` with reason `unsupported_type`.
3. **Command detection**: `/status`, `/cancel`, `/summary`,
   `/end`, `/provider`, `/doctor`, `/whoami` route to
   `commands/*`.
4. **Attachment detection**: if the message has a photo /
   document / audio / video, §13.5 (PRD) flow runs in parallel
   with text classification.
5. **Text**: default path → `provider_run` job.

### 9.3 Attachment handling (HLD-level)

Per PRD §13.5. Attachment handling is split across **two** phases
to keep the inbound SQLite transaction short and free of network
I/O (§7.10 transaction boundaries).

**Phase 1 — inbound metadata (runs inside the inbound txn, §7.1):**

1. For each attachment in the update, classify its Telegram type
   (photo / document / audio / video) and read the metadata
   Telegram already supplied in the update payload (file_id, claimed
   MIME/size when present, message_id).
2. Insert a `storage_objects` row with:
   - `retention_class = session`
   - `source_channel = 'telegram'`
   - `source_message_id = update.message_id`
   - `source_external_id = update.file_id`
   - `capture_status = pending`
   - `status = pending` (sync status; only meaningful once
     `capture_status = captured`)
   - `sha256` / `mime_type` / `size_bytes` left nullable.
3. Create the `jobs` row and advance the Telegram offset as usual.
   Do not call `getFile`, download bytes, or probe MIME in this
   transaction.

**Phase 2 — byte capture (runs in the worker, §7.2 step 3):**

4. Worker pre-step, per attachment: `getFile` → download →
   `sha256` / MIME / size.
5. In a single capture transaction, set `capture_status = captured`,
   `captured_at = now`, and populate the computed fields. If the
   retention class is S3-eligible, enqueue a `storage_sync` job
   here (not before).
6. On failure, set `capture_status = failed` with
   `capture_error_json`. The owning `provider_run` continues and
   the user turn records that capture failed, so the user can retry.
7. Promotion to `long_term` is handled by explicit user intent
   (`/save_last_attachment` or natural-language match) and only
   applies to rows with `capture_status = captured`.

### 9.4 Outbound delivery

`telegram/outbound` is driven by `notification_retry` and by
direct enqueues from worker terminal transitions. Delivery
rules:

1. Respect Telegram message length limits; split long responses
   into numbered chunks with continuation markers.
2. Respect `retry_after` on 429; move the row back to
   `pending` and re-attempt after the delay.
3. Record every successful `sendMessage` id in
   `telegram_message_ids_json` for later `/cancel`/edit flows
   (P1).

### 9.5 Offset invariant (restated)

The single most important rule in the inbound design, restated
here because it is the one that state drift most often violates:

> **`telegram_next_offset` advances only after the transaction
> that persisted the corresponding `telegram_updates` rows (and
> the associated `jobs` rows, if any) has committed.**

This is the invariant spike §6.1.3 exists to verify and the
invariant AC-JOB-002 (recovery behavior) relies on.

---

## 10. Context Builder + Packer Design

PRD §12.4–12.6 define the policy. The HLD pins down the
**decision procedure** and the **recording** of what was injected,
so tests can assert on it.

### 10.1 Builder inputs

`context/builder` consumes, in order:

1. **Identity block** — a small, fixed "you are this user's
   personal agent" string.
2. **Active project context** — from `sessions.project_id` if set,
   resolving to a short project brief.
3. **Current session summary** — latest `memory_summaries` row of
   type `session` for the current session.
4. **Long-term memory** — P0 disabled (placeholder for P2).
5. **Recent turns** — the last N `turns` for the session; used
   only in `replay_mode`.
6. **User message** — the current inbound text and attachment
   metadata (not bytes) from §9.3.

Budgets are per PRD §12.5; the token estimator per §12.6.

### 10.2 Resume vs replay decision

```
has_provider_session_id(session) && session_id_not_expired()
  ├── true  → resume_mode
  └── false → replay_mode
```

Details:

1. `resume_mode` is used only if:
   - A `provider_session_id` exists on the `sessions` row.
   - It has not been marked broken by a previous run.
   - Claude CLI's `--resume` is expected to work for this version
     (per spike §6.1.6).
2. `replay_mode` is the safe default; any doubt resolves to
   replay.
3. The decision is recorded in `provider_runs.context_packing_mode`
   before the subprocess is spawned, so logs always reflect the
   actual mode used (even if the subprocess dies mid-call).

### 10.3 Packing

The packer composes the final prompt:

- `resume_mode`: `[delta summary] + [user message]`.
- `replay_mode`: `[identity] + [project] + [session summary] +
  [recent N turns] + [user message]`.

Rules:

1. The packer **never** silently drops content to fit the budget.
   If the packed prompt exceeds the budget, recent turns are
   dropped first, then project brief, then session summary, in a
   documented precedence; the result is recorded in
   `provider_runs.injected_snapshot_json`.
2. If even the minimum (user message + identity) does not fit, the
   job fails with a specific error (`prompt_overflow`); the user
   sees a `job_failed` notification.
3. The packer outputs a structured "what was injected" record used
   by observability (`context_packing_mode`, slot-by-slot bytes).

### 10.4 Token estimator

Per PRD §12.6, always prefer overestimation. No precise tokenizer
dependency in P0.

---

## 11. Memory + Summary Design

`memory/summary` owns the creation of durable memory artifacts.

### 11.1 Triggers

Per PRD §12.3 and DEC-019, two classes of triggers exist:

- **Explicit** (always allowed):
  - `/summary` — on-demand snapshot of the current session; does
    not change `sessions.status`.
  - `/end` — summary + close the session; the next DM creates a
    new `session_id`.
- **Automatic** (gated by a throttle):
  - A `summary_generation` job is enqueued automatically when any
    one of the following is true and **the throttle is
    satisfied**:
    - `turn_count ≥ 20` since the last summary for this session.
    - `transcript_estimated_tokens ≥ 6_000`.
    - `session_age ≥ 24h`.
  - **Throttle**: automatic triggers fire only when **≥ 8 new
    user turns** have occurred since the previous summary. This
    prevents near-simultaneous re-summaries around the thresholds.
- The automatic check runs inside the worker after each
  `provider_run` transitions to `succeeded`. It never runs during
  a `provider_run` because it would change context-packer input
  mid-job.

All three routes (`/summary`, `/end`, automatic) produce identical
`memory_summaries` + local file artifacts.

### 11.2 Generation procedure

1. Select source turns: every `turns` row in the session up to the
   trigger point, excluding content marked as redacted beyond
   recovery.
2. Spawn Claude under the advisory/chat lockdown profile (§8.1).
3. Prompt schema: the five fields listed in PRD §12.3 (facts,
   preferences, decisions, open tasks, cautions), plus
   per-item `provenance` and `confidence`.
4. Validate the returned JSON against the schema.
5. Insert `memory_summaries` row; write local file
   (`memory/sessions/<session_id>.jsonl`, and a rolled-up
   `memory/personal/YYYY-MM-DD.md` line); enqueue `storage_sync`
   for both if the retention class applies.
6. Emit `outbound_notifications` row `summary`.

### 11.3 Provenance and confidence

Strict per PRD §12.2:

- Only `user_stated` / `user_confirmed` items are eligible for
  long-term personal preferences.
- Other provenance classes are stored on the summary but never
  promoted out of the session.
- Every item carries a `confidence ∈ [0,1]`.

### 11.4 Artifact linkage

If the summary references an attachment (e.g. "the PDF you sent
on 2026-04-22"), the summary generator inserts a
`memory_artifact_links` row connecting the
`memory_summaries.id` to the `storage_objects.id`. Invariants
§5.2.5 and §6.4 apply.

### 11.5 Failure modes

- Schema validation failure: retry once with a stricter schema
  reminder; on second failure, record raw and surface a user-
  visible error.
- Subprocess error in lockdown profile: treated like any other
  provider failure; summary job moves to `failed`.
- Summary attempted on an empty session: produce an explicit
  "empty session" summary object rather than refuse.

---

## 12. Storage Sync Design

`storage/sync` is the only writer that drives `storage_objects`
rows into `uploaded`. Its job is to be boring and retryable.

### 12.1 Scheduler

A single loop:

1. Select up to `batch_size` `storage_objects` rows where
   `status ∈ {pending, failed}` and retention class implies S3
   and retry budget remains.
2. For each row, attempt upload (§12.2).
3. Between batches: sleep for `poll_interval_ms` (short when
   backlog exists, longer when idle).
4. Never holds a DB transaction across S3 I/O.

Only one sync loop runs. Concurrent syncs across a single row are
prevented by a "reservation" timestamp on the row (optional
optimization; single-loop design avoids the need).

### 12.2 Upload procedure

Per row:

1. Read local file; verify `sha256` matches the stored hash. If
   mismatch: mark `failed` with `error_json.reason = 'hash_mismatch'`
   (do not upload corrupted content).
2. Compose object key per PRD §12.8.4.
3. `Bun.S3Client.put(key, stream)` (or equivalent).
4. Verify via `stat` (optional in P0; required if spike §6.1.8
   reveals quirks).
5. Update row: `status = uploaded`, `uploaded_at = now`.

### 12.3 Error classification

| Class                | Example                                  | Action                                      |
| -------------------- | ---------------------------------------- | ------------------------------------------- |
| Transient network    | socket timeout, 503, DNS blip            | `failed` + retry next cycle; backoff.       |
| Credential           | 401 / 403                                | `failed` + doctor flag; no retry until ops. |
| Client error         | 400 malformed request                    | `failed` + `error_json`; no auto-retry.     |
| Local-only error     | local file missing, hash mismatch        | `failed` permanent; admin intervention.     |
| Unknown              | anything else                            | `failed` + retry with capped attempts.      |

`/doctor` checks the top K oldest `failed` rows and surfaces
their `error_json.reason`.

### 12.4 Independence from provider success

Explicit: a `storage_sync` failure never rolls back a
`provider_run` succeeded status (AC-STO-002), and never prevents
`job_completed` notifications. Users see their response even if
the S3 mirror is degraded.

### 12.5 Degraded mode

When `/doctor` reports Hetzner Object Storage as unreachable:

- Runs still succeed.
- `storage_sync` rows accumulate; the loop keeps retrying.
- The operator decides when to investigate credentials or the
  endpoint.
- If the outage exceeds the retention-class budget, future writes
  in that class are still accepted locally; playbook §11.3
  governs recovery.

### 12.6 Delete paths

- **Soft delete** (user `/forget_last_attachment`): updates
  `storage_objects.status = deleted`; a later sync pass may issue
  `DELETE` to S3 (policy configurable; default: delete S3 object
  but retain SQLite row for audit).
- **Hard delete**: out of scope for P0.

### 12.7 Key collision

Keys are effectively unique by construction (UUID +
sha256). Collisions are not expected; a `PUT` to an existing key
is acceptable (idempotent) because the content hash is the same.

---

## 13. Observability + Redaction Design

Observability in P0 is "enough to operate one user's agent". Full
Langfuse / tracing tooling is P1+.

### 13.1 Redaction boundary

There is exactly one redaction boundary in the system:

```
┌─────────────────────────────────────────────────────┐
│  RAW REGION (inside-process memory only)            │
│                                                     │
│   Telegram update JSON, Claude stdout/stderr lines, │
│   user message, filenames, captions                 │
│                                                     │
│                    │                                │
│                    ▼                                │
│     observability/redact.apply(payload)             │
│                    │                                │
│                    ▼                                │
│  REDACTED REGION (durable)                          │
│                                                     │
│   SQLite tables, local files, S3 objects, logs      │
└─────────────────────────────────────────────────────┘
```

Rules:

1. Nothing durable receives a payload that has not passed through
   `observability/redact.apply`.
2. Raw payloads are never written to disk. They exist only in
   memory while being transformed.
3. The redactor is a single module; multiple call sites share
   the same patterns. No inline ad-hoc redaction.

### 13.2 Redaction patterns (P0)

Starting set (extensible):

- `TELEGRAM_BOT_TOKEN` literal.
- Anthropic / OpenAI / Google API-key-like patterns.
- Hetzner S3 access/secret key patterns.
- JWT-like tokens.
- Emails (for PII privacy when the setting is on).
- Phone numbers (optional).

The redactor exposes both "redact" (replace with placeholder) and
"detect" (boolean + category) so the attachment policy (PRD
§12.8.3) can refuse promotion without mutating content.

### 13.3 Logs

- Structured (JSON) line logs to stdout, captured by systemd
  journal.
- Keys include: `event`, `job_id`, `session_id`,
  `provider_session_id`, `notification_type`,
  `storage_object_id`, `duration_ms`, `error_type`.
- No full payloads in logs; logs always reference rows in SQLite
  by id.

### 13.4 Correlation

Every inbound DM eventually produces log entries across
`telegram/poller → telegram/inbound → queue/worker →
providers/claude → telegram/outbound → storage/sync`. Each entry
carries the `job_id`. `/status` and `/doctor` use the same id.

### 13.5 `/doctor` outputs (preview; full spec in §16)

At minimum: DB reachable (and WAL OK), Telegram API reachable,
Claude binary present and version, S3 endpoint reachable (put/
get/list/delete smoke), disk free, oldest pending
`storage_sync`, oldest pending `outbound_notifications`,
`interrupted` jobs count.

---

## 14. Subprocess Lifecycle

This is the single most dangerous piece of the runtime. A surviving
subprocess means user-visible bugs and possible resource leaks;
killing the wrong process means lost work. The rules below are
non-negotiable.

### 14.1 Spawn

- `Bun.spawn([...argv], { cwd, env, stdin, stdout: 'pipe',
  stderr: 'pipe' })`.
- `detached: true` so the child gets its own process group
  (`setsid` on Linux). The adapter records `proc.pid` and the
  group id (== pid for the leader) on the `provider_runs` row
  immediately.
- **`argv` only**; shell-style string interpolation is forbidden
  (PRD §15).
- `proc.unref()` is **not** called by default; the parent tracks
  exit via `proc.exited`.

### 14.2 Run

- Adapter reads stdout line by line; redacts and persists each
  line before doing anything parser-dependent (§8.3).
- `AbortController` / `AbortSignal` is wired so `/cancel` can
  initiate teardown without waiting for the next I/O tick.
- Stall detection: if no output arrives within
  `stall_timeout_ms`, the adapter triggers the timeout teardown
  (§14.3).

### 14.3 Teardown

Ordered steps; each step waits `grace_ms` before escalating:

1. Signal `SIGTERM` to the **process group** (not just the
   leader PID).
2. Wait `grace_ms`. If `proc.exited` resolves: done.
3. `SIGKILL` to the process group.
4. Wait `hard_kill_ms`. If still alive: log Sev-B condition,
   rely on systemd `KillMode=control-group` as the ultimate
   safety net (PRD §16.2).

Teardown is triggered by:

- `/cancel` command.
- `max_runtime` exceeded.
- Stall timeout.
- `max_output_bytes` exceeded (with a grace to let the process
  finish writing).
- Service shutdown (SIGTERM to the Bun process).

### 14.4 Ownership

- Only the adapter that spawned the subprocess is allowed to
  kill it.
- The `jobs` row records the adapter's internal "in-memory
  handle"? No — the adapter keeps it in memory and uses
  `provider_runs.process_group_id` as the durable reference.
- On process restart, the adapter is gone; recovery at boot
  (§15) reconciles by treating those `running` jobs as
  interrupted and sweeping any orphan processes that claim the
  `process_group_id` from `provider_runs`.

### 14.5 Side-effect marker

`cancelled_after_start = true` is set on the `jobs` row when the
subprocess had begun producing output (at least one
`provider_raw_events` row) before teardown. This allows retry
policy (PRD §16.3) to refuse auto-retry when side effects may
have occurred.

### 14.6 What we explicitly do not do

- Spawn Claude without a process group.
- Run the subprocess as root or share the parent's working
  directory blindly.
- Trust the subprocess to self-terminate on SIGTERM alone.
- Pipe the full stdout into memory before parsing.

---

## 15. Startup Recovery

Run on every boot before the worker loop starts accepting new
jobs.

### 15.1 Steps

1. **DB bring-up**: open SQLite (WAL), run migrations forward
   (P0 migrations are forward-only, idempotent).
2. **Schema sanity**: expected tables and indices exist; if not,
   exit with a clear error (systemd will restart).
3. **`jobs` reconciliation**:
   a. For each row with `status = running`:
      - Set `status = interrupted`, `finished_at = now`, append
        a recovery note to `error_json`.
   b. For each new `interrupted`:
      - If `safe_retry AND attempts < max_attempts`: set
        `status = queued` and leave `attempts` unchanged (do
        not charge an attempt for an OS-level interruption).
      - Else: leave `interrupted`; enqueue an
        `outbound_notifications` row `job_failed` with a
        "restarted during your job" explanation.
4. **Orphan process sweep** (best-effort):
   - For each `provider_runs` row belonging to a reconciled job
     that recorded a `process_group_id`, check `kill(-pgid, 0)`;
     if alive, `kill(-pgid, SIGKILL)`.
5. **Offset sanity**: ensure `telegram_next_offset` is not
   behind the smallest `update_id` in `telegram_updates` rows
   still pending classification; if it is, fast-forward (this
   should be impossible by invariant, but we verify).
6. **`storage_objects`**: no automatic status changes. The
   storage sync loop will pick up pending/failed rows on its
   normal cadence.
7. **`outbound_notifications`**: no automatic status changes;
   `notification_retry` loop handles them.
8. **Boot doctor**: emit a structured log entry summarizing
   reconciliations, orphan kills, backlog counts, and any
   anomalies.

### 15.2 Failure modes during recovery

- DB is unreadable: exit non-zero; systemd restarts; if
  repeated, operator must intervene (playbook §11).
- Migration fails: exit non-zero; must be resolved by
  roll-forward, never by silently ignoring.
- `kill(-pgid, SIGKILL)` fails (e.g. process already gone,
  permission): log and continue.
- Orphan process cannot be killed (rare): surface via `/doctor`
  until resolved.

### 15.3 Guarantees after recovery

- No `jobs` row is `running` unless a currently-alive adapter
  owns it.
- No "attempt" counter was inflated merely because of an OS-
  level interruption.
- `telegram_next_offset` is consistent with the
  `telegram_updates` ledger.

---

## 16. `/doctor` Smoke Test Design

`/doctor` is both a command and a boot-time routine. It runs the
same checks either way; the command version posts the result to
Telegram, the boot version logs it.

### 16.1 Checks (P0)

Per DEC-017, `/doctor` is a single command in P0. Each check is
tagged as `quick` or `deep` in the output and every line reports
`category`, `duration_ms`, and `status` (`ok | warn | fail`).

| Check                          | Category | Pass criterion                                               |
| ------------------------------ | -------- | ------------------------------------------------------------ |
| `config_loaded`                | quick    | All required config fields present; none contain obvious placeholders. |
| `sqlite_open_wal`              | quick    | `PRAGMA journal_mode` returns `wal`; a test write+read succeeds. |
| `migrations_applied`           | quick    | Schema version matches the code's expected version.          |
| `telegram_api_reachable`       | quick    | `getMe` returns 200; bot id matches config.                  |
| `claude_binary_present`        | quick    | Claude CLI present at configured path; `--version` returns.  |
| `claude_version_pinned`        | quick    | Version matches the value recorded in `03_RISK_SPIKES.md`.   |
| `redaction_boundary_quick`     | quick    | A small self-test string containing a known pattern is redacted correctly. |
| `bootstrap_whoami_guard`       | quick    | If `BOOTSTRAP_WHOAMI=true`, remaining auto-expiry time is reported; `warn` while on, `fail` past the 30-minute window (DEC-009). |
| `s3_endpoint_smoke`            | deep     | `put` + `get` + `stat` + `list` + `delete` on a temp key per PRD §12.8. AC-OBS-001. |
| `claude_lockdown_smoke`        | deep     | A short prompt under `--tools ""` + `--permission-mode dontAsk` produces no interactive prompt and no fs writes outside Claude's session path (SP-05). |
| `subprocess_teardown_smoke`    | deep     | `Bun.spawn` detached process-group kill completes within the grace + hard-kill budget (SP-07). |
| `disk_free_ok`                 | deep     | Free bytes > configured threshold for SQLite + local storage; S3 degraded thresholds (DEC-018) not exceeded. |
| `interrupted_jobs`             | deep     | Count of `status = interrupted` (informational; > 0 is a warn). |
| `stale_pending_notifications`  | deep     | Count of `pending` older than `stale_threshold_ms` (warn). |
| `stale_pending_storage_sync`   | deep     | Count of `pending`/`failed` `storage_objects` older than `stale_threshold_ms`. |
| `orphan_processes`             | deep     | 0 orphan Claude process groups from `provider_runs`.         |

If aggregate `/doctor` latency exceeds the Phase-10 budget, split
into `/doctor deep`, `/doctor s3`, `/doctor claude` per DEC-017.
Until then a single command runs both categories and reports the
totals.

### 16.2 Output

- Command version: a single Telegram message listing each check
  with `category`, `duration_ms`, and `ok`/`warn`/`fail`; a
  short reason for any non-`ok` line.
- Boot version: structured log, plus a rolled-up `boot_doctor`
  event used by the runbook.

### 16.3 Relation to acceptance

AC-OBS-001 requires `s3_endpoint_smoke` to pass for the P0 acceptance
gate. Failure puts the system into a documented degraded mode
(local-only) rather than refusing to start.

### 16.4 What `/doctor` does not do

- Mutate state (other than its own temp smoke-test objects,
  which it cleans up).
- Try to "fix" anything it finds.
- Emit notifications other than the single doctor reply.

---

## 17. Risk Spikes

Full list with acceptance criteria is in
`docs/00_PROJECT_DELIVERY_PLAYBOOK.md` §6 and will be tracked in
`docs/03_RISK_SPIKES.md`. The HLD assumptions that directly depend
on spike outcomes, recapped here so reviewers can find them in one
place:

| HLD section  | Depends on spike                                       |
| ------------ | ------------------------------------------------------ |
| §5 (txn model) | §6.1.1 Bun `bun:sqlite` WAL + `BEGIN IMMEDIATE` behavior. |
| §6.1, §7.1, §9.5 | §6.1.2 Telegram `getUpdates` direct-fetch behavior.    |
| §6.1 invariants, §15 | §6.1.3 Telegram offset durability under crash.      |
| §8.3, §7.3   | §6.1.4 Claude `stream-json` event shape.               |
| §8.1         | §6.1.5 Claude permission lockdown.                     |
| §8.2, §10.2  | §6.1.6 Claude `--session-id` / `--resume` semantics.   |
| §14          | §6.1.7 `Bun.spawn` detached process group kill.        |
| §12, §16.1   | §6.1.8 `Bun.S3Client` against Hetzner Object Storage.  |

If any of these spikes return a result that contradicts the HLD's
assumption, the owning section must be updated **before**
implementation proceeds past that area (playbook §6.3).

---

## 18. Implementation Sequencing

Full sequencing lives in `docs/04_IMPLEMENTATION_PLAN.md` (to be
written). The HLD's contribution is the **module order** implied by
the boundaries above; this matches the playbook §7.2 build order.

1. `config`, `observability/redact` (skeleton only).
2. DB schema + migrations (PRD Appendix D + §5.2 invariants as
   test targets).
3. `telegram/poller` + `telegram/inbound` (up to
   `telegram_updates.status` and offset advance).
4. `queue/worker` with a **fake provider adapter**; `jobs.status`
   machine end-to-end.
5. `telegram/outbound` + `outbound_notifications.status`.
6. **Walking skeleton gate** (playbook §5.5).
7. `providers/claude`: subprocess lifecycle (§14), stream-json
   parser (§8.3), resume/replay (§8.2, §10.2).
8. `context/builder` + `context/packer` (§10).
9. `memory/summary` (§11).
10. `storage/local` + `storage/sync` (§12).
11. `commands/*` and `/doctor` (§16).
12. `startup/recovery` (§15) — hardened to pass AC-JOB-002.
13. systemd unit + RUNBOOK (playbook §10).

Each vertical slice ends with at least one ledger integration
test against the corresponding state machine transitions.

---

## 19. Open Questions

These are questions the HLD deliberately leaves open. Each will
resolve to a `08_DECISION_REGISTER.md` entry or a PRD amendment, not silent
drift.

1. **`sessions.status` machine**: P0 may need `active | ended`
   states to make `/end` testable. Decide during Phase 4 whether
   to promote `sessions` to a fifth state machine or keep it as a
   simple flag.
2. **Summary promotion policy**: the HLD currently treats
   `user_stated` / `user_confirmed` as the only gates for long-
   term personal preferences. Should we add a "user reviewed and
   confirmed at summary time" gate for items the assistant
   proposed? Track as P0 vs P1 question.
3. **Attachment promotion UX**: the HLD names
   `/save_last_attachment` and `/forget_last_attachment` as
   provisional commands. Decide the canonical names before the
   Claude vertical slice lands.
4. **`storage_sync` delete policy on soft-delete**: default is
   "delete the S3 object, keep SQLite row as audit". Confirm with
   Security review.
5. **`/cancel` target disambiguation**: when the user has a
   running job and queued jobs, does `/cancel` hit the running
   one only, or prompt for a choice? P0 default: running-only;
   revisit if the queue grows.
6. **Turn replay boundary in `replay_mode`**: default `N = 10`
   recent turns. Tune after the first real-world session; lock
   in a value in the implementation plan.
7. **Redaction pattern coverage**: initial set is listed in
   §13.2; the corpus will grow. Maintain the list in
   `config/redaction_patterns.ts` with tests for every new
   pattern.

---

*End of HLD. This document is updated in place whenever an
implementation discovery changes its contents; a silent divergence
between HLD and code is a process bug (playbook §7.4, §13.1).*





