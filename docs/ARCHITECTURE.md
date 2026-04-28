# Architecture

> Status: thin current-state overview · Owner: project lead ·
> Last updated: 2026-04-28
>
> This is a short pointer doc. For why decisions were made, see
> `docs/adr/` (ADR-0001 … ADR-0015). For acceptance contracts and
> full P0 design rationale, see `docs/PRD.md` and `docs/02_HLD.md`.
> For the architectural authority of the DB-native AI-first
> Judgment System direction, see `docs/JUDGMENT_SYSTEM.md` (Phase 0 /
> 0.5 design record; Phase 1A.1–1A.8 implemented; Phase 1B.1–1B.3
> runtime-wired). For current schema and code layout, see
> `docs/DATA_MODEL.md` and `docs/CODE_MAP.md`.

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
| DB-native AI-first Judgment System (Phase 1A+)    | Phase 1A.1–1A.8 locally implemented; **Phase 1B.1–1B.3 runtime-wired**: Control Gate telemetry on non-system provider_run, active judgment context injection in builder, `/judgment` + `/judgment_explain` Telegram commands |
| Vector / graph derived projections                | planned     |
| second-brain repo as canonical runtime memory     | not planned (history/seed only) |
| Obsidian / Markdown active write path             | not planned |

The Phase 0 / 0.5 Judgment System architectural design has landed on
`main` as ADR-0009 through ADR-0013 plus `docs/JUDGMENT_SYSTEM.md`;
ADR-0015 covers the Phase 1A.8 Control Gate ledger.
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
transaction. **Active/eligible rows now exist in the DB and are
read by `src/queue/worker.ts` for context injection (Phase 1B.2)
and via Telegram read commands `/judgment` / `/judgment_explain`
(Phase 1B.3).** The commit tool is not registered anywhere in the
runtime (write-path tools remain unregistered).

Phase 1A.6 has added the **query / explain local read surfaces**:
`src/judgment/repository.ts` now also exports `queryJudgments`
and `explainJudgment`, and `src/judgment/tool.ts` now also exports
`JUDGMENT_QUERY_TOOL` / `JUDGMENT_EXPLAIN_TOOL` and
`executeJudgmentQueryTool` / `executeJudgmentExplainTool`.
These are local, unregistered, read-only surfaces only:
they query or explain committed or historical judgment rows,
but they do **not** mutate any `judgment_*` table, append
`judgment_events`. Active/eligible rows are now injected into
runtime context via Phase 1B.2; see Phase 1B section below.

Phase 1A.7 added the **retirement lifecycle local surfaces**:
`src/judgment/repository.ts` now also exports `supersedeJudgment`,
`revokeJudgment`, and `expireJudgment`, and `src/judgment/tool.ts`
now also exports `JUDGMENT_SUPERSEDE_TOOL` / `JUDGMENT_REVOKE_TOOL` /
`JUDGMENT_EXPIRE_TOOL` and the corresponding `execute*` functions.

- **supersede**: marks an existing `active/eligible/approved/normal`
  judgment as superseded by another `active/eligible/approved/normal`
  judgment. Transitions old judgment to `lifecycle_status=superseded` /
  `activation_state=excluded`; updates `supersedes_json` /
  `superseded_by_json` arrays; inserts one `judgment_edges` row with
  `relation=supersedes`; appends one `judgment.superseded` event.
- **revoke**: transitions an `active/eligible/approved/normal` judgment
  to `lifecycle_status=revoked` / `activation_state=excluded`; appends
  one `judgment.revoked` event.
- **expire**: transitions an `active/eligible/approved/normal` judgment
  to `lifecycle_status=expired` / `activation_state=excluded`;
  optionally sets `valid_until`; appends one `judgment.expired` event.

None of these retirement operations register tools, call LLMs, or
trigger background processing. Retired (excluded) rows are filtered
out of the Phase 1B.2 context injection query.

Phase 1A.8 added the **Control Gate substrate**: `src/judgment/control_gate.ts`
(`evaluateTurn`, `evaluateCandidate`, `recordControlGateDecision`) and
`migrations/005_control_gate_events.sql` (append-only `control_gate_events`
table; schema version 5) + migration 006 adds `job_id` attribution (schema version 6).
The gate evaluates TurnInput / JudgmentCandidate →
ControlGateDecision (L0–L3); `direct_commit_allowed` is always false
(ADR-0012 invariant).
**Phase 1B.1**: `src/queue/worker.ts` now imports `control_gate.ts` and calls
`evaluateTurn()` + `recordControlGateDecision()` before non-system `provider_run`.

**Phase 1B.2**: `src/context/builder.ts` gains a `judgment_items` slot;
`src/queue/worker.ts` queries active/eligible/normal/global/time-valid
judgments and injects them into `buildContext()` in `replay_mode`.

**Phase 1B.3**: `/judgment` and `/judgment_explain` Telegram read commands
dispatched via `src/queue/worker.ts`.

Full Context Compiler, provider tool registration, memory-promotion path,
and Telegram write commands remain future work.

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
- **Architecture decisions** — `docs/adr/*` (ADR-0001 … ADR-0015
  accepted on `main`; ADR-0009 … ADR-0013 + ADR-0015 cover the
  Judgment System direction; Phase 1A.1–1A.8 and Phase 1B.1–1B.3
  implemented — DEC-038 records the Phase 1B runtime wiring decision;
  full Context Compiler and Telegram write commands remain future work).
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
  review + source/evidence-link + commit/activation + query/explain +
  retirement lifecycle (supersede/revoke/expire) repository surfaces,
  and typed-tool contracts. **Phase 1B**: `control_gate.ts` imported
  by worker (telemetry); `tool.ts` query/explain executors imported by
  worker (Telegram commands); context builder gains `judgment_items`
  slot. See §Phase 1A–1B below.

## Phase 1A–1B current slice and planned architecture

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
  now injected into runtime context via Phase 1B.2.

The DB-native AI-first Judgment System direction (ADR-0009 …
ADR-0013, `docs/JUDGMENT_SYSTEM.md`) defines the following
components. **Implemented** (Phase 1A.1 / 1A.2 / 1A.3 / 1A.4 / 1A.5 / 1A.6 / 1A.7 / 1A.8):

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
  appends `judgment.committed`. Active/eligible rows exist in DB
  and are injected into runtime context via Phase 1B.2.
- **Query / explain read surfaces** — `src/judgment/repository.ts`
  (`queryJudgments`, `explainJudgment`). Read-only local query and
  audit/explain surfaces over judgment rows, evidence, sources, and
  lifecycle events. They do not mutate tables or append events.
- **Retirement lifecycle surfaces** — `src/judgment/repository.ts`
  (`supersedeJudgment`, `revokeJudgment`, `expireJudgment`). Local
  unregistered write operations that transition `active/eligible`
  judgments to `activation_state=excluded`. `supersedeJudgment` can
  write `judgment_edges`. Excluded rows are filtered out of the Phase
  1B.2 context injection query.
- **Typed-tool contracts** — `src/judgment/tool.ts` (propose /
  approve / reject / record_source / link_evidence / commit /
  query / explain / supersede / revoke / expire). Write-path contracts
  not imported from any runtime module. `executeJudgmentQueryTool` +
  `executeJudgmentExplainTool` imported by `src/queue/worker.ts`
  (Phase 1B.3, for Telegram read commands only).
- **Control Gate substrate** — `src/judgment/control_gate.ts`
  (`evaluateTurn`, `evaluateCandidate`, `recordControlGateDecision`)
  and `migrations/005_control_gate_events.sql` (append-only
  `control_gate_events` table; schema version 5) + migration 006 `job_id`
  attribution (schema version 6). Evaluates
  TurnInput / JudgmentCandidate → ControlGateDecision (L0–L3);
  `direct_commit_allowed` is always false (ADR-0012 invariant).
  **Phase 1B.1**: now wired — `src/queue/worker.ts` calls
  `evaluateTurn()` + `recordControlGateDecision()` before each
  `provider_run`. Not called from providers, context, memory, or
  telegram modules (only from worker, for telemetry).

**Phase 1B.1–1B.3 (implemented):**

- **Phase 1B.1** — Control Gate telemetry wired: `src/queue/worker.ts`
  calls `evaluateTurn()` + `recordControlGateDecision()` per non-system `provider_run`.
- **Phase 1B.2** — Active judgment context injection: worker queries
  active/eligible/normal/global/time-valid rows and passes them to
  `buildContext()` as `judgment_items` slot (priority 600). Excluded
  from `summary_generation`. Resume-mode staleness tracked in issue #44.
- **Phase 1B.3** — Telegram read commands: `/judgment` and
  `/judgment_explain <id>` added. Output via notification only (not turns).

**Not implemented** (beyond Phase 1B.3):

- `Tension` telemetry and the `tensions` table — **not implemented**.
- `ReflectionTriageEvent` and the `reflection_triage_events` ledger
  — **not implemented**.
- `current_operating_view` projection (DEC-036) — **not implemented**.
- Vector and graph derived projections — **not implemented**.
- Further typed tools (`update_current_state`) and Critique Lens
  v0.1 integration (ADR-0013) — **not implemented**.
- Telegram write commands (propose/approve/commit) — **not implemented**.
- Resume-mode judgment refresh (issue #44) — **not implemented**.
- `control_gate_events` job_id attribution (issue #45) — **implemented** (migration 006, worker.ts passes `job.id`).
- Full Context Compiler (`current_operating_view`) — **not implemented**.
- `src/providers/*`, `src/memory/*`, and `src/telegram/*` do not
  import from `src/judgment/*`.

These are listed so AI coding agents do not mistake design
documents for implemented behavior. Phase 1A.1–1A.8 and Phase 1B.1–1B.3
have landed. Full Context Compiler and write-path Telegram commands
remain future scope. See `docs/RUNTIME.md` and `docs/DATA_MODEL.md`
for the current runtime boundary.

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
