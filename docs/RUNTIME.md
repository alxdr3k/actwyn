# Runtime Flow

> Status: thin current-state map · Owner: project lead ·
> Last updated: 2026-04-26
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
   shared cancel-handle map.
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
  │   │     └─ spawn detached, parse stream-json, persist turns + raw events
  │   │     └─ resume_mode then optional replay_mode fallback
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
re-sends a sent notification.

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

### Failure modes (current)

| Failure                          | Behavior                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------- |
| Provider subprocess crash        | `provider_runs.status=failed`; worker may re-queue under `replay_mode` if safe_retry.  |
| Resume failed mid-run            | Same `jobs` row flips back to `queued` with `replay_mode` (HLD §6.2).                  |
| DB busy (WAL contention)         | `BEGIN IMMEDIATE` retried by Bun SQLite busy_timeout; long contention surfaces in events. |
| S3 unavailable                   | `storage_objects.status` cycles `pending → failed → pending`; never blocks the worker. |
| Notification send failure        | Per-chunk `failed` row picked up by a `notification_retry` job (worker-dispatched); sent chunks not resent. |
| Process restart                  | `startup/recovery` reconciles: `running → interrupted`, `safe_retry` → `queued`, kills orphan PIDs. |
| Missing required env             | `loadConfig()` throws `ConfigError` and the process exits 1 before opening the DB.     |
| Unauthorized inbound             | `telegram_updates.status=skipped`, `skip_reason` recorded, no job created.             |

## Judgment System: current state and runtime boundary

Phase 1A.1 (schema skeleton + types + validators), Phase 1A.2
(proposal-only write surface), and Phase 1A.3 (proposal review
local surface) have landed on `main`. **Runtime request handling
is unchanged.** The implemented runtime stages above — Telegram
inbound, `provider_run`, `summary_generation`, `storage_sync`,
`notification_retry`, and outbound delivery — do not call any
judgment tool. Provider context still uses the existing
`src/context/builder.ts` + `src/context/packer.ts` memory
implementation.

### What is implemented

**Phase 1A.1** — judgment schema skeleton:

- `migrations/004_judgment_skeleton.sql` — 5 tables + FTS5
  virtual table: `judgment_sources`, `judgment_items`,
  `judgment_evidence_links`, `judgment_edges`, `judgment_events`,
  `judgment_items_fts`.
- `src/judgment/types.ts` — typed enumerations and interfaces.
- `src/judgment/validators.ts` — input validators.

**Phase 1A.2** — proposal-only write surface:

- `src/judgment/repository.ts` (`proposeJudgment`) — writes
  `judgment_items` and `judgment_events` in a single transaction,
  forced to `lifecycle_status=proposed` / `approval_state=pending`
  / `activation_state=history_only`. Appends `judgment.proposed`
  events.
- `src/judgment/tool.ts` (`JUDGMENT_PROPOSE_TOOL`,
  `executeJudgmentProposeTool`) — local unregistered typed-tool
  contract.

**Phase 1A.3** — proposal review local surface:

- `src/judgment/repository.ts` (`approveProposedJudgment`,
  `rejectProposedJudgment`) — approve sets `approval_state=approved`
  but does **not** activate (`lifecycle_status` stays `proposed`,
  `activation_state` stays `history_only`). Reject sets
  `approval_state=rejected` / `lifecycle_status=rejected` /
  `activation_state=excluded`. Both write one `judgment_events`
  row in the same transaction.
- `src/judgment/tool.ts` (`JUDGMENT_APPROVE_TOOL`,
  `executeJudgmentApproveTool`, `JUDGMENT_REJECT_TOOL`,
  `executeJudgmentRejectTool`) — local unregistered typed-tool
  contracts.

The proposal and review surfaces can be exercised by tests or
direct local code. They are **not** exposed to providers, Telegram,
commands, worker dispatch, or context building:

- `judgment.propose`, `judgment.approve`, `judgment.reject` are
  not registered in `src/main.ts` or any runtime module.
- `src/providers/*`, `src/context/*`, `src/queue/worker.ts`,
  `src/memory/*`, `src/telegram/*`, and `src/commands/*` do not
  import from `src/judgment/`.

Schema version remains **4**.

### What is not implemented

The following are not implemented. Do not wire any of these until
a task explicitly authorizes a further Judgment runtime slice.

**Stage 2** — automatic AI extraction of candidate `JudgmentItem`
rows from provider output: **not implemented**.

**Stage 3** — Judgment Store lifecycle:

- A partial persistence substrate exists: schema, FTS5 index,
  proposal + review writers, and `judgment.proposed` /
  `judgment.approved` / `judgment.rejected` events.
- Not implemented: activation workflow, `commit`, `supersede`,
  `revoke`, `expire`, `query`, `explain`, and evidence-linking
  workflow. `judgment_sources`, `judgment_evidence_links`, and
  `judgment_edges` have no runtime writer.

**Stage 4** — Context Compiler: `current_operating_view`
projection (DEC-036) and the Stage 4 Context Compiler that would
replace `src/context/builder.ts` + `src/context/packer.ts` are
**not implemented**.

**Stage 5** — judgment-driven agent runtime: **not implemented**.

**Stage 6** — feedback / reflection loop: **not implemented**.

**Cross-cutting control-plane** (all unimplemented):

- Control Gate evaluators and `control_gate_events` /
  `control_plane_events` ledger.
- `Tension` telemetry and the `tensions` table.
- `ReflectionTriageEvent` and `reflection_triage_events`.
- Vector and graph derived projections.
- Memory promotion integration.
- Telegram command integration for judgment operations.

The 6-stage pipeline in `docs/JUDGMENT_SYSTEM.md` remains the
architectural authority for the Judgment System direction
(ADR-0009 … ADR-0013, DEC-037). Until a task explicitly
authorizes a further Judgment runtime slice, do not wire the
existing proposal or review surfaces into any runtime path.

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
