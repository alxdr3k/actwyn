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
| DB-native AI-first Judgment System (Phase 1A+)    | planned     |
| Vector / graph derived projections                | planned     |
| second-brain repo as canonical runtime memory     | not planned (history/seed only) |
| Obsidian / Markdown active write path             | not planned |

The Phase 0 / 0.5 Judgment System architectural design has landed on
`main` as ADR-0009 through ADR-0013 plus `docs/JUDGMENT_SYSTEM.md`.
Per **DEC-037** (Implementation Documentation Lifecycle Policy),
those documents are the architectural authority for *why* the
direction was chosen but are **not** the source of truth for
implemented runtime behavior. None of the planned schemas, typed
tools, Control Gate evaluators, or projections are implemented yet
(Phase 1A is a separate, future track).

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
  direction but are not yet implemented).
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

## Planned but not implemented

The DB-native AI-first Judgment System direction (ADR-0009 …
ADR-0013, `docs/JUDGMENT_SYSTEM.md`) defines the following
components. The architectural commitment is on `main`; **none of
them are implemented in code today**.

- `JudgmentItem` and the supporting Phase 1A schema skeleton
  (`judgment_sources`, `judgment_items`, `judgment_evidence_links`,
  `judgment_edges`, `judgment_events`).
- `Control Gate` evaluators and the `control_gate_events` /
  `control_plane_events` ledger (the table name choice between the
  two is itself open per `docs/JUDGMENT_SYSTEM.md` §Implementation
  Readiness).
- `Tension` telemetry and the `tensions` table.
- `ReflectionTriageEvent` and the `reflection_triage_events` ledger.
- `current_operating_view` projection (DEC-036; supersedes the
  earlier "current truth" framing).
- Vector and graph derived projections (FTS5 first; vector / graph
  deferred per ADR-0009).
- Typed tool surface (`judgment.propose` / `commit` / `supersede` /
  `revoke` / `query` / `explain` / `link_evidence` /
  `update_current_state`) and Critique Lens v0.1 integration
  (ADR-0013).
- `epistemic_origin` (ADR-0012), `authority_source` (ADR-0012),
  `lifecycle_status` / `activation_state` / `retention_state`
  (ADR-0013, DEC-033) field semantics on judgment rows.

These are listed here so AI coding agents do not mistake design
documents for implemented behavior. Phase 1A implementation is **out
of scope** for this PR; see `docs/RUNTIME.md` and
`docs/DATA_MODEL.md` for how the planned shape sits next to the
implemented shape, and `docs/JUDGMENT_SYSTEM.md` §Implementation
Readiness for the Phase 1A scope itself.

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
