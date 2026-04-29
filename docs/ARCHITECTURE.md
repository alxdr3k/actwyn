# Architecture

> Status: thin current-state overview · Owner: project lead ·
> Last updated: 2026-04-29
>
> This file is an index, not an implementation log. Replace
> current-state summaries; do not append phase history.
>
> This is a short pointer doc. For why decisions were made, see
> `docs/adr/` (ADR-0001 … ADR-0017). For acceptance contracts and
> full P0 design rationale, see `docs/PRD.md` and `docs/02_HLD.md`.
> For the architectural authority of the DB-native AI-first
> Judgment System direction, see `docs/JUDGMENT_SYSTEM.md` (Phase 0 /
> 0.5 design record; Phase 1A.1–1A.8 implemented; Phase 1B.1–1B.5
> runtime-wired). For roadmap/status, see
> `docs/04_IMPLEMENTATION_PLAN.md`. For current schema and code
> layout, see `docs/DATA_MODEL.md` and `docs/CODE_MAP.md`.

## Status

| Area                                              | Status      |
| ------------------------------------------------- | ----------- |
| Personal Agent P0 vertical (Telegram + Claude)    | implemented |
| Bun + TypeScript runtime, single systemd service  | implemented |
| SQLite (WAL) state of record                      | implemented |
| Hetzner Object Storage (S3) artifact archive      | implemented |
| Redaction at the persistence boundary             | implemented |
| Memory summaries with provenance + confidence     | implemented |
| Telegram attachment two-phase capture             | implemented |
| DB-native AI-first Judgment System (Phase 1A+)    | Phase 1A.1–1A.8 locally implemented; **Phase 1B.1–1B.5 runtime-wired**: Control Gate telemetry on non-system provider_run, active judgment context injection, Telegram read commands, Telegram write commands, and Telegram retirement commands |
| Vector / graph derived projections                | planned     |
| second-brain repo as canonical runtime memory     | not planned (history/seed only) |
| Obsidian / Markdown active write path             | not planned |

The Judgment System direction is committed by ADR-0009 … ADR-0013,
ADR-0015, ADR-0017, and `docs/JUDGMENT_SYSTEM.md`; ADR-0017 refines
memory-to-judgment convergence. Per DEC-037, those records explain
*why*; implemented behavior is defined by code, migrations, and tests.

Current Judgment slice:

- Phase 1A.1–1A.8: schema, local repository operations, typed-tool
  contracts, query/explain, retirement operations, and Control Gate
  substrate are implemented under `src/judgment/*`.
- Phase 1B.1–1B.5: runtime wiring is limited to Control Gate telemetry
  in `src/queue/worker.ts`, active/eligible/global judgment context
  injection, Telegram read commands (`/judgment`, `/judgment_explain`),
  Telegram write commands (`/judgment_propose`, `/judgment_approve`,
  `/judgment_reject`, `/judgment_source`, `/judgment_link`,
  `/judgment_commit`), and Telegram retirement commands
  (`/judgment_supersede`, `/judgment_revoke`, `/judgment_expire`).
- Phase 1C.2a: successful `summary_generation` structured output is
  converted into proposed Judgment rows only; those rows are not
  approved, evidence-linked, committed, activated, or exposed as
  provider tools.
- Phase 1C.2b: summary completion notifications surface the count,
  short IDs, and review commands for auto-proposed summary Judgments.
- Judgment typed-tool contracts remain unregistered as provider tools.
- Phase 1C.2c / DEC-041: freeform provider-output extraction is not
  an MVP automatic proposal source. Any future provider-output proposal
  path needs a new explicit post-run analyzer leaf.
- Provider tool registration, `current_operating_view`, and
  vector/graph projections are future scope.
- ADR-0017 resolves Q-027: context-visible durable behavioral baselines
  converge on `judgment_items`. The first runtime slice is implemented:
  summary extraction no longer writes active `memory_items`; summary
  output creates proposal-only Judgment rows; context packing keeps
  active/eligible judgments above memory recall.

## System overview

actwyn is a single-user Telegram personal agent. One systemd service
runs the Bun process. `src/main.ts` launches **two top-level loops
concurrently** — the Telegram long-poll loop and the job worker
loop. Storage sync and notification retry are not separate top-level
loops; they are worker-owned job handlers (`storage_sync` and
`notification_retry` `jobs.job_type`s) that the worker dispatches
alongside `provider_run` and `summary_generation`. SQLite (WAL) is
the source of truth for runtime state. Hetzner Object Storage holds
durable artifacts asynchronously.

```
Telegram long-poll  ──┐
                      ▼
              telegram_updates (state machine)
                      ▼
                    jobs        (state machine; one provider_run at a time)
                      ▼
          provider_runs + turns (Claude CLI subprocess)
                      ▼
             outbound_notifications + chunks (state machine)
                      ▼
                Telegram sendMessage

  storage_objects (state machine) ──► Hetzner Object Storage (async)
```

Detailed module / state-machine diagrams live in `docs/02_HLD.md`.

## Major boundaries

- **Telegram boundary** — `src/telegram/*` owns inbound parsing,
  authorization, and outbound delivery. No other module talks to the
  Telegram API directly.
- **Provider boundary** — `src/providers/*` owns the Claude CLI
  subprocess, stream-json parsing, and resume/replay decision. No
  other module spawns providers.
- **Storage / DB boundary** — `src/db.ts` owns the SQLite handle;
  `src/storage/*` owns local FS and S3. Each table has a single-writer
  module (see `docs/DATA_MODEL.md` §Single-writer map; `docs/02_HLD.md` §5.1 has historical reasoning).
- **Memory boundary** — `src/memory/*` writes `memory_summaries` and
  owns the `memory_items` writer primitives used by correction flows.
  Summary output remains memory-plane recall/candidate material and
  does not auto-promote to active `memory_items`.
- **Redaction boundary** — `src/observability/redact.ts` is the only
  module allowed to define redaction patterns or emit `[REDACTED:*]`
  placeholders. Enforced at lint time by
  `scripts/check-single-redactor.ts`.
- **External docs / repo boundary** — the second-brain repo and
  Obsidian are not on the active runtime write path in P0. Any future
  Markdown / GitHub publishing is a derived export, not a source of
  truth.

## Canonical sources

- **Implemented behavior** — `src/`, `test/`, `migrations/`.
- **Active runtime state** — the SQLite database opened by
  `src/db.ts` (path resolved by `ACTWYN_DB_PATH` /
  `/var/lib/actwyn/actwyn.db` on prod).
- **Roadmap / status** — `docs/04_IMPLEMENTATION_PLAN.md` owns
  milestone, track, phase, slice, gate, status, evidence, and next
  work. `docs/context/current-state.md` is the compressed first-read
  view.
- **Architecture decisions** — `docs/adr/*` (ADR-0001 … ADR-0017
  accepted on `main`; ADR-0009 … ADR-0013 + ADR-0015 cover the
  Judgment System direction, and ADR-0017 resolves memory-to-judgment
  convergence; Phase 1A.1–1A.8 and Phase 1B.1–1B.5 implemented —
  DEC-038 records the initial Phase 1B.1–1B.3 runtime wiring decision;
  DEC-039 records the MVP convergence implementation posture; provider
  tool registration remains future work;
  ADR-0016 records the future internal task-runner security boundary,
  not implemented runtime behavior).
- **Tactical decisions and open questions** —
  `docs/08_DECISION_REGISTER.md`, `docs/07_QUESTIONS_REGISTER.md`
  (DEC-037 records the documentation lifecycle policy this set of
  current-state docs implements; Q-063 tracks the docs-structure
  follow-up that produced them).
- **Acceptance contract for the P0 vertical** —
  `docs/06_ACCEPTANCE_TESTS.md` plus PRD §17.
- **Judgment System Phase 0 / 0.5 design** —
  `docs/JUDGMENT_SYSTEM.md`. Architectural authority for the
  direction; **not** authority for runtime behavior.

The second-brain GitHub repo is **not** a canonical runtime store. It
may serve as a future seed, export target, or publishing surface, but
not as authority for what the agent has remembered.

## Implemented modules

A short summary; the full file map lives in `docs/CODE_MAP.md`.

- `src/main.ts` — composition root and systemd entrypoint.
- `src/config.ts` — typed config loader (env + `config/runtime.json`).
- `src/db.ts`, `src/db/migrator.ts` — SQLite handle + forward-only
  migrations.
- `src/telegram/*` — long-poll, inbound classifier, outbound
  delivery, attachment metadata.
- `src/queue/worker.ts` — single job claim / dispatch loop;
  also owns the in-process attachment capture pre-step
  (`runCapturePass`) and dispatches `storage_sync` /
  `notification_retry` jobs.
- `src/queue/notification_retry.ts` — handlers + helpers for the
  `notification_retry` job_type, called from the worker loop.
- `src/providers/*` — Claude adapter, fake adapter, stream-json
  parsing, subprocess lifecycle.
- `src/context/*` — context compiler, slot builder, and packer
  (read-only).
- `src/memory/*` — summary, items, provenance.
- `src/storage/*` — local FS, S3 transport, sync handler (driven by
  `storage_sync` jobs from the worker), MIME probe.
- `src/observability/*` — events emitter and the single redactor.
- `src/commands/*` — `/cancel`, `/correct`, `/doctor`, `/forget_*`,
  `/provider`, `/save_last_attachment`, `/status`, `/summary`,
  `/end`, `/whoami`.
- `src/startup/recovery.ts` — boot-time reconciliation of stale
  `running` jobs (force `interrupted`, requeue if `safe_retry`, kill
  orphan PIDs); offset fast-forward; one-shot `storage_sync` for
  `failed` / `delete_failed` rows only.
- `src/judgment/*` — Judgment types, validators, local repository
  surfaces, typed-tool contracts, and Control Gate helpers. Runtime
  reachability is intentionally narrow; see §Judgment current slice.

## Judgment current slice

Implemented local substrate:

- Migration 004 adds `judgment_*` tables plus FTS5; migrations 005
  and 006 add `control_gate_events` with `job_id` attribution.
- `src/judgment/repository.ts` owns proposal, review, source,
  evidence, commit, query/explain, and retirement operations.
- `src/judgment/tool.ts` defines local typed-tool contracts. They are
  not registered as provider tools; `src/queue/worker.ts` imports
  executors for Telegram Judgment system commands.
- `src/judgment/control_gate.ts` owns Control Gate evaluation and
  `control_gate_events` writes.

Runtime-wired surface:

- `src/queue/worker.ts` records Control Gate telemetry before
  non-system `provider_run` jobs.
- Worker context building reads active/eligible/normal/global/time-valid
  judgment rows into the `judgment_items` slot.
- `/judgment` and `/judgment_explain <id>` expose read-only Telegram
  command output through outbound notifications.
- `/judgment_propose`, `/judgment_approve`, `/judgment_reject`,
  `/judgment_source`, `/judgment_link`, and `/judgment_commit` expose
  the proposal/review/evidence/commit write path as worker-dispatched
  Telegram system commands.
- `/judgment_supersede`, `/judgment_revoke`, and `/judgment_expire`
  expose retirement operations as worker-dispatched Telegram system
  commands.

All Judgment Telegram command output is sent through outbound
notifications and is not stored as conversation turns. DEC-041 excludes
freeform provider-output parsing as an MVP automatic proposal source.
Still future: any explicit post-run provider-output analyzer, provider
tool registration, `Tension` / `ReflectionTriageEvent`,
`current_operating_view`, and vector/graph projections.

## Salvage audit pointer

The 2026-04 salvage audit
(`docs/design/salvage-audit-2026-04.md`) concluded that most P0
runtime stays. `src/context/builder.ts` remains a REPLACE candidate
after the Stage 4 Context Compiler landing; deletion timing is tracked
by Q-066. `src/queue/worker.ts` and `src/memory/*` are ADAPT surfaces:
summary output now stays in `memory_summaries` and creates
proposal-only Judgment rows with notification visibility, while
freeform provider-output extraction is excluded for MVP by DEC-041.
Q-027 is resolved by ADR-0017: behavioral baselines converge on
`judgment_items`. See the audit for history; this file records the
current architecture only.
