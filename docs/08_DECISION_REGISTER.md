# Decision Register

> Status: living document · Owner: project lead · Last updated: 2026-04-22
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
- Impacted docs: PRD §15, AC10; HLD §13.
- Risks / mitigations: subtle bypass (e.g. a logger that prints
  raw objects) still possible; mitigated by a property test on
  seeded patterns across every durable dump (AC10).
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
- Impacted docs: PRD §12.7; HLD §12; AC16.
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
  AC01.
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
- Impacted docs: PRD §15, AC10; HLD §13.2.
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
  1. Technical: all AC01..AC25+ green on the staging host
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
- Impacted docs: PRD §7, §8.1; HLD §16.5.
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
- Impacted docs: PRD §8.5, §13.3, AC06; HLD §6.2, §15;
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
- Impacted docs: PRD §8.7; HLD §16; AC16.
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
- Impacted docs: PRD §8.7, AC08, AC16; HLD §12.5, §16.1;
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

---

## Incident log

Follow the runbook §13 template. One entry per incident; keep
entries terse.

*No incidents yet.*

