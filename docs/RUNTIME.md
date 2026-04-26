# Runtime Flow

> Status: thin current-state map · Owner: project lead ·
> Last updated: 2026-04-27
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
4. `runStartupRecovery(db, …)` — reconciles `running` jobs and
   pending storage objects (`src/startup/recovery.ts`).
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

`status = sent` is terminal; the retry loop never re-sends a sent
notification.

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
| Notification send failure        | Per-chunk `failed` row picked up by `notification_retry` loop; sent chunks not resent. |
| Process restart                  | `startup/recovery` reconciles: `running → interrupted`, `safe_retry` → `queued`, kills orphan PIDs. |
| Missing required env             | `loadConfig()` throws `ConfigError` and the process exits 1 before opening the DB.     |
| Unauthorized inbound             | `telegram_updates.status=skipped`, `skip_reason` recorded, no job created.             |

## Planned Judgment System flow (not implemented)

These steps are **planned** under the DB-native AI-first Judgment
System direction (ADR-0009 … ADR-0013, `docs/JUDGMENT_SYSTEM.md`
§6-stage pipeline). The architectural commitment is on `main`;
**none of these steps run in code today**. The numbering here
follows the 6-stage pipeline in `docs/JUDGMENT_SYSTEM.md`.

1. **Event Ledger (Stage 1)** — append-only, redacted,
   source-preserving record of inbound turns, files, provider
   outputs, metrics. Builds on the existing `telegram_updates` /
   `turns` ledgers.
2. **Extraction / Proposal (Stage 2)** — AI proposes candidate
   `JudgmentItem` rows; not yet truth.
3. **Judgment Store (Stage 3)** — source-grounded, typed, scoped,
   temporal, supersedable judgments persisted in `judgment_*`
   tables.
4. **Projections** — `current_operating_view` (DEC-036), FTS5
   index, and (deferred) vector / graph projections feed retrieval.
   Projections are derived; the DB remains canonical.
5. **Context Compiler (Stage 4)** — assemble per-task
   `current_operating_view` + constraints + evidence + negatives
   under a token budget. Replaces the current
   `src/context/builder.ts` + `src/context/packer.ts` shape for
   judgment-driven prompts.
6. **Agent Runtime (Stage 5)** — same Claude subprocess wiring as
   today, but prompt inputs come from the compiled judgment view.
7. **Feedback / Reflection (Stage 6)** — execution result and
   failure feed back into the ledger and `judgment_events`.
   Reflection produces `reflection_triage_events`.

Cross-cutting, control-plane:

- **Control Gate** decisions land in `control_gate_events` /
  `control_plane_events` (table name itself is open per
  `docs/JUDGMENT_SYSTEM.md` §Implementation Readiness).
- **`Tension`** telemetry is recorded when contradictions or
  missing authority sources are detected (ADR-0013 §Tension
  Generalization).
- **Critique Lens v0.1** is manual L2 / L3 invocation only in
  Phase 1A (DEC-031, ADR-0013).

Until Phase 1A migrations and code ship, agents must treat the
above as **documentation only**:

- Do not implement these steps.
- Do not invoke or seed the planned tables in tests.
- Do not change the implemented runtime above to anticipate them.

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
