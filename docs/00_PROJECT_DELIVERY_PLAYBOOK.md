# Project Delivery Playbook

> Status: draft · Owner: project lead · Last updated: 2026-04-22
>
> This document defines **how** the Personal Agent project is delivered. It is
> deliberately separate from the PRD (which defines **what** we are building)
> and from the HLD (which will define **how it is structured**). Read this
> first before touching any code on P0.

---

## 1. Purpose

The Personal Agent is not a "chat UI over an LLM". It is a small but
non-trivial distributed runtime:

```
Telegram inbound ledger
  → durable job queue
  → Claude subprocess runtime
  → memory writer
  → outbound notification retry
  → async S3 storage sync
  → startup recovery
```

The dominant risk in this project is **not** "the code is hard". The dominant
risk is **state transitions and failure recovery silently drift**: Telegram
offset advances before the update is committed, a `job` moves to `succeeded`
before its turns are persisted, a notification is lost because S3 sync
failed, a subprocess survives a cancel, a resume replays a turn that was
already answered.

A 30-page design document will not prevent those bugs. A 30-line `README`
absolutely will not. What prevents them is a small, shared set of rules
about:

- **Order**: PRD → HLD → risk spikes → walking skeleton → vertical slice → P0.
- **Gates**: what must be true before we advance to the next phase.
- **Artifacts**: what documents exist, where they live, who owns them.
- **Definition of Done**: what "P0 is finished" actually means.

This playbook owns those rules. If a rule here conflicts with a habit, the
rule wins; if the rule is wrong, update the rule first and then the work.

Non-goals of this document:

- It does not duplicate the PRD. Scope, user stories, and acceptance
  criteria live in `docs/PRD.md`.
- It does not define the architecture. Modules, state machines, and flows
  live in the HLD (`docs/02_HLD.md`, to be written).
- It is not a style guide or a code review checklist for day-to-day PRs.

---

## 2. Project Principles

These are the principles the rest of the playbook is derived from. They are
short on purpose — if they grow, they stop being principles.

1. **Durability before cleverness.** A boring, resumable state transition
   beats a clever one every time. Every inbound Telegram update, every job,
   every outbound notification, and every S3 sync is a ledger row before it
   is anything else.
2. **One writer per state machine.** Every table whose rows have a status
   (`telegram_updates`, `jobs`, `turns`, `outbound_notifications`,
   `storage_sync`) has exactly one component that is allowed to advance its
   status. The HLD names that component.
3. **Advance the offset last.** `telegram_next_offset` only moves forward
   after the update it represents has been durably recorded. Side effects
   (job creation, notifications) happen inside the same transaction or are
   idempotently retryable.
4. **Failure is a state, not an exception.** `failed`, `interrupted`, and
   `cancelled` are first-class statuses with defined transitions in and out.
   A crash mid-run must be recoverable by reading the DB at startup.
5. **Subprocesses are owned, not summoned.** Every spawned Claude process
   has a known `pid`, `process group`, `job_id`, and lifecycle owner.
   "Orphan process" is a bug class we design out, not something we clean up
   later.
6. **Redaction has a boundary, not a sprinkle.** Secrets are redacted at a
   specific, documented point in the pipeline. Both "pre-redaction raw" and
   "post-redaction stored" exist intentionally; everything else is at one
   side of that boundary.
7. **S3 is an artifact archive, not a memory database.** SQLite owns
   state, meaning, index, and provenance; the local filesystem owns
   ephemeral working copies; S3 holds the durable originals (images,
   files, generated artifacts, snapshots). An S3 object in isolation
   must not reveal why it exists — meaning lives in SQLite metadata
   and `memory_artifact_links`. A failed S3 sync never rolls back a
   successful job. Full policy: PRD §12.8.
8. **Vertical slices over horizontal layers.** We do not finish "the DB"
   before building "the Telegram layer". We build a thin end-to-end path
   and thicken it.
9. **Smoke test the scary assumptions first.** Before we depend on Bun's
   S3 client against Hetzner, on Claude's `stream-json` event shape, or on
   `Bun.spawn` detached kill semantics, we prove each one works in a 30-line
   script. The result lives in `docs/03_RISK_SPIKES.md`.
10. **Write the rule down once.** If we made a decision twice, it becomes
    a `docs/08_DECISION_REGISTER.md` entry or an ADR. We do not rediscover why Bun was
    chosen in the middle of a Slack thread.

---

## 3. Delivery Phases

P0 is delivered in nine ordered phases. Each phase has an explicit entry
condition (the previous phase's gate, section 5) and an explicit exit
artifact. We do not skip phases to save time; we shrink them.

```
 ┌──────────────┐
 │ 0. PRD       │  docs/PRD.md
 └──────┬───────┘
        ▼
 ┌──────────────┐
 │ 1. HLD       │  docs/02_HLD.md
 └──────┬───────┘
        ▼
 ┌──────────────┐
 │ 2. Risk      │  docs/03_RISK_SPIKES.md + spike/ scripts
 │    Spikes    │
 └──────┬───────┘
        ▼
 ┌──────────────┐
 │ 3. Impl.     │  docs/04_IMPLEMENTATION_PLAN.md
 │    Plan      │
 └──────┬───────┘
        ▼
 ┌──────────────┐
 │ 4. Walking   │  end-to-end path with a FAKE provider
 │    Skeleton  │
 └──────┬───────┘
        ▼
 ┌──────────────┐
 │ 5. Claude    │  fake provider replaced by the Claude adapter
 │    Vertical  │
 │    Slice     │
 └──────┬───────┘
        ▼
 ┌──────────────┐
 │ 6. P0        │  docs/06_ACCEPTANCE_TESTS.md results
 │    Acceptance│
 └──────┬───────┘
        ▼
 ┌──────────────┐
 │ 7. Systemd   │  docs/05_RUNBOOK.md + deployed service
 │    Deploy    │
 └──────┬───────┘
        ▼
 ┌──────────────┐
 │ 8. Ops       │  operational review notes, tracked issues
 │    Review    │
 └──────────────┘
```

Phase summaries:

- **Phase 0 — PRD** (done): the `what` and the `why`. Already captured in
  `docs/PRD.md`. The playbook treats the PRD as frozen for P0 except via
  the change-control process in section 13.
- **Phase 1 — HLD**: a *thin* design document whose job is to unblock
  implementation, not to describe every function. Must land state machines,
  module boundaries, core flows, and failure/recovery behavior. Everything
  that is not those four concerns can stay out of P0 HLD.
- **Phase 2 — Risk Spikes**: run the smoke tests in section 6 before writing
  real code. Update the HLD with what was learned; some spikes will
  invalidate assumptions.
- **Phase 3 — Implementation Plan**: convert the HLD into a module-by-module
  build order. This is where sequencing, ownership, and rough effort live.
  It is a working document; it will drift. That is fine.
- **Phase 4 — Walking Skeleton**: the first end-to-end path. Telegram DM →
  `telegram_updates` → `jobs` → fake provider → `turns` →
  `outbound_notifications` → Telegram reply → restart and the state is
  still coherent. Claude is **not** in the loop yet.
- **Phase 5 — Claude Vertical Slice**: replace the fake provider with the
  Claude Code adapter. Stream-json parsing, permission lockdown,
  `--session-id`/`--resume`, subprocess lifecycle, and redaction all
  integrate here.
- **Phase 6 — P0 Acceptance**: run the PRD's acceptance criteria and the
  spike-derived failure drills. Log results in
  `docs/06_ACCEPTANCE_TESTS.md`.
- **Phase 7 — Systemd Deploy**: Hetzner CX22, systemd unit, `/doctor`
  passes on the box, `RUNBOOK.md` describes restart and recovery.
- **Phase 8 — Ops Review**: run the agent in real life for a defined
  window, catalog issues into P1/P2, decide what gets promoted next.

Phases 4 and 5 are where most of the actual implementation lives. Phases 1,
2, 3 exist specifically so those two phases do not have to discover the
design while writing the code.

---

## 4. Required Artifacts

The project lives in `docs/` plus source code. Every artifact below has a
single canonical path; if it exists elsewhere, it is wrong.

```
docs/
  00_PROJECT_DELIVERY_PLAYBOOK.md   ← this document
  PRD.md                             ← product requirements (kept at legacy path)
  02_HLD.md                          ← module boundaries, state machines, flows
  03_RISK_SPIKES.md                  ← spike list, results, follow-ups
  04_IMPLEMENTATION_PLAN.md          ← module-by-module build order
  05_RUNBOOK.md                      ← deploy, restart, recover, rotate
  06_ACCEPTANCE_TESTS.md             ← P0 acceptance run log
  07_QUESTIONS_REGISTER.md           ← question ledger (Q-###)
  08_DECISION_REGISTER.md            ← small decisions ledger (DEC-###)
  09_TRACEABILITY_MATRIX.md          ← Q- / DEC- / ADR- ↔ PRD / HLD / AC
  adr/                               ← architecture decision records
    README.md                        ← ADR index + template
    0001-*.md                        ← one file per ADR
spike/                               ← throwaway scripts for section 6 spikes
```

Note on `PRD.md`: the PRD currently lives at `docs/PRD.md`. Renaming it to
`01_PRD.md` is a cosmetic change and not required for P0. If we rename it,
we do so in a single dedicated commit, not mixed with content changes.

Required per phase (artifacts must exist before the phase gate in section 5
can pass):

| Phase                     | Required artifact(s)                                       |
| ------------------------- | ---------------------------------------------------------- |
| 0. PRD                    | `docs/PRD.md` frozen for P0 (change control per §13)       |
| 1. HLD                    | `docs/02_HLD.md`                                           |
| 2. Risk Spikes            | `docs/03_RISK_SPIKES.md`, spike scripts under `spike/`     |
| 3. Implementation Plan    | `docs/04_IMPLEMENTATION_PLAN.md`                           |
| 4. Walking Skeleton       | running end-to-end fake-provider path; updated HLD deltas  |
| 5. Claude Vertical Slice  | running Claude path; ADR / DEC entries for surprises       |
| 6. P0 Acceptance          | `docs/06_ACCEPTANCE_TESTS.md` with pass/fail per criterion |
| 7. Systemd Deploy         | `docs/05_RUNBOOK.md`, deployed and verified on CX22        |
| 8. Ops Review             | issue list categorized as P1/P2/deferred                   |

Rules for these artifacts:

- **HLD is thin.** The HLD's job is to unblock implementation, not to be
  complete. Anything not needed for P0 implementation belongs in a backlog
  note, not in the HLD.
- **Risk spikes are throwaway.** Spike scripts live under `spike/` and are
  not required to be production quality. They must be reproducible and
  their results captured in `03_RISK_SPIKES.md`.
- **Runbook is written before deploy, not after.** Phase 7 does not pass
  until `05_RUNBOOK.md` describes: cold start, crash recovery, secret
  rotation, S3 outage behavior, Telegram outage behavior, and `/doctor`
  interpretation.
- **Acceptance tests are run, not read.** `06_ACCEPTANCE_TESTS.md` records
  the actual run: date, commit SHA, which criteria passed, which failed,
  and links to follow-up issues.
- **08_DECISION_REGISTER.md and adr/ are append-only within P0.** Entries
  are not rewritten; they are superseded by new entries that reference the
  old id. See §12 for the Knowledge Promotion Pipeline that governs how
  questions become decisions and how decisions reach PRD / HLD.

---

## 5. Phase Gates

A phase gate is a checklist that must be fully satisfied before the next
phase starts. Gates are intentionally specific so that "are we done with
this phase?" is not a judgment call.

### 5.1 PRD gate

- [ ] P0, P1, P2 scope is explicitly separated; non-goals are listed.
- [ ] Every P0 acceptance criterion is testable (pass/fail, not "works well").
- [ ] Security, privacy, observability, and recovery requirements are
      present (not deferred to HLD).
- [ ] Known constraints (Bun version, Hetzner CX22, Claude Code CLI,
      Hetzner Object Storage) are explicit.
- [ ] Open questions are listed rather than silently assumed.

### 5.2 HLD gate

- [ ] Module boundaries are named. For each module: purpose, inputs,
      outputs, owning tables, owning state transitions.
- [ ] State machines are defined for at least: `jobs.status`,
      `telegram_updates.status`, `outbound_notifications.status`,
      `storage_sync.status`. Each transition lists: trigger, transaction
      scope, side effects, retry behavior, user-visible notification.
- [ ] Core flows are described at sequence-level, minimally:
      inbound update → job queue, worker → provider run, provider stream →
      turns + notifications, startup recovery, `/cancel`, `/summary`,
      `/end`, S3 sync retry, redaction boundary.
- [ ] Failure modes for each flow are explicit: what happens on crash
      before commit, between commit and notification, mid-stream, during
      S3 sync, during resume, during summary generation.
- [ ] Claude `resume_mode` and `replay_mode` semantics are pinned down.
- [ ] `Bun.spawn` subprocess ownership and teardown strategy is pinned
      down (process group, signal order, timeout).
- [ ] Redaction boundary is named: which table stores pre-redaction raw,
      which stores post-redaction, which fields are redacted.

### 5.3 Risk spike gate

All spikes in section 6 that are marked **blocking** must have a status of
`passed` or `passed-with-caveats` in `03_RISK_SPIKES.md`. A
`passed-with-caveats` result must link to either an HLD update or a
`08_DECISION_REGISTER.md` entry.

- [ ] Bun exact version pinned; `bun:sqlite` WAL + transaction behavior
      verified.
- [ ] Telegram `getUpdates`/`sendMessage` direct-fetch smoke test passes.
- [ ] Telegram offset durability test passes (crash between receive and
      commit does not lose updates and does not double-process).
- [ ] Claude Code `stream-json` event shape verified against the version
      we will ship with.
- [ ] Claude Code permission lockdown verified (`--tools ""` or equivalent
      behaves as expected; disallowed tools are actually disallowed).
- [ ] Claude `--session-id` / `--resume` behavior verified for the
      replay / resume semantics the HLD relies on.
- [ ] `Bun.spawn` detached process group kill verified on Linux (child
      and any grandchildren terminate on cancel/timeout).
- [ ] `Bun.S3Client` against Hetzner Object Storage verified for `put`,
      `get`, `stat`, `list`, `delete`, plus a simulated outage.

### 5.4 Implementation plan gate

- [ ] Build order is expressed as vertical slices, not horizontal layers.
- [ ] Each slice has: scope, owned modules, required tables/migrations,
      required config, acceptance check.
- [ ] Phase 4 (walking skeleton) is scoped to the fake provider only.
- [ ] Phase 5 (Claude slice) depends on the walking skeleton passing.

### 5.5 Walking skeleton gate

- [ ] Telegram DM is received and recorded in `telegram_updates`.
- [ ] A `jobs` row is created within the same transaction as, or
      idempotently following, the update commit.
- [ ] A worker claims the job, runs the fake provider, and records
      `turns`.
- [ ] An outbound Telegram message is sent via
      `outbound_notifications`.
- [ ] Killing the process mid-run and restarting leaves the system in a
      coherent state: no lost updates, no duplicate replies, no orphan
      `running` jobs without an owner.
- [ ] `telegram_next_offset` never advances ahead of the updates
      durably recorded.

### 5.6 Claude vertical slice gate

- [ ] Fake provider is fully replaced by the Claude adapter for the
      happy path.
- [ ] Subprocess is spawned with the documented permission lockdown.
- [ ] Stream-json events are parsed and converted to `turns` rows.
- [ ] `/cancel` terminates the entire process group within the timeout
      budget and moves the job to `cancelled`.
- [ ] Resume / replay behaves as the HLD specifies (no double-answer,
      no lost partial output beyond what is documented).
- [ ] Redaction boundary holds: no raw secrets in post-redaction
      storage; raw storage (if any) is access-controlled per HLD.

### 5.7 P0 acceptance gate

- [ ] Every PRD acceptance criterion has a recorded pass in
      `06_ACCEPTANCE_TESTS.md`.
- [ ] `/doctor` returns green on the target box.
- [ ] Failure drills pass: crash mid-run, Telegram outage, S3 outage,
      Claude subprocess hang, disk-full on SQLite WAL.

### 5.8 Deploy gate

- [ ] systemd unit is present, enabled, and restarts on failure.
- [ ] `RUNBOOK.md` covers cold start, crash recovery, rotation, outage.
- [ ] Secrets are loaded from environment/disk per the documented
      mechanism; no secrets in logs, transcripts, or notification
      payloads.
- [ ] A documented backup of the SQLite database exists and has been
      restored at least once in a dry run.

### 5.9 Ops review gate

- [ ] The agent has been used for real work for the ops-review window
      defined at the start of phase 8.
- [ ] Every incident or surprise is an issue with a P1/P2/deferred
      label.
- [ ] `08_DECISION_REGISTER.md` has been updated with any decisions taken during
      live use.

---

## 6. Risk Spike Policy

Spikes exist because this project depends on third-party behaviors we do
not control: Bun runtime details, Claude Code CLI event shapes, Telegram
long-polling edge cases, Hetzner Object Storage S3 compatibility, and
Linux subprocess semantics. A surprise in any of these mid-implementation
is expensive; the same surprise in a 30-line spike script is cheap.

A spike is in scope for P0 if **getting it wrong silently breaks
durability or recovery**. Spikes that are only about ergonomics or
performance can be deferred.

### 6.1 Blocking spikes (P0)

Each of these must be recorded in `docs/03_RISK_SPIKES.md` with: date,
Bun/Claude/SDK versions used, the script (or a link to it under
`spike/`), the observed behavior, the conclusion, and any follow-up
items that modify the HLD.

1. **Bun runtime and `bun:sqlite` durability.**
   - Pin an exact Bun version; record it in the spike.
   - Confirm WAL mode survives process kill.
   - Confirm `BEGIN IMMEDIATE` / transaction semantics match the HLD's
     assumptions for the inbound-ledger transaction.
2. **Telegram direct-fetch long polling.**
   - `getUpdates` with `offset` and `timeout`, then `sendMessage`, via
     plain `fetch`.
   - Confirm the offset advance rule: offset is only advanced after
     update processing commits.
3. **Telegram offset durability under crash.**
   - Simulate: receive update → crash before commit. Restart.
   - Expected: the same update is delivered again; no double-processing
     after commit; no lost updates.
4. **Claude Code stream-json event shape.**
   - Run `claude` with the arguments the HLD plans to use.
   - Capture an example of every event type we rely on (tool call, tool
     result, assistant text, final, error).
   - Diff against the HLD's assumed schema.
5. **Claude Code permission lockdown.**
   - Verify the flag set we plan to ship with actually disables the
     tools we expect.
   - Attempt a disallowed tool and confirm it is rejected rather than
     silently allowed.
6. **Claude `--session-id` / `--resume` semantics.**
   - Confirm resume does not replay turns we have already persisted.
   - Confirm session IDs survive across process restarts in the way the
     HLD relies on.
7. **`Bun.spawn` detached process group kill.**
   - Spawn a child that spawns a grandchild that ignores `SIGTERM`.
   - Confirm the documented teardown strategy kills the whole group
     within the timeout budget.
8. **`Bun.S3Client` against Hetzner Object Storage.**
   - `put`, `get`, `stat`, `list`, `delete`, plus a large object.
   - Simulate outage: revoke credentials or block the endpoint; confirm
     the client fails in a way `storage_sync` can observe and retry.

### 6.2 Non-blocking spikes (nice to have)

These are worth doing but do not block P0 gates:

- Measure Claude stream latency and tokens/sec under the permission set
  we ship, to size timeout budgets.
- Measure SQLite write throughput for the expected `turns` rate.
- Measure S3 put latency from CX22 to Hetzner Object Storage.

### 6.3 When a spike invalidates a design

If a spike reveals that a HLD assumption is wrong (e.g. Claude stream
events do not carry the field we expected, Hetzner's S3 dialect rejects
a request shape), the procedure is:

1. Stop spiking further areas that depend on the broken assumption.
2. Update `docs/02_HLD.md` with the corrected design.
3. Add a `08_DECISION_REGISTER.md` entry naming the assumption, the evidence, and
   the new direction.
4. Re-check any already-green gates that depended on the old assumption.

### 6.4 Spike hygiene

- Spikes live under `spike/` and are not wired into the main app.
- Spikes may hardcode credentials from a local `.env`; they must not be
  committed with credentials.
- Spikes are allowed to be ugly. They are not allowed to be misleading:
  if a spike prints "ok" it must actually mean the behavior was
  observed.

---

## 7. Implementation Strategy

Implementation is organized as **vertical slices**, not horizontal
layers. The goal of the first slice is **not** "good answers"; it is
**durable end-to-end state flow**.

### 7.1 Walking skeleton first

The walking skeleton is the thinnest end-to-end path that exercises
every state machine the runtime depends on:

```
Telegram DM
  → telegram_updates (status: received → enqueued)
  → jobs (status: queued)
  → worker claims (jobs: queued → running)
  → fake provider runs
  → turns rows written
  → outbound_notifications (status: pending)
  → Telegram sendMessage
  → outbound_notifications (status: sent)
  → jobs (status: running → succeeded)
  → restart the process
  → state is still coherent
```

Rules for the walking skeleton:

- Claude is **not** used. The provider is a stub that returns a fixed
  response after a short delay and optionally can be toggled to fail.
- S3 sync may be disabled or mocked; `storage_sync` is not exercised
  until phase 5.
- Redaction is stubbed to identity; the redaction boundary is defined
  but not yet applied.
- The skeleton's measure of success is the state machines, not the
  content of replies.

### 7.2 Build order

The recommended module sequencing (detailed form lives in
`04_IMPLEMENTATION_PLAN.md`):

1. **Config + secrets loader.** Fail closed on missing required
   config; emit exactly the fields `/doctor` expects.
2. **DB schema + migrations.** Every table the HLD names, with its
   status columns and indexes. Migrations are forward-only in P0.
3. **Telegram inbound ledger.** `getUpdates` loop, `telegram_updates`
   writes, offset advance rule. This is the first place durability is
   real.
4. **Job queue + worker loop.** `jobs` row lifecycle, claim semantics,
   crash-safe recovery at startup (`running` → `interrupted` at boot).
5. **Outbound notification ledger.** `outbound_notifications` writes,
   retry policy, idempotency via `(payload_hash, notification_type,
   job_id)`.
6. **Fake provider vertical slice.** End the walking skeleton here.
   Gate 5.5 must pass before continuing.
7. **Claude provider adapter.** Subprocess lifecycle, permission
   lockdown, stream-json parsing, resume/replay, per spike results.
8. **Context packer.** Assembles the prompt inputs the HLD defines.
   Not before the Claude slice, because the packer's shape depends on
   what the adapter actually accepts.
9. **Memory + summary.** `/summary` and `/end`, with the permission
   profile the HLD specifies.
10. **S3 `storage_sync`.** Async mirror of the directories the HLD
    names. Failures here must not roll back provider runs.
11. **`/doctor` and smoke tests.** On-box checks for every dependency.
12. **systemd deploy.** Runbook, unit file, restart behavior, backup.

### 7.3 What we do **not** do during implementation

- We do not add features that are outside the PRD's P0 scope, even if
  they are "easy". Scope creep is how P0 slips.
- We do not refactor the walking skeleton into "clean" abstractions
  before the Claude slice lands. Two concrete implementations (fake
  and Claude) are what reveal the right abstraction.
- We do not add backwards-compatibility shims. P0 has one user, one
  box, one DB. Breakages are handled by migrations or a redeploy.
- We do not add retry, caching, or circuit-breaker logic that is not
  called out by the HLD. Every such mechanism must be justified by a
  state machine or an acceptance criterion.
- We do not suppress errors to make tests green. If a spike or an
  acceptance test is red, the state machine or the code is wrong, not
  the test.

### 7.4 When to stop and update the HLD

Pause implementation and update the HLD (not after the fact, *now*)
when:

- A state machine transition is discovered that the HLD did not
  specify.
- A failure mode is discovered that the HLD did not address.
- A module's responsibility expands beyond what the HLD names.
- A spike result contradicts the HLD.

Updating the HLD mid-implementation is the expected case, not a
failure mode. The failure mode is letting the code and the HLD
silently diverge.

---

## 8. Testing Strategy

Testing in P0 is shaped by the project's risk profile: the code is not
especially algorithmically tricky, but the **state transitions are**. The
test strategy reflects that — unit tests matter less than ledger-level
integration tests and failure drills.

### 8.1 Test layers

1. **Unit tests.** For pure functions: config parsing, redaction,
   context packing, stream-json parsing, payload hashing. Fast,
   deterministic, no I/O.
2. **Ledger integration tests.** The primary test layer. Drive the
   state machines with real SQLite (file-backed, per-test) and a fake
   Telegram + fake provider. Assert on DB state transitions, not on
   stdout. Every state machine in section 5.2 has at least one happy
   path and one failure-mode test here.
3. **Subprocess tests.** For the Claude adapter only: confirm spawn,
   stream parsing, cancel, timeout, and process-group teardown using a
   stub binary that behaves like Claude. The real Claude binary is
   exercised in the vertical slice acceptance run, not in CI.
4. **End-to-end drills.** Manual or scripted, run before the P0
   acceptance gate. See 8.3.

### 8.2 Required coverage

We do not chase a coverage percentage. We require the following cases
to be covered by a real test:

- Offset durability: crash between `received` and `enqueued`; restart
  re-delivers and idempotently reconciles.
- Job crash recovery: a `running` job whose worker died boots into a
  defined status (e.g. `interrupted`) and is not silently left as
  `running`.
- Cancel: a `/cancel` during a long-running provider run terminates
  the process group and reaches `cancelled` within the timeout.
- Notification retry: Telegram `sendMessage` fails transiently;
  `outbound_notifications` retries and eventually reaches `sent`
  without duplicating.
- S3 outage: `storage_sync` fails and retries; provider runs keep
  succeeding.
- Redaction: a payload containing a known secret pattern is redacted
  at the documented boundary and never appears in post-redaction
  storage.
- Resume: a resumed session does not double-answer an already-answered
  turn.

### 8.3 Failure drills

The following drills are run manually before the P0 acceptance gate,
and their outcomes recorded in `docs/06_ACCEPTANCE_TESTS.md`:

1. `kill -9` the app mid-job; restart; confirm state machine
   reconciliation.
2. Block the Telegram endpoint at the firewall for 2 minutes during a
   job; unblock; confirm notifications catch up.
3. Revoke S3 credentials for 5 minutes; confirm runs still succeed,
   `storage_sync` is failing, `/doctor` surfaces the problem, and
   sync recovers on credential restore.
4. `kill -STOP` the Claude subprocess to simulate a hang; confirm the
   configured timeout triggers, the process group is terminated, and
   the job moves to the HLD-defined failure status.
5. Fill the DB disk to near-full; confirm the app fails safely and
   `/doctor` reports the condition rather than silently losing
   writes.

### 8.4 What we do not test in P0

- Multi-user isolation (not in scope).
- Webhook delivery (not in scope).
- Long-horizon memory correctness beyond what the HLD specifies for
  `/summary` and `/end`.
- Third-party quirks that are not on the blocking spike list.

### 8.5 Test artifacts

- Tests live alongside the source (`src/**/*.test.ts` or the Bun
  convention we adopt in phase 4). The convention is chosen once and
  documented in `04_IMPLEMENTATION_PLAN.md`.
- CI is a stretch goal for P0. If CI exists, it runs unit and ledger
  integration tests on every push to the P0 branch. Subprocess and
  E2E drills are run locally before the acceptance gate.
- A red test blocks merge into the P0 branch. Skipping a test to
  unblock a merge is a §13 change-control decision, not a judgment
  call.

---

## 9. Review Process

Every major artifact (PRD, HLD, risk spikes, implementation plan,
acceptance run) is reviewed from **multiple perspectives**, not just
"does the code work". In a one-person or small-team project these
perspectives are hats worn in sequence; the point is that each set of
questions gets asked.

### 9.1 Review perspectives

| Perspective        | Primary question                                            |
| ------------------ | ----------------------------------------------------------- |
| Product / CEO      | Does this match the PRD's scope and non-goals?              |
| Engineering Mgr    | Is the sequencing realistic? Are dependencies explicit?     |
| Staff Engineer     | Are state machines, failure modes, and invariants sound?    |
| Security           | Secrets, auth, injection, prompt injection, memory poison.  |
| QA                 | Are acceptance criteria testable? What regressions are we   |
|                    | likely to introduce?                                        |
| SRE                | Cold start, restart, degraded mode, backup, on-call.        |
| Technical Writer   | Ambiguity, unstated assumptions, handoff clarity.           |

The three most important perspectives for this project are **Staff
Engineer, Security, and SRE**, because the project's risk is
concentrated in state-transition correctness, secret handling, and
recoverability.

### 9.2 Review triggers

- **HLD**: full review from all perspectives before the HLD gate.
- **Risk spikes**: Staff + SRE review of the `03_RISK_SPIKES.md`
  conclusions before the spike gate.
- **Implementation plan**: EM + Staff review before phase 4 starts.
- **Walking skeleton**: Staff + QA review before the skeleton gate.
- **Claude vertical slice**: Security review required (permission
  lockdown, redaction boundary, subprocess ownership).
- **Acceptance run**: QA + SRE review.
- **Deploy**: SRE review of the runbook before cutover.

### 9.3 Review output

A review produces one of three outcomes, recorded in the PR or the
artifact:

- **Pass**: proceed.
- **Pass with follow-ups**: proceed, but the follow-ups are tracked as
  issues with owners.
- **Block**: the artifact cannot advance past its gate until the
  blocking items are addressed.

A review that produces only "looks good" is not a review. Every review
must either list concrete observations or explicitly state "no
observations" after checking the perspective-specific questions.

### 9.4 PR discipline

- PRs target the P0 development branch, not `main`.
- PR titles reference the phase and slice (e.g. "phase 4: job queue
  + worker claim").
- PRs that touch a state machine must cite the HLD section they are
  implementing or amending.
- PRs that weaken a test or relax a gate must link to the
  `08_DECISION_REGISTER.md` entry authorizing it.
- PRs that introduce a dependency not listed in the PRD or HLD
  require Staff + Security review.

---

## 10. Deployment Process

P0 is deployed to a single Hetzner CX22 host under systemd. Deployment
is manual for P0; it becomes scripted in P1 if warranted.

### 10.1 Pre-deploy checklist

The deploy gate (5.8) must pass. In addition:

- [ ] Target Bun version is installed and matches the pin in
      `03_RISK_SPIKES.md`.
- [ ] Target Claude Code CLI version is installed and matches the
      version used in spike §6.1.4.
- [ ] `/doctor` has been run locally and is green against the target
      config.
- [ ] Secrets are placed in the documented location with correct
      permissions (owner-only read).
- [ ] SQLite DB path and S3 bucket exist and are reachable.
- [ ] A clean `RUNBOOK.md` section exists for this deploy's version.

### 10.2 Deploy steps

The canonical steps live in `docs/05_RUNBOOK.md`. The playbook only
pins the **order** and the non-negotiable guarantees:

1. Stop the running service (if any) via systemd, not `kill`.
2. Back up the SQLite DB file. Record the backup path and SHA256.
3. Pull the target commit. Install deps with `bun install --frozen`.
4. Run migrations forward. Migrations are idempotent; a re-run on a
   clean DB is a no-op.
5. Start the service via systemd.
6. Wait for the service to pass `/doctor`.
7. Send a test Telegram DM end-to-end.
8. Record the deploy in `RUNBOOK.md`: commit SHA, date, operator,
   observations.

Guarantees, regardless of what the runbook looks like on a given day:

- **No deploy without a backup.** Step 2 is not skippable.
- **No deploy without `/doctor` green.** If `/doctor` cannot go green,
  roll back.
- **No silent migrations.** A migration that changes a state column
  must be called out in the deploy notes, not hidden in a batch.

### 10.3 Rollback

Rollback in P0 is:

1. Stop the service.
2. Restore the DB backup from step 10.2.2 if a migration was applied
   that the older binary cannot read.
3. Check out the previous commit, `bun install --frozen`, start the
   service.
4. Confirm `/doctor` is green.
5. Record the rollback in `RUNBOOK.md` with the reason.

Rollback is a routine operation, not an incident. We exercise it at
least once in a dry run before the first real deploy.

### 10.4 Post-deploy observation

- Run the agent for at least one real interaction end-to-end.
- Check `/doctor` again after the first interaction, not only before.
- Tail logs for redaction-boundary violations (section 11.4).

---

## 11. Incident and Recovery Process

P0 has one operator. "Incident" here just means "something is wrong
and we need to fix it without making it worse".

### 11.1 Severity bands

- **Sev-A**: data loss or secret leak. Examples: raw secrets in
  stored transcripts, `telegram_updates` gap, DB corruption.
- **Sev-B**: durable user-visible failure. Examples: jobs stuck
  `running` forever, notifications not delivered, `/cancel` has no
  effect.
- **Sev-C**: degraded but recovering. Examples: S3 sync failing but
  jobs succeeding, Telegram transient outage handled by retry.

### 11.2 Immediate response

For any severity, the first actions are identical:

1. **Preserve state.** Do not wipe the DB. Do not clear logs. Do not
   restart the service as the first reflex — snapshot first, restart
   second.
2. **Capture evidence.**
   - `sqlite3 db.sqlite ".backup incident-<ts>.sqlite"`
   - Copy the relevant log window.
   - Record the commit SHA currently running.
3. **Decide: keep running or stop?**
   - Sev-A: stop the service until the leak/loss is understood.
   - Sev-B/C: usually keep running; investigate live.

### 11.3 Recovery paths

Map the incident to a state-machine recovery path:

- **Orphan `running` job**: reconcile at startup (`running` →
  `interrupted`), per HLD. If the reconciler is not doing this, it is
  a Sev-B bug.
- **Notification stuck `pending`**: check the retry budget and the
  `(payload_hash, notification_type, job_id)` idempotency key; do
  **not** manually re-send from outside the ledger.
- **`storage_sync` stuck `failed`**: treat as Sev-C; fix the
  credential or network issue; let the retryer reconcile. Never
  hand-copy files to S3 outside `storage_sync`.
- **Telegram offset appears to have skipped**: treat as Sev-A until
  proven otherwise. Reconstruct the gap from `telegram_updates` and
  compare with Telegram server offset.

### 11.4 Redaction boundary violations

A redaction boundary violation (a secret pattern appearing in a
post-redaction store) is **always Sev-A**, even if the secret is
"low value":

1. Stop the service.
2. Identify the records containing the unredacted data.
3. Redact or delete per the retention policy in the PRD.
4. Fix the code path that produced the unredacted write.
5. Add a ledger integration test that would have caught it.
6. Record the incident and the fix in `08_DECISION_REGISTER.md`.

### 11.5 After every incident

Regardless of severity, write a short note (paragraph, not essay)
in `RUNBOOK.md`: date, symptom, root cause, fix, prevention. This
is the mechanism by which P0 operations feed back into the design.

---

## 12. Knowledge Promotion Pipeline

Questions, decisions, and requirements live in different files on
purpose. This section defines the pipeline that moves knowledge from
"something someone wondered about" to "something the system is built
to".

### 12.1 The pipeline

```
Question  →  Proposed answer  →  Decision / Deferred / Open
      ↓                                    ↓
07_QUESTIONS_REGISTER.md         08_DECISION_REGISTER.md
                                     or adr/####-*.md
                                          ↓
                           PRD / HLD / Runbook / Acceptance Tests
                                          ↓
                            09_TRACEABILITY_MATRIX.md
```

The rule: **the Questions Register is where thinking happens; the
PRD / HLD / Runbook / Acceptance Tests are where the system is
defined.** Decisions link the two. The Traceability Matrix keeps
the links visible.

### 12.2 File-by-file role

| File                              | Owns                                                              |
| --------------------------------- | ----------------------------------------------------------------- |
| `07_QUESTIONS_REGISTER.md`        | Open questions, proposed answers, reasoning history.              |
| `08_DECISION_REGISTER.md`         | Small decisions (policy defaults, command sets, thresholds).      |
| `adr/####-*.md`                   | Architecture-level decisions (runtime, storage, provider, trust). |
| `PRD.md`                          | Product requirements, scope, non-goals, acceptance criteria.      |
| `02_HLD.md`                       | System design: modules, state machines, flows, failure recovery.  |
| `05_RUNBOOK.md`                   | Operator procedures, thresholds, incident response.               |
| `06_ACCEPTANCE_TESTS.md`          | Testable consequences of decisions.                               |
| `09_TRACEABILITY_MATRIX.md`       | Links across the above so nothing drifts silently.                |

The Questions Register is **not** a source of truth. Once a question
is decided, the binding answer lives in PRD / HLD / Runbook /
Acceptance Tests; the Questions Register keeps the rationale and
the promotion pointer.

### 12.3 Lifecycle of a question

- **Open question**: new `Q-###` entry with `Status: open`.
- **Proposed answer** (not yet accepted): same entry moves to
  `Status: proposed` with the draft answer.
- **Small decision** (policy, default, threshold): creates a `DEC-###`
  entry in `08_DECISION_REGISTER.md`; the `Q-###` entry links to it.
- **Architecture decision** (runtime choice, storage model, provider,
  trust boundary, protocol): creates a new `docs/adr/####-title.md`;
  the `Q-###` entry links to it.
- **Impact on what the system must do**: PRD is patched.
- **Impact on how the system is built**: HLD is patched.
- **Impact on how the system is operated**: Runbook is patched.
- **Impact on what we must verify**: Acceptance Tests are patched.
- Every promotion adds a row to `09_TRACEABILITY_MATRIX.md`.

### 12.4 ADR vs DEC — promotion criteria

A decision becomes an **ADR** when **all** of the following are true:

1. It affects architecture (runtime, storage, protocol, trust
   boundary, provider, deployment shape).
2. Reversing it would require rewriting multiple modules or
   migrating durable state.
3. A future engineer reading only PRD / HLD could not infer the
   rationale from those artifacts alone.

If any of those is false, the decision lives in
`08_DECISION_REGISTER.md` as a `DEC-###` entry.

### 12.5 Entry formats (summary)

All three registers use the same skeleton: short header, structured
fields, explicit links. Full templates:

- `07_QUESTIONS_REGISTER.md` — at the top of that file.
- `08_DECISION_REGISTER.md` — at the top of that file.
- `adr/README.md` — ADR template plus the index.

Rules that hold across all three:

- IDs are monotonic and never reused.
- Entries are not edited after `accepted` / `decided` except to add
  a `Superseded by` pointer.
- A superseding entry must reference the id it replaces.

### 12.6 What to do when an answer changes

When reality diverges from a previous decision (spike result,
incident, policy change):

1. Open a new `Q-###` in `07_QUESTIONS_REGISTER.md` describing what
   changed and why.
2. Write the new decision as a fresh `DEC-###` or a new ADR.
3. Mark the old `DEC-###` / ADR `Status: superseded` with a pointer.
4. Patch PRD / HLD / Runbook / Acceptance Tests in the same commit.
5. Update `09_TRACEABILITY_MATRIX.md` to reflect the new links.

### 12.7 Decisions the playbook itself cares about

Some decisions change the playbook's own rules. Those require:

- An ADR (architecture-level) or a `DEC-###` (policy-level).
- A PR that updates this playbook in the same commit.
- A Staff-Engineer review signoff.

Examples: changing a phase gate criterion, dropping a blocking spike,
adding a new phase, changing the Definition of Done.

---

## 13. Change Control

The PRD, HLD, and this playbook are not untouchable — but they are
not edited casually either. Change control is how we keep the three
documents, the code, and the acceptance tests from drifting apart.

### 13.1 What counts as a change

- **PRD changes**: adding, removing, or materially rewording a P0
  scope item, non-goal, acceptance criterion, or functional/
  non-functional requirement.
- **HLD changes**: changing a module boundary, state-machine
  transition, flow, failure mode, or redaction boundary.
- **Playbook changes**: any change to a gate, principle, required
  artifact, or Definition of Done.

Typo fixes, formatting, and clarifications that do not change
meaning are **not** changes and do not need the process below.

### 13.2 Change process

1. **Propose**: open an issue or PR describing the change, why it is
   needed, and what it invalidates (existing gates, tests, code,
   other docs).
2. **Review**: the relevant perspective(s) from section 9 review it.
   HLD/PRD changes always include Staff Engineer. Security and
   recovery-related changes always include Security and SRE.
3. **Decide**: accept, reject, or defer. The outcome is a
   `08_DECISION_REGISTER.md` entry, not just a merged PR.
4. **Propagate**: in the same PR (or an immediately following one),
   update any dependent artifact:
   - PRD change → HLD affected sections → implementation plan →
     tests.
   - HLD change → implementation plan → tests → code.
   - Playbook change → the specific gate/check affected.
5. **Communicate**: mention the change in the next RUNBOOK entry
   or project update. Silent changes cause drift.

### 13.3 Scope creep

The most common "change" is scope creep: a feature that feels
small, is outside P0, and is "easier to add now". The answer is
almost always no. The process:

1. The idea goes into a P1/P2 backlog note.
2. If it is truly P0-necessary, it follows the change process above
   and the PRD is amended explicitly.
3. A P0 feature added without amending the PRD is a process bug,
   regardless of how small the feature is.

### 13.4 Emergency changes

If an incident (section 11) forces a change that cannot wait for
review:

1. Make the smallest change that resolves the incident.
2. Record it in `RUNBOOK.md` immediately.
3. Open the formal change PR within 24 hours.
4. The emergency change is reviewed retroactively; if rejected,
   the next change reverts it.

Emergencies are rare. Using "emergency" to bypass change control
routinely is itself a Sev-B process failure.

---

## 14. Definition of Done

P0 is **done** — not "nearly done", not "done except for…" — only when
every item below is true. This is the one list that is not allowed to be
partially checked at the time of declaring P0 complete.

### 14.1 Product

- [ ] Every acceptance criterion in `docs/PRD.md` §17 passes and is
      recorded in `docs/06_ACCEPTANCE_TESTS.md` with the run date and
      commit SHA.
- [ ] All P0 Telegram commands in the PRD behave per spec: `/status`,
      `/cancel`, `/summary`, `/end`, `/provider`, `/doctor`, `/whoami`,
      plus freeform DM.
- [ ] The agent has been used for at least one full day of real
      interactions on the target box without a Sev-A or Sev-B incident.

### 14.2 Design alignment

- [ ] `docs/02_HLD.md` matches the shipped code:
      - State machines described in the HLD match the code's actual
        transitions.
      - Modules described in the HLD are the modules that exist.
      - Any mid-implementation drift has been reconciled either by
        updating the HLD or by updating the code.
- [ ] Every `08_DECISION_REGISTER.md` entry referenced by the HLD exists and is
      in `accepted` status.

### 14.3 Durability and recovery

- [ ] Telegram offset durability drill passes (§8.3.1 / §5.5).
- [ ] Job crash-recovery drill passes: no orphan `running` jobs after
      restart; `running` → `interrupted` reconciliation is tested.
- [ ] Cancel drill passes: `/cancel` kills the Claude process group
      within the configured timeout.
- [ ] Notification retry drill passes: transient Telegram failures
      recover without duplicate delivery.
- [ ] S3 outage drill passes: `storage_sync` retries, jobs keep
      succeeding, `/doctor` flags the issue.
- [ ] Claude hang drill passes: stuck subprocess is reaped by
      timeout + process-group kill; job moves to the HLD-defined
      failure status.

### 14.4 Security and privacy

- [ ] Redaction boundary has a ledger integration test and no known
      violations in the stored corpus.
- [ ] Secrets are not present in logs, transcripts, notification
      payloads, summaries, or S3-mirrored files.
- [ ] Only the authorized Telegram user can drive the agent; all
      other senders are rejected at the inbound boundary.
- [ ] Claude subprocess permission lockdown is in place and verified
      by the spike from §6.1.5.

### 14.5 Observability

- [ ] `/doctor` checks every dependency: DB, Telegram, Claude binary,
      S3 endpoint, disk, required config, pending-job health.
- [ ] Logs are structured enough to trace a single request from
      `telegram_updates` → `jobs` → `turns` → `outbound_notifications`
      via a correlation key.
- [ ] Failure states (`failed`, `interrupted`, `cancelled`) are
      visible in `/status` and in logs, not silent.

### 14.6 Operations

- [ ] systemd unit restarts the service on crash.
- [ ] `docs/05_RUNBOOK.md` covers cold start, rollback, backup/restore,
      secret rotation, S3 outage, Telegram outage, and `/doctor`
      interpretation.
- [ ] A DB backup has been taken and restored in a dry run.
- [ ] The deploy procedure has been exercised at least once end-to-end
      from a fresh checkout.

### 14.7 Process

- [ ] Every phase gate (§5) has been recorded as passed, with the
      date and the artifact that proved it.
- [ ] The risk spike log (`03_RISK_SPIKES.md`) has a final status
      for every blocking spike.
- [ ] P1/P2 follow-ups discovered during P0 exist as issues, not as
      mental notes.

Anything that is genuinely not P0 but uncovered during P0 goes into
the backlog, not into "we'll just add it before calling it done".

---

## 15. Appendix: Checklists

Short, copy-pasteable checklists for the operations that happen
repeatedly. Each is a subset of an earlier section, collected here for
convenience.

### 15.1 New-artifact checklist

Use when creating a new top-level doc under `docs/`:

- [ ] Filename matches the convention in §4 (numbered prefix, snake-
      or kebab-case as already established).
- [ ] The doc has an owner named at the top.
- [ ] The doc links back to the PRD and/or HLD sections it relates
      to.
- [ ] The doc is referenced from `00_PROJECT_DELIVERY_PLAYBOOK.md` if
      it is part of the phase pipeline.

### 15.2 HLD review checklist

- [ ] Module list with responsibilities, inputs, outputs, owned
      tables, owned state transitions.
- [ ] State machines for `jobs`, `telegram_updates`,
      `outbound_notifications`, `storage_sync` with every transition
      annotated (trigger, transaction, side effects, retry, notify).
- [ ] Core flows at sequence level: inbound, worker, stream, restart
      recovery, `/cancel`, `/summary`, `/end`, S3 sync, redaction.
- [ ] Explicit failure-mode list per flow.
- [ ] Subprocess ownership and teardown strategy.
- [ ] Redaction boundary named.
- [ ] Open questions listed, not hidden.

### 15.3 Risk-spike checklist (per spike)

- [ ] Versions of Bun, Claude Code CLI, and any SDKs recorded.
- [ ] Minimal reproducible script under `spike/`.
- [ ] Observed behavior captured (raw output where useful).
- [ ] Conclusion: `passed`, `passed-with-caveats`, or `failed`.
- [ ] Follow-up: HLD update or `08_DECISION_REGISTER.md` entry if behavior
      diverged from the assumption.

### 15.4 PR checklist

- [ ] Targets the P0 development branch, not `main`.
- [ ] Title references the phase and slice.
- [ ] Scope is minimal; no drive-by refactors unless justified.
- [ ] State-machine changes cite the HLD section.
- [ ] Tests added or updated, including at least one ledger-level
      assertion if a status column is touched.
- [ ] No new dependencies without Staff + Security sign-off.
- [ ] No suppressed or skipped tests; any exception has a
      `08_DECISION_REGISTER.md` entry.

### 15.5 Deploy checklist

- [ ] Phase 7 gate (§5.8) passes.
- [ ] Pre-deploy checklist (§10.1) passes.
- [ ] Backup taken; path and SHA256 recorded.
- [ ] Migrations noted in deploy log.
- [ ] `/doctor` green post-deploy.
- [ ] End-to-end Telegram test passes post-deploy.
- [ ] Deploy recorded in `RUNBOOK.md`.

### 15.6 Incident checklist

- [ ] Severity assigned (A/B/C).
- [ ] Evidence captured (DB snapshot, logs, commit SHA).
- [ ] Decision recorded: keep running vs stop.
- [ ] Recovery path identified (state-machine reconciliation, not
      hand-editing tables).
- [ ] Post-incident note added to `RUNBOOK.md`.
- [ ] Follow-up issue opened for any systemic fix.

### 15.7 "Am I about to do the wrong thing?" checklist

A short gut-check before taking a risky action:

- [ ] Am I changing a state column directly by hand? → stop; use the
      state machine.
- [ ] Am I about to skip a test to unblock a merge? → stop; §8.5.
- [ ] Am I about to add a feature that is not in the PRD? → stop;
      §13.3.
- [ ] Am I about to `kill -9` the running service? → stop; snapshot
      first, §11.2.
- [ ] Am I about to commit a secret or a `.env` file? → stop; the
      commit does not go out.

---

*End of playbook. This document is intended to be read cover-to-cover
once, and then referenced section-by-section forever after.*

