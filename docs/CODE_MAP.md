# Code Map

> Status: thin current-state map · Owner: project lead ·
> Last updated: 2026-04-26
>
> This file maps the actual files in `src/`, `test/`, `migrations/`,
> `scripts/`, `config/`, and `deploy/`. It is meant to be skimmed by
> AI coding agents before they edit code, so they touch the right
> module.

Status legend:

- `implemented` — present in `main`, exercised by tests.
- `planned` — referenced by design docs but not present in code.
- `salvage:KEEP|ADAPT|ADAPT-light|REPLACE` — classification from
  the 2026-04 implementation salvage audit
  (`docs/design/salvage-audit-2026-04.md`). Indicates the module's
  fate under the DB-native Judgment System direction. KEEP = stays
  as-is; ADAPT = behavior preserved, surface or call-site changes
  expected; ADAPT-light = invariant preserved, only adjacent gate
  semantics shift; REPLACE = surface contract incompatible with
  the new model. Do not start the salvage refactors without the
  follow-up PR sequence in §6 of the audit.
- `possibly stale` — implemented but superseded by a newer module;
  flagged for cleanup. (None currently flagged.)

## Entry points

| Path                              | Purpose                                                                 |
| --------------------------------- | ----------------------------------------------------------------------- |
| `src/main.ts`                     | systemd entrypoint and composition root. Wires real transports.        |
| `package.json`                    | Bun scripts (`test`, `typecheck`, `lint:redactor`, `ci`).              |
| `bunfig.toml`                     | Bun runtime config.                                                     |
| `.bun-version`                    | Pinned Bun version.                                                     |
| `tsconfig.json`                   | TypeScript compiler config (`~/*` path alias to `src/*`).               |
| `config/runtime.json`             | Tunables (Bun version, log level, redaction config, claude binary).    |
| `.env.example`                    | Required env surface for runtime.                                       |

## Runtime / Telegram

| Path                                     | Purpose                                                                          |
| ---------------------------------------- | -------------------------------------------------------------------------------- |
| `src/telegram/poller.ts`                 | Long-poll loop against Telegram Bot API; advances the offset stored in `settings['telegram.next_offset']`. |
| `src/telegram/inbound.ts`                | Classifies updates (text / command / attachment / unauthorized) and enqueues.    |
| `src/telegram/outbound.ts`               | `sendMessage` executor; drives `outbound_notifications` + chunk states.          |
| `src/telegram/bot_api.ts`                | Telegram Bot API HTTP transport (no framework dependency).                       |
| `src/telegram/attachment_capture.ts`     | Phase-2 attachment download + MIME probe.                                        |
| `src/telegram/attachment_metadata.ts`    | Phase-1 attachment metadata persistence.                                         |
| `src/telegram/types.ts`                  | Shared Telegram update type aliases.                                             |

## Providers

| Path                              | Purpose                                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------------------- |
| `src/providers/claude.ts`         | Claude Code CLI adapter; spawns subprocess, parses stream-json, manages resume/replay.       |
| `src/providers/fake.ts`           | Deterministic fake provider used by tests.                                                  |
| `src/providers/stream_json.ts`    | stream-json line parser + final-text normalization.                                          |
| `src/providers/subprocess.ts`     | Subprocess spawn / lifetime helpers (process group, abort).                                  |
| `src/providers/types.ts`          | Provider-facing request / response / event type aliases.                                     |

## Database / storage

| Path                              | Purpose                                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------------------- |
| `src/db.ts`                       | SQLite handle factory (WAL, busy_timeout, FK pragmas).                                       |
| `src/db/migrator.ts`              | Forward-only migration runner (records applied versions in `settings`).                      |
| `migrations/001_init.sql`         | Base tables: `allowed_users`, `settings`, `telegram_updates`, `sessions`, `jobs`, `provider_runs`, `provider_raw_events`, `turns`, `outbound_notifications`, `outbound_notification_chunks`, `memory_summaries`, `memory_items`. |
| `migrations/002_artifacts.sql`    | `storage_objects`, `memory_artifact_links`.                                                  |
| `migrations/003_notification_payload_text.sql` | Adds `payload_text` to `outbound_notifications`.                              |
| `src/storage/local.ts`            | Local FS reads / writes for objects and transcripts.                                         |
| `src/storage/s3.ts`               | Hetzner Object Storage transport (Bun.S3Client based).                                       |
| `src/storage/sync.ts`             | `storage_sync` worker; advances `storage_objects.status`.                                    |
| `src/storage/objects.ts`          | DB-row builders / readers for `storage_objects`.                                             |
| `src/storage/mime.ts`             | Magic-bytes MIME probe used during attachment capture.                                       |

## Memory / context

| Path                              | Purpose                                                                                     | Status                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `src/memory/summary.ts`           | `/summary` and `/end` summary generation; provenance + confidence per PRD §12.2.            | implemented · salvage:ADAPT (auto-promotion of fact / decision / open_task / caution → `memory_items.status='active'` re-injects via worker; Q-027) |
| `src/memory/items.ts`             | Atomic `memory_items` rows with supersede semantics.                                        | implemented · salvage:ADAPT-light (writer invariants KEEP; insert path only gates `preference` provenance — baseline-eligibility moves to judgment layer per Q-027) |
| `src/memory/provenance.ts`        | Provenance / confidence helpers shared by summary + items.                                  | implemented · salvage:ADAPT (`Provenance` enum KEEP; `mayPromoteToLongTerm` semantics must split — `mayPersistAsMemoryItem` / `mayBecomeBehaviorBaseline` / `mayProposeJudgment`) |
| `src/context/builder.ts`          | Assembles prompt inputs (resume vs replay decision, recent turns, memory snapshot).         | implemented · salvage:REPLACE (slot taxonomy + `MemoryItemSlot.provenance` / `.status` input incompatible with `current_operating_view` / `lifecycle_status` / `activation_state` — superseded by Stage 4 Context Compiler) |
| `src/context/packer.ts`           | Token-budget aware packer per PRD §12.5–§12.6.                                              | implemented · salvage:ADAPT (drop-by-priority + `injected_snapshot_json` shape KEEP; input type re-defined to Compiler output) |
| `src/context/token_estimator.ts`  | CJK-safer token estimator (DEC-021).                                                        | implemented · salvage:KEEP                   |

The Judgment System (`JudgmentItem`, Control Gate, Tension,
ReflectionTriageEvent, `current_operating_view`, vector / graph
projections) is **planned** under ADR-0009 … ADR-0013 and
`docs/JUDGMENT_SYSTEM.md` (Phase 0 / 0.5 architectural design
record per DEC-037). It has no module in `src/` yet. See
`docs/DATA_MODEL.md` and `docs/RUNTIME.md`.

## Queue / orchestration

| Path                                  | Purpose                                                                              | Status                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------- |
| `src/queue/worker.ts`                 | Single job claim + dispatch loop; one `provider_run` at a time. Also runs the in-process attachment capture pre-step before each `provider_run`. | implemented · salvage:ADAPT (`buildContextForRun` reads `memory_items WHERE status='active'` / `memory_summaries` (latest) / `turns` and calls `buildContext` / `pack` directly — retrieval / packing responsibility moves to Stage 4 Compiler. JSONL / MD sidecar pending §5.3 of audit) |
| `src/queue/notification_retry.ts`     | Handlers / helpers used by the worker to process `notification_retry` jobs (per-chunk re-send of `outbound_notification_chunks`). Not a separate loop. | implemented · salvage:KEEP |
| `src/startup/recovery.ts`             | Boot-time reconciliation of stale `running` jobs (force `interrupted`, requeue if `safe_retry`, kill orphan PIDs); offset fast-forward; enqueues one `storage_sync` job for `failed` / `delete_failed` rows only (not for `pending`). | implemented · salvage:KEEP |

## Observability

| Path                              | Purpose                                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------------------- |
| `src/observability/events.ts`     | Structured event emitter (level + name + JSON payload to stderr).                           |
| `src/observability/redact.ts`     | The single redactor; only module allowed to define redaction patterns (HLD §13.1).          |

## Commands

| Path                                  | Purpose                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------ |
| `src/commands/cancel.ts`              | `/cancel` — stop running or queued job.                                              |
| `src/commands/correct.ts`             | `/correct <id>` and natural-language "정정:" corrections.                            |
| `src/commands/doctor.ts`              | `/doctor` — typed system smoke-test output.                                          |
| `src/commands/forget.ts`              | `/forget_last`, `/forget_session`, `/forget_artifact`, `/forget_memory`.             |
| `src/commands/provider.ts`            | `/provider` — provider switch (P0: only `claude`).                                   |
| `src/commands/save.ts`                | `/save_last_attachment` and natural-language "저장해줘" promotion.                   |
| `src/commands/status.ts`              | `/status` — typed queue / job status output (DEC-015).                               |
| `src/commands/summary.ts`             | `/summary` and `/end` triggers.                                                      |
| `src/commands/whoami.ts`              | `/whoami` and `BOOTSTRAP_WHOAMI` flow (DEC-009).                                     |

## Scripts

| Path                                       | Purpose                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------ |
| `scripts/check-single-redactor.ts`         | Lint that enforces the single-redactor invariant (HLD §13.1).                        |

## Deploy

| Path                                       | Purpose                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------ |
| `deploy/install.sh`                        | Idempotent installer (creates service user, dirs, env file placeholder).             |
| `deploy/systemd/actwyn.service`            | systemd unit file (Type=simple, KillMode=control-group, hardening directives).       |
| `deploy/systemd/README.md`                 | Install / enable / uninstall instructions for the unit.                              |

## Tests

| Path                                              | Purpose                                                                          |
| ------------------------------------------------- | -------------------------------------------------------------------------------- |
| `test/commands/*.test.ts`                         | Per-command happy / error path coverage.                                         |
| `test/config.test.ts`                             | Config loader — required env, runtime.json validation.                           |
| `test/context/packer.test.ts`                     | Context packer drop-order + token budget.                                        |
| `test/context/token_estimator.test.ts`            | CJK-safer token estimator behavior (DEC-021).                                    |
| `test/db/invariants.test.ts`                      | Cross-table invariants from HLD §5.2.                                            |
| `test/db/schema.test.ts`                          | Schema / migration shape assertions.                                             |
| `test/events.test.ts`                             | Event emitter contract.                                                          |
| `test/memory/correction.test.ts`                  | Memory correction supersede semantics (AC-MEM-004).                              |
| `test/memory/summary.test.ts`                     | Summary generation + provenance (AC-MEM-002).                                    |
| `test/notifications/*.test.ts`                    | Notification chunking, ledger, retry state machine, worker wiring (AC-NOTIF-*). |
| `test/providers/*.test.ts`                        | Claude adapter, fake provider, stream-json parser, subprocess lifecycle.         |
| `test/queue/*.test.ts`                            | Job claim atomicity, attachment capture, queue state machine.                    |
| `test/redaction.test.ts`                          | Redaction pattern coverage (DEC-010, AC-SEC-001).                                |
| `test/single-redactor.test.ts`                    | Asserts the single-redactor lint catches violations.                             |
| `test/startup/recovery.test.ts`                   | Boot-time reconciliation behavior (AC-JOB-002).                                  |
| `test/storage/roundtrip.test.ts`                  | Local + S3 roundtrip.                                                            |
| `test/storage/state_machine.test.ts`              | `storage_objects.status` transitions.                                            |
| `test/telegram/*.test.ts`                         | Telegram inbound classifier, poller offset durability, attachment metadata.      |

## Stale / superseded

None currently flagged. The 2026-04 salvage audit
(`docs/design/salvage-audit-2026-04.md`) classified the surviving
modules as KEEP / ADAPT / ADAPT-light / REPLACE and identified
**no DELETE candidates**. `src/context/builder.ts` is the only
REPLACE candidate; it stays in tree until the Stage 4 Context
Compiler PR (audit §6 step 9) marks it `possibly stale` and a
follow-up PR removes it.
