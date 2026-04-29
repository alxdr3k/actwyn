# Personal Agent P0 — Implementation Plan

> Status: living roadmap/status ledger + historical P0 build plan ·
> Owner: project lead · Last updated: 2026-04-29
>
> This file owns the canonical roadmap/status ledger for milestone,
> track, phase, slice, gate, status, evidence, and next work. The
> original P0 build plan remains below as the historical build-order
> contract. If the ledger and a historical phase section disagree
> about current status, the ledger wins.
>
> Rules:
>
> 1. Roadmap / phase / slice inventory lives here, not in
>    `docs/context/current-state.md` or thin current-state docs.
> 2. A slice can be `landed` while its acceptance or staging gate is
>    still `not_run`.
> 3. Evidence is linked by source anchor (path, test, Q, DEC, ADR,
>    AC, issue, commit when known) instead of copying implementation
>    detail into this ledger.

## Current roadmap / status ledger

This section adapts the boilerplate roadmap/status taxonomy without
moving the existing thin docs into `docs/current/`. In actwyn, the
thin current-state docs remain at the top of `docs/`
(`ARCHITECTURE.md`, `CODE_MAP.md`, `DATA_MODEL.md`, `RUNTIME.md`,
`TESTING.md`, `OPERATIONS.md`). This file owns roadmap/status; those
docs own fast navigation for implemented behavior.

### Taxonomy

| Term | Meaning | Example ID | Notes |
| ---- | ------- | ---------- | ----- |
| Milestone | Product / user-facing delivery gate | `P0-M5` | Defined by what the user or operator can rely on. |
| Track | Technical stream or major implementation flow | `JDG` | Examples: P0 runtime, Judgment, docs, ops. |
| Phase | Ordered stage inside a track | `JDG-1B` | Reuses existing Judgment phase names where already established. |
| Slice / Task | Commit-sized or PR-sized work unit | `JDG-1B.5` | Should be small enough to review and validate. |
| Gate | Acceptance, test, staging, or manual verification criterion | `AC-MEM-004` / `bun run ci` | Gate definitions live in `docs/06_ACCEPTANCE_TESTS.md` or test files. |
| Evidence | Anchor proving status | code, tests, docs, Q, DEC, ADR | Prefer links / IDs over copied details. |

### Status vocabulary

Implementation status:

| Status | Meaning |
| ------ | ------- |
| `planned` | Planned but not ready to start. |
| `ready` | Dependencies and scope are clear enough to start. |
| `in_progress` | Work is actively being changed. |
| `landed` | Code or docs are on `main`; acceptance may still be pending. |
| `accepted` | The relevant gate has passed and the milestone accepts the work. |
| `blocked` | Cannot proceed without resolving a blocker. |
| `deferred` | Intentionally moved out of the current milestone. |
| `dropped` | Explicitly not planned. |

Gate status:

| Status | Meaning |
| ------ | ------- |
| `defined` | Gate is defined but is not yet due. |
| `not_run` | Gate is due or relevant but has not been executed. |
| `passing` | Gate passed. |
| `failing` | Gate failed. |
| `waived` | Gate explicitly waived with rationale. |

### Milestones

| Milestone | Product / user gate | Status | Gate | Gate status | Evidence | Next |
| --------- | ------------------- | ------ | ---- | ----------- | -------- | ---- |
| `P0-M1` | Walking skeleton with durable Telegram/job/outbound ledger and fake provider | `landed` | Walking Skeleton gate | `not_run` | `src/telegram/*`, `src/queue/*`, `src/providers/fake.ts`, queue/telegram tests | Historical gate remains in `docs/06_ACCEPTANCE_TESTS.md`. |
| `P0-M2` | Claude vertical slice | `landed` | Provider acceptance criteria | `not_run` | `src/providers/claude.ts`, `test/providers/*`, `docs/RUNTIME.md` | Staging provider checks still tracked as acceptance work. |
| `P0-M3` | Memory + summary | `landed` | Memory acceptance criteria | `not_run` | `src/memory/*`, `src/context/*`, `test/memory/*`, `test/context/*` | Judgment convergence follow-ups tracked under `JDG`. |
| `P0-M4` | Attachment + S3 | `landed` | Storage acceptance criteria | `not_run` | `src/storage/*`, `src/telegram/attachment_*`, storage/attachment tests | Staging S3 smoke remains acceptance work. |
| `P0-M5` | Operate-and-polish: commands, doctor/status, startup recovery, deploy/runbook | `landed` | P0 Acceptance gate | `not_run` | `src/commands/*`, `src/startup/recovery.ts`, `deploy/*`, `docs/OPERATIONS.md` | Run full acceptance/staging gate before calling P0 accepted. |
| `MVP-JDG` | Judgment-backed behavioral baseline for MVP | `landed` | `bun run ci` + current docs review | `passing` | `src/judgment/*`, `src/queue/worker.ts`, `src/context/*`, ADR-0017, DEC-039, DEC-041 | Summary-output proposal is landed; freeform provider-output extraction is excluded for MVP; `current_operating_view` remains planned. |

### Tracks

| Track | Purpose | Active phase | Status | Notes |
| ----- | ------- | ------------ | ------ | ----- |
| `P0` | Single-user Telegram + Claude personal agent vertical | `P0-M5` | `landed` | Implementation is on `main`; staging acceptance and dogfood gates are not run. |
| `JDG` | DB-native Judgment System and memory-to-judgment convergence | `JDG-1C` | `in_progress` | Runtime foundation, summary-output proposal, and proposal visibility are landed; freeform provider-output extraction is excluded for MVP by DEC-041. |
| `DOC` | Documentation source-of-truth and roadmap/status migration | `DOC-1A` | `landed` | DEC-040/Q-068 define the migration; `DOC-1A.5` adds the top-down leaf roadmap. |
| `OPS` | Deployment, staging acceptance, dogfood evidence | `OPS-1A` | `ready` | First leaf is `OPS-1A.1`; acceptance files still show many `pending` rows because staging gates have not been executed. |

### Phases / slices

| Slice | Milestone | Track | Phase | Goal | Depends | Gate | Gate status | Status | Evidence | Next |
| ----- | --------- | ----- | ----- | ---- | ------- | ---- | ----------- | ------ | -------- | ---- |
| `P0-M5.GATE` | `P0-M5` | `OPS` | `OPS-1A` | Run staging P0 Acceptance gate and dogfood evidence collection | Deployed staging host, configured Telegram/S3/Claude | `docs/06_ACCEPTANCE_TESTS.md` | `not_run` | `planned` | `docs/06_ACCEPTANCE_TESTS.md`, `docs/05_RUNBOOK.md`, DEC-013 | Promote acceptance results from pending/not_run to pass/fail when executed. |
| `JDG-1A` | `MVP-JDG` | `JDG` | `JDG-1A` | Local Judgment schema/repository/tool/control-gate substrate | ADR-0009..ADR-0015 | `bun run ci` | `passing` | `landed` | `migrations/004_*`, `005_*`, `006_*`; `src/judgment/*`; `test/judgment/*`; `test/db/*judgment*` | Provider registration intentionally out of scope. |
| `JDG-1B` | `MVP-JDG` | `JDG` | `JDG-1B` | Runtime Judgment reachability through telemetry, context injection, and Telegram commands | `JDG-1A` | `bun run ci` | `passing` | `landed` | `src/queue/worker.ts`; `test/queue/judgment_*`; DEC-038 | Keep provider tools unregistered until explicitly authorized. |
| `JDG-1C.1` | `MVP-JDG` | `JDG` | `JDG-1C` | First ADR-0017 convergence slice: split memory gates, stop summary active-memory promotion, make judgments outrank memory recall | ADR-0017, DEC-039 | `bun run ci` | `passing` | `landed` | `src/memory/provenance.ts`; `src/memory/summary.ts`; `src/context/*`; Q-027; Q-064 | Continue with extraction/proposal only when explicitly scoped. |
| `JDG-1C.2` | `MVP-JDG` | `JDG` | `JDG-1C` | Automatic Judgment extraction/proposal from summary output plus provider-output boundary decision | `JDG-1C.1` | New tests + docs update | `passing` | `landed` | ADR-0017; Q-027; DEC-041; `src/judgment/summary_proposals.ts` | Summary-output proposal and notification visibility are landed; freeform provider-output extraction is not authorized for MVP. |
| `JDG-1C.3` | `MVP-JDG` | `JDG` | `JDG-1C` | Provider tool registration for Judgment write path | `JDG-1B`, provider safety review | New provider/tool tests | `defined` | `deferred` | ADR-0009..ADR-0013; `docs/RUNTIME.md` not-implemented list | Do not implement without explicit authorization. |
| `JDG-2A` | Future | `JDG` | `JDG-2A` | `current_operating_view` and compiler input sourced from it | `JDG-1C` | New compiler/context tests | `defined` | `planned` | ADR-0013; DEC-036; `docs/RUNTIME.md` | Future runtime slice. |
| `JDG-3A` | Future | `JDG` | `JDG-3A` | Vector / graph derived projections | Evidence that FTS/metadata retrieval is insufficient | TBD | `defined` | `planned` | ADR-0009; `docs/ARCHITECTURE.md` | Keep as derived projection, not source of truth. |
| `DOC-1A.1` | Project docs | `DOC` | `DOC-1A` | Adopt roadmap/status taxonomy and create compressed current-state entrypoint | Boilerplate migration checklist | `bun run ci` | `passing` | `landed` | Q-068; DEC-040; this file; `docs/context/current-state.md`; `AGENTS.md`; `bun run ci` (2026-04-29) | Keep future roadmap/status inventory in this ledger. |
| `DOC-1A.2` | Project docs | `DOC` | `DOC-1A` | Tighten maintenance drift workflow around roadmap/status, current-state, and acceptance gates | `DOC-1A.1`; `../boilerplate` commit `24b47f1` | `bun run ci` | `passing` | `landed` | `.codex/skills/*`; `.github/pull_request_template.md`; `.github/workflows/doc-freshness.yml`; `docs/DOCUMENTATION.md`; `bun run ci` (2026-04-29) | Keep workflow warnings aligned with docs policy when doc ownership changes. |
| `DOC-1A.3` | Project docs | `DOC` | `DOC-1A` | Review current code against updated docs and patch consistency gaps | `DOC-1A.2`; current implementation docs | `bun run ci` | `passing` | `landed` | `.github/pull_request_template.md`; `docs/DOCUMENTATION.md`; `docs/CODE_MAP.md`; `docs/RUNTIME.md`; `bun run ci` (2026-04-29) | No remaining consistency findings from the current loop. |
| `DOC-1A.4` | Project docs | `DOC` | `DOC-1A` | Expand consistency review to full repo docs/code/test/migration scope | `DOC-1A.3`; full repo scan | `bun run ci` | `passing` | `landed` | `docs/ARCHITECTURE.md`; `docs/CODE_MAP.md`; `docs/DATA_MODEL.md`; `docs/generated/schema.md`; `bun run docs:generate:schema`; `bun run ci` (2026-04-29) | No remaining full-scope consistency findings from the current loop. |
| `DOC-1A.5` | Project docs | `DOC` | `DOC-1A` | Expand the roadmap from planning/design docs into a top-down leaf inventory | `DOC-1A.4`; PRD/HLD/acceptance/traceability docs | `bun run ci` | `passing` | `landed` | this file; `docs/context/current-state.md`; `bun run ci` (2026-04-29) | Use the leaf rows below as the dev-cycle discovery surface. |

### Full leaf roadmap

The table above is the compact roadmap/status view. The rows below are
the executable leaf inventory derived from the PRD, HLD, playbook, risk
spikes, acceptance tests, traceability matrix, ADRs, Q register, DEC
register, and current code/tests. Some existing slice IDs appear in
both places when the compact row was already leaf-sized. A broad parent
row is not considered "ready to code" unless its next step points at
one of these leaf rows or a new leaf row is added first.

For implementation rows, `passing` means the current local automated
gate (`bun run ci`) covers the shipped code. P0 acceptance and staging
evidence remain separate OPS leaves until the real environment gate is
executed.

#### P0 Runtime Implementation Leaves

| Leaf | Milestone | Phase | Goal | Gate | Gate status | Status | Evidence | Next |
| ---- | --------- | ----- | ---- | ---- | ----------- | ------ | -------- | ---- |
| `P0-1A.1` | `P0-M1` | Phase 1 | Typed config loader and runtime config validation | `bun run ci` | `passing` | `landed` | `src/config.ts`; `test/config.test.ts`; PRD Appendix F | Maintain with env/runtime changes. |
| `P0-1A.2` | `P0-M1` | Phase 1 | Single redactor boundary and redaction lint | `bun run ci` | `passing` | `landed` | `src/observability/redact.ts`; `scripts/check-single-redactor.ts`; `test/redaction.test.ts`; `test/single-redactor.test.ts`; DEC-002/010 | Add patterns only in the redactor module. |
| `P0-1A.3` | `P0-M1` | Phase 1 | Structured event emitter with correlation payloads | `bun run ci` | `passing` | `landed` | `src/observability/events.ts`; `test/events.test.ts`; HLD §13.3 | Keep logs redacted at boundaries. |
| `P0-2A.1` | `P0-M1` | Phase 2 | SQLite handle, WAL pragmas, migrator, base schema | `bun run ci` | `passing` | `landed` | `src/db.ts`; `src/db/migrator.ts`; `migrations/001_init.sql`; `test/db/schema.test.ts`; `test/db/invariants.test.ts` | Schema changes require a new contiguous migration. |
| `P0-2A.2` | `P0-M4` | Phase 2 | Artifact and memory-artifact schema | `bun run ci` | `passing` | `landed` | `migrations/002_artifacts.sql`; `docs/DATA_MODEL.md`; `test/db/schema.test.ts` | Keep storage rows single-writer. |
| `P0-2A.3` | `P0-M1` | Phase 2 | Notification payload schema extension | `bun run ci` | `passing` | `landed` | `migrations/003_notification_payload_text.sql`; `test/db/schema.test.ts` | No current follow-up. |
| `P0-3A.1` | `P0-M1` | Phase 3 | Telegram long-poll offset ledger | `bun run ci` | `passing` | `landed` | `src/telegram/poller.ts`; `test/telegram/poller.test.ts`; `test/telegram/offset_durability.test.ts`; ADR-0002/0008 | Staging offset crash drills live in `OPS-1A.5a`. |
| `P0-3A.2` | `P0-M1` | Phase 3 | Inbound classification, authorization, command/job enqueue | `bun run ci` | `passing` | `landed` | `src/telegram/inbound.ts`; `test/telegram/inbound.test.ts`; AC-TEL-001, AC-TEL-003, AC-TEL-004 | Keep command registry aligned with worker dispatch. |
| `P0-3A.3` | `P0-M4` | Phase 3 | Attachment metadata phase, no network I/O in inbound txn | `bun run ci` | `passing` | `landed` | `src/telegram/attachment_metadata.ts`; `test/telegram/attachment_metadata.test.ts`; AC-STO-003a | Staging byte-capture proof lives in `OPS-1A.5d`. |
| `P0-4A.1` | `P0-M1` | Phase 4 | Atomic job claim and queue state machine | `bun run ci` | `passing` | `landed` | `src/queue/worker.ts`; `test/queue/claim.test.ts`; `test/queue/state_machine.test.ts`; DEC-001 | Acceptance restart proof lives in `OPS-1A.5a`. |
| `P0-4A.2` | `P0-M1` | Phase 4 | Deterministic fake provider for walking skeleton/tests | `bun run ci` | `passing` | `landed` | `src/providers/fake.ts`; `test/providers/fake.test.ts` | Keep fake behavior deterministic. |
| `P0-4A.3` | `P0-M4` | Phase 4 | Attachment byte capture phase and MIME/hash fields | `bun run ci` | `passing` | `landed` | `src/telegram/attachment_capture.ts`; `src/storage/mime.ts`; `test/queue/attachment_capture.test.ts`; AC-STO-003b | Reinforcement staging test lives in `OPS-1A.5d`. |
| `P0-5A.1` | `P0-M1` | Phase 5 | Outbound notification parent + chunk ledger | `bun run ci` | `passing` | `landed` | `src/telegram/outbound.ts`; `test/notifications/chunk_ledger.test.ts`; `test/notifications/splitting.test.ts`; DEC-020 | Acceptance chunk failure proof lives in `OPS-1A.5c`. |
| `P0-5A.2` | `P0-M1` | Phase 5 | Notification retry independent from provider/job terminal state | `bun run ci` | `passing` | `landed` | `src/queue/notification_retry.ts`; `test/notifications/retry_driver.test.ts`; AC-NOTIF-001, AC-NOTIF-003, AC-NOTIF-005 | No code follow-up. |
| `P0-5A.3` | `P0-M1` | Phase 5 | Worker notification creation/sending wiring | `bun run ci` | `passing` | `landed` | `src/queue/worker.ts`; `test/notifications/worker_wiring.test.ts`; AC-TEL-002 | Staging Telegram delivery proof lives in `OPS-1A.5a`. |
| `P0-6A.1` | `P0-M1` | Phase 6 | Walking Skeleton staging report with fake provider | Walking Skeleton gate | `not_run` | `planned` | `docs/04_IMPLEMENTATION_PLAN.md` Phase 6; playbook §5.5 | Run alongside `OPS-1A.5a`, `OPS-1A.5c`, and `OPS-1A.5d` before marking `P0-M1` accepted. |
| `P0-7A.1` | `P0-M2` | Phase 7 | Claude provider adapter and command builder | `bun run ci` | `passing` | `landed` | `src/providers/claude.ts`; `test/providers/claude.test.ts`; ADR-0005/0007 | Provider smoke lives in `OPS-1A.5b`. |
| `P0-7A.2` | `P0-M2` | Phase 7 | Stream-json parser and final-text normalization | `bun run ci` | `passing` | `landed` | `src/providers/stream_json.ts`; `test/providers/parser.test.ts`; AC-PROV-005 | Re-run fixtures on Claude CLI bumps. |
| `P0-7A.3` | `P0-M2` | Phase 7 | Subprocess lifecycle, abort, timeout, process-group teardown | `bun run ci` | `passing` | `landed` | `src/providers/subprocess.ts`; `test/providers/subprocess.test.ts`; AC-PROV-002, AC-PROV-004, AC-PROV-006 | Runtime kill drills live in `OPS-1A.5b`. |
| `P0-8A.1` | `P0-M3` | Phase 8 | Context compiler, builder, packer, token estimator | `bun run ci` | `passing` | `landed` | `src/context/*`; `test/context/*`; DEC-021; Q-066 | `src/context/builder.ts` cleanup remains open under Q-066. |
| `P0-8A.2` | `P0-M3` | Phase 8 | Summary generation and memory summary persistence | `bun run ci` | `passing` | `landed` | `src/memory/summary.ts`; `test/memory/summary.test.ts`; AC-MEM-001, AC-MEM-002, AC-MEM-005, AC-MEM-006 | Summary-output Judgment proposal and visibility are landed; DEC-041 excludes freeform provider-output extraction for MVP. |
| `P0-8A.3` | `P0-M3` | Phase 8 | Memory item writer, provenance gates, correction supersede | `bun run ci` | `passing` | `landed` | `src/memory/items.ts`; `src/memory/provenance.ts`; `test/memory/correction.test.ts`; `test/memory/provenance.test.ts`; AC-MEM-004 | Behavioral baseline authority stays in `JDG`. |
| `P0-9A.1` | `P0-M4` | Phase 9 | Local artifact object helpers and key generation | `bun run ci` | `passing` | `landed` | `src/storage/local.ts`; `src/storage/objects.ts`; `test/storage/state_machine.test.ts`; AC-SEC-002 | No code follow-up. |
| `P0-9A.2` | `P0-M4` | Phase 9 | S3 transport, storage sync, retry states | `bun run ci` | `passing` | `landed` | `src/storage/s3.ts`; `src/storage/sync.ts`; `test/storage/roundtrip.test.ts`; `test/storage/state_machine.test.ts`; ADR-0004 | S3 smoke lives in `OPS-1A.6`. |
| `P0-9A.3` | `P0-M4` | Phase 9 | Local/S3 capacity policy and long-term write gate | `bun run ci` | `passing` | `landed` | `src/storage/capacity.ts`; `test/storage/capacity.test.ts`; DEC-018 | Monitor during dogfood. |
| `P0-10A.1` | `P0-M5` | Phase 10 | Core system commands: status, cancel, summary/end, provider, whoami | `bun run ci` | `passing` | `landed` | `src/commands/status.ts`; `src/commands/cancel.ts`; `src/commands/summary.ts`; `src/commands/provider.ts`; `src/commands/whoami.ts`; `test/commands/basic.test.ts`; AC-OBS-003 | Staging command proof lives in `OPS-1A.5e`. |
| `P0-10A.2` | `P0-M5` | Phase 10 | `/doctor` checks and typed output | `bun run ci` | `passing` | `landed` | `src/commands/doctor.ts`; `test/commands/doctor.test.ts`; AC-OBS-001, AC-OPS-002 | Deep smoke lives in `OPS-1A.6`. |
| `P0-10A.3` | `P0-M5` | Phase 10 | Save, forget, and correct command surfaces | `bun run ci` | `passing` | `landed` | `src/commands/save.ts`; `src/commands/forget.ts`; `src/commands/correct.ts`; `test/commands/save.test.ts`; `test/commands/forget.test.ts`; `test/commands/correct.test.ts`; AC-MEM-003, AC-MEM-004, AC-STO-004, AC-STO-005 | Staging destructive-flow proof lives in `OPS-1A.5d`. |
| `P0-10A.4` | `P0-M5` | Phase 10 | Startup recovery and stale job reconciliation | `bun run ci` | `passing` | `landed` | `src/startup/recovery.ts`; `test/startup/recovery.test.ts`; AC-JOB-002 | Crash/restart acceptance lives in `OPS-1A.5a`. |
| `P0-10A.5` | `P0-M5` | Phase 10 | WAL-safe local DB backup helper | `bun run ci` | `passing` | `landed` | `scripts/backup-sqlite.ts`; `test/db/backup_sqlite.test.ts`; AC-OPS-004 | Exercise on staging before P0 accepted. |
| `P0-11A.1` | `P0-M5` | Phase 11 | systemd unit, installer, deployment docs, operations docs | `bun run ci` | `passing` | `landed` | `deploy/install.sh`; `deploy/systemd/*`; `docs/05_RUNBOOK.md`; `docs/OPERATIONS.md`; playbook §10 | Fresh-host proof lives in `OPS-1A.2`/`OPS-1A.6`. |

#### P0 Acceptance And Operations Leaves

| Leaf | Milestone | Phase | Goal | Gate | Gate status | Status | Evidence | Next |
| ---- | --------- | ----- | ---- | ---- | ----------- | ------ | -------- | ---- |
| `OPS-1A.1` | `P0-M5` | `OPS-1A` | Prepare acceptance environment inventory | Manual checklist | `defined` | `ready` | `docs/06_ACCEPTANCE_TESTS.md` §Test environment; `docs/05_RUNBOOK.md` | Record host, bot, authorized/unauthorized accounts, Claude, S3 bucket, and env source. |
| `OPS-1A.2` | `P0-M5` | `OPS-1A` | Fresh deploy or staging deploy rehearsal | Deploy gate | `not_run` | `planned` | `deploy/install.sh`; `deploy/systemd/actwyn.service`; playbook §5.8 | Run install/restart/reboot path. |
| `OPS-1A.3a` | `P0-M5` | `OPS-1A` | Write full plans for inbound/outbound ledger backlog | Acceptance plan completeness | `not_run` | `planned` | `docs/06_ACCEPTANCE_TESTS.md` §Phase-gate escalation | AC-TEL-005, AC-TEL-006, AC-TEL-007, AC-TEL-008, AC-TEL-009, AC-NOTIF-001, AC-NOTIF-002, AC-NOTIF-003, AC-NOTIF-004, AC-NOTIF-005, AC-OPS-003, TEST-NOTIF-CHUNK-001. |
| `OPS-1A.3b` | `P0-M5` | `OPS-1A` | Write full plans for attachment/storage reinforcement backlog | Acceptance plan completeness | `not_run` | `planned` | `docs/06_ACCEPTANCE_TESTS.md` §Phase-gate escalation | TEST-TEL-ATTACH-001 and TEST-STO-STATE-001. |
| `OPS-1A.3c` | `P0-M5` | `OPS-1A` | Write full plans for Claude/provider/security backlog | Acceptance plan completeness | `not_run` | `planned` | `docs/06_ACCEPTANCE_TESTS.md` §Phase-gate escalation | AC-PROV-007, AC-PROV-008, AC-PROV-010, AC-PROV-011, AC-PROV-012, AC-PROV-013, AC-SEC-003, AC-SEC-004, AC-SEC-005, AC-SEC-006, AC-SEC-007, TEST-PROV-RESUME-001. |
| `OPS-1A.3d` | `P0-M5` | `OPS-1A` | Write full plans for summary/advisory output backlog | Acceptance plan completeness | `not_run` | `planned` | `docs/06_ACCEPTANCE_TESTS.md` §Phase-gate escalation | AC-PROV-014 and AC-MEM-006. |
| `OPS-1A.3e` | `P0-M5` | `OPS-1A` | Write full plans for operate-and-polish backlog | Acceptance plan completeness | `not_run` | `planned` | `docs/06_ACCEPTANCE_TESTS.md` §Phase-gate escalation | AC-OPS-002, AC-OPS-004, AC-PROV-009, AC-SEC-ATTACH-001. |
| `OPS-1A.4` | `P0-M5` | `OPS-1A` | Run or explicitly supersede risk spikes SP-01..SP-08 | Risk Spike gate | `not_run` | `planned` | `docs/03_RISK_SPIKES.md`; playbook §5.3 | Promote each spike from `pending` to `passed` or add a DEC explaining supersession by landed tests. |
| `OPS-1A.5a` | `P0-M5` | `OPS-1A` | Execute Telegram and job acceptance criteria | P0 Acceptance gate | `not_run` | `planned` | `docs/06_ACCEPTANCE_TESTS.md`; `docs/09_TRACEABILITY_MATRIX.md` | AC-TEL-001, AC-TEL-002, AC-TEL-003, AC-TEL-004, AC-TEL-005, AC-TEL-006, AC-TEL-007, AC-TEL-008, AC-TEL-009, AC-JOB-001, AC-JOB-002, AC-JOB-003. |
| `OPS-1A.5b` | `P0-M5` | `OPS-1A` | Execute provider and security acceptance criteria | P0 Acceptance gate | `not_run` | `planned` | `docs/06_ACCEPTANCE_TESTS.md`; `docs/09_TRACEABILITY_MATRIX.md` | AC-PROV-001, AC-PROV-002, AC-PROV-003, AC-PROV-004, AC-PROV-005, AC-PROV-006, AC-PROV-007, AC-PROV-008, AC-PROV-009, AC-PROV-010, AC-PROV-011, AC-PROV-012, AC-PROV-013, AC-PROV-014, AC-SEC-001, AC-SEC-002, AC-SEC-003, AC-SEC-004, AC-SEC-005, AC-SEC-006, AC-SEC-007, AC-SEC-ATTACH-001. |
| `OPS-1A.5c` | `P0-M5` | `OPS-1A` | Execute notification acceptance criteria | P0 Acceptance gate | `not_run` | `planned` | `docs/06_ACCEPTANCE_TESTS.md`; `docs/09_TRACEABILITY_MATRIX.md` | AC-NOTIF-001, AC-NOTIF-002, AC-NOTIF-003, AC-NOTIF-004, AC-NOTIF-005, TEST-NOTIF-CHUNK-001. |
| `OPS-1A.5d` | `P0-M5` | `OPS-1A` | Execute memory and storage acceptance criteria | P0 Acceptance gate | `not_run` | `planned` | `docs/06_ACCEPTANCE_TESTS.md`; `docs/09_TRACEABILITY_MATRIX.md` | AC-MEM-001, AC-MEM-002, AC-MEM-003, AC-MEM-004, AC-MEM-005, AC-MEM-006, AC-STO-001, AC-STO-002, AC-STO-003a, AC-STO-003b, AC-STO-004, AC-STO-005, AC-STO-006, TEST-TEL-ATTACH-001, TEST-STO-STATE-001. |
| `OPS-1A.5e` | `P0-M5` | `OPS-1A` | Execute observability and operations acceptance criteria | P0 Acceptance gate | `not_run` | `planned` | `docs/06_ACCEPTANCE_TESTS.md`; `docs/09_TRACEABILITY_MATRIX.md` | AC-OBS-001, AC-OBS-002, AC-OBS-003, AC-OPS-001, AC-OPS-002, AC-OPS-003, AC-OPS-004. |
| `OPS-1A.6` | `P0-M5` | `OPS-1A` | Run `/doctor` quick/deep, S3 smoke, backup, reboot recovery | Deploy gate | `not_run` | `planned` | `docs/05_RUNBOOK.md`; `docs/OPERATIONS.md`; AC-OBS-001, AC-OPS-004 | Attach output summaries to the acceptance log. |
| `OPS-1A.7` | `P0-M5` | `OPS-1A` | Seven-day dogfood evidence collection | DEC-013 dogfood gate | `not_run` | `planned` | DEC-013; playbook §14 | Track incidents, redaction checks, recovery, and operator notes. |
| `OPS-1A.8` | `P0-M5` | `OPS-1A` | Acceptance closeout and P0 accepted declaration | P0 Acceptance gate | `not_run` | `planned` | `docs/06_ACCEPTANCE_TESTS.md`; `docs/08_DECISION_REGISTER.md` | Mark milestones accepted only after all required gates pass or are waived. |

#### Judgment Leaves

| Leaf | Milestone | Phase | Goal | Gate | Gate status | Status | Evidence | Next |
| ---- | --------- | ----- | ---- | ---- | ----------- | ------ | -------- | ---- |
| `JDG-1A.1` | `MVP-JDG` | `JDG-1A` | Judgment schema skeleton and FTS5 table | `bun run ci` | `passing` | `landed` | `migrations/004_judgment_skeleton.sql`; `test/db/judgment_schema.test.ts`; ADR-0009..0013 | No schema change without migration. |
| `JDG-1A.2` | `MVP-JDG` | `JDG-1A` | Proposal repository and unregistered `judgment.propose` contract | `bun run ci` | `passing` | `landed` | `src/judgment/repository.ts`; `src/judgment/tool.ts`; `test/judgment/repository.test.ts`; `test/judgment/tool.test.ts` | Runtime command wiring tracked in `JDG-1B.4`. |
| `JDG-1A.3` | `MVP-JDG` | `JDG-1A` | Approve/reject local review surface | `bun run ci` | `passing` | `landed` | `src/judgment/repository.ts`; `src/judgment/tool.ts`; `test/judgment/repository.test.ts` | Approval still does not activate. |
| `JDG-1A.4` | `MVP-JDG` | `JDG-1A` | Source recording and evidence linking | `bun run ci` | `passing` | `landed` | `src/judgment/repository.ts`; `src/judgment/tool.ts`; `test/judgment/repository.test.ts` | Evidence linking still does not activate. |
| `JDG-1A.5` | `MVP-JDG` | `JDG-1A` | Commit approved/evidence-linked judgment as active/eligible | `bun run ci` | `passing` | `landed` | `src/judgment/repository.ts`; `src/judgment/tool.ts`; `test/judgment/repository.test.ts` | Context visibility handled by `JDG-1B.2`. |
| `JDG-1A.6` | `MVP-JDG` | `JDG-1A` | Query and explain read-only judgment surfaces | `bun run ci` | `passing` | `landed` | `src/judgment/repository.ts`; `src/judgment/tool.ts`; `test/judgment/tool.test.ts` | Telegram read commands tracked in `JDG-1B.3`. |
| `JDG-1A.7` | `MVP-JDG` | `JDG-1A` | Supersede, revoke, expire retirement operations | `bun run ci` | `passing` | `landed` | `src/judgment/repository.ts`; `src/judgment/tool.ts`; `test/judgment/repository.test.ts` | Telegram retirement commands tracked in `JDG-1B.5`. |
| `JDG-1A.8` | `MVP-JDG` | `JDG-1A` | Control Gate evaluator and append-only event ledger | `bun run ci` | `passing` | `landed` | `migrations/005_control_gate_events.sql`; `migrations/006_control_gate_job_id.sql`; `src/judgment/control_gate.ts`; `test/judgment/control_gate.test.ts`; `test/db/control_gate_schema.test.ts`; ADR-0015 | Runtime telemetry tracked in `JDG-1B.1`. |
| `JDG-1B.1` | `MVP-JDG` | `JDG-1B` | Record Control Gate telemetry for non-system `provider_run` jobs | `bun run ci` | `passing` | `landed` | `src/queue/worker.ts`; `test/queue/control_gate_telemetry.test.ts`; DEC-038 | Signal detection remains future. |
| `JDG-1B.2` | `MVP-JDG` | `JDG-1B` | Inject active/eligible/global/time-valid judgments into context | `bun run ci` | `passing` | `landed` | `src/context/compiler.ts`; `src/context/builder.ts`; `src/queue/worker.ts`; `test/queue/judgment_context_injection.test.ts`; issue #44 | `current_operating_view` is `JDG-2A`. |
| `JDG-1B.3` | `MVP-JDG` | `JDG-1B` | Telegram read commands `/judgment` and `/judgment_explain` | `bun run ci` | `passing` | `landed` | `src/queue/worker.ts`; `src/telegram/inbound.ts`; `test/queue/judgment_commands.test.ts` | No provider tool registration. |
| `JDG-1B.4` | `MVP-JDG` | `JDG-1B` | Telegram write commands for propose/review/source/evidence/commit | `bun run ci` | `passing` | `landed` | `src/queue/worker.ts`; `test/queue/judgment_commands.test.ts` | DEC-041 keeps provider-output parsing and provider tools out of MVP. |
| `JDG-1B.5` | `MVP-JDG` | `JDG-1B` | Telegram retirement commands for supersede/revoke/expire | `bun run ci` | `passing` | `landed` | `src/queue/worker.ts`; `test/queue/judgment_commands.test.ts` | No current follow-up. |
| `JDG-1C.1` | `MVP-JDG` | `JDG-1C` | Split memory persistence vs judgment proposal gates; stop summary active-memory promotion; raise judgment context priority | `bun run ci` | `passing` | `landed` | `src/memory/provenance.ts`; `src/memory/summary.ts`; `src/context/*`; `test/memory/*`; `test/context/*`; ADR-0017; DEC-039; Q-027/Q-064 | Summary proposal and visibility landed; provider-output boundary is decided by DEC-041. |
| `JDG-1C.2a` | `MVP-JDG` | `JDG-1C` | Convert `summary_generation` structured output into proposed judgments | `bun run ci` | `passing` | `landed` | ADR-0017; Q-027; `src/judgment/summary_proposals.ts`; `src/queue/worker.ts`; `test/judgment/summary_proposals.test.ts`; `test/queue/state_machine.test.ts` | Summary-output-only proposal implemented; it does not approve/link/commit or activate. |
| `JDG-1C.2b` | `MVP-JDG` | `JDG-1C` | Add review/operator visibility for auto-proposed summary judgments | `bun run ci` | `passing` | `landed` | `src/queue/worker.ts`; `test/queue/state_machine.test.ts`; existing `/judgment_explain`, `/judgment_approve`, `/judgment_reject` commands | Summary notifications include proposal count, short IDs, and review command hints. |
| `JDG-1C.2c` | `MVP-JDG` | `JDG-1C` | Decide provider-output extraction boundary | DEC-041 | `passing` | `landed` | DEC-041; ADR-0017; ADR-0005; provider safety constraints | Freeform provider-output parsing is not authorized for MVP; future analyzer work needs a new explicit leaf. |
| `JDG-1C.2d` | `MVP-JDG` | `JDG-1C` | Implement provider-output proposal only if explicitly re-authorized | New provider/worker tests | `defined` | `deferred` | DEC-041 | DEC-041 does not authorize MVP implementation; revisit only as a scoped post-run analyzer leaf. |
| `JDG-1C.3` | `MVP-JDG` | `JDG-1C` | Provider tool registration for Judgment write path | Provider/tool safety review | `defined` | `deferred` | ADR-0009..0013; `docs/RUNTIME.md` not-implemented list | Do not implement without explicit authorization. |
| `JDG-2A.1` | Future | `JDG-2A` | Define `current_operating_view` projection contract | New ADR/DEC or design note | `defined` | `planned` | ADR-0013; DEC-036; Q-057 | Decide schema/projection before runtime code. |
| `JDG-2A.2` | Future | `JDG-2A` | Implement `current_operating_view` read model and compiler input | New migration + compiler tests | `defined` | `planned` | Depends on `JDG-2A.1` | Future runtime slice. |
| `JDG-3A.1` | Future | `JDG-3A` | Define vector/graph derived projection need and source-of-truth boundary | New design note | `defined` | `planned` | ADR-0009; `docs/ARCHITECTURE.md` | Keep projections derived, never canonical. |
| `JDG-3A.2` | Future | `JDG-3A` | Implement vector/graph projection if retrieval evidence justifies it | New projection tests | `defined` | `planned` | Depends on `JDG-3A.1` | Future, not MVP. |

#### Documentation And Process Leaves

| Leaf | Milestone | Phase | Goal | Gate | Gate status | Status | Evidence | Next |
| ---- | --------- | ----- | ---- | ---- | ----------- | ------ | -------- | ---- |
| `DOC-1A.1` | Project docs | `DOC-1A` | Roadmap/status taxonomy and compressed current-state entrypoint | `bun run ci` | `passing` | `landed` | Q-068; DEC-040; `docs/context/current-state.md`; `AGENTS.md` | Keep current-state short. |
| `DOC-1A.2` | Project docs | `DOC-1A` | Drift workflow, PR template, doc freshness CI, skill overrides | `bun run ci` | `passing` | `landed` | `.github/*`; `.codex/*`; `docs/DOCUMENTATION.md` | Keep workflow warnings aligned with policy. |
| `DOC-1A.3` | Project docs | `DOC-1A` | Current code/docs consistency pass | `bun run ci` | `passing` | `landed` | `docs/CODE_MAP.md`; `docs/RUNTIME.md`; `docs/DOCUMENTATION.md` | No remaining findings from that loop. |
| `DOC-1A.4` | Project docs | `DOC-1A` | Full repo docs/code/test/migration consistency pass | `bun run ci`; `bun run docs:generate:schema` | `passing` | `landed` | `docs/ARCHITECTURE.md`; `docs/DATA_MODEL.md`; `docs/generated/schema.md` | No remaining findings from that loop. |
| `DOC-1A.5` | Project docs | `DOC-1A` | Top-down leaf roadmap from planning/design docs | `bun run ci` | `passing` | `landed` | this file; `docs/context/current-state.md`; `bun run ci` (2026-04-29) | Use the leaf rows as the dev-cycle discovery surface. |
| `DOC-1B.1` | Project docs | `DOC-1B` | Keep roadmap leaves current after every feature/ops slice | Doc freshness warning + review | `defined` | `planned` | `docs/DOCUMENTATION.md`; `.github/workflows/doc-freshness.yml` | Update this ledger whenever next work changes. |

#### Future Deferred Leaves

| Leaf | Track | Goal | Gate | Gate status | Status | Evidence | Next |
| ---- | ----- | ---- | ---- | ----------- | ------ | -------- | ---- |
| `ITR-1A.1` | `ITR` | Define capability-governed internal task runner security boundary | New ADR/DEC or design note | `defined` | `deferred` | ADR-0016; Q-067 | Do not implement in P0/MVP without explicit authorization. |
| `ITR-1A.2` | `ITR` | Implement task-runner security/capability modules | New tests + threat review | `defined` | `deferred` | Depends on `ITR-1A.1` | Future self-improvement track. |
| `ITR-1A.3` | `ITR` | Implement repo/deploy task adapters | New integration tests | `defined` | `deferred` | ADR-0016 future refs | Future self-improvement track. |
| `DOC-2A.1` | `DOC` | Decide archive/move policy for Phase 0 design docs | Q/DEC update | `defined` | `planned` | Q-063; DEC-037 | Avoid moving archives during feature work. |
| `MEM-2A.1` | `P0` | Decide `memory_base_path` JSONL/MD sidecar policy | Q/DEC update | `defined` | `planned` | Q-065; `src/memory/summary.ts`; `src/queue/worker.ts` | Keep sidecars non-canonical unless policy changes. |
| `CTX-2A.1` | `P0` | Decide `src/context/builder.ts` deletion/soak timing | Q/DEC update | `defined` | `planned` | Q-066; `docs/design/salvage-audit-2026-04.md` | Do not remove until migration risk is accepted. |

#### Current Execution Order

1. If the goal is P0 completion, execute `OPS-1A.1`,
   `OPS-1A.2`, `OPS-1A.3a` through `OPS-1A.3e`,
   `OPS-1A.4`, `OPS-1A.5a` through `OPS-1A.5e`, then
   `OPS-1A.6` through `OPS-1A.8`.
2. If the goal is feature development instead of acceptance work,
   there is no currently ready repo-local feature leaf after DEC-041;
   add a new explicit leaf before implementing provider-output proposal
   or continue with a planned future design leaf.
3. Any parent row that still feels too broad must be split into new
   leaf rows here before implementation begins.

### Gates / acceptance

- `bun run ci` is the current full local validation command.
- Acceptance status in `docs/06_ACCEPTANCE_TESTS.md` means staging /
  acceptance execution status, not necessarily implementation status.
- A milestone is `accepted` only when its required gates are
  `passing` or explicitly `waived`.
- Rows marked `landed` above are implementation status rows; do not
  read them as acceptance-pass claims unless the gate status is also
  `passing`.

### Migration notes

This ledger follows the migration rules adopted from `../boilerplate`:

1. Existing product/user gates map to `P0-M1` ... `P0-M5` and
   `MVP-JDG`.
2. Technical streams map to `P0`, `JDG`, `DOC`, and `OPS`.
3. Existing P0 phases stay in the historical plan below; active
   status lives in the ledger above.
4. Ambiguous `done` / `pending` language is split into implementation
   status and gate status.
5. Source anchors use paths, tests, Q, DEC, ADR, AC, and issue IDs.
   Unknown commit anchors are intentionally omitted rather than
   fabricated.

## Phase map

```
Phase 1  → Config + Redactor skeleton
Phase 2  → DB schema + migrations
Phase 3  → Telegram inbound ledger
Phase 4  → Queue worker + fake provider
Phase 5  → Outbound notifications + retry
Phase 6  → Walking Skeleton gate  ✦
Phase 7  → Claude provider adapter
Phase 8  → Context builder + packer + memory summary
Phase 9  → Storage sync (S3)
Phase 10 → Commands + /doctor + startup recovery
Phase 11 → systemd unit + RUNBOOK handoff
```

## Milestones

P0 groups the phases above into five user-visible milestones. This
is the level at which scope, "is it useful yet?", and go/no-go
decisions are made. Phase numbers are fixed; milestone boundaries
are the product lens on the same build order.

| Milestone | Name                               | Phases            | What the user/operator gets                                                                                     |
| --------- | ---------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------- |
| **M0**    | Docs + spikes                      | pre-Phase 1       | PRD / HLD / Risk Spikes closed; no runtime yet. Exit: Risk Spike gate passed for the spikes Phase 1 depends on. |
| **M1**    | Walking skeleton (fake provider)   | Phase 1 → Phase 6 | Telegram inbound durable, job ledger, outbound retry, fake provider end-to-end. Exit: Walking Skeleton gate ✦. |
| **M2**    | Claude vertical slice              | Phase 7           | Real Claude subprocess replaces the fake provider; stream-json parsed; permission lockdown enforced.            |
| **M3**    | Memory + summary                   | Phase 8           | Context builder/packer, `/end` + `/summary`, `memory_summaries`, `memory_items` with provenance.                 |
| **M4**    | Attachment + S3                    | Phase 9           | Attachment capture (two-phase, HLD §9.3) + S3 sync; `storage_objects` fully live; `/doctor` S3 smoke passes.    |
| **M5**    | Operate-and-polish                 | Phase 10 → 11     | `/forget_*`, `/correct`, `/status`, `/doctor`, startup recovery, systemd + runbook. Exit: P0 Acceptance gate.   |

Milestone rules:

- A milestone cannot begin until all of its component phases'
  entry criteria are met (in particular, the risk-spike gate
  listed below).
- "P0 done" means M5 has passed the P0 Acceptance gate. Earlier
  milestones are not "P0 done" even if they are releasable
  internally.
- Any re-scoping decision (e.g. cut forget/correct to P1) moves
  work between milestones, not between phases. Phase numbers
  stay stable so that cross-doc references (HLD §18, runbook,
  traceability) do not drift.

Gates (playbook §5):

- Before Phase 1 (entering M1): Risk Spike gate must be met
  (SP-01, SP-02, SP-03 in particular; others can land in parallel
  but must pass before the phase that depends on them).
- Before Phase 7 (entering M2): SP-04, SP-05, SP-06, SP-07 must be
  passed.
- Before Phase 9 (entering M4): SP-08 must be passed.
- After Phase 6 (end of M1): Walking Skeleton gate.
- After Phase 10 (end of M5 code work, before Phase 11): P0
  Acceptance Test gate — every `AC-*` in
  [`docs/06_ACCEPTANCE_TESTS.md`](./06_ACCEPTANCE_TESTS.md) whose
  priority is P0 must pass; `/doctor` returns `ok` for all P0
  checks. This gate is defined by the test file, not by a fixed
  numeric range.

Acceptance-test plan backlog rule: each phase also closes out the
test-plan rows it owns in the "Pending-to-add (backlog)" section of
[`docs/06_ACCEPTANCE_TESTS.md`](./06_ACCEPTANCE_TESTS.md) before
its gate passes, per the phase-gate escalation schedule in that
file. Reinforcement tests (TEST-TEL-ATTACH-001,
TEST-NOTIF-CHUNK-001, TEST-PROV-RESUME-001, TEST-STO-STATE-001) are
promoted on the same schedule as the AC they reinforce, not
deferred to P1.

## Definition of "done" for a phase

A phase is done when:

- All listed deliverables exist and are committed.
- All listed exit-criteria tests pass on CI or the local harness
  (whichever is current).
- `/doctor` reports no new `fail` outputs attributable to the
  phase.
- The HLD section that governs the phase matches implementation
  (any drift is resolved before closing the phase, per playbook
  §7.4).

---

## Phase 1 — Config + Redactor skeleton

- **Entry criteria**:
  - Repository initialized; Bun version pinned per PRD Appendix F.
  - SP-01 passed.
- **Deliverables**:
  - `src/config.ts` — typed config loader: reads env +
    `config/*.json`; required fields validated at start-up; fails
    fast on missing values.
  - `src/observability/redact.ts` — single-module redactor
    implementing HLD §13.1 boundary. Starting patterns per HLD
    §13.2 + Q12 leaning.
  - `src/observability/events.ts` — structured-log emitter (JSON
    lines) with correlation keys (HLD §13.3–13.4).
  - `test/redaction.test.ts` — redaction matrix covering each
    pattern + negative cases + a "no raw payload leaks" property
    test.
  - `test/config.test.ts` — missing-field failure + happy path.
- **Exit criteria**:
  - All listed tests green.
  - The redactor is a **single module**; no other module performs
    inline redaction. Enforced by a simple grep CI check.
- **Ledger tests introduced**: none yet (no DB).

---

## Phase 2 — DB schema + migrations

- **Entry criteria**:
  - Phase 1 done.
  - PRD Appendix D frozen.
- **Deliverables**:
  - `src/db.ts` — SQLite open, WAL on, `busy_timeout` set,
    prepared-statement helpers.
  - `migrations/001_init.sql` — create the tables listed in PRD
    Appendix D plus indices noted in HLD §5.1 writer map (e.g.
    unique `(job_type, idempotency_key)` on `jobs`).
  - `migrations/002_artifacts.sql` — create `storage_objects` +
    `memory_artifact_links` per PRD Appendix D.
  - `src/db/migrator.ts` — forward-only, idempotent migration
    runner; records version in `settings`.
  - `test/db/schema.test.ts` — every table and column per PRD
    Appendix D exists; indices exist; WAL is on after migrate.
  - `test/db/invariants.test.ts` — HLD §5.2 cross-table invariants
    expressed as SQL assertions (e.g. unique `update_id`, unique
    `idempotency_key` per job_type, FK resolution for
    `memory_artifact_links`).
- **Exit criteria**:
  - Fresh DB can be created from empty by running migrations.
  - Re-running migrations is a no-op.
  - Invariant tests pass on a seeded fixture DB.
- **Ledger tests introduced**: schema + invariants only; state
  machines wired in later phases.

---

## Phase 3 — Telegram inbound ledger

- **Entry criteria**:
  - Phase 2 done.
  - SP-02 and SP-03 passed.
- **Deliverables**:
  - `src/telegram/poller.ts` — long-poll loop; redacted insert +
    batch commit; `settings.telegram_next_offset` advance in the
    same txn.
  - `src/telegram/inbound.ts` — classify update (auth / type /
    command / attachment / text) → insert `jobs` row or mark
    `skipped`. For each attachment in the update, insert a
    `storage_objects` row with `capture_status = 'pending'`,
    `status = 'pending'`, `retention_class = 'session'`,
    `source_external_id = file_id`, `source_message_id` set, and
    `sha256` / `mime_type` / `size_bytes` left NULL — **inside the
    same inbound txn as the `jobs` insert** (PRD §13.5 Phase 1,
    HLD §7.1, §7.10).
  - `src/telegram/attachment_metadata.ts` — pure inbound-side
    helpers for metadata-only insert: classification, oversize
    check against `document.file_size` already present in the
    update payload (no network), and row construction. **Must not
    call `getFile`, download bytes, or probe MIME.** Byte capture
    lives in Phase 4 (`src/queue/worker.ts` pre-step); see
    `src/storage/objects.ts` in Phase 9 for the durable-sync side.
  - `test/telegram/poller.test.ts` — harness against a stub
    Telegram server; offset invariant (HLD §9.5, PRD §13.2)
    asserted.
  - `test/telegram/inbound.test.ts` — authorized text, authorized
    command, unauthorized sender, unsupported type, attachment,
    oversize attachment. **New oracle**: when the update contains
    a photo/document, the stub Telegram `getFile` / download /
    MIME-probe surface records **zero calls** during the inbound
    txn, the `storage_objects` row exists with
    `capture_status = 'pending'` and NULL `sha256` / `mime_type`
    / `size_bytes`, and `source_external_id` matches the Telegram
    `file_id` (AC-STO-003a).
  - `test/telegram/offset_durability.test.ts` — reproduces SP-03
    crash points deterministically against the stub.
- **Exit criteria**:
  - Stub-server end-to-end test: 50 updates inbound → 50
    `telegram_updates` rows → correct counts of `enqueued` /
    `skipped`; `telegram_next_offset` equals
    `max(update_id) + 1`.
  - Unauthorized sender never creates a `jobs` row (AC-TEL-001).
  - Duplicate `update_id` from retry never creates a second
    `jobs` row (AC-TEL-003).
- **Ledger tests introduced**: `telegram_updates.status` machine
  (HLD §6.1).

---

## Phase 4 — Queue worker + fake provider

- **Entry criteria**:
  - Phase 3 done.
- **Deliverables**:
  - `src/queue/worker.ts` — single worker loop; atomic claim
    (`BEGIN IMMEDIATE` → `UPDATE ... WHERE status='queued'`);
    dispatch by `job_type`. **Attachment capture pre-step** (PRD
    §13.5 Phase 2, HLD §7.2 step 3): before invoking the provider
    adapter, for every `storage_objects` row associated with the
    job where `capture_status = 'pending'`, call Telegram
    `getFile`, download bytes to the local store, compute
    `sha256`, detect `mime_type`, measure `size_bytes`, and in a
    single post-capture transaction set
    `capture_status = 'captured'`, populate those fields, and set
    `captured_at`. A `storage_sync` job is enqueued only for rows
    whose retention class is S3-eligible per PRD §14.1 storage_sync
    query contract. On capture failure, set
    `capture_status = 'failed'` with `capture_error_json`; no
    `storage_sync` job is enqueued for that row, and the
    provider_run continues so the user turn still commits with a
    capture-failure note.
  - `src/telegram/attachment_capture.ts` — pure capture helpers
    (no SQL writes except the single capture txn above); unit
    tests for success, getFile failure, download failure, MIME
    probe failure, and oversize-at-download.
  - `src/providers/types.ts` — `AgentRequest` / `AgentResponse`
    per PRD Appendix B plus adapter interface.
  - `src/providers/fake.ts` — deterministic test adapter that
    echoes the user message; supports configurable exit
    behaviors (ok / error / timeout / partial).
  - `test/queue/claim.test.ts` — atomic claim under contention;
    no double-claim.
  - `test/queue/state_machine.test.ts` — drives
    `queued → running → succeeded | failed | cancelled` via the
    fake adapter and asserts each transition against HLD §6.2.
  - `test/queue/attachment_capture.test.ts` — AC-STO-003b:
    success fills `sha256` / `mime_type` / `size_bytes` and flips
    `capture_status = 'captured'`; injected `getFile` error leaves
    `capture_status = 'failed'` with redacted `capture_error_json`
    and **no** `storage_sync` job; provider_run still reaches a
    terminal state in both cases.
- **Exit criteria**:
  - A seeded job flows from `queued` to `succeeded` via the fake
    provider and produces a `turns` row with `role='assistant'`.
  - `cancelled` and `failed` paths exercise the expected
    transitions.
  - Only one job is `running` at a time.
  - For a job that owns a `storage_objects` row inserted in
    Phase 3, the worker's capture pre-step produces either
    `capture_status = 'captured'` with populated bytes/hash/MIME
    or `capture_status = 'failed'` with `capture_error_json`;
    neither path mutates `jobs.status` back to `queued`.
- **Ledger tests introduced**: `jobs.status` machine (HLD §6.2)
  except `interrupted` (added in Phase 10); `storage_objects`
  capture sub-machine (`pending → captured | failed`, independent
  of the sync `status` column).

---

## Phase 5 — Outbound notifications + retry

- **Entry criteria**:
  - Phase 4 done.
- **Deliverables**:
  - `src/telegram/outbound.ts` — `sendMessage` executor; splits
    payload into chunks per Telegram limits; 429 `retry_after`
    handling; creates the `outbound_notifications` row **and** its
    `chunk_count` `outbound_notification_chunks` rows atomically
    in the same SQLite transaction (PRD Appendix D invariants;
    HLD §6.3, §7.10); sends only chunks with
    `status IN ('pending', 'failed')` and records the resulting
    `telegram_message_id` on each chunk row; **never** resends a
    chunk whose `status = 'sent'`.
  - `src/queue/notification_retry.ts` — retry loop that selects
    `outbound_notification_chunks` where
    `status IN ('pending', 'failed')` and retry budget is not
    exhausted; rolls up `outbound_notifications.status` from the
    chunk-row state only (derived, never mutated independently);
    does not touch `provider_runs.status` or `jobs.status`
    (AC-NOTIF-001, AC-STO-002).
  - Notification creation wired into `src/queue/worker.ts`:
    terminal job transitions insert the parent
    `outbound_notifications` row **and** the per-chunk ledger in
    the same txn, with a deterministic `payload_hash`.
  - `test/notifications/state_machine.test.ts` — full
    `pending → sent` and `pending → failed → pending → sent`
    paths at the parent level; duplicate
    `(job_id, notification_type, payload_hash)` returns the
    existing parent row (and its existing chunk rows).
  - `test/notifications/chunk_ledger.test.ts` — **per-chunk ledger
    coverage** (TEST-NOTIF-CHUNK-001, AC-NOTIF-003, AC-NOTIF-004,
    AC-NOTIF-005):
    - Parent `outbound_notifications` row and its N
      `outbound_notification_chunks` rows are inserted
      atomically; rolling back the txn removes all N+1 rows.
    - With a 4-chunk response, chunks 1–2 send successfully and
      chunk 3 fails: retry **only** re-sends chunk 3 (and any
      later `pending`/`failed` chunks) — chunks 1–2 are not
      re-sent, and the stub Telegram server records no duplicate
      `sendMessage` for them.
    - `outbound_notifications.status` flips to `sent` **only
      after** every chunk row reaches `status = 'sent'`; while
      any chunk is `pending` or `failed` the parent remains
      non-terminal.
    - `provider_runs.status` / `jobs.status` do not move off
      `succeeded` when a chunk is `failed`.
  - `test/notifications/splitting.test.ts` — long responses are
    split across multiple `sendMessage` calls; each call
    populates the corresponding chunk row's
    `telegram_message_id`, and the parent row's
    `telegram_message_ids_json` is derived from the chunk roll-up.
- **Exit criteria**:
  - A fake-provider job `succeeds` and the user receives one or
    more chunks via the stub Telegram server; each chunk has a
    matching `outbound_notification_chunks` row.
  - Duplicate notifications are prevented by the idempotency
    triple at the parent level; chunk re-sends for an already
    `sent` chunk are impossible by construction.
  - Telegram outage simulation leaves only the affected chunk
    rows in `pending` / `failed`; the next cycle re-sends only
    those chunks and the parent roll-up advances to `sent`.
- **Ledger tests introduced**:
  - `outbound_notifications.status` derived roll-up (HLD §6.3).
  - `outbound_notification_chunks.status` per-chunk machine
    (`pending → sent`, `pending → failed → pending → sent`).
  - `provider_runs.status` / `jobs.status` independence from
    chunk failure (AC-STO-002, AC-NOTIF-001).

---

## Phase 6 — Walking Skeleton gate ✦

This is a **gate**, not a coding phase. The work done in Phases 1–5
is exercised end-to-end with a fake provider on a staging host.

- **Entry criteria**:
  - Phases 1–5 done.
- **Verification procedure** (playbook §5.5):
  1. Deploy the service with the fake provider.
  2. From the authorized Telegram account, send a text message.
  3. Confirm: `telegram_updates` row → `jobs` row → `turns`
     row → `outbound_notifications` sent → reply visible in
     Telegram.
  4. Restart the service mid-run; confirm recovery semantics are
     acceptable even though the full recovery logic lands in
     Phase 10 (running jobs may fail loudly; that is fine
     here).
  5. Send an attachment; confirm a `storage_objects` row appears
     immediately with `capture_status = 'pending'` and NULL
     `sha256` / `mime_type` / `size_bytes` (AC-STO-003a), and
     that after the worker capture pre-step the same row
     transitions to `capture_status = 'captured'` with those
     fields populated (AC-STO-003b). Also run the simulated
     capture-failure path and confirm the row ends at
     `capture_status = 'failed'` without enqueuing a
     `storage_sync` job.
- **Exit criteria** (gate pass):
  - Steps 2–5 observed; no panic; no unredacted payload in any
    log or row.
  - All ledger tests introduced in Phases 3–5 pass on CI.
- **Output**: a short "walking skeleton report" in
  `docs/08_DECISION_REGISTER.md` if any deviation from PRD/HLD was
  discovered; otherwise a one-line note.

---

## Phase 7 — Claude provider adapter

- **Entry criteria**:
  - Phase 6 passed.
  - SP-04, SP-05, SP-06, SP-07 passed.
- **Deliverables**:
  - `src/providers/claude.ts` — spawn (argv-only, `detached:
    true`), run, teardown; conversational + advisory profiles
    (HLD §8.1).
  - `src/providers/stream_json.ts` — line reader, redaction,
    parser with `final_text` assembly; parser-fallback path per
    PRD §16.3 and HLD §8.3.
  - `src/providers/subprocess.ts` — HLD §14 teardown orchestration
    (SIGTERM → grace → SIGKILL on process group; `AbortSignal`
    wiring; `cancelled_after_start` marker).
  - `test/providers/parser.test.ts` — runs against
    `test/fixtures/claude-stream-json/*` from SP-04.
  - `test/providers/subprocess.test.ts` — exercises teardown
    scenarios using a bash subject (mirrors SP-07).
- **Exit criteria**:
  - A real Claude run produces a `turns` row (AC-JOB-001, AC-TEL-002).
  - Raw stream lines land in `provider_raw_events` only after
    redaction (AC-PROV-001, AC-SEC-001).
  - Parser fallback produces `final_text` on a forcibly-truncated
    fixture (AC-PROV-005).
  - Subprocess teardown always leaves no survivor (AC-PROV-004, AC-PROV-006).
- **Ledger tests introduced**: populates `provider_runs`,
  `provider_raw_events`, `turns`; no new state machine but
  exercises `jobs.status` end-to-end with the real provider.

---

## Phase 8 — Context builder + packer + memory summary

- **Entry criteria**:
  - Phase 7 done.
- **Deliverables**:
  - `src/context/builder.ts` — assemble slots per PRD §12.4–12.5.
  - `src/context/packer.ts` — pack within token budget; drop
    order per HLD §10.3; produce `provider_runs.injected_
    snapshot_json`.
  - `src/context/token_estimator.ts` — PRD §12.6 heuristic.
  - `src/memory/summary.ts` — summary generation under advisory
    profile; provenance + confidence per PRD §12.2–12.3. Auto-
    trigger gating from DEC-019 (turn / token / age + 8-turn
    throttle) lands here.
  - `src/memory/provenance.ts` — provenance helpers.
  - `src/memory/items.ts` — `memory_items` writer. Inserts
    candidates from summary output; applies supersede semantics
    from `commands/correct` (HLD §6.5: old row → `superseded`
    in the **same txn** as the new row's insert).
  - `test/context/packer.test.ts` — budget overflow triggers the
    documented drop order and records the result; `superseded`
    and `revoked` `memory_items` are never injected (AC-MEM-004).
  - `test/memory/summary.test.ts` — `/summary` on a sample
    session produces a schema-valid `memory_summaries` row and
    a local markdown/jsonl file; long-term items respect
    provenance gate.
  - `test/memory/correction.test.ts` — `/correct` inserts a new
    `memory_items` row with `supersedes_memory_id` set and
    flips the prior row to `superseded` in the same transaction
    (AC-MEM-004).
- **Exit criteria**:
  - `resume_mode` vs `replay_mode` recorded on every
    `provider_runs` row (AC test per HLD §10.2).
  - `prompt_overflow` error surfaces when even the minimum
    prompt does not fit.
  - `/summary` works end-to-end with Claude under the advisory
    profile (AC-PROV-003, PRD §12.3).
- **Ledger tests introduced**: writes to `memory_summaries`.

---

## Phase 9 — Storage sync (S3)

- **Entry criteria**:
  - Phase 8 done.
  - SP-08 passed.
- **Deliverables**:
  - `src/storage/local.ts` — filesystem writer with the layout
    from PRD Appendix A and HLD §12.
  - `src/storage/s3.ts` — Bun.S3Client wrapper (or
    `@aws-sdk/client-s3` fallback per 08_DECISION_REGISTER.md).
  - `src/storage/sync.ts` — sync loop; error classification per
    HLD §12.3; retries with bounded attempts.
  - `src/storage/objects.ts` — `storage_objects` row authoring
    helpers.
  - `test/storage/roundtrip.test.ts` — put/get/list/delete
    round trip (against the SP-08 dev bucket in CI-optional
    mode).
  - `test/storage/state_machine.test.ts` —
    `pending → uploaded` on success;
    `pending → failed → pending → uploaded` on transient
    failure; `ephemeral` never reaches S3; `long_term`
    pre-conditions enforced.
- **Exit criteria**:
  - A session memory snapshot is uploaded to S3 after
    `/summary` (AC-MEM-001).
  - `storage_sync` failure does not roll back an owning job
    (AC-STO-001, AC-STO-002, AC-STO-006).
  - Object keys match PRD §12.8.4 (AC-SEC-002).
- **Ledger tests introduced**: `storage_objects.status` machine
  (HLD §6.4).

---

## Phase 10 — Commands + /doctor + startup recovery

- **Entry criteria**:
  - Phase 9 done.
- **Deliverables**:
  - `src/commands/status.ts` — `/status` per PRD §14.1 output
    contract (DEC-015).
  - `src/commands/cancel.ts` — `/cancel` per HLD §7.4.
  - `src/commands/summary.ts`, `src/commands/end.ts` — per
    DEC-019 + HLD §11.1.
  - `src/commands/provider.ts` — `/provider` (claude only; stub
    for gemini/codex/ollama).
  - `src/commands/doctor.ts` — checks from HLD §16.1 with the
    `quick` / `deep` category tag per DEC-017; includes
    `bootstrap_whoami_guard` (DEC-009) and the S3 smoke (AC-OBS-001).
  - `src/commands/whoami.ts` — respects BOOTSTRAP_WHOAMI and
    writes the 30-minute expiry timestamp on enablement.
  - `src/commands/save.ts` — `/save_last_attachment` + natural-
    language synonyms (ADR-0006). Promotes `retention_class`
    to `long_term`; creates `memory_artifact_links` with
    `provenance = user_stated`.
  - `src/commands/forget.ts` — `/forget_last`,
    `/forget_session`, `/forget_artifact <id>`, `/forget_memory
    <id>` (DEC-006). Tombstone semantics per HLD §6.4 / §6.5;
    never hard-deletes rows.
  - `src/commands/correct.ts` — `/correct <id>` and the
    natural-language path ("정정:" / "not X but Y"). Inserts a
    new `memory_items` row with `supersedes_memory_id` pointing
    at the prior row; flips the prior row to `superseded` in
    the same transaction (AC-MEM-004).
  - `src/startup/recovery.ts` — HLD §15 boot sequence:
    `running → interrupted`, `safe_retry` re-queue, orphan
    sweep, boot doctor. Emits user-visible Telegram restart
    messages per DEC-016 / PRD §8.4.
  - `test/commands/*` — per-command tests, including:
    - `save.test.ts` — command + natural-language match +
      negative (no save intent → no promotion).
    - `forget.test.ts` — each scope; verifies tombstone
      transitions and that `storage/sync` issues the S3
      `DELETE` for `deletion_requested` (AC-MEM-003).
    - `correct.test.ts` — atomic supersede invariant (AC-MEM-004).
  - `test/startup/recovery.test.ts` — reproduces mid-run crash,
    asserts HLD §15 guarantees (AC-JOB-002), and checks the DEC-016
    messaging policy (silent when there is no user-visible
    impact; user-visible notice otherwise).
  - `test/doctor.test.ts` — every check reports `category`,
    `duration_ms`, `ok`/`warn`/`fail` deterministically; AC-OBS-001
    S3 smoke passes against SP-08's dev bucket.
- **Exit criteria**:
  - All commands listed in PRD §8.1 function. Phase 10 exercises
    the P0 acceptance criteria listed in
    [`docs/06_ACCEPTANCE_TESTS.md`](./06_ACCEPTANCE_TESTS.md)
    under the `TEL`, `JOB`, `PROV`, `MEM`, `STO`, and `OBS`
    domains; exhaustive coverage is validated by the P0
    Acceptance Test gate at phase end.
  - Startup recovery does not double-charge attempts on
    interruption and matches DEC-016 messaging.
  - `/doctor` passes every `quick` and `deep` check against the
    staging host.
- **Ledger tests introduced**: adds `interrupted` to
  `jobs.status` coverage; exercises `storage_objects` soft-delete
  (`deletion_requested → deleted`) and `memory_items`
  (`active → superseded`, `active → revoked`).

---

## Phase 11 — systemd unit + RUNBOOK handoff

- **Entry criteria**:
  - Phase 10 done.
  - P0 Acceptance Tests (`docs/06_ACCEPTANCE_TESTS.md`) all
    green on the staging host.
- **Deliverables**:
  - `deploy/systemd/actwyn.service` — `Type=simple`,
    `KillMode=control-group`, restart on failure,
    `EnvironmentFile` for secrets, non-root user (PRD §15).
  - `deploy/systemd/README.md` — install/uninstall notes.
  - `docs/05_RUNBOOK.md` — operator procedures (deploy, restart,
    incident, S3 degraded, backup, key rotation, redaction
    incident).
  - `deploy/install.sh` — idempotent installer for the service
    user, paths, and unit file.
- **Exit criteria**:
  - Clean-install on a fresh host reaches a green `/doctor`
    without manual steps beyond populating the
    `EnvironmentFile`.
  - A scheduled reboot of the host leaves the service healthy
    within the documented recovery window.
- **Ledger tests introduced**: none; this phase is packaging.

---

## Cross-cutting work

Some work spans phases and is tracked here rather than pinning it
to a single phase.

- **CI** (starts Phase 1, continues every phase):
  - Lint, type-check, unit tests, redaction grep-check.
  - Ledger integration tests: each state-machine test added in
    its owning phase stays green in later phases.
  - Spike re-runs gated by the triggers table in
    `docs/03_RISK_SPIKES.md` §Re-run triggers.
- **Observability** (Phase 1 start, polished during Phase 10):
  - Structured logs per HLD §13.3; correlation by `job_id`.
- **Docs sync** (every phase):
  - If implementation diverges from HLD/PRD, amend the doc
    before closing the phase (playbook §7.4).
- **08_DECISION_REGISTER.md updates** (as needed):
  - Any spike deviation, dependency change, or policy tweak
    triggers a `08_DECISION_REGISTER.md` entry.

## Risk register (rolled up)

| Risk                                          | Mitigation                                                 |
| --------------------------------------------- | ---------------------------------------------------------- |
| Claude CLI output shape changes mid-P0        | Spike fixtures + parser fallback; re-run SP-04 on bump.    |
| Hetzner S3 quirks block Bun.S3Client          | Fallback to `@aws-sdk/client-s3` documented in 08_DECISION_REGISTER.md.  |
| Subprocess survives cancel / restart          | SP-07 proves process-group teardown; systemd `KillMode=control-group` as last resort. |
| Secret leaks into durable row                 | Single-writer redactor + grep CI + Sev-A runbook entry.    |
| Retention drift (local disk fills up)         | Q10 durations + `/doctor` disk check + Q23 thresholds.     |
| Over-scoped P0                                | Phase gates; walking-skeleton-first discipline.            |

## Schedule sketch (informational only)

Not a commitment — project is single-operator cadence.

| Week   | Focus                                  |
| ------ | -------------------------------------- |
| 1      | Phase 1–2 + spikes SP-01..SP-03        |
| 2      | Phase 3–4 + spike SP-02 if not done    |
| 3      | Phase 5 + Phase 6 gate                 |
| 4      | Spikes SP-04..SP-07 + Phase 7          |
| 5      | Phase 8                                |
| 6      | Spike SP-08 + Phase 9                  |
| 7      | Phase 10 + acceptance test dry runs    |
| 8      | Phase 11 + P0 acceptance gate          |

Adjust aggressively; the phase order is fixed, the weeks are not.
