# Runtime Flow

> Status: thin current-state map · Owner: project lead ·
> Last updated: 2026-04-29
>
> This file is an index, not an implementation log. Replace
> current-state summaries; do not append phase history.
>
> This file describes the implemented runtime as it exists in
> `src/`. The fuller, design-level state-machine specifications
> for the implemented P0 vertical live in `docs/02_HLD.md` §6. The
> planned Judgment System pipeline lives in
> `docs/JUDGMENT_SYSTEM.md` §6-stage pipeline (per DEC-037, that
> is a historical architectural record, not implementation
> authority).

## Boot sequence

`src/main.ts` drives boot:

1. `loadConfig()` — fail fast on missing env or malformed
   `config/runtime.json` (`src/config.ts`).
2. `openDatabase()` — opens SQLite with WAL, busy_timeout, FK pragmas
   (`src/db.ts`).
2a. `assertNoPendingProviderRunsBeforeMigration006()` — upgrade guard:
   aborts boot if schema-5 `provider_run` jobs are running/queued and
   migration 006 has not yet been applied. Prevents cross-schema retry
   duplicates in the append-only `control_gate_events` ledger.
   Skip: fresh DB (no `settings` table), already-upgraded DB, no jobs table.
3. `migrate(db, migrationsPath)` — forward-only, idempotent
   (`src/db/migrator.ts`).
4. `runStartupRecovery(db, …)` — reconciles stale `running` jobs
   (forces `running → interrupted`, requeues if `safe_retry`, kills
   orphan process groups), fast-forwards
   `settings['telegram.next_offset']` past gaps, and **sweeps only
   `storage_objects` rows in `('failed', 'delete_failed')`** by
   enqueueing one `storage_sync` job with a per-boot idempotency key.
   Rows in `pending` are **not** swept here — they are picked up by
   ordinary `storage_sync` jobs created by capture / promotion paths.
   See `src/startup/recovery.ts`.
5. Wires composition root: redactor, S3 transport, Telegram Bot API
   transport, Claude adapter (full + advisory variants), MIME probe,
   storage-capacity check, shared cancel-handle map.
6. Boot `/doctor` quick checks via `runDoctor` (config, schema
   version, redaction self-test).
7. Launches concurrently:
   - `runPoller` — Telegram long-poll loop.
   - `runWorkerLoop` — job claim + dispatch loop.
8. SIGTERM / SIGINT trip a shared `AbortController`; both loops
   drain and the DB handle closes.

## Current implemented flow

### Inbound

```
Telegram getUpdates
  └─► telegram_updates (status=received)
       └─► classifier
            ├─► authorized text                  → jobs (provider_run, queued,
            │                                       idempotency_key='telegram:' || update_id)
            │                                       telegram_updates → enqueued
            ├─► authorized command               → jobs (provider_run | summary_generation,
            │                                       depending on the command)
            ├─► authorized message + attachment  → jobs (provider_run, queued)
            │                                       + storage_objects (capture_status=pending)
            │                                       in the SAME inbound transaction;
            │                                       byte capture is performed in-process by
            │                                       the worker via runCapturePass(jobId)
            │                                       before the AI run (NOT a separate job)
            ├─► unauthorized                     → telegram_updates → skipped
            └─► malformed / unsupported          → telegram_updates → skipped or failed
```

The implemented `jobs.job_type` enum is exactly
`{ provider_run, summary_generation, storage_sync, notification_retry }`
(see `migrations/001_init.sql` CHECK constraint). There is no
`storage_capture` job type; attachment byte capture runs inside the
owning `provider_run` job before the AI subprocess executes
(`runCapturePass` in `src/queue/worker.ts`, which calls
`captureOne` from `src/telegram/attachment_capture.ts`).
S3-eligible objects then get a `storage_sync` job inserted by
`commitCaptureSuccess`.

The long-poll offset (settings key `telegram.next_offset`, see
`OFFSET_KEY` in `src/telegram/inbound.ts`) is advanced **only after**
the same transaction that records `enqueued` / `skipped` / `failed`.
Crash before commit re-delivers the update; `update_id` makes the
second delivery a no-op.

### Job execution

```
queue/worker
  ├─ claim queued job (BEGIN IMMEDIATE → single-row update)
  ├─ dispatch by job_type
  │   ├─ provider_run        → providers/claude
  │   │     └─ spawn detached, parse stream-json, return parsed events
  │   │     └─ worker persists turns + raw events; resume_mode then optional replay_mode fallback
  │   ├─ summary_generation  → memory/summary (advisory Claude profile)
  │   ├─ storage_sync        → storage/sync → S3
  │   └─ notification_retry  → outbound chunk retry
  ├─ on success → outbound_notifications (job_completed)
  └─ on failure → outbound_notifications (job_failed) or re-queue if safe_retry
```

Concurrency invariants:

- At most **one** `provider_run` job is `running` at a time
  (`src/queue/worker.ts`, DEC-001).
- `storage_sync` and `notification_retry` run independently; their
  failures never roll back a `provider_run` success.

### Outbound delivery

```
outbound_notifications (status=pending)
  └─ chunked into outbound_notification_chunks
       └─ telegram/outbound sendMessage per chunk (in order)
            ├─ chunk → sent
            └─ chunk → failed → notification_retry job picks it up
```

`status = sent` is terminal; the `notification_retry` handler never
re-sends a sent notification. Retry reconstruction is ledger-driven:
stored `outbound_notifications.payload_text` is the source of truth,
with a legacy `job_completed` fallback to the assistant turn plus the
job footer. If legacy text cannot be reconstructed, remaining retryable
chunks are terminalized as failed instead of being rescheduled forever.

### Storage capacity

`src/storage/capacity.ts` evaluates `ACTWYN_OBJECTS_PATH` usage and
filesystem free space against `config/runtime.json#storage_capacity`
(DEC-018). `/status` and `/doctor` surface warnings. Above the hard
threshold, new `long_term` attachment promotions are blocked; caption
save intent is downgraded to `session` retention with an instant
Telegram explanation. Summary jobs still write memory JSONL / Markdown,
but skip the S3-backed `memory_snapshot` row while the hard threshold is
active. Degraded capacity reduces `storage_sync` upload batch size.

### Storage (attachment lifecycle)

```
inbound attachment
  └─ Phase 1 (synchronous, in inbound txn):
       storage_objects (capture_status=pending, status=pending,
                        retention_class=session, source_channel=telegram)
       + provider_run job (no separate storage_capture job)
  └─ Phase 2 (in-process, run by the worker before the AI subprocess):
       runCapturePass(jobId) → captureOne(...) downloads bytes,
       runs MIME probe, sets capture_status=captured +
       sha256/size_bytes via commitCaptureSuccess; on S3-eligible
       retention class, inserts a storage_sync job
       (idempotency_key='sync:' || storage_object_id)
  └─ Phase 3 (async):
       storage/sync uploads to S3, advances status to uploaded
```

`/save_last_attachment` (or natural-language equivalents) is what
promotes a `session` attachment to `long_term`.

DEC-018 local artifact capacity is enforced from
`src/storage/capacity.ts` using `config/runtime.json#storage_capacity`
thresholds. `/status` and `/doctor` surface the current capacity
level. `degraded` / `critical` levels reduce `storage_sync` upload
batch size; `critical` blocks new `long_term` promotion through
`/save_last_attachment`, save-intent attachment captions, and memory
snapshot S3 staging. Incoming attachments still land as `session`
rows so the conversation path keeps moving.

### Failure modes (current)

| Failure                          | Behavior                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------- |
| Provider subprocess crash        | `provider_runs.status=failed`; worker may re-queue under `replay_mode` if safe_retry.  |
| Resume failed mid-run            | Same `jobs` row flips back to `queued` with `replay_mode` (HLD §6.2).                  |
| DB busy (WAL contention)         | `BEGIN IMMEDIATE` retried by Bun SQLite busy_timeout; long contention surfaces in events. |
| S3 unavailable                   | `storage_objects.status` cycles `pending → failed → pending`; never blocks the worker. |
| Artifact cache capacity pressure | `/status` / `/doctor` warn; hard threshold blocks new `long_term` writes and degrades save-intent attachments to `session`. |
| Notification send failure        | Per-chunk `failed` row picked up by a `notification_retry` job (worker-dispatched); sent chunks not resent. |
| Local artifact capacity pressure | `/status` / `/doctor` warn from DEC-018 thresholds; critical pressure blocks new `long_term` writes while keeping new attachments as `session`. |
| Process restart                  | `startup/recovery` reconciles: `running → interrupted`, `safe_retry` → `queued`, kills orphan PIDs. |
| Missing required env             | `loadConfig()` throws `ConfigError` and the process exits 1 before opening the DB.     |
| Unauthorized inbound             | `telegram_updates.status=skipped`, `skip_reason` recorded, no job created.             |

## Judgment System: current state and runtime boundary

The Judgment System has local schema/repository/tool-contract
substrate under `src/judgment/*`, but runtime access is intentionally
limited. Provider context is assembled through `src/context/compiler.ts`
and packed through `src/context/packer.ts`. The write path
(propose → approve → link → commit) and retirement path are exposed
only through worker-dispatched Telegram system commands, not provider
tools or background workers.

Runtime access:

- `src/judgment/control_gate.ts` — imported by `src/queue/worker.ts`
  for telemetry. `evaluateTurn` + `recordControlGateDecision` run
  before non-system `provider_run` jobs, not `summary_generation`.
  `job_id` attribution is present in schema version 6. Signal
  detection is still deferred; current worker telemetry records L0.
- `src/judgment/tool.ts` — executors imported by `src/queue/worker.ts`
  for Judgment Telegram commands:
  `/judgment`, `/judgment_explain`, `/judgment_propose`,
  `/judgment_approve`, `/judgment_reject`, `/judgment_source`,
  `/judgment_link`, `/judgment_commit`, `/judgment_supersede`,
  `/judgment_revoke`, and `/judgment_expire`. Output is sent through
  outbound notifications and is not stored as conversation turns.
- `src/context/builder.ts` — gains `judgment_items` slot type
  (priority 790, above memory recall). `src/queue/worker.ts` populates it with
  active/eligible/normal/global/time-valid rows in `replay_mode`
  full context builds and in the `resume_mode` judgment refresh path;
  it is excluded from `summary_generation`.
- `src/providers/*`, `src/memory/*`, `src/telegram/*`,
  `src/commands/*`, and `src/main.ts` do **not** import from
  `src/judgment/`.

Schema version is **6** (migration 005 adds `control_gate_events`; migration 006 adds
`job_id` attribution and a pre-migration upgrade guard — see `src/main.ts`
`assertNoPendingProviderRunsBeforeMigration006()`).

ADR-0017 / DEC-039 first runtime slice is implemented: provenance
gates are split into memory persistence vs Judgment proposal helpers;
summary output stays in `memory_summaries` and does not create active
`memory_items`; active/eligible judgments outrank memory recall in
context packing.

### What is not implemented

The following are not implemented. Do not wire any of these until
a task explicitly authorizes a further Judgment runtime slice.

- Automatic extraction of candidate `JudgmentItem` rows from provider
  or summary output.
- Provider tool registration for any Judgment write path.
- `current_operating_view` and `current_operating_view`-sourced Compiler input
  (`src/context/compiler.ts` is now wired; `builder.ts` remains in tree for regression parity).
- Destructive migration or physical merge of existing `memory_items`
  into `judgment_items`.
- Runtime readers for `judgment_edges`.
- `Tension` telemetry and the `tensions` table: **not implemented**.
- `ReflectionTriageEvent` and `reflection_triage_events`: **not implemented**.
- Vector and graph derived projections: **not implemented**.

The 6-stage pipeline in `docs/JUDGMENT_SYSTEM.md` remains the
architectural authority for the Judgment System direction
(ADR-0009 … ADR-0013, DEC-037). Until a task explicitly
authorizes a further Judgment runtime slice, do not wire these
surfaces into provider tools, background workers, or additional
runtime paths.

## Failure / debug path (current)

Use these in roughly this order when something goes wrong:

1. **Process** — `journalctl -u actwyn -f` (prod) or stderr in dev.
   Boot crashes log a `boot.crash` JSON line and exit 1.
2. **`/doctor`** — typed system smoke test (config, schema version,
   redaction self-test, S3 ping, Telegram ping, Claude version).
3. **DB** — open `/var/lib/actwyn/actwyn.db` with `sqlite3` and
   inspect the relevant ledger:
   - inbound: `telegram_updates`
   - jobs: `jobs`, `provider_runs`, `provider_raw_events`, `turns`
   - notifications: `outbound_notifications`, `outbound_notification_chunks`
   - storage: `storage_objects`
4. **Storage** — `/var/lib/actwyn/objects/` for local bytes; S3
   bucket for uploaded objects.
5. **Tests** — replicate locally with `bun test <path>` (see
   `docs/TESTING.md`).
6. **Recovery** — restart the service; `runStartupRecovery` makes the
   ledger consistent and emits a `boot.recovery` event with counts.

For environments and run paths, see `docs/OPERATIONS.md`.
