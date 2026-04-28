# Code Map

> Status: thin current-state map · Owner: project lead ·
> Last updated: 2026-04-28
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
| `src/config.ts`                   | Typed config loader: reads env vars + `config/runtime.json`; fails fast on missing required fields. |
| `package.json`                    | Bun scripts (`dev`, `test`, `typecheck`, `lint:redactor`, `ci`, `docs:generate:schema`). `dev` runs `doppler run -- bun run src/main.ts`. |
| `doppler.yaml`                    | Doppler project/config pin (`actwyn` / `dev`) for local development secret injection. |
| `bunfig.toml`                     | Bun runtime config.                                                     |
| `.bun-version`                    | Pinned Bun version.                                                     |
| `tsconfig.json`                   | TypeScript compiler config (`~/*` path alias to `src/*`).               |
| `config/runtime.json`             | Tunables (Bun version, log level, redaction config). Optional `claude_binary` field overrides the default `claude` PATH lookup; do not commit machine-local paths. |
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
| `migrations/004_judgment_skeleton.sql` | Phase 1A.1 schema-only Judgment System skeleton: `judgment_sources`, `judgment_items`, `judgment_evidence_links`, `judgment_edges`, `judgment_events`, plus the `judgment_items_fts` FTS5 virtual table and sync triggers. |
| `migrations/005_control_gate_events.sql` | Phase 1A.8 append-only Control Gate ledger: `control_gate_events` table with CHECK constraints (level L0–L3, phase, budget_class, persist_policy, direct_commit_allowed=0), BEFORE UPDATE/DELETE/INSERT triggers enforcing immutability (including INSERT OR REPLACE block). |
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
projections) is architecturally committed under ADR-0009 … ADR-0013
and `docs/JUDGMENT_SYSTEM.md`. Phase 1A slices and Phase 1B.1–1B.3
runtime wiring have landed:

- **Phase 1A.1–1A.8**: schema skeleton, proposal/review/source/evidence/commit/retirement
  repositories, query/explain read surfaces, typed-tool contracts, Control Gate evaluator +
  `control_gate_events` migration. All Phase 1A surfaces are local and unregistered.
- **Phase 1B.1**: `src/judgment/control_gate.ts` now imported by `src/queue/worker.ts`.
  `evaluateTurn()` + `recordControlGateDecision()` called per non-system `provider_run` (not
  `summary_generation`). L0-only telemetry; signal detection deferred.
- **Phase 1B.2**: `src/context/builder.ts` gains `judgment_items` slot (priority 600).
  Worker queries active/eligible/normal/global/time-valid judgments and injects them
  into `buildContext()` in `replay_mode`. Excluded from `summary_generation`.
- **Phase 1B.3**: `/judgment` and `/judgment_explain <id>` Telegram commands added to
  `KNOWN_COMMANDS` (inbound) and `SYSTEM_COMMANDS` (worker). `executeJudgmentQueryTool`
  + `executeJudgmentExplainTool` from `src/judgment/tool.ts` imported by worker for
  these commands only. Command output not stored as turns.

Pending: Context Compiler, Telegram write commands (propose/approve/commit), resume-mode
judgment refresh (#44), `control_gate_events` `job_id` attribution (#45).
See `docs/RUNTIME.md` for the full runtime boundary description.

## Judgment (Phase 1B.3 — schema + repositories + typed-tool contracts + Control Gate + runtime wiring)

| Path                                  | Purpose                                                                              | Status                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `src/judgment/types.ts`               | `as const` literal arrays + union types for the P0.5 enum surfaces (`kind`, `epistemic_origin`, `authority_source`, `approval_state`, `lifecycle_status`, `activation_state`, `retention_state`, `confidence`, `decay_policy`, `procedure_subtype`, `trust_level`) plus `ONTOLOGY_VERSION` / `SCHEMA_VERSION` defaults (DEC-028). Pure TS, no `Bun` / `bun:*` import (ADR-0014). | implemented (Phase 1A.1 — not runtime-integrated)                     |
| `src/judgment/validators.ts`          | Pure-TS type guards over the literal arrays in `types.ts`, plus `validateStatement` / `validateScopeJson` / `validateScopeObject` / `validateKind` / `validateEpistemicOrigin` / `validateImportance` / `validateConfidenceLabel` / `validateStringArray` / `validateJsonValue` / `validateNonEmptyString` / `validatePlainJsonObject` / `validateTrustLevel` / `validateOptionalNonEmptyString`, and Phase 1A.6 query/explain input helpers (`validateBoolean`, enum-array helpers, pagination/order helpers, `validateScopeContains`) returning a tagged result. | implemented (Phase 1A.1/1A.2/1A.3/1A.4/1A.6 — not runtime-integrated)                     |
| `src/judgment/repository.ts`          | Proposal + proposal review + source recording + evidence linking + commit/activation + retirement lifecycle transitions, plus read-only query/explain surfaces: `proposeJudgment`, `approveProposedJudgment`, `rejectProposedJudgment`, `recordJudgmentSource`, `linkJudgmentEvidence`, `commitApprovedJudgment`, `supersedeJudgment`, `revokeJudgment`, `expireJudgment`, `queryJudgments`, `explainJudgment`. Write paths use `BEGIN IMMEDIATE` transactions. Query/explain read local judgment rows, FTS hits, evidence, sources, and lifecycle events without mutating tables or appending events. Active/eligible rows read by worker context injection (Phase 1B.2) and Telegram commands (Phase 1B.3). | implemented (Phase 1A.2–1A.7 + Phase 1B.2/1B.3 runtime read)                     |
| `src/judgment/tool.ts`                | Typed-tool contracts (constants + `execute*` functions) for propose/approve/reject/record_source/link_evidence/commit/query/explain/supersede/revoke/expire. Write-path contracts not registered in runtime. `executeJudgmentQueryTool` + `executeJudgmentExplainTool` imported by `src/queue/worker.ts` for `/judgment` + `/judgment_explain` commands (Phase 1B.3). | implemented (Phase 1A.2–1A.7; query+explain runtime-wired in Phase 1B.3)                     |
| `src/judgment/control_gate.ts`        | Control Gate evaluator: `ProbeLevel`, `ProbeType`, `LensId`, `TriggerCode`, `ControlGateDecision` types; `evaluateTurn(input, turnId?)` → L0/L1/L3 decision; `evaluateCandidate(candidate)` → L0/L1/L2/L3 decision; `recordControlGateDecision(db, decision)` → persists to `control_gate_events`. `direct_commit_allowed` is always false (ADR-0012 invariant). Imported by `src/queue/worker.ts` (Phase 1B.1). | implemented (Phase 1A.8 + Phase 1B.1 runtime-wired)                     |

## Queue / orchestration

| Path                                  | Purpose                                                                              | Status                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------- |
| `src/queue/worker.ts`                 | Single job claim + dispatch loop; one `provider_run` at a time. Also: attachment capture pre-step, Control Gate evaluation (Phase 1B.1), active judgment context injection (Phase 1B.2), `/judgment` + `/judgment_explain` Telegram command dispatch (Phase 1B.3). | implemented · salvage:ADAPT (`buildContextForRun` reads `memory_items` / `memory_summaries` / `turns` / `judgment_items` and calls `buildContext` / `pack` directly — retrieval / packing responsibility moves to Stage 4 Compiler) |
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

**Phase 1B.3 inline commands (dispatched directly in `src/queue/worker.ts`):**

| Command | Purpose |
| ------- | ------- |
| `/judgment` | List active/eligible/valid judgments. Applies same temporal validity filter as context injection. |
| `/judgment_explain <id>` | Show detail (kind, status, sources, evidence links, events) for one judgment row. |

## Scripts

| Path                                       | Purpose                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------ |
| `scripts/check-single-redactor.ts`         | Lint that enforces the single-redactor invariant (HLD §13.1).                        |
| `scripts/generate-schema-doc.ts`           | Generates `docs/generated/schema.md` from migration SQL files. Run via `bun run docs:generate:schema` after any migration change. |

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
| `test/db/judgment_schema.test.ts`                 | Judgment schema CHECK / NOT NULL / JSON / FTS5 trigger coverage (Phase 1A.1).    |
| `test/db/control_gate_schema.test.ts`             | `control_gate_events` schema CHECK / NOT NULL / JSON / append-only trigger coverage (Phase 1A.8). |
| `test/events.test.ts`                             | Event emitter contract.                                                          |
| `test/judgment/validators.test.ts`                | Pure-TS validator type guards + field validator behavior including `validateNonEmptyString` / `validatePlainJsonObject` / `validateTrustLevel` / `validateOptionalNonEmptyString`, plus Phase 1A.6 query/explain helper validators for booleans, enum filters, pagination, ordering, and `scope_contains`. |
| `test/judgment/repository.test.ts`                | Proposal repository insert, defaults, validation rejections, FTS trigger, transaction rollback; approve/reject review transitions, event payloads, state guards, rollback; source recording insert, defaults, trimming, event, rollback; evidence linking insert, state guards, trimming, event, denormalized JSON arrays, rollback; commit success (state transition, event, evidence requirement, denormalized array sync), invalid state guards, malformed denormalized array element guards, validation rejections, transaction rollback; Phase 1A.6 read-only `queryJudgments` / `explainJudgment` filters, FTS query, scope filter, evidence/source/event explanation output, malformed persisted JSON handling, and no-mutation/no-event-append assertions; Phase 1A.7 supersede/revoke/expire state transitions, event payloads, JSON array updates, edge insertion, invalid state guards, rollback on event/edge failure, and query/explain integration checks after retirement. |
| `test/judgment/tool.test.ts`                      | Typed-tool contract constants, executor happy/error paths (including malformed array element errors returning `validation_error`), Phase 1A.6 `judgment.query` / `judgment.explain` contract coverage, read-only no-mutation/no-event-append checks, Phase 1A.7 `judgment.supersede` / `judgment.revoke` / `judgment.expire` executor happy/error paths and no-mutation checks, static boundary assertions for all eleven judgment tools; Phase 1B.3: worker is now allowed to import `executeJudgmentQueryTool` + `executeJudgmentExplainTool`. |
| `test/context/builder_judgments.test.ts`          | Phase 1B.2 — `judgment_active` slot injection, priority ordering (700→600→500), `skipJudgments` empty-array behavior, multi-item rendering. |
| `test/queue/control_gate_telemetry.test.ts`       | Phase 1B.1 — `control_gate_events` row inserted per non-system `provider_run`; excluded for system commands and `summary_generation`; L0 default; ADR-0012 `direct_commit_allowed=0` invariant. |
| `test/queue/judgment_commands.test.ts`            | Phase 1B.3 — `/judgment` and `/judgment_explain` command dispatch via worker; output delivered via notification (not turns); empty/not-found/valid responses. |
| `test/queue/judgment_context_injection.test.ts`   | Phase 1B.2 — global-scope injection in packed message, non-global/archived exclusion, temporal validity filter (future `valid_from`, past `valid_until`), `summary_generation` exclusion, judgment command turn exclusion (no turn created for `/judgment`/`/judgment_explain`). |
| `test/judgment/control_gate.test.ts`              | `evaluateTurn` L0/L1/L3 coverage, `evaluateCandidate` L0/L1/L2/L3 coverage, 6 eval fixtures from `docs/JUDGMENT_SYSTEM.md §Eval fixtures`, `recordControlGateDecision` persistence round-trip, and static import boundary check (Phase 1A.8). |
| `test/memory/correction.test.ts`                  | Memory correction supersede semantics (AC-MEM-004).                              |
| `test/memory/summary.test.ts`                     | Summary generation + provenance (AC-MEM-002).                                    |
| `test/notifications/*.test.ts`                    | Notification chunking, ledger, retry state machine, worker wiring (AC-NOTIF-*). |
| `test/providers/*.test.ts`                        | Claude adapter, fake provider, stream-json parser, subprocess lifecycle.         |
| `test/queue/*.test.ts`                            | Job claim atomicity, attachment capture, queue state machine.                    |
| `test/redaction.test.ts`                          | Redaction pattern coverage (DEC-010, AC-SEC-001).                                |
| `test/skills/*.test.ts`                           | Codex skill contract/static compatibility checks.                                |
| `test/single-redactor.test.ts`                    | Asserts the single-redactor lint catches violations.                             |
| `test/startup/recovery.test.ts`                   | Boot-time reconciliation behavior (AC-JOB-002).                                  |
| `test/storage/roundtrip.test.ts`                  | Local + S3 roundtrip.                                                            |
| `test/storage/state_machine.test.ts`              | `storage_objects.status` transitions.                                            |
| `test/telegram/*.test.ts`                         | Telegram inbound classifier, poller offset durability, attachment metadata.      |

## Stale / superseded

None currently flagged. The 2026-04 salvage audit
(`docs/design/salvage-audit-2026-04.md`) classified
`src/context/builder.ts` as the only REPLACE candidate. It
remains in tree until the Stage 4 Context Compiler path is
available. The removal timing — immediate deletion vs a
`possibly stale` soak period — is an open follow-up decision
recorded in audit §7.
