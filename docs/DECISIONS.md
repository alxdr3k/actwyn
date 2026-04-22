# Decision Log

> Status: living document · Owner: project lead · Last updated: 2026-04-22
>
> This file records decisions that change the shape of the
> project: dependency choices, protocol shifts, policy changes,
> spike outcomes that amend the HLD, and incident follow-ups. It
> is the audit trail that prevents "why did we decide this
> again?".

## How to use this file

Every decision uses this shape:

```
## D## — Short title

- Date: yyyy-mm-dd
- Status: accepted | superseded | deferred | reversed
- Context: why this came up
- Decision: the chosen option, stated concretely
- Alternatives considered: short bullets
- Consequences: what now has to change / be true
- Risks: what this exposes us to
- Mitigations: how we contain those risks
- Review trigger: what would cause us to revisit
- Refs: PRD §, HLD §, Q## in 07_OPEN_QUESTIONS, SP-## in 03_RISK_SPIKES
```

Rules:

1. Never delete a decision entry. Supersede it by adding a new
   entry that references the old one and flipping the old one's
   status.
2. Keep entries short. If the rationale grows past a page, split
   out an ADR under `docs/adr/`.
3. For decisions taken implicitly in the PRD or HLD, an entry
   here is optional. Add one only when the decision itself is
   likely to be questioned later.

## Index

| ID   | Title                                                    | Status   |
| ---- | -------------------------------------------------------- | -------- |
| D01  | Use Bun + TypeScript for P0                              | accepted |
| D02  | Use Telegram long polling, not webhooks                  | accepted |
| D03  | SQLite (WAL) as the single source of truth               | accepted |
| D04  | Claude as the only P0 provider                           | accepted |
| D05  | S3 is an artifact archive, not a memory database         | accepted |
| D06  | Single worker, one provider_run at a time                | accepted |
| D07  | Explicit-save-first for attachments                      | accepted |
| D08  | Redaction boundary is a single module                    | accepted |
| D09  | Keep PRD at `docs/PRD.md`; numbered PRD rename deferred  | accepted |
| D10  | Bun.S3Client with path-style URLs; AWS SDK as fallback   | accepted |

---

## D01 — Use Bun + TypeScript for P0

- **Date**: pre-project (codified here).
- **Status**: accepted.
- **Context**: We needed a runtime that supports direct `fetch`,
  built-in SQLite bindings with WAL, S3 client, and
  first-class TypeScript — without pulling in a heavy
  dependency tree (PRD §20, §Appendix F).
- **Decision**: Bun (pinned version per PRD Appendix F) plus
  TypeScript. No Node-specific polyfills beyond what Bun
  already provides.
- **Alternatives considered**:
  - Node.js + `better-sqlite3` + custom S3 client.
  - Deno (less mature SQLite + S3 story).
  - Go (fewer ergonomics for our use case).
- **Consequences**:
  - Single runtime across dev, test, and prod.
  - `bun:sqlite`, `Bun.S3Client`, and `Bun.spawn` become core
    primitives; each needs a spike (SP-01, SP-07, SP-08).
- **Risks**:
  - Bun quirks in one of the primitives may force a fallback
    driver.
- **Mitigations**:
  - Spike-first (SP-01, SP-07, SP-08).
  - Fallback to `@aws-sdk/client-s3` for S3 is pre-documented
    (see D10).
- **Review trigger**: a blocking Bun regression we cannot pin
  around, or a spike failure we cannot work around.
- **Refs**: PRD §Appendix F; SP-01, SP-07, SP-08.

## D02 — Use Telegram long polling, not webhooks

- **Date**: pre-project.
- **Status**: accepted.
- **Context**: Webhook deploy requires public TLS, a reverse
  proxy, and a durable HTTP endpoint — all incidental to P0's
  actual goals (PRD §5, §13).
- **Decision**: `getUpdates` long polling with direct `fetch`;
  no bot framework dependency.
- **Alternatives considered**:
  - Webhook + nginx + certbot.
  - A bot framework (e.g. `grammy`) to shorten the poller.
- **Consequences**:
  - No TLS / reverse proxy setup on the host.
  - Offset durability becomes the critical invariant (§9.5 HLD,
    SP-03).
- **Risks**:
  - Long-polling adds a steady outbound connection; minor
    resource cost.
- **Mitigations**:
  - Keep the poll timeout generous (~25-30s) to minimize churn.
- **Review trigger**: move to multi-user or move off Hetzner
  CX22.
- **Refs**: PRD §13.1; HLD §9.1; AC17.

## D03 — SQLite (WAL) as the single source of truth

- **Date**: pre-project.
- **Status**: accepted.
- **Context**: We want durable state across restarts, crash
  safety, and atomic claim semantics without operating a
  separate DBMS.
- **Decision**: SQLite in WAL mode, stored on local disk; all
  state machines (HLD §6) live here. S3 is archive only (D05).
- **Alternatives considered**:
  - Postgres on the same host (heavier; overkill for P0).
  - Remote managed DB (latency + operational surface).
- **Consequences**:
  - All atomicity reasoning lives in `BEGIN IMMEDIATE`-style
    transactions (HLD §5, §6).
  - Crash safety becomes a single-machine concern.
- **Risks**:
  - SQLite WAL surprises with concurrent writers.
- **Mitigations**:
  - Single-process writer model; SP-01 verifies behavior.
- **Review trigger**: multi-host deployment, or a scale need
  SQLite cannot meet.
- **Refs**: PRD §12.7; HLD §5, §6; SP-01.

## D04 — Claude as the only P0 provider

- **Date**: pre-project.
- **Status**: accepted.
- **Context**: We need one provider that works well and is
  testable end-to-end; adding more is out of scope (PRD §5).
- **Decision**: Ship `providers/claude.ts` + a provider
  interface. Keep stubs for `gemini`, `codex`, `ollama` to
  enforce the interface shape, but do not implement them.
- **Alternatives considered**:
  - Multi-provider from day one — rejected; too much testing
    surface.
- **Consequences**:
  - Spikes SP-04–SP-06 focus only on Claude.
  - `/provider` command exists but only `claude` is selectable.
- **Risks**:
  - If Claude changes aggressively mid-P0, rework is
    concentrated.
- **Mitigations**:
  - Pinned CLI version; fixtures in
    `test/fixtures/claude-stream-json/`.
- **Review trigger**: a second provider becomes required for a
  P1 user journey.
- **Refs**: PRD §5, §11; HLD §8; SP-04, SP-05, SP-06.

## D05 — S3 is an artifact archive, not a memory database

- **Date**: 2026-04-22.
- **Status**: accepted (codified in PRD §12.8 and HLD §12).
- **Context**: Earlier phrasing implied S3 was "memory storage";
  this blurred the line between SQLite (state + meaning) and S3
  (binary archive) and risked putting active state in S3.
- **Decision**: SQLite owns state, index, meaning, provenance.
  Local filesystem owns ephemeral working copies. S3 holds
  durable originals (attachments, generated artifacts,
  snapshots). An S3 object in isolation must never reveal why
  it exists.
- **Alternatives considered**:
  - S3 as the primary memory store with SQLite as a cache.
  - Dual-writing semantics into S3 object metadata.
- **Consequences**:
  - PRD §12.8, Appendix D (`storage_objects`,
    `memory_artifact_links`) and HLD §6.4, §12 reflect this.
  - `storage_sync` failures never roll back `provider_run`.
- **Risks**:
  - Operators may still refer to S3 as "memory"; confusing
    language in incidents.
- **Mitigations**:
  - Glossary reminders in HLD §5 and runbook §7.
- **Review trigger**: moving active memory retrieval into P1+
  may blur this again.
- **Refs**: PRD §12.8, Appendix D; HLD §12; Q08 in
  `07_OPEN_QUESTIONS.md`.

## D06 — Single worker, one `provider_run` at a time

- **Date**: pre-project.
- **Status**: accepted.
- **Context**: P0 is single user. Concurrency across
  `provider_run` jobs adds real complexity (subprocess
  budgeting, context interleaving, token cost) without a P0
  benefit.
- **Decision**: Exactly one `provider_run` in `status =
  running` at any time. `notification_retry` and
  `storage_sync` run concurrently with the worker (they do not
  spawn Claude).
- **Alternatives considered**:
  - Multi-worker with global `provider_run` semaphore.
  - Multi-provider concurrency.
- **Consequences**:
  - `queue/worker` claim logic serializes provider execution.
  - `/cancel` and `/status` have a single clear target.
- **Risks**:
  - A slow user message blocks subsequent ones.
- **Mitigations**:
  - Timeouts per PRD §15; notification_accepted tells the user
    we have the message.
- **Review trigger**: multi-user P1+, or a workflow that
  requires a long-running background job.
- **Refs**: PRD §5; HLD §3.1, §6.2.

## D07 — Explicit-save-first for attachments

- **Date**: 2026-04-22.
- **Status**: accepted.
- **Context**: Telegram attachments are easy to send by accident
  and may contain sensitive material. Auto-promotion to
  `long_term` is the wrong default in a single-user personal
  agent.
- **Decision**: All inbound attachments default to
  `retention_class = session`. Promotion to `long_term`
  requires an explicit user signal (`/save_last_attachment` or
  natural-language "save / remember this file"); `long_term`
  items also need `provenance ∈ {user_stated,
  user_confirmed}`.
- **Alternatives considered**:
  - Auto-save everything.
  - Auto-save with a confidence heuristic.
- **Consequences**:
  - PRD §12.8.3, HLD §6.4, §9.3, AC22–AC24 encode this rule.
  - We need `forget` commands (see D06-adjacent design and
    Q05).
- **Risks**:
  - Users forget to save something they wanted kept.
- **Mitigations**:
  - Session-scoped copies stay available during the session;
    the UX surfaces "saved / not saved" state (Q17).
- **Review trigger**: a stronger policy decision on automatic
  classification in P1.
- **Refs**: PRD §12.8.3; HLD §9.3, §11.4; Q04, Q07, Q13.

## D08 — Redaction boundary is a single module

- **Date**: 2026-04-22.
- **Status**: accepted.
- **Context**: Scattered inline redaction is how leaks happen.
  A single boundary is easier to audit and test.
- **Decision**: One module, `src/observability/redact.ts`, is
  the only writer of post-redaction strings. No other module
  calls `.replace(/.../)` on sensitive-looking content inline.
  A CI grep enforces this.
- **Alternatives considered**:
  - Per-module redaction helpers with shared regex constants.
  - A middleware layer in the DB driver.
- **Consequences**:
  - Every durable write goes through `redact.apply(...)`.
  - Pattern additions are one-file changes with one-test
    changes.
- **Risks**:
  - A subtle bypass still possible (e.g. structured logging
    prints raw objects). CI grep alone is not sufficient.
- **Mitigations**:
  - Property test: for a seeded pattern in any inbound, zero
    occurrences in any durable dump (AC10 shape).
- **Review trigger**: switch to a logging library that
  serializes objects outside the redactor.
- **Refs**: PRD §15, AC10; HLD §13; Q12.

## D09 — Keep PRD at `docs/PRD.md`; numbered PRD rename deferred

- **Date**: 2026-04-22.
- **Status**: accepted.
- **Context**: The doc set uses `NN_` numbering
  (`00_PROJECT_DELIVERY_PLAYBOOK.md`, `02_HLD.md`, etc.).
  Renaming PRD to `01_PRD.md` is cosmetic but touches many
  existing references.
- **Decision**: Leave the PRD at `docs/PRD.md` for P0. Other
  docs cross-reference `docs/PRD.md` directly.
- **Alternatives considered**:
  - Rename now and update all refs.
  - Rename at the first doc-structure overhaul.
- **Consequences**:
  - Minor inconsistency in numbering; called out in playbook
    §4.
- **Risks**:
  - New contributors may expect `01_PRD.md` and not find it.
- **Mitigations**:
  - A pointer in the playbook §4; top of `docs/` README (when
    added).
- **Review trigger**: doc-structure overhaul at P1.
- **Refs**: playbook §4.

## D10 — Bun.S3Client with path-style URLs; AWS SDK as fallback

- **Date**: pre-project (codified here).
- **Status**: accepted.
- **Context**: Hetzner Object Storage is S3-compatible but
  documented for path-style (`virtualHostedStyle=false`).
  Bun.S3Client should handle this, but SP-08 will confirm.
- **Decision**: Ship with `Bun.S3Client` configured for path-
  style. If SP-08 reveals incompatibilities that cannot be
  worked around, fall back to `@aws-sdk/client-s3`
  post-P0.5; document in a follow-up decision.
- **Alternatives considered**:
  - Ship AWS SDK from the start (heavier dep tree).
- **Consequences**:
  - Storage adapter (`src/storage/s3.ts`) keeps a thin
    driver-independent surface.
  - AC16 may be satisfied by either driver.
- **Risks**:
  - Bun.S3Client surprises (range reads, multipart, error
    shapes).
- **Mitigations**:
  - SP-08 exercises the full CRUD matrix; failure triggers
    the documented fallback.
- **Review trigger**: SP-08 failure or a later Hetzner API
  change.
- **Refs**: PRD §12.7; HLD §12; SP-08.

---

## Incident log

Follow the runbook §13 template. One entry per incident; keep
entries terse.

*No incidents yet.*

