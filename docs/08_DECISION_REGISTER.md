# Decision Register

> Status: living document · Owner: project lead · Last updated: 2026-04-28
>
> Small, confirmed decisions that shape the project but are not
> architecture-level. Architecture-level decisions live under
> [`adr/`](./adr/). See
> [`00_PROJECT_DELIVERY_PLAYBOOK.md`](./00_PROJECT_DELIVERY_PLAYBOOK.md)
> §12 for the promotion pipeline.

## How to use this file

A `DEC-###` entry records a policy, default, command set, or
operational threshold that is concrete, non-architectural, and
long-lived enough to be worth stating once instead of rediscovering.

ADR-vs-DEC (see playbook §12.4): ADRs are for architecture-level
decisions (runtime, storage, protocol, trust boundary, provider,
deployment shape). Everything else is a `DEC-###`.

### Entry format

```
## DEC-### — Short title

- Date: yyyy-mm-dd
- Status: accepted | superseded | deferred | reversed
- Context: why this came up
- Decision: the chosen option, stated concretely
- Alternatives considered: short bullets
- Impacted docs: PRD §, HLD §, Runbook §, AC##
- Risks / mitigations: what could go wrong and what we do about it
- Review trigger: what would cause us to revisit
- Supersedes / superseded by: link, if any
- Refs: Q-### from 07, SP-## from 03, other pointers
```

### Rules

1. IDs are monotonic; never reused.
2. `accepted` entries are not edited except to add a
   `Superseded by` pointer.
3. A superseding entry must reference the id it replaces.
4. Every `accepted` entry must list at least one binding location
   under **Impacted docs**.

## Index

| ID      | Title                                                          | Status   |
| ------- | -------------------------------------------------------------- | -------- |
| DEC-001 | Single worker, one `provider_run` at a time                    | accepted |
| DEC-002 | Redaction is a single-module boundary                          | accepted |
| DEC-003 | Keep PRD at `docs/PRD.md`; numbered rename deferred            | accepted |
| DEC-004 | Bun.S3Client with path-style; AWS SDK as P0.5 fallback         | accepted |
| DEC-005 | Artifact retention durations per class                         | accepted |
| DEC-006 | `/forget` command set with tombstone semantics                 | accepted |
| DEC-007 | Memory correction via supersede; `memory_items` table          | accepted |
| DEC-008 | P0 uses private bucket only; client-side encryption at P1+     | accepted |
| DEC-009 | `BOOTSTRAP_WHOAMI` procedure with 30-minute auto-expiry        | accepted |
| DEC-010 | P0 redaction pattern list                                      | accepted |
| DEC-011 | Remember-feedback footer UX                                    | accepted |
| DEC-012 | P0 notification minimal set                                    | accepted |
| DEC-013 | P0 success = AC pass + 7-day dogfood thresholds                | accepted |
| DEC-014 | Required observational data categories                         | accepted |
| DEC-015 | `/status` output contract                                      | accepted |
| DEC-016 | Restart user-notification policy                               | accepted |
| DEC-017 | `/doctor` single command, typed output (quick + deep)          | accepted |
| DEC-018 | S3 degraded concrete thresholds                                | accepted |
| DEC-019 | Summary auto-trigger conditions                                | accepted |
| DEC-020 | Telegram message chunking at 3,800 chars                       | accepted |
| DEC-021 | CJK-safer token estimator rule                                 | accepted |
| DEC-022 | second-brain GitHub repo는 actwyn judgment의 canonical 아님    | accepted |
| DEC-023 | `JudgmentItem.kind` v1 도입 enum 범위 (6 enforced + 6 deferred) | accepted |
| DEC-024 | P0.5 cognitive scope (Goal / Workspace / Reflection 최소형)    | accepted |
| DEC-025 | JudgmentItem metacognitive 필드는 P0.5 schema에 optional 도입  | accepted |
| DEC-026 | `JudgmentItem.status` enum P0.5 도입 범위 (9 enum 모두)        | superseded by DEC-033 |
| DEC-027 | `decay_policy` enum P0.5는 `none` + `supersede_only`만         | accepted |
| DEC-028 | `ontology_version` + `schema_version` 모든 새 record에 강제    | accepted |
| DEC-029 | `system_authored` enum 제거 + `authority_source` P0.5 범위     | accepted |
| DEC-030 | Control-plane vs Judgment-plane 분리                          | accepted |
| DEC-031 | Critic Loop P0.5 도입 단계 (1-3단계만)                        | accepted |
| DEC-032 | Tension `target_domain` P0.5 도입 범위 (8 enum)               | accepted |
| DEC-033 | `JudgmentItem.status` 9 enum → 3축 분리 (lifecycle/activation/retention) | accepted |
| DEC-034 | `procedure_subtype` 5 enum + default `skill`                  | accepted |
| DEC-035 | Reflection 5 sub-action P0.5 도입 (`reflection_triage`만)     | accepted |
| DEC-036 | `current_truth` → `current_operating_view` 이름 변경          | accepted |
| DEC-037 | Implementation Documentation Lifecycle Policy                  | accepted |
| DEC-038 | Judgment System Phase 1B.1–1B.3 Runtime Wiring (2026-04-28)   | accepted |

Decisions that were previously `D01`..`D05` in the flat log have
been promoted to ADRs (`ADR-0001`..`ADR-0005` plus `ADR-0006`..
`ADR-0008`); see [`adr/`](./adr/).

---

## DEC-001 — Single worker, one `provider_run` at a time

- Date: 2026-04-22 (codified from pre-project decision; was D06).
- Status: accepted.
- Context: P0 is single user. Concurrency across `provider_run`
  jobs adds real complexity (subprocess budgeting, context
  interleaving, token cost) without a P0 benefit.
- Decision: Exactly one `provider_run` may be `status = running`
  at any time. `notification_retry` and `storage_sync` run
  concurrently with the worker; they do not spawn Claude.
- Alternatives considered: multi-worker with global semaphore;
  multi-provider concurrency.
- Impacted docs: PRD §5, §8.5; HLD §3.1, §6.2.
- Risks / mitigations: a slow user message blocks subsequent
  ones; mitigated by runtime timeouts (PRD §15) and the
  `job_accepted` notification.
- Review trigger: multi-user P1+, or a workflow that needs a
  long-running background job.
- Supersedes / superseded by: —
- Refs: —

## DEC-002 — Redaction is a single-module boundary

- Date: 2026-04-22 (codified; was D08).
- Status: accepted.
- Context: Scattered inline redaction is how leaks happen. A
  single boundary is easier to audit, test, and extend.
- Decision: `src/observability/redact.ts` is the only writer of
  post-redaction strings. No other module performs inline
  redaction. A CI grep check enforces the rule.
- Alternatives considered: per-module helpers with shared
  constants; redact as middleware in the DB driver.
- Impacted docs: PRD §15, AC-SEC-001; HLD §13.
- Risks / mitigations: subtle bypass (e.g. a logger that prints
  raw objects) still possible; mitigated by a property test on
  seeded patterns across every durable dump (AC-SEC-001).
- Review trigger: switch to a logging library that serializes
  objects outside the redactor.
- Supersedes / superseded by: —
- Refs: Q-012.

## DEC-003 — Keep PRD at `docs/PRD.md`; numbered rename deferred

- Date: 2026-04-22 (was D09).
- Status: accepted.
- Context: The rest of the doc set uses `NN_` numbering; the PRD
  does not. Renaming it to `docs/01_PRD.md` is cosmetic but
  touches many references.
- Decision: Leave the PRD at `docs/PRD.md` through P0. Rename at
  the first doc-structure overhaul (likely P1 kickoff) as a
  single dedicated commit.
- Alternatives considered: rename now and update all references;
  wait until an arbitrary future milestone.
- Impacted docs: `00_PROJECT_DELIVERY_PLAYBOOK.md` §4.
- Risks / mitigations: new contributors expect `01_PRD.md` and
  don't find it; mitigated by the playbook §4 pointer.
- Review trigger: next major doc-structure pass.
- Supersedes / superseded by: —
- Refs: playbook §4.

## DEC-004 — Bun.S3Client with path-style; AWS SDK as P0.5 fallback

- Date: 2026-04-22 (codified; was D10).
- Status: accepted.
- Context: Hetzner Object Storage is S3-compatible but documented
  for path-style URLs. Bun.S3Client should handle this, but
  SP-08 confirms it in practice.
- Decision: Ship P0 with `Bun.S3Client` using path-style
  (`virtualHostedStyle=false`). If SP-08 reveals incompatibilities
  that cannot be worked around, fall back to
  `@aws-sdk/client-s3` post-P0.5; document in a follow-up DEC
  entry.
- Alternatives considered: ship the AWS SDK from the start
  (heavier dep tree); wait for a future Bun release.
- Impacted docs: PRD §12.7; HLD §12; AC-OBS-001.
- Risks / mitigations: Bun.S3Client surprises (range reads,
  multipart, error shapes) — SP-08 exercises the full CRUD
  matrix; fallback path is documented.
- Review trigger: SP-08 failure, or a later Hetzner API change
  that breaks path-style.
- Supersedes / superseded by: —
- Refs: SP-08.

## DEC-005 — Artifact retention durations per class

- Date: 2026-04-22.
- Status: accepted.
- Context: PRD §12.8.2 names four retention classes
  (`ephemeral` / `session` / `long_term` / `archive`) but leaves
  the concrete durations open. Without them, retention sprawl
  is invisible until the disk is full.
- Decision:
  - `ephemeral` — delete at the end of the owning run; never on
    S3.
  - `session` — local + optional S3; 30 days after session end.
  - `long_term` — durable on S3; retained until the user
    deletes.
  - `archive` — durable on S3; default 1 year; ops can override.
  Durations are configurable at deploy time.
- Alternatives considered: longer session retention (90 days)
  defer-to-P1 deletion, no automatic deletion at all.
- Impacted docs: PRD §12.8.2; HLD §12; 05_RUNBOOK §7.
- Risks / mitigations: deletion automation is P1; P0 records
  the class but does not auto-expire. `/doctor disk_free_ok`
  surfaces pressure before it is critical.
- Review trigger: when deletion automation lands in P1, or when
  disk pressure on CX22 triggers a different profile.
- Supersedes / superseded by: —
- Refs: Q-010.

## DEC-006 — `/forget` command set with tombstone semantics

- Date: 2026-04-22.
- Status: accepted.
- Context: A single overloaded `/forget` is ambiguous about
  scope. Hard deletion has legal / recovery consequences we
  are not ready to handle in P0.
- Decision: Four scoped commands with tombstone (soft-delete)
  semantics:
  - `/forget_last` — most recent memory candidate or artifact
    link → `revoked` / `deleted`.
  - `/forget_session` — current session summary + long-term
    candidates → inactive; transcripts follow retention class.
  - `/forget_artifact <id>` — remove `memory_artifact_links`;
    set `storage_objects.status = deletion_requested`; later
    sync pass issues S3 `DELETE` and flips to `deleted` or
    `delete_failed`.
  - `/forget_memory <id>` — set `memory_items.status = revoked`.
  Full GDPR-style hard erasure is out of P0.
- Alternatives considered: single `/forget` + follow-up
  question; defer to P1.
- Impacted docs: PRD §7, §8.1, Appendix D; HLD §6.4, §7.x.
- Risks / mitigations: users assume "forget" = "deleted from
  the planet"; Runbook §7 + a short `/help` line explain the
  tombstone model.
- Review trigger: first concrete hard-deletion requirement
  (legal, audit, or user request) that tombstones cannot
  satisfy.
- Supersedes / superseded by: —
- Refs: Q-005.

## DEC-007 — Memory correction via supersede; `memory_items` table

- Date: 2026-04-22.
- Status: accepted.
- Context: Overwriting memory loses history and makes auditing
  the twin data set impossible. Corrections must be first-class
  events.
- Decision: Introduce a `memory_items` table (see PRD Appendix
  D) with
  `status: active | superseded | revoked` and a
  `supersedes_memory_id` pointer. A `user_stated` correction
  creates a new `memory_items` row referencing the prior id;
  the prior row moves to `superseded` and is excluded from
  context packing. Both free-text corrections (e.g. "정정:
  X가 아니라 Y") and an explicit `/correct <id>` command land
  on the same mechanism.
- Alternatives considered: overwrite in place; maintain history
  in an audit table only; defer corrections to P1.
- Impacted docs: PRD §12, Appendix D; HLD §11.3.
- Risks / mitigations: chain of supersedes can grow; HLD §10.3
  drop order excludes `superseded` items so packing stays
  bounded.
- Review trigger: when we add automated confidence-based
  revocation (P1+).
- Supersedes / superseded by: —
- Refs: Q-006.

## DEC-008 — P0 uses private bucket only; client-side encryption at P1+

- Date: 2026-04-22.
- Status: accepted.
- Context: Client-side encryption adds material complexity
  (key rotation, backup, indexing, preview, key-loss recovery)
  that we are not prepared to handle in P0. We still need a
  defensible privacy posture.
- Decision: P0 combines (a) private Hetzner bucket, (b) opaque
  object keys per PRD §12.8.4, (c) secret redaction in logs
  and transcripts, (d) S3 credentials in systemd
  `EnvironmentFile` mode 0600. A short threat-model note in
  Runbook §9 records what this posture does and does not
  protect against.
- Alternatives considered: client-side envelope encryption in
  P0; per-user / per-project key derivation.
- Impacted docs: PRD §15; HLD §12; 05_RUNBOOK §9.
- Risks / mitigations: bucket-credential compromise exposes
  files; mitigated by minimizing credential surface and
  rotating per Runbook §9.
- Review trigger: a concrete user need for encrypted-at-rest
  durable storage, or a Security review finding.
- Supersedes / superseded by: —
- Refs: Q-009.

## DEC-009 — `BOOTSTRAP_WHOAMI` procedure with 30-minute auto-expiry

- Date: 2026-04-22.
- Status: accepted.
- Context: We need a safe one-shot mechanism for an operator
  to learn the authorized user's `user_id` without leaving a
  permanent back door.
- Decision: The flag is enabled via the systemd
  `EnvironmentFile` and automatically carries a 30-minute
  expiry timestamp recorded in `settings`. `/doctor`
  surfaces the remaining window; beyond expiry, `/doctor`
  escalates to `fail` until the flag is disabled and the
  service is restarted.
- Alternatives considered: manual toggle without expiry;
  one-shot CLI subcommand printing IDs without starting the
  service.
- Impacted docs: PRD §8.3; HLD §9.2, §16.1; 05_RUNBOOK §12;
  AC-TEL-001.
- Risks / mitigations: operator forgets to turn it off —
  auto-expiry ensures the hole closes on its own.
- Review trigger: Security review prior to P0 acceptance.
- Supersedes / superseded by: —
- Refs: Q-011.

## DEC-010 — P0 redaction pattern list

- Date: 2026-04-22.
- Status: accepted.
- Context: "Redaction required" is not a pattern list. A
  concrete starting set is needed for tests and reviews.
- Decision: Required starting coverage:
  - **Exact values** read from config at runtime:
    `TELEGRAM_BOT_TOKEN`, `S3_ACCESS_KEY_ID`,
    `S3_SECRET_ACCESS_KEY`, and any env var whose name ends in
    `TOKEN`, `SECRET`, `KEY`, or `PASSWORD`.
  - **Patterns**: `Bearer <token>`, `sk-...`, `xoxb-...`,
    `-----BEGIN ... PRIVATE KEY-----`, `AWS_ACCESS_KEY_ID`-style
    assignments, long high-entropy strings above a configured
    threshold.
  Redaction runs **before** persistence. `test/redaction.test.ts`
  fails if any exact value or pattern leaks into a durable
  store.
- Alternatives considered: general-purpose DLP; patterns only;
  manual review pre-release.
- Impacted docs: PRD §15, AC-SEC-001; HLD §13.2.
- Risks / mitigations: new secret types are not caught — the
  pattern list is extensible, and every failure surfaces via
  the Sev-A path in Runbook §8.
- Review trigger: any redaction incident, or a new product
  feature that introduces new secret shapes.
- Supersedes / superseded by: —
- Refs: Q-012.

## DEC-011 — Remember-feedback footer UX

- Date: 2026-04-22.
- Status: accepted.
- Context: Users need to know when the agent captured something
  durable. A silent system erodes trust in the memory layer. A
  separate confirmation message per memory is noisy.
- Decision: Append a short footer to the assistant reply when
  the turn produced a memory candidate or an attachment save.
  Examples:
  - `기억함: "Personal Agent P0는 Bun 기반"`
  - `저장함: image · art_abc123 · long_term`
  One or two lines; no verbose structure. A `/memory` listing
  UI is P1+.
- Alternatives considered: silent (surface via `/summary`
  only); separate confirmation message; always include a JSON
  block.
- Impacted docs: PRD §8.4; HLD §11.
- Risks / mitigations: footer grows and eats the reply —
  capped at two lines with truncation.
- Review trigger: if the footer becomes the dominant content
  or causes confusion.
- Supersedes / superseded by: —
- Refs: Q-017.

## DEC-012 — P0 notification minimal set

- Date: 2026-04-22.
- Status: accepted.
- Context: Notification fatigue causes users to mute the bot,
  which destroys the signal value of real failure alerts.
- Decision: P0 pushes the following notification types and no
  others:
  - `job_accepted`, `job_completed`, `job_failed`,
    `job_cancelled`.
  - `summary`, `doctor`.
  - Explicit `saved` confirmation when the user requested a
    save (ties into DEC-011 footer; separate push only if no
    assistant reply carries it).
  Silent by default: `job_started`, successful
  `storage_sync`, successful `notification_retry`, internal
  retries.
- Alternatives considered: push every lifecycle event;
  user-configurable filter at P0.
- Impacted docs: PRD §13.3; HLD §6.3, §9.4.
- Risks / mitigations: a silent failure path is missed — all
  failure types are explicitly included; `/status` surfaces
  backlog counts.
- Review trigger: any user report of missed notifications
  (signal lost) or mute complaints (noise too high).
- Supersedes / superseded by: —
- Refs: Q-018.

## DEC-013 — P0 success = AC pass + 7-day dogfood thresholds

- Date: 2026-04-22.
- Status: accepted.
- Context: "All ACs pass" is necessary but not sufficient; a
  technical acceptance without real-world use would miss the
  product's value hypothesis.
- Decision: P0 is declared succeeded only when both gates
  pass:
  1. Technical: all AC-TEL-001..AC-STO-006+ green on the staging host
     (06_ACCEPTANCE_TESTS).
  2. Dogfood: 7 calendar days of daily use by the authorized
     user with ≥ 20 user turns, ≥ 5 read session summaries,
     ≥ 3 explicit save events, ≥ 1 artifact saved and later
     referenced, 0 critical data-loss / unauthorized access /
     unsafe Claude tool executions.
- Alternatives considered: AC-only gate; dogfood-only gate;
  subjective "feels good" gate.
- Impacted docs: PRD §17; 00_PROJECT_DELIVERY_PLAYBOOK §5.7,
  §14; 06_ACCEPTANCE_TESTS (gate criteria).
- Risks / mitigations: week slips because of calendar, not
  system quality — extend the window rather than lowering the
  bar.
- Review trigger: any P0 acceptance run that passes ACs but
  fails dogfood.
- Supersedes / superseded by: —
- Refs: Q-001.

## DEC-014 — Required observational data categories

- Date: 2026-04-22.
- Status: accepted.
- Context: The digital-twin hypothesis cannot be evaluated
  after the fact if the data was never captured. Missing
  fields at P0 become permanent gaps.
- Decision: P0 persists, at minimum:
  - **Turn-level**: user_message, assistant_response,
    timestamp, session_id, project_id?, source_channel,
    is_command, command name.
  - **Provider-run-level**: provider, provider_session_id,
    context_packing_mode, **`injected_context_ids`**,
    estimated + reported token usage, duration_ms,
    parser_status, error_type.
  - **Memory-level**: provenance, confidence, source_turn_ids,
    correction / supersession events.
  - **Artifact-level**: storage_object_id, artifact_type,
    retention_class, source_turn_id, memory-link captions.
  - **Feedback-level**: remember / save / forget / correction
    events; `/summary` and `/end` invocations.
  `injected_context_ids` is required; without it we cannot
  debug an off answer after the fact.
- Alternatives considered: collect only what ACs require;
  retro-add later.
- Impacted docs: PRD §14.2; HLD §10.3, §13.3; Appendix D.
- Risks / mitigations: small per-run storage overhead —
  measure in SP-01 / Phase 9 and confirm acceptable on CX22.
- Review trigger: if any retro-analysis fails for lack of a
  field we should have had.
- Supersedes / superseded by: —
- Refs: Q-002.

## DEC-015 — `/status` output contract

- Date: 2026-04-22.
- Status: accepted.
- Context: `/status` is both a user-facing health glance and a
  first-stop operational tool. Too little and users run
  `/doctor` routinely (too expensive); too much and it becomes
  noise.
- Decision: A compact, one-screen Telegram message including:
  - Short `session_id`.
  - Active `provider`.
  - `packing_mode` (`resume_mode` | `replay_mode`).
  - Running / queued job counts.
  - Failed-retryable counts for jobs, notifications,
    `storage_sync`.
  - S3 health (`ok` | `degraded` | `unknown`).
  - Last completed job relative time.
  - Short last-issue string, if any.
  A deeper `/status deep` variant is P1+.
- Alternatives considered: queue-only output; full operational
  dump; JSON.
- Impacted docs: PRD §7, §8.1, §13.3, §14.1.
- Risks / mitigations: field drift over time — template
  frozen in Phase 10; changes require a new DEC.
- Review trigger: when a field consistently confuses users or
  is ignored.
- Supersedes / superseded by: —
- Refs: Q-019, Q-020.

## DEC-016 — Restart user-notification policy

- Date: 2026-04-22.
- Status: accepted.
- Context: systemd restarts are inevitable. Silent recovery
  risks the user missing lost work; per-event notifications on
  every reboot risk alert fatigue.
- Decision: Restart recovery is silent unless there is
  user-visible impact. Per job:
  - `interrupted → queued (safe_retry)` →
    "중단된 작업을 복구해 다시 실행합니다."
  - `interrupted → failed` →
    "작업이 중단되어 자동 재시도하지 않았습니다."
  - Infrastructure-only interruptions (no in-flight user
    jobs) → no user message; boot doctor logs only.
  - Provider_run already `succeeded` but outbound pending →
    resume `notification_retry`; no extra notice.
- Alternatives considered: always-silent; boot summary every
  time; opt-in verbosity.
- Impacted docs: PRD §8.5, §13.3, AC-JOB-002; HLD §6.2, §15;
  05_RUNBOOK §4.
- Risks / mitigations: user misses a silent partial state —
  `/status` surfaces the backlog.
- Review trigger: if an incident is missed because the user
  had no signal.
- Supersedes / superseded by: —
- Refs: Q-021.

## DEC-017 — `/doctor` single command, typed output (quick + deep)

- Date: 2026-04-22.
- Status: accepted.
- Context: Splitting `/doctor` into quick / deep / targeted
  commands is cheap to add later but expensive to coordinate
  at P0. We still want the caller to understand which checks
  are cheap and which are expensive.
- Decision: A single `/doctor` command in P0. Output reports
  each check with a category tag (`quick` | `deep`), duration,
  and status (`ok` | `warn` | `fail`). Split to
  `/doctor deep` / `/doctor s3` / `/doctor claude` in P1+
  only when the aggregate latency exceeds the response-time
  budget set in Phase 10.
- Alternatives considered: split now; quick-only in P0; CLI
  flag.
- Impacted docs: PRD §8.7; HLD §16; AC-OBS-001.
- Risks / mitigations: `/doctor` grows slow — budget is
  measured in Phase 10 and split triggered by DEC update.
- Review trigger: `/doctor` p95 latency exceeds budget.
- Supersedes / superseded by: —
- Refs: Q-022.

## DEC-018 — S3 degraded concrete thresholds

- Date: 2026-04-22.
- Status: accepted.
- Context: "Degraded mode does not block replies" is correct
  in principle, but local disk is finite; without concrete
  thresholds, a multi-day outage silently fills the disk.
- Decision: Local artifact cache thresholds, tuned for CX22
  at deploy time:
  - **> 1 GB** or **< 20% free** → `/status` / `/doctor`
    warning.
  - **> 2 GB** or **< 15% free** → degraded warning;
    non-essential `storage_sync` backlog batches reduced.
  - **> 3 GB** or **< 10% free** → refuse new
    `long_term` writes; attachments still accepted as
    `ephemeral` / `session` with a user-visible explanation.
  Values are configurable in `config/storage.json`.
- Alternatives considered: percentage-only; absolute-only; no
  hard cap.
- Impacted docs: PRD §8.7, AC-STO-001, AC-OBS-001; HLD §12.5, §16.1;
  05_RUNBOOK §7.
- Risks / mitigations: thresholds are wrong for real workload
  — configurable values with one-line override; runbook
  documents the tuning procedure.
- Review trigger: first real storage outage or first CX22
  disk-pressure event.
- Supersedes / superseded by: —
- Refs: Q-023.

## DEC-019 — Summary auto-trigger conditions

- Date: 2026-04-22.
- Status: accepted.
- Context: Auto-summary every turn wastes tokens; never
  auto-summarizing risks context overflow.
- Decision: Explicit triggers first (`/summary`, `/end`).
  Automatic trigger fires when **any one** of the following is
  true **and** the throttle is satisfied:
  - `turn_count ≥ 20` since the last summary.
  - `transcript_estimated_tokens ≥ 6000`.
  - `session_age ≥ 24h`.
  **Throttle**: ≥ 8 new user turns since the previous summary.
  Summary runs use the advisory / lockdown profile with a
  dedicated small token budget.
- Alternatives considered: explicit-only; always-on fixed
  cadence; user opt-in.
- Impacted docs: PRD §12.3, §12.5; HLD §11.1.
- Risks / mitigations: too-eager automatic summaries eat token
  budget — the throttle + explicit default provide guard
  rails.
- Review trigger: if token usage analysis shows summaries
  dominating spend.
- Supersedes / superseded by: —
- Refs: Q-024.

## DEC-020 — Telegram message chunking at 3,800 chars

- Date: 2026-04-22.
- Status: accepted.
- Context: Telegram's `sendMessage` text limit is 4,096 UTF-16
  code units. Splitting at exactly the limit risks truncation
  edge cases around multi-byte sequences.
- Decision: Chunk at 3,800 characters. Each chunk carries a
  numbered marker (`(1/N)`, `(2/N)`). Full response is stored
  once in `turns` / local transcripts; Telegram receives
  chunked delivery only. Partial chunk failure is handled by
  `notification_retry` without rolling back `provider_run`
  success.
- Alternatives considered: split at 4,000 / 4,096; no chunk
  markers; split per sentence.
- Impacted docs: PRD §8.4; HLD §9.4.
- Risks / mitigations: very-long code blocks are split across
  chunks — user-visible but acceptable for P0.
- Review trigger: Telegram API limit change; user feedback on
  chunked readability.
- Supersedes / superseded by: —
- Refs: Q-018.

## DEC-021 — CJK-safer token estimator rule

- Date: 2026-04-22.
- Status: accepted.
- Context: ASCII-only estimation (`ceil(char_count / 3)`)
  undercounts Korean / CJK text by a large margin; undercount
  causes prompt-overflow failures.
- Decision: For Korean / CJK-heavy text, use
  `ceil(char_count / 1.5)`. For mixed text, take the maximum
  of ASCII and CJK estimates. For CJK-heavy worst case, fall
  back to `ceil(char_count)` if `/1.5` still disagrees with
  observed tokenizer behavior (PRD §12.6).
- Alternatives considered: run a real tokenizer at P0 (adds a
  large dependency); always assume ASCII.
- Impacted docs: PRD §12.6; HLD §10.4.
- Risks / mitigations: we over-allocate budget and drop
  context we could have fit — acceptable; overflow is worse
  than overestimation.
- Review trigger: first time a Korean-heavy prompt hits
  `prompt_overflow` unexpectedly, or we ship a real tokenizer.
- Supersedes / superseded by: —
- Refs: Q-025.

## DEC-022 — second-brain GitHub repo는 actwyn judgment의 canonical store가 아니다

- Date: 2026-04-26.
- Status: accepted.
- Context: 사용자가 Round 7에서 (a) Obsidian 미사용, (b) GitHub PR
  write-back 마찰 거부, (c) second-brain repo를 사람이 직접 편집하지
  않고 AI를 통해서만 조회 / 편집한다는 조건을 명시. 이 조건들 위에서
  Markdown vault canonical 전제는 깨진다. ADR-0009가 핵심 architectural
  결정을 codify했지만, "second-brain repo는 어떤 역할로 남는가"라는
  운영 차원의 결정이 별도로 trace 가능해야 한다.
- Decision: second-brain GitHub repo (`alxdr3k/second-brain`)는
  actwyn judgment system의 canonical store **아니다**. 역할 4가지로
  한정한다: (1) seed corpus — 기존에 누적된 생각 / 대화의 import
  source, (2) human-readable export — 가끔 읽기 좋은 Markdown
  snapshot, (3) backup / archive — Git history, (4) publishing
  layer — 일부 지식의 블로그 / 공개 문서 승격. **canonical이 아닌
  것**: 실시간 memory write path, `current_operating_view` source
  (ADR-0013 cleanup으로 rename; 이전 이름: "current truth"), agent
  runtime retrieval primary DB, Obsidian vault, PR 기반 memory
  manager.
- Alternatives considered: second-brain repo를 canonical로 유지하고
  Markdown frontmatter `judgment_role` optional 필드 도입; second-brain
  repo를 deprecate / archive; second-brain repo를 actwyn judgment
  system으로 흡수.
- Impacted docs: ADR-0009 §1; `docs/JUDGMENT_SYSTEM.md` §What this is /
  §Refs.
- Risks / mitigations: seed corpus import 형식이 미정 — Phase 1
  schema 결정 시 함께 정의. second-brain repo의 기존 정책 문서
  (SOURCE_OF_TRUTH / INGESTION_RULES / PROMPTING_GUIDE 등) 처분은 별
  결정 (Q-030).
- Review trigger: 사용자가 외부 PKM (Obsidian / Logseq / 별 repo)을
  다시 도입할 때, 또는 seed corpus 외 다른 use case가 등장할 때.
- Supersedes / superseded by: —
- Refs: ADR-0009; second-brain Ideation 노트 Round 7 결정 #2;
  Q-030.

## DEC-023 — `JudgmentItem.kind` v1 도입 enum 범위 (5-6개부터 시작)

- Date: 2026-04-26.
- Status: accepted.
- Context: ADR-0009 / `docs/JUDGMENT_SYSTEM.md`가 `JudgmentItem.kind`
  **11개** (`fact` / `preference` / `claim` / `principle` /
  `hypothesis` / `experiment` / `result` / `decision` /
  `current_state` / `procedure` / `caution`)를 conceptual catalog로
  정의했다. 이후 ADR-0013 §architecture_assumption refine이 `assumption`
  (`kind=assumption` + `target_domain` 패턴)을 추가해 conceptual catalog는
  **12개**가 됐다. Phase 1 schema 첫 도입에서 12개를 모두 enforce하면
  사용자 측 모델링 비용 / classification 비용이 크고, 실제로 actwyn
  P0 use case에 모두 필요하다는 evidence는 아직 없다. Open question
  Q-028 (kind v1 enum 범위)에 대한 commitment 단계의 출발점이 필요하다.
- Decision: Phase 1 (P0.5) 첫 schema 도입은 **6개 enforced kind**에서
  시작한다: `fact` / `preference` / `decision` / `current_state` /
  `procedure` / `caution`. 나머지 6개 deferred (`claim` / `principle` /
  `hypothesis` / `experiment` / `result` / `assumption`)는 evidence가 모일 때 별
  마이그레이션 / DEC로 추가한다. `assumption`은 P1 도입 예정
  (ADR-0013 §architecture_assumption). schema 자체는 enum 확장이 비
  파괴적으로 가능한 형태 (TEXT NOT NULL + 검증)로 작성한다.
- Alternatives considered: 처음부터 12개 모두 도입; 더 좁게 4개
  (`fact` / `preference` / `decision` / `caution`)부터; Phase 2
  (typed tool) 도입 시점까지 enum 범위 미정.
- Impacted docs: `docs/JUDGMENT_SYSTEM.md` §Enum catalog,
  §Phase 0-5 roadmap; ADR-0009 §Risks (enum rigidity).
- Risks / mitigations: 후속 enum 확장 시 마이그레이션 필요 —
  enum은 TEXT column + 응용 검증으로 확장 비용 최소화. Eval harness
  결과가 추가 kind 필요성을 surface (Q-031).
- Review trigger: Phase 1 schema 구현 중 5-6개로 부족하다는 use
  case 등장; user가 명시적으로 `experiment` / `result` 같은 kind를
  요청; eval harness가 missing kind를 기록.
- Supersedes / superseded by: —
- Refs: ADR-0009; second-brain Ideation 노트 Round 7 + Appendix
  A.3 (enum 카탈로그); Q-028.

## DEC-024 — P0.5 cognitive scope: Judgment Ledger + Goal / Workspace / Reflection 최소형 + Eval 질문 세트

- Date: 2026-04-26.
- Status: accepted.
- Context: ADR-0010이 actwyn Judgment System을 cognitive architecture로
  framing 확장하면서 12-layer를 식별했다. Phase 1(P0.5) 도입 시
  12-layer 전체를 한 번에 다루면 scope creep / over-engineering 위험이
  있다. ADR-0010 Decision 6이 P0.5 / P1 / P2+ 분할을 commitment 수준에서
  잡았으나, "P0.5에 정확히 어떤 cognitive 자원이 들어가는가"는 별
  trace 가능한 결정이 필요하다.
- Decision: P0.5 cognitive scope는 다음 6개 layer로 한정한다.
  (1) Event Memory(이미 P0), (2) Episodic Memory(`memory_summaries`,
  ADR-0006), (3) Semantic Memory(`memory_items` + `judgment_items`),
  (4) Judgment Ledger(`judgment_items` 5 tables), (5) Goal / Value
  Layer **최소형**(Goal table 또는 view, decision_criteria 별 객체
  형태는 schema PR에서), (6) Working Memory / Workspace **최소형**
  (task / goal_stack / active_scope / current_state / relevant_memory /
  decision_criteria 슬롯만). 추가로 Reflection 최소형 — 단,
  Reflection clause는 **DEC-035로 refined.** P0.5 reflection scope는
  `reflection_triage`만 (ADR-0012 `ReflectionTriageEvent`). turn 종료
  시점의 lesson candidate append와 나머지 4 sub-action
  (`reflection_proposal` / `consolidation` / `critique` /
  `eval_generation`)은 P1+로 미룬다. 본격 Attention scoring formula /
  Procedure library / Active experiment loop / Forgetting policy
  4-5(`archive` / `compress`)는 P1로 분리.
- Alternatives considered: 12-layer 전체를 P0.5에 도입; Goal /
  Workspace 없이 ADR-0009 Phase 1 그대로 유지하고 모두 P1로 미룸;
  Reflection을 P1로 미루고 P0.5는 Goal / Workspace만.
- Impacted docs: `docs/JUDGMENT_SYSTEM.md` §Cognitive Architecture
  Extension §Phase 재구성 / §12-layer cognitive architecture; ADR-0010
  §Decision 6.
- Risks / mitigations: "최소형"의 정의가 모호 — Phase 1 schema PR에서
  명시. ADR-0010 Consequences가 schema 결정 항목을 catalog. eval harness
  결과가 부족 evidence 시 layer 추가 trigger.
- Review trigger: Phase 1 schema PR에서 6 layer로 부족하다는 use case;
  사용자가 procedure library / attention scoring을 P0.5로 당겨달라고
  요청; eval harness가 layer gap을 surface.
- Supersedes / superseded by: Reflection / Consolidation 최소형 clause
  ("turn 종료 시 lesson candidate를 `judgment_events`에 append") is
  **superseded by DEC-035** — P0.5 reflection scope is narrowed to
  `reflection_triage` only. The rest of the DEC-024 decision (P0.5
  cognitive layer 6종, Goal / Workspace 최소형) remains accepted.
- Refs: ADR-0010 §Decision 6 / §Phase 재구성; ADR-0013 §Decision 5;
  DEC-035; second-brain Ideation 노트 Round 9; Q-032; Q-054.

## DEC-025 — JudgmentItem metacognitive 필드 (`would_change_if` / `missing_evidence` / `review_trigger`)는 P0.5 schema에 optional 도입

- Date: 2026-04-26.
- Status: accepted.
- Context: ADR-0010 Decision 3이 `JudgmentItem`에 9개 신규 필드(stakes /
  risk / valence / user_emphasis / confidence_reason / missing_evidence /
  would_change_if / review_trigger / uncertainty_notes)를 spec했다.
  P0.5 schema PR에서 모두 required로 도입하면 사용자 / AI 입력 비용이
  급격히 늘고, 실제 retrieval / explain API에서 필요한지 evidence가
  아직 없다. 그러나 일부 필드(특히 `would_change_if` / `missing_evidence` /
  `review_trigger`)는 explain API 품질을 결정하는 핵심 metacognitive
  자원이다.
- Decision: 9개 필드 모두 **P0.5 schema에 optional column / nullable
  field로 도입**한다. 강제(required)는 아님. 단, 다음 3개 필드는
  **권장 채우기**로 spec한다(필수는 아님): `would_change_if` /
  `missing_evidence` / `review_trigger`. 나머지 6개(stakes / risk /
  valence / user_emphasis / confidence_reason / uncertainty_notes)는
  필요 시에만 채운다. P1+에서 eval harness가 metacognitive 필드 누락이
  답변 품질을 떨어뜨린다는 evidence를 surface하면 일부를 required로
  승격(별 ADR / DEC 필요).
- Alternatives considered: 9개 모두 required로 도입; 9개 모두 단순
  optional로 도입(권장 표시 없음); P0.5는 metacognitive 필드 전체 미도입,
  P1로 이월.
- Impacted docs: `docs/JUDGMENT_SYSTEM.md` §JudgmentItem schema
  extension / §Metacognition fields; ADR-0010 §Decision 3 / §Risks.
- Risks / mitigations: 권장 / 필수 경계가 모호 — Phase 1 schema PR에서
  CHECK constraint 또는 응용 검증으로 명시. assistant_generated /
  inferred judgment에서 metacognitive 필드를 hallucinate할 위험 — explain
  API에서 source-grounding 검증, eval harness가 자동 체크.
- Review trigger: eval harness가 metacognitive 필드 누락이 explain
  API / would_change_if 검증 / scheduled review 품질을 떨어뜨린다는
  evidence를 surface; 사용자가 명시적으로 강제(required) 요청; metacognitive
  hallucination incident 발생.
- Supersedes / superseded by: —
- Refs: ADR-0010 §Decision 3 / §Metacognition fields; second-brain
  Ideation 노트 Round 9 + Appendix A.19; Q-032.

## DEC-026 — JudgmentItem.status enum P0.5 도입 범위 (9 enum 모두)

- Date: 2026-04-26.
- Status: accepted.
- Context: ADR-0009의 6 status (`proposed` / `active` / `superseded` /
  `revoked` / `rejected` / `expired`)에 ADR-0011이 3개 신규 status
  (`dormant` / `stale` / `archived`)를 추가. P0.5 schema에 모두
  포함할지, 일부만 포함할지 결정 필요.
- Decision: P0.5에 9 status 모두 도입. 단 default는 `active`로 유지하고,
  기존 row는 `schema_version: 0.0`으로 표시. application 코드는 P0.5에서
  `dormant` / `stale` / `archived`를 자동으로 set하지 않으며, 모두
  명시적 transition으로만 진입한다 (자동 stale 분류는 P1+ activation_score
  formula 도입 시).
- Alternatives considered: P0.5는 ADR-0009 6 status만 + P1에 3 신규
  추가; `archived`만 P0.5 / 나머지는 P1.
- Impacted docs: ADR-0011 §Decision 2 / §Status enum 확장; Q-036
  (rejected/revoked 통합).
- Risks / mitigations: 9 enum이 over-engineering 위험 → application
  코드는 P0.5에서 active / proposed / superseded / revoked / expired만
  실제 사용; dormant / stale / archived는 schema column에만 존재.
- Review trigger: P1 activation_score formula 도입 시 자동 stale 분류
  로직 검토; rejected / revoked 통합 결정 (Q-036).
- Supersedes / superseded by: **superseded by DEC-033** (Round 13 Critique
  Lens로 status 9 enum이 truth lifecycle / activation / retention 3축
  axis conflation임을 발견. 3축 분리.)
- Refs: ADR-0011 §Decision 2; Q-036; ADR-0013 §Decision 3; DEC-033.

## DEC-027 — `decay_policy` enum P0.5 도입 범위 (`none` + `supersede_only`만)

- Date: 2026-04-26.
- Status: accepted.
- Context: ADR-0011이 5 decay_policy (`none` / `time_decay` /
  `verification_decay` / `event_driven` / `supersede_only`)를 정의.
  P0.5에 모두 도입하면 over-engineering 위험; 모두 미도입하면 ADR-0009의
  supersede chain 정책이 schema에 반영 안 됨.
- Decision: P0.5는 `none` + `supersede_only` 2종만 도입. 모든 새 record는
  default `supersede_only`로 설정 (ADR-0009의 12 Laws #7 "Supersede,
  do not overwrite" 정합). 나머지 3종 (`time_decay` /
  `verification_decay` / `event_driven`)은 P1+에서 evidence 기반 추가.
- Alternatives considered: P0.5는 `none`만 / 5종 모두 도입.
- Impacted docs: ADR-0011 §Decision 4; `docs/JUDGMENT_SYSTEM.md`
  §volatility + decay_policy.
- Risks / mitigations: 나중에 `time_decay` / `verification_decay`가
  필요해지면 schema migration 필요 → 현재 enum을 string column으로
  저장하면 추가 cost 없음 (CHECK constraint 추가만).
- Review trigger: 마케팅 채널 성과 / 외부 연구 요약처럼 빠른 stale이
  필요한 use case가 P1에 등장할 때.
- Supersedes / superseded by: —
- Refs: ADR-0011 §Decision 4.

## DEC-028 — `ontology_version` + `schema_version` 모든 새 record에 강제

- Date: 2026-04-26.
- Status: accepted.
- Context: taxonomy / schema가 미래에 바뀔 가능성이 매우 높음 (Round 10
  upgradeability 논의). 새 record에 version 정보가 없으면 기존
  데이터를 어떤 ontology로 해석해야 할지 불명확.
- Decision: 모든 새 `judgment_items` row는 `ontology_version`과
  `schema_version`을 강제 (NOT NULL). 초기 값은
  `ontology_version: judgment-taxonomy-v0.1`과 `schema_version: 0.1.0`.
  typed tool layer (`judgment.propose` / `judgment.commit`)에서 자동
  주입하여 작성 friction 최소화.
- Alternatives considered: optional 필드로 시작; ontology_version만 강제.
- Impacted docs: ADR-0011 §Decision 5; Q-030 (migration 전략).
- Risks / mitigations: ADR-0011 도입 전 row가 NULL이 되어 NOT NULL
  constraint 위반 → 기존 row는 일괄 backfill (`ontology_version: pre-v0.1`,
  `schema_version: 0.0`)로 처리. migration script는 Phase 1 schema PR에
  포함.
- Review trigger: ontology v0.2로 업그레이드 시; migration tooling이
  P2 필요하다고 판명 시.
- Supersedes / superseded by: —
- Refs: ADR-0011 §Decision 5; Q-030.

## DEC-029 — `system_authored` enum 제거 + `authority_source` P0.5 도입 범위

- Date: 2026-04-26.
- Status: accepted.
- Context: Round 11 must-fix #3가 `system_authored`를 `epistemic_status`에
  추가했지만 (commit `eb9004b`), 사용자가 즉시 모순 발견 — origin과 authority
  를 한 필드에 섞은 axis conflation. ADR-0012가 RETRACT.
- Decision: (a) `epistemic_status`에서 `system_authored` 제거, 8 enum 유지
  (origin only). (b) 신규 `authority_source` 필드 (7 enum, optional)로
  authority 분리. (c) P0.5 `authority_source` 도입 범위는 `none` +
  `user_confirmed` 2종만. 나머지 5 enum (`maintainer_approved` /
  `merged_adr` / `runtime_config` / `compiled_system_policy` /
  `safety_policy`)은 P1+ evidence 기반 추가.
- Alternatives considered: `system_authored` 의미 재정의로 유지;
  `authority_source` 7 enum 모두 P0.5 도입; `epistemic_status`와
  `authority_source` 통합 single field.
- Impacted docs: ADR-0012 §Decision 1-3; `docs/JUDGMENT_SYSTEM.md`
  §Authority Source; ADR-0011 Refs.
- Risks / mitigations: ADR-0011 commit `eb9004b`이 system_authored를
  추가했던 row가 있을 수 있음 → 현재 시점은 schema migration 전이라
  실제 row 없음. 문서 정정만으로 충분.
- Review trigger: P1 schema PR에서 `authority_source` enum 추가 필요 시.
- Supersedes / superseded by: —
- Refs: ADR-0012 §Decision 1-3; ADR-0011 §Refs (system_authored RETRACT
  cross-ref); second-brain Ideation Round 12 사용자 모순 직접 발견
  (no upstream Q-### — DEC-029는 retraction 결정이라 ADR-0012가 직접
  source). *(이전 Refs Q-040은 last_verified_at trigger 추적이라 무관 —
  codex bot review로 발견하여 정정.)*

## DEC-030 — Control-plane vs Judgment-plane 분리 commitment

- Date: 2026-04-26.
- Status: accepted.
- Context: ADR-0012가 `ReflectionTriageEvent` / `interaction_signals` /
  `tensions` (ADR-0013 §Tension Generalization으로 `design_tensions` →
  `tensions` rename + target_domain 차원) / `critique_outcomes` 4
  control-plane object를 신설. 이를 judgment-plane (decision /
  current_state / caution / procedure / principle / fact / preference)과
  명시적으로 분리할지, 같은 plane으로 취급할지 결정 필요.
- Decision: control-plane과 judgment-plane을 명시적으로 분리한다.
  control-plane는 telemetry / audit / debug 용 (durable 아닐 수 있음,
  retention class `session` 기본). judgment-plane는 actwyn 행동의 기준
  (durable). `Tension` 등 critique object (ADR-0012가 `DesignTension`
  으로 도입한 것을 ADR-0013이 일반 `Tension`으로 generalize)는
  judgment_items에 들어가지 않으며, judgment_items는 critique 카테고리를
  가지지 않는다.
- Alternatives considered: 모두 judgment_items로 통합 (recursive critique
  위험); 별 DB 분리 (운영 cost 증가).
- Impacted docs: ADR-0012 §Decision 6; `docs/JUDGMENT_SYSTEM.md`
  §Metacognitive Critique Loop §Control-plane vs Judgment-plane.
- Risks / mitigations: 같은 SQLite DB 안에서 schema (`control_plane_*`
  prefix vs `judgment_*` prefix)로 분리. application 코드에서 두 plane
  cross-reference는 link table만 (foreign key 없음).
- Review trigger: control-plane object가 judgment-plane으로 승격해야 할
  use case 발견 시; storage cost가 control-plane에서 폭발할 때.
- Supersedes / superseded by: —
- Refs: ADR-0012 §Decision 6.

## DEC-031 — Critic Loop P0.5 도입 단계 (1-3단계만)

- Date: 2026-04-26.
- Status: accepted.
- Context: ADR-0012가 Critic Loop 8단계 (capture → signal detection →
  tension proposal → target linking → severity ranking → resolution path
  → outcome tracking → learning)를 정의. P0.5에 모두 도입하면
  over-engineering 위험.
- Decision: P0.5는 1-3단계만 도입 — capture (이미 ADR-0008 ledger 활용),
  signal detection (rule-based + 사용자 명시), tension proposal (수동
  생성 + critic model 후보). 4-7단계 (target linking / severity ranking
  / resolution path / outcome tracking)는 P1+. 8단계 (learning /
  auto-heuristic 승격)는 P3+.
- Alternatives considered: 1-2단계만 (signal detection까지) — tension
  proposal이 없으면 critique loop 시작 안 됨; 1-7단계 모두 — P1 cost
  너무 큼.
- Impacted docs: ADR-0012 §Decision 9; `docs/JUDGMENT_SYSTEM.md`
  §Metacognitive Critique Loop §Critic Loop 8단계.
- Risks / mitigations: P0.5 `tensions` (ADR-0013 rename)이 자동 resolution
  없이 쌓일 위험 → 사용자가 직접 review하여 resolution path 결정. P1에
  4단계 자동화.
- Review trigger: P1 schema PR; `tensions` queue가 사용자 검토
  burden을 만들 때.
- Supersedes / superseded by: —
- Refs: ADR-0012 §Decision 9; Q-047.

## DEC-032 — Tension `target_domain` P0.5 도입 범위 (8 enum)

- Date: 2026-04-26.
- Status: accepted.
- Context: ADR-0013이 `DesignTension`을 일반 `Tension` + `target_domain`
  차원 (13 enum)으로 일반화. P0.5 도입 범위 결정 필요. `target_domain`
  enum은 `Tension`과 `kind=assumption` (ADR-0011 정교화)이 공유 — 따라서
  `architecture`도 P0.5 enum에 포함해야 한다 (Round 13 codex bot review
  정정).
- Decision: P0.5는 **8 enum** (`design` / `memory` / `policy` /
  `workflow` / `evidence` / `decision` / `security` / `architecture`)
  도입. `architecture`는 `kind=assumption` + `target_domain=architecture`
  형태로 시스템 자신의 설계 가정을 표현하는 데 필수. 나머지 5 enum
  (`product` / `marketing` / `user_preference` / `research` / `tooling`)은
  schema reserved (string-like + CHECK constraint enum 확장 가능). P1+
  사용자 ideation에서 해당 domain의 tension 발견 시 enum 추가.
- Alternatives considered: 13 enum 모두 P0.5; 7 enum만 (architecture
  제외 — codex bot이 발견한 일관성 깨짐); 6 enum만 (security 제외).
- Impacted docs: ADR-0013 §Decision 2 / §Decision 8 (architecture_assumption);
  `docs/JUDGMENT_SYSTEM.md` §Tension Generalization +
  §architecture_assumption.
- Risks / mitigations: 새 domain 등장 시 enum 확장 비용 → schema는 TEXT
  column + CHECK constraint, application 코드에서 검증. 마이그레이션 비용
  최소.
- Review trigger: 사용자가 reserved 5 enum의 domain에서 tension 제기 시.
- Supersedes / superseded by: —
- Refs: ADR-0013 §Decision 2 + §Decision 8; Q-051; PR #10 codex bot
  review (P1 architecture missing).

## DEC-033 — `JudgmentItem.status` 9 enum → 3축 분리 (lifecycle / activation / retention)

- Date: 2026-04-26.
- Status: accepted.
- Context: ADR-0011이 status 9 enum 통합을 결정 (DEC-026). Round 13
  Critique Lens 적용으로 3축 (truth lifecycle / activation /
  retention) 섞임 발견 (axis conflation). ADR-0013이 partial retract.
- Decision: status 9 enum 단일 폐기. 3축 분리:
  (a) `lifecycle_status` 6 enum (proposed / active / rejected / revoked /
      superseded / expired) — P0.5 모두.
  (b) `activation_state` 5 enum (eligible / dormant / stale /
      history_only / excluded) — P0.5는 3 enum (eligible / history_only /
      excluded). dormant / stale 자동 분류는 P1+.
  (c) `retention_state` 3 enum (normal / archived / deleted) — P0.5 모두.
  조합 가능: active+stale / superseded+history_only / active+archived 등.
- Alternatives considered: status 9 enum 유지 + application 코드에서 분리;
  2축 분리 (lifecycle + activation, retention 미도입); 4축 분리 (visibility
  추가).
- Impacted docs: ADR-0013 §Decision 3; `docs/JUDGMENT_SYSTEM.md` §Status
  Axis Separation; ADR-0011 §Decision 2 (partial retract).
- Risks / mitigations: 3축 분리로 SQL filter 복잡도 증가 → 직교 축이라
  AND 결합 단순. projection rule이 복잡도 흡수.
- Review trigger: 새 차원 (visibility / acl) 필요 시.
- Supersedes / superseded by: **supersedes DEC-026** (status 9 enum 통합).
- Refs: ADR-0013 §Decision 3; DEC-026.

## DEC-034 — `procedure_subtype` 5 enum 추가 + default `skill`

- Date: 2026-04-26.
- Status: accepted.
- Context: ADR-0010의 `kind=procedure`가 skill / policy /
  preference_adaptation / safety_rule / workflow_rule을 묶는 axis
  conflation. ADR-0013이 분리.
- Decision: `kind=procedure` 유지. 신규 `procedure_subtype` 필드 5 enum
  (skill / policy / preference_adaptation / safety_rule / workflow_rule).
  기존 procedure 노트 마이그레이션 default `subtype=skill` (사용자 명시
  변경 가능).
- Alternatives considered: 5 별 kind 추가 (kind enum 폭발); subtype 미도입
  (axis conflation 유지).
- Impacted docs: ADR-0013 §Decision 7; `docs/JUDGMENT_SYSTEM.md`
  §procedure_subtype.
- Risks / mitigations: 기존 노트 default 분류 오류 — 사용자가 명시
  override.
- Review trigger: 새 procedure_subtype 필요 시.
- Supersedes / superseded by: —
- Refs: ADR-0013 §Decision 7; Q-056.

## DEC-035 — Reflection 5 sub-action P0.5 도입 (reflection_triage만)

- Date: 2026-04-26.
- Status: accepted.
- Context: ADR-0010의 reflection layer 통합은 summary / lesson / critique
  / consolidation / triage / eval generation을 묶는 axis conflation.
  ADR-0013이 5 sub-action으로 분해.
- Decision: P0.5는 `reflection_triage`만 도입 (ADR-0012의
  `ReflectionTriageEvent` 그대로). 나머지 4 sub-action
  (`reflection_proposal` / `consolidation` / `critique` /
  `eval_generation`)은 P1+ 점진 도입.
- Alternatives considered: 5 sub-action 모두 P0.5; reflection_triage +
  critique만 P0.5.
- Impacted docs: ADR-0013 §Decision 5; `docs/JUDGMENT_SYSTEM.md`
  §Reflection 5 sub-action.
- Risks / mitigations: P0.5 reflection 기능 협소 — 사용자 명시 trigger로
  workaround.
- Review trigger: 사용자가 reflection_proposal / critique 자동화 요구 시.
- Supersedes / superseded by: —
- Refs: ADR-0013 §Decision 5; Q-054.

## DEC-036 — `current_truth` → `current_operating_view` 이름 변경

- Date: 2026-04-26.
- Status: accepted.
- Context: ADR-0009 Law #4 ("Current truth is a projection")의 "truth"
  함의 위험. "진짜 진실"이 아닌 "현재 운영 기준". Round 13 Critique Lens
  Term compression check 발견.
- Decision: 문서 / UX 차원에서 `current_truth` → `current_operating_view`
  이름 변경. DB 필드 `current_state`는 유지 (ADR-0009 / 0010 정합 — 코드
  / migration 영향 없음). ADR-0009 Law #4 본문은 ADR-0013 §Decision 4로
  cross-ref.
- Alternatives considered: `current_truth` 유지; `active_baseline_view`
  대체.
- Impacted docs: ADR-0009 Law #4 (정정); ADR-0013 §Decision 4;
  `docs/JUDGMENT_SYSTEM.md` §current_operating_view.
- Risks / mitigations: 외부 reader에 misleading — 이름 변경으로 해결.
- Review trigger: 더 정확한 이름 (예: `active_view`) 발견 시.
- Supersedes / superseded by: —
- Refs: ADR-0013 §Decision 4; Q-057.

## DEC-037 — Implementation Documentation Lifecycle Policy

- Date: 2026-04-26.
- Status: accepted.
- Context: actwyn judgment system은 Phase 0/0.5에서 ADR 5 + JUDGMENT_SYSTEM.md
  spec + DEC/Q register로 큰 design surface를 만들었다. Phase 1A 구현이
  시작되면 이 design 문서들을 어떻게 관리할지 — current behavior에 맞춰
  편집할지, 그대로 historical record로 두고 별도 current-state docs를
  만들지 — 결정이 필요하다. 결정 없이 가면 (a) accepted ADR이 사후
  수정되어 audit trail 깨짐, (b) design spec과 implementation drift가
  silent하게 누적, (c) 새 contributor가 어디를 source of truth로 봐야
  할지 모름.
- Decision: Phase 0/0.5 design 문서와 implementation 문서의 lifecycle을
  다음 7개 원칙으로 분리한다.
  1. Phase 0 design specs (`docs/JUDGMENT_SYSTEM.md`, ADR-0009 ~ ADR-0013,
     관련 DEC/Q)는 Phase 1 구현이 시작되면 **historical architectural
     records**로 취급한다.
  2. **Accepted ADRs는 current behavior에 맞춰 편집하지 않는다.** 새
     ADR이 supersede / refine한다 (ADR README §Promotion rules 정합).
  3. Current implemented behavior는 implementation 시작 후 **thin
     current-state docs**로 기록한다 (별도 PR).
  4. Code / tests / migrations / schema 정의가 implemented behavior의
     **source of truth**다. 문서가 코드와 다르면 코드가 맞다.
  5. Current docs는 작게 유지하며, behavior / schema / runtime 변경 시만
     업데이트한다.
  6. Archived design docs는 **history**이며 **authority가 아니다**.
     reader는 이를 "왜 이 결정을 했는가"의 근거로 보고, "지금 어떻게
     동작하는가"의 source로 보지 않는다.
  7. `AGENTS.md` / 본격 current-state doc 구조는 별도 docs-structure PR
     에서 도입한다 (Q-063 추적).
- Alternatives considered:
  - (a) ADR을 current behavior에 맞춰 사후 편집 — audit trail 깨짐, ADR
    promotion rules와 충돌.
  - (b) design spec을 그대로 current spec으로 유지 — implementation drift
    누적 후 silent contradiction.
  - (c) 본 PR에서 archive 폴더 + AGENTS.md + current-state docs 모두 도입
    — scope creep, Phase 0/0.5 cleanup 본 PR 범위 밖.
- Impacted docs: ADR README §Promotion rules; `docs/JUDGMENT_SYSTEM.md`
  (자체가 historical record가 될 후보); 모든 ADR-0009 ~ ADR-0013;
  DEC-022 ~ DEC-036; Q-027 ~ Q-062.
- Risks / mitigations:
  - design / implementation drift → §5 (small current docs) + §4
    (code is source of truth) + Phase 1A에서 thin current-state docs
    도입 시점에 명시 sync.
  - ADR이 stale로 보일 위험 → §1 (historical record라는 framing) +
    ADR README §Index가 supersede chain 표시.
  - 새 contributor 혼동 → Phase 1A 첫 commit 또는 docs-structure PR에서
    `AGENTS.md`로 onboarding.
- Review trigger:
  - Phase 1A 첫 implementation PR이 열릴 때 (current-state docs 시작
    시점).
  - docs-structure PR이 시작될 때 (`AGENTS.md` / archive location 결정).
  - design spec과 implementation 사이 silent drift가 감지될 때.
- Supersedes / superseded by: —
- Refs: ADR README §Promotion rules; Q-063 (follow-up docs-structure PR).

## DEC-038 — Judgment System Phase 1B.1–1B.3 Runtime Wiring

- **Date**: 2026-04-28
- **Status**: decided
- **Decision**: Wire Phase 1A judgment surfaces into the live runtime in three incremental steps. Phase 1B.1: `evaluateTurn()` + `recordControlGateDecision()` called per non-system `provider_run` in `src/queue/worker.ts` (L0-only telemetry). Phase 1B.2: active/eligible/normal/global/time-valid `judgment_items` injected into `buildContext()` as `judgment_active` slot (priority 600) in `replay_mode`; excluded from `summary_generation`. Phase 1B.3: `/judgment` and `/judgment_explain <id>` Telegram commands dispatched in worker; output via outbound notification only (not stored as turns).
- **Context**: Phase 1A.1–1A.8 implemented all judgment surfaces as local, unregistered modules. Phase 1B was the first runtime integration step — authorised explicitly by the operator on 2026-04-28.
- **Key constraints preserved**:
  - Write-path tool contracts (propose/approve/commit/…) remain unregistered in runtime.
  - `src/providers/*`, `src/memory/*`, `src/telegram/*`, and `src/main.ts` do not import from `src/judgment/*`.
  - Context injection scoped to `global` scope and `retention_state=normal` rows only; resume-mode staleness deferred (issue #44).
  - Control Gate `job_id` attribution and retry idempotency: **resolved** (migration 006, issue #45). `recordControlGateDecision` now accepts `job_id`, worker passes `job.id`; partial UNIQUE index + pre-check guard ensure one turn row per job. Boot-time upgrade guard prevents cross-schema duplicates.
- **Impacted docs**: `docs/ARCHITECTURE.md`, `docs/RUNTIME.md`, `docs/CODE_MAP.md`, `docs/DATA_MODEL.md`, `docs/TESTING.md`, `AGENTS.md`, `docs/07_QUESTIONS_REGISTER.md` (Q-027).
- **Refs**: AGENTS.md §Source of truth Phase 1B; `feat(judgment): Phase 1B.1-1B.3 runtime wiring` commit.

---

### 본 PR에서 의도적으로 하지 않은 것 (DEC-037 scope clarification)

다음은 후속 docs-structure PR로 분리한다 (Q-063):

- `docs/ARCHITECTURE.md`, `docs/CODE_MAP.md`, `AGENTS.md`,
  `docs/design/archive/` 같은 새 구조 도입 X.
- `docs/JUDGMENT_SYSTEM.md` 이동 또는 archive X (본 commit으로 자체
  cleanup만).
- Full current-doc structure 생성 X.

본 DEC는 lifecycle policy commitment만 codify한다.

---

## Incident log

Follow the runbook §13 template. One entry per incident; keep
entries terse.

*No incidents yet.*

