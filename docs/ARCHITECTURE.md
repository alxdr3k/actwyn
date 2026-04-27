# Architecture

> Status: thin current-state overview · Owner: project lead ·
> Last updated: 2026-04-27
>
> This is a short pointer doc. For why decisions were made, see
> `docs/adr/` (ADR-0001 … ADR-0013). For acceptance contracts and
> full P0 design rationale, see `docs/PRD.md` and `docs/02_HLD.md`.
> For the architectural authority of the DB-native AI-first
> Judgment System direction, see `docs/JUDGMENT_SYSTEM.md` (Phase 0 /
> 0.5 design record; not implemented). For current schema and code
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
| DB-native AI-first Judgment System (Phase 1A+)    | schema skeleton + proposal repository + proposal review repository + source/evidence-link repository + commit/activation repository + unregistered tool contracts (not runtime-wired) |
| Vector / graph derived projections                | planned     |
| second-brain repo as canonical runtime memory     | not planned (history/seed only) |
| Obsidian / Markdown active write path             | not planned |

The Phase 0 / 0.5 Judgment System architectural design has landed on
`main` as ADR-0009 through ADR-0013 plus `docs/JUDGMENT_SYSTEM.md`.
Per **DEC-037** (Implementation Documentation Lifecycle Policy),
those documents are the architectural authority for *why* the
direction was chosen but are **not** the source of truth for
implemented runtime behavior.

Phase 1A.1 landed the **judgment schema skeleton**:
`migrations/004_judgment_skeleton.sql` (5 tables + FTS5),
`src/judgment/types.ts`, and `src/judgment/validators.ts`.

Phase 1A.2 landed a **proposal-only write surface**:
`src/judgment/repository.ts` (`proposeJudgment`) and a local
**unregistered typed-tool contract** `src/judgment/tool.ts`
(`judgment.propose`). The repository can create rows with
`lifecycle_status = proposed` / `approval_state = pending` /
`activation_state = history_only` only.

Phase 1A.3 has added **proposal review transitions**:
`src/judgment/repository.ts` now also exports
`approveProposedJudgment` and `rejectProposedJudgment`, and
`src/judgment/tool.ts` now also exports `JUDGMENT_APPROVE_TOOL` /
`JUDGMENT_REJECT_TOOL` and `executeJudgmentApproveTool` /
`executeJudgmentRejectTool`. Approval sets `approval_state =
approved` but does **not** activate or make the judgment
context-visible (`lifecycle_status` remains `proposed`,
`activation_state` remains `history_only`). Rejection sets
`approval_state = rejected` / `lifecycle_status = rejected` /
`activation_state = excluded` for audit purposes. None of these
tools are registered anywhere in the runtime.

Phase 1A.4 has added **source recording and evidence-link surfaces**:
`src/judgment/repository.ts` now also exports
`recordJudgmentSource` and `linkJudgmentEvidence`, and
`src/judgment/tool.ts` now also exports
`JUDGMENT_RECORD_SOURCE_TOOL` / `JUDGMENT_LINK_EVIDENCE_TOOL` and
`executeJudgmentRecordSourceTool` / `executeJudgmentLinkEvidenceTool`.
Source recording inserts a `judgment_sources` row and appends a
`judgment.source.recorded` event (`judgment_id = NULL`). Evidence
linking inserts a `judgment_evidence_links` row, updates the
denormalized `source_ids_json` / `evidence_ids_json` arrays on
`judgment_items`, and appends a `judgment.evidence.linked` event.
**Evidence linking does not activate, approve, commit, or make a
judgment context-visible.** None of these tools are registered
anywhere in the runtime.

Phase 1A.5 has added the **commit / activation local surface**:
`src/judgment/repository.ts` now also exports
`commitApprovedJudgment`, and `src/judgment/tool.ts` now also
exports `JUDGMENT_COMMIT_TOOL` and `executeJudgmentCommitTool`.
Commit requires `lifecycle_status=proposed`, `approval_state=approved`,
`activation_state=history_only`, `retention_state=normal`, and at
least one row in `judgment_evidence_links`. On success it sets
`lifecycle_status=active`, `activation_state=eligible`,
`authority_source=user_confirmed`, syncs the denormalized
`source_ids_json` / `evidence_ids_json` arrays from canonical link
rows, and appends a `judgment.committed` event — all in one
transaction. **Active/eligible rows can now exist in the DB, but
runtime context still does not read them: no Context Compiler, no
provider prompt integration, no Telegram command, and no memory
promotion path exists yet.** The commit tool is not registered
anywhere in the runtime.

No Control Gate, no Context Compiler, no context/provider runtime
hookup, and no memory-promotion path exists yet — those remain
Phase 1A+ work.

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
  module (see `docs/02_HLD.md` §5.1 writer map).
- **Memory boundary** — `src/memory/*` writes `memory_summaries` and
  `memory_items` from session output. Provenance + confidence come
  from this module.
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
- **Architecture decisions** — `docs/adr/*` (ADR-0001 … ADR-0013
  accepted on `main`; ADR-0009 … ADR-0013 cover the Judgment System
  direction; Phase 1A.1 through Phase 1A.5 are implemented — full
  Judgment System runtime is not implemented; runtime wiring remains
  future work).
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
- `src/context/*` — prompt builder + packer (read-only).
- `src/memory/*` — summary, items, provenance.
- `src/storage/*` — local FS, S3 transport, sync handler (driven by
  `storage_sync` jobs from the worker), MIME probe.
- `src/observability/*` — events emitter and the single redactor.
- `src/commands/*` — `/cancel`, `/correct`, `/doctor`, `/forget`,
  `/provider`, `/save_last_attachment`, `/status`, `/summary`,
  `/whoami`.
- `src/startup/recovery.ts` — boot-time reconciliation of stale
  `running` jobs (force `interrupted`, requeue if `safe_retry`, kill
  orphan PIDs); offset fast-forward; one-shot `storage_sync` for
  `failed` / `delete_failed` rows only.
- `src/judgment/*` — Phase 1A types, validators, proposal + proposal
  review + source/evidence-link + commit/activation repository, and
  unregistered `judgment.propose` / `judgment.approve` /
  `judgment.reject` / `judgment.record_source` /
  `judgment.link_evidence` / `judgment.commit` tool contracts.
  Not wired into any runtime module; see §Phase 1A below.

## Phase 1A current slice and planned architecture

Phase 1A.1 landed the **judgment schema skeleton** (5 tables + FTS5
virtual table in `migrations/004_judgment_skeleton.sql`) plus
`src/judgment/types.ts` and `src/judgment/validators.ts`.

Phase 1A.2 landed the **proposal-only write surface**:
`src/judgment/repository.ts` (`proposeJudgment`) and the local
**unregistered typed-tool contract** `src/judgment/tool.ts`
(`judgment.propose`). The repository writes only rows with
`lifecycle_status = proposed` / `approval_state = pending` /
`activation_state = history_only`.

Phase 1A.3 landed the **proposal review transitions**:
`approveProposedJudgment` and `rejectProposedJudgment` in
`src/judgment/repository.ts`, and `JUDGMENT_APPROVE_TOOL` /
`JUDGMENT_REJECT_TOOL` / `executeJudgmentApproveTool` /
`executeJudgmentRejectTool` in `src/judgment/tool.ts`. These are
local, unregistered DB operations only. Approval/rejection review
exists only as local unregistered DB operations:

- Approval does **not** activate a judgment.
- Approved judgments remain `lifecycle_status = proposed` and
  `activation_state = history_only`.
- Rejected judgments become `lifecycle_status = rejected` and
  `activation_state = excluded`.
- Active/eligible write path exists only through local unregistered
  `commitApprovedJudgment` (Phase 1A.5). Active/eligible rows are
  not context-visible because runtime context does not read them.

The DB-native AI-first Judgment System direction (ADR-0009 …
ADR-0013, `docs/JUDGMENT_SYSTEM.md`) defines the following
components. **Implemented** (Phase 1A.1 / 1A.2 / 1A.3 / 1A.4 / 1A.5):

- **Schema skeleton** — `judgment_sources`, `judgment_items`,
  `judgment_evidence_links`, `judgment_edges`, `judgment_events`,
  `judgment_items_fts` in migration 004.
- **Proposal repository** — `src/judgment/repository.ts`
  (`proposeJudgment`). Writes `judgment_items` and
  `judgment_events` with `lifecycle_status=proposed` /
  `approval_state=pending` / `activation_state=history_only`.
- **Proposal review repository** — `src/judgment/repository.ts`
  (`approveProposedJudgment`, `rejectProposedJudgment`). Review
  transitions only. Approval does not activate. Approved judgments
  remain `lifecycle_status=proposed` / `activation_state=history_only`.
- **Source recording** — `src/judgment/repository.ts`
  (`recordJudgmentSource`). Writes `judgment_sources` +
  `judgment_events`. Does not create or mutate `judgment_items`.
- **Evidence linking** — `src/judgment/repository.ts`
  (`linkJudgmentEvidence`). Writes `judgment_evidence_links`,
  updates denormalized arrays on `judgment_items`, appends
  `judgment.evidence.linked` event. Does not activate or approve.
- **Commit / activation** — `src/judgment/repository.ts`
  (`commitApprovedJudgment`). Requires approved+evidence, sets
  `lifecycle_status=active` / `activation_state=eligible` /
  `authority_source=user_confirmed`, syncs denormalized arrays,
  appends `judgment.committed`. Active/eligible rows can now exist
  in DB, but runtime context does not read them — no Context
  Compiler or provider integration exists.
- **Unregistered typed-tool contracts** — `src/judgment/tool.ts`
  (`judgment.propose`, `judgment.approve`, `judgment.reject`,
  `judgment.record_source`, `judgment.link_evidence`,
  `judgment.commit`). Not imported from any runtime module.

`judgment_edges` has no runtime writer yet.

**Not implemented** (beyond Phase 1A.5):

- `Control Gate` evaluators and the `control_gate_events` /
  `control_plane_events` ledger (table name open per
  `docs/JUDGMENT_SYSTEM.md` §Implementation Readiness) — **not
  implemented**.
- `Tension` telemetry and the `tensions` table — **not
  implemented**.
- `ReflectionTriageEvent` and the `reflection_triage_events` ledger
  — **not implemented**.
- `current_operating_view` projection (DEC-036) — **not
  implemented**.
- Vector and graph derived projections — **not implemented**.
- Further typed tools (`supersede` / `revoke` / `expire` /
  `query` / `explain` / `update_current_state`) and Critique Lens
  v0.1 integration (ADR-0013) — **not implemented**.
- Provider / context / memory-promotion runtime integration —
  **not implemented**. The judgment tables are not read or written
  by `src/providers/*`, `src/context/*`, `src/queue/worker.ts`,
  `src/memory/*`, or `src/telegram/*`. None of the judgment tools
  are wired into any of these modules.

These are listed so AI coding agents do not mistake design
documents for implemented behavior. Phase 1A.1 through Phase 1A.5
have landed. Local commit/activation exists. **Supersede, revoke,
expire, query, explain, runtime context integration, and Control
Gate work remain future scope.** See `docs/RUNTIME.md` and
`docs/DATA_MODEL.md` for how the implemented slice sits next to
the runtime, and `docs/JUDGMENT_SYSTEM.md` §Implementation
Readiness for the broader Phase 1A scope.

## Existing implementation re-classification (2026-04 salvage audit)

The 2026-04 implementation salvage audit
(`docs/design/salvage-audit-2026-04.md`) classified the
pre-Judgment-System modules. Headlines:

- **No DELETE candidates.** Most P0 runtime survives.
- **One REPLACE candidate**: `src/context/builder.ts`. Its slot
  taxonomy and `MemoryItemSlot.provenance` / `.status='active'`
  input contract are incompatible with `current_operating_view` /
  `lifecycle_status` / `activation_state`. Replaced by a Stage 4
  Context Compiler in a later PR; the file stays in tree until
  Compiler stabilises.
- **ADAPT cluster** (`src/queue/worker.ts`,
  `src/memory/summary.ts`, `src/memory/provenance.ts`,
  `src/memory/items.ts`). The risk is the
  *summary → memory_items.status='active' → worker context
  injection* loop: `assistant_generated` / `inferred` summary
  items currently land in active memory and are re-injected as
  the next prompt input. Judgment direction requires those items
  to remain proposal-only — see audit §5.1 and Q-027.
- **JSONL / MD filesystem sidecar** in `src/queue/worker.ts`
  (`memory/sessions/<session_id>.jsonl`,
  `memory/personal/YYYY-MM-DD.md`) is **not** an Obsidian /
  GitHub-repo runtime dependency, but its role under the new
  direction is policy-pending — see audit §5.3.
- Q-027 (`memory_items` ↔ `judgment_items`) and the
  `docs/JUDGMENT_SYSTEM.md` §Relationship to memory layer
  section both stand: judgment is added **above** ADR-0006's
  memory layer, not in place of it.

The audit performs no code changes. The full per-module
classification table lives in the audit itself
(`docs/design/salvage-audit-2026-04.md` §4). `docs/CODE_MAP.md`
records the salvage status only for modules that were previously
flagged `needs audit` or that the follow-up PR sequence directly
affects (memory/*, context/*, queue/worker.ts). The follow-up PR
sequence is in audit §6.
