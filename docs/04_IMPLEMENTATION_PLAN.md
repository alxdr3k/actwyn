# Personal Agent P0 — Implementation Plan

> Status: draft · Owner: project lead · Last updated: 2026-04-22
>
> This plan turns the PRD + HLD into a concrete build order. It
> expands the playbook's build-order sketch (§7.2) into named
> phases with **entry criteria**, **deliverables**, **exit
> criteria**, and **ledger-integration test targets**.
>
> Rules:
>
> 1. Phases happen in order. A phase may not begin until its entry
>    criteria are met.
> 2. Every phase ends with at least one automated test that
>    asserts the state-machine transitions it introduced (HLD §6).
> 3. The first implementation target is not Claude response
>    quality — it is durable end-to-end state flow (playbook §7.3).

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
    `skipped`.
  - `src/telegram/attachment.ts` — `getFile` → local temp →
    sha256/mime/size → `storage_objects` insert (retention
    `session`, status `pending`).
  - `test/telegram/poller.test.ts` — harness against a stub
    Telegram server; offset invariant (HLD §9.5, PRD §13.2)
    asserted.
  - `test/telegram/inbound.test.ts` — authorized text, authorized
    command, unauthorized sender, unsupported type, attachment,
    oversize attachment.
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
    dispatch by `job_type`.
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
- **Exit criteria**:
  - A seeded job flows from `queued` to `succeeded` via the fake
    provider and produces a `turns` row with `role='assistant'`.
  - `cancelled` and `failed` paths exercise the expected
    transitions.
  - Only one job is `running` at a time.
- **Ledger tests introduced**: `jobs.status` machine (HLD §6.2)
  except `interrupted` (added in Phase 10).

---

## Phase 5 — Outbound notifications + retry

- **Entry criteria**:
  - Phase 4 done.
- **Deliverables**:
  - `src/telegram/outbound.ts` — `sendMessage` executor; message
    chunking per Telegram limits; 429 `retry_after` handling.
  - `src/queue/notification_retry.ts` — loop that re-sends
    `pending` / `failed` rows within budget.
  - Notification creation wired into `src/queue/worker.ts`:
    terminal job transitions insert the corresponding
    `outbound_notifications` row with a deterministic
    `payload_hash`.
  - `test/notifications/state_machine.test.ts` — full
    `pending → sent` and `pending → failed → pending → sent`
    paths; duplicate `(job_id, notification_type, payload_hash)`
    returns existing row.
  - `test/notifications/splitting.test.ts` — long responses are
    split across multiple `sendMessage` calls and every
    `telegram_message_ids_json` entry is recorded.
- **Exit criteria**:
  - A fake-provider job `succeeds` and the user receives a
    `job_completed` message via the stub Telegram server.
  - Duplicate notifications are prevented by the idempotency
    triple.
  - Telegram outage simulation leaves rows in `pending` /
    `failed` and the next cycle sends them successfully.
- **Ledger tests introduced**: `outbound_notifications.status`
  machine (HLD §6.3).

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
  5. Send an attachment; confirm `storage_objects` row appears.
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

