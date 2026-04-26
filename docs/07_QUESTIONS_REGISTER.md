# Personal Agent — Questions Register

> Status: living document · Owner: project lead · Last updated: 2026-04-26
>
> This file is the **question ledger**: it captures questions, proposed
> answers, and the promotion pointers that route each decided answer
> into the right source-of-truth document. See
> [`00_PROJECT_DELIVERY_PLAYBOOK.md`](./00_PROJECT_DELIVERY_PLAYBOOK.md)
> §12 for the Knowledge Promotion Pipeline.

## How to use this file

The Questions Register is **not** a source of truth. Binding answers
live in:

- [`PRD.md`](./PRD.md) — what the system must do.
- [`02_HLD.md`](./02_HLD.md) — how it is built.
- [`05_RUNBOOK.md`](./05_RUNBOOK.md) — how it is operated.
- [`06_ACCEPTANCE_TESTS.md`](./06_ACCEPTANCE_TESTS.md) — how it is
  verified.

Decisions that promote an answer into those docs are recorded as
either `DEC-###` entries in
[`08_DECISION_REGISTER.md`](./08_DECISION_REGISTER.md) or as
`ADR-####` files under [`adr/`](./adr/).
[`09_TRACEABILITY_MATRIX.md`](./09_TRACEABILITY_MATRIX.md) connects
everything.

### Entry format

```
### Q-### — Short title

- Section: <one of the sections below>
- Status: open | proposed | decided | deferred | superseded
- Top 10 priority: — | rank N
- Owner: <role(s)>
- Proposed answer: <the current best answer, or draft>
- Decision: <DEC-### or ADR-#### once promoted, else —>
- Impacted docs: <PRD §, HLD §, Runbook §, AC##, or —>
- Follow-up: <pending work, or —>
- History: <dated notes if the answer moved>
```

### Rules

1. Add a question when it first comes up — even if you plan to
   answer it within the hour. Unrecorded questions cause silent
   drift.
2. Do not delete answered questions; flip to `Status: decided` and
   record the promotion pointer.
3. A decision disputed later is reopened as a **new** Q-### that
   `Supersedes: Q-<old>`; the old entry stays untouched but moves
   to `superseded`.
4. Promotion is not optional. A `decided` entry must list the
   `Decision` (`DEC-###` or `ADR-####`) **and** the impacted docs.

## Sections

1. [Product](#1-product)
2. [Memory](#2-memory)
3. [Artifact Storage](#3-artifact-storage)
4. [Security / Privacy](#4-security--privacy)
5. [Provider Runtime](#5-provider-runtime)
6. [Telegram UX](#6-telegram-ux)
7. [Operations](#7-operations)
8. [Cost / Token Budget](#8-cost--token-budget)
9. [Future Architecture](#9-future-architecture)

## Top 10 priority index

Ranked by "if we answer this wrong, how painful is it to unwind?"

| Rank | Q      | Title                                                                    |
| ---- | ------ | ------------------------------------------------------------------------ |
| 1    | Q-003  | Boundary between memory, transcript, artifact, summary, preference, fact |
| 2    | Q-007  | Default attachment save policy                                           |
| 3    | Q-005  | What "forget" must actually delete                                       |
| 4    | Q-008  | Where artifact meaning and provenance live                               |
| 5    | Q-014  | Recovering a session when the Claude provider session is lost            |
| 6    | Q-020  | Tracking outbound delivery failures and duplicates                       |
| 7    | Q-023  | How long the system tolerates S3 degraded mode                           |
| 8    | Q-024  | Summary generation triggers and token budget                             |
| 9    | Q-004  | Long-term promotion gate                                                 |
| 10   | Q-001  | What "P0 success" means, measurable                                      |

---

## 1. Product

### Q-001 — What does "P0 success" mean, measurable?

- **Section**: Product
- **Status**: decided (2026-04-22).
- **Top 10 priority**: rank 10
- **Owner**: Product + project lead
- **Proposed answer**: Two-step gate. Technical acceptance (all
  ACs green) unlocks "ready for daily use". P0 is **succeeded**
  only after 7 calendar days of actual daily use with the
  following thresholds met:
  - ≥ 20 user turns from the authorized user.
  - ≥ 5 session summaries produced that the user read.
  - ≥ 3 explicit remember / save events.
  - ≥ 1 artifact saved in one session and referenced in a later
    session.
  - 0 critical data-loss events.
  - 0 unauthorized access events.
  - 0 unsafe Claude tool executions.
- **Decision**: DEC-013.
- **Impacted docs**: PRD §17, §18; playbook §5.7, §14;
  06_ACCEPTANCE_TESTS §Entry / exit criteria.
- **Follow-up**: During Phase 11 write a lightweight dogfood-log
  template (one row per day) operators fill in.
- **History**: recorded 2026-04-22.

### Q-002 — What observational data must P0 collect for the digital twin?

- **Section**: Product
- **Status**: decided (2026-04-22).
- **Top 10 priority**: —
- **Owner**: Product + Staff Eng
- **Proposed answer**: Collect a broad observational set from the
  first run. Anything missing here is a gap we cannot retroactively
  fill. Required categories:
  - **Turn-level**: user_message, assistant_response, timestamp,
    session_id, project_id?, source_channel, is_command, command
    name.
  - **Provider-run-level**: provider, provider_session_id,
    context_packing_mode, injected_context_ids (the specific
    memories / summaries packed), estimated + reported token
    usage, duration_ms, parser_status, error_type.
  - **Memory-level**: memory candidates with provenance,
    confidence, source_turn_ids, summary_version, correction /
    supersession events.
  - **Artifact-level**: storage_object_id, artifact_type,
    retention_class, source_turn_id, memory links with caption /
    summary.
  - **Feedback-level**: explicit remember / save / forget /
    correction events; `/summary` and `/end` invocations.
  - **Critical field**: `injected_context_ids` — without it we
    cannot explain later why an answer went off.
- **Decision**: DEC-014.
- **Impacted docs**: PRD §14.2; HLD §10.3, §13.3.
- **Follow-up**: HLD §10 must persist `injected_context_ids` on
  `provider_runs`; add to Appendix D if missing.
- **History**: recorded 2026-04-22.

---

## 2. Memory

### Q-003 — What is the boundary between memory, transcript, artifact, summary, preference, and fact?

- **Section**: Memory
- **Status**: decided (2026-04-22).
- **Top 10 priority**: rank 1
- **Owner**: Staff Eng + Product
- **Proposed answer**: Adopt separate concepts with explicit
  storage locations. `transcript` is the raw evidence of a
  conversation; `summary` is the compressed intermediate context;
  `memory` is reusable structured knowledge (facts, preferences,
  decisions, open tasks, cautions); `artifact` is a stored binary
  (image, PDF, generated file); `storage_object` is the artifact's
  metadata row; `memory_artifact_link` connects an artifact to a
  memory or turn. Not every transcript is memory; not every
  artifact is memory.
- **Decision**: Promoted into PRD §12 taxonomy; schema support via
  `memory_items` in Appendix D (DEC-007). No new ADR; the layering
  follows from ADR-0003, ADR-0004, ADR-0006.
- **Impacted docs**: PRD §12, Appendix D; HLD §5, §11.
- **Follow-up**: PRD §12.1 adds the glossary table cited here.
- **History**: recorded 2026-04-22.

### Q-004 — When is a piece of information promoted to long-term memory?

- **Section**: Memory
- **Status**: decided (2026-04-22).
- **Top 10 priority**: rank 9
- **Owner**: Product + Staff Eng
- **Proposed answer**: P0 is explicit-save-first everywhere.
  Long-term promotion requires `provenance ∈ {user_stated,
  user_confirmed}`. `observed`, `inferred`, `tool_output`, and
  `assistant_generated` items stay in the session summary and
  never cross into durable personal memory in P0. Automatic
  confidence-based promotion is a P1+ feature that needs a
  dedicated review / correction UX.
- **Decision**: ADR-0006.
- **Impacted docs**: PRD §12.2, §12.3; HLD §11.3.
- **Follow-up**: —
- **History**: recorded 2026-04-22.

### Q-005 — What does "forget" delete?

- **Section**: Memory
- **Status**: decided (2026-04-22).
- **Top 10 priority**: rank 3
- **Owner**: Security + Product + Staff Eng
- **Proposed answer**: Four scoped commands, tombstone-based:
  - `/forget_last` — marks the most recent memory candidate or
    artifact link `revoked` / `deleted`.
  - `/forget_session` — marks the current session summary and
    its long-term candidates inactive; transcripts remain under
    their retention-class rules.
  - `/forget_artifact <id>` — removes
    `memory_artifact_links` rows, sets
    `storage_objects.status = deletion_requested`; a later sync
    pass issues the S3 `DELETE` and flips to `deleted` or
    `delete_failed`.
  - `/forget_memory <id>` — sets `memory_items.status = revoked`.
  P0 does **not** do a full GDPR-style erasure; the agent stops
  using the data, and ops can reverse the tombstone if needed.
- **Decision**: DEC-006.
- **Impacted docs**: PRD §7 (user stories), §8.1 (commands),
  Appendix D (`storage_objects.status`, `memory_items.status`);
  HLD §6.4, §7.x (forget flow).
- **Follow-up**: Add `/forget_*` commands to PRD §8.1 and HLD §4.10.
- **History**: recorded 2026-04-22.

### Q-006 — How does the user correct a wrong memory?

- **Section**: Memory
- **Status**: decided (2026-04-22).
- **Top 10 priority**: —
- **Owner**: Product + Staff Eng
- **Proposed answer**: Corrections supersede, they do not
  overwrite. A `user_stated` correction creates a new
  `memory_items` row with `supersedes_memory_id` pointing at the
  prior item; the prior item moves to `superseded` and is
  excluded from context packing. Free-text corrections ("정정:",
  "not X, but Y") and an explicit `/correct <id>` command both
  land on the same mechanism.
- **Decision**: DEC-007.
- **Impacted docs**: PRD §12 (corrections subsection), Appendix D
  (`memory_items` table); HLD §11.3.
- **Follow-up**: Add `memory_items` table to Appendix D with the
  `status: active | superseded | revoked` enum.
- **History**: recorded 2026-04-22.

---

## 3. Artifact Storage

### Q-007 — Is every Telegram attachment saved, or only on explicit intent?

- **Section**: Artifact Storage
- **Status**: decided (2026-04-22).
- **Top 10 priority**: rank 2
- **Owner**: Security + Product
- **Proposed answer**: Default `retention_class = session`.
  Promotion to `long_term` requires an explicit user signal — a
  `/save_last_attachment` command or a natural-language "save /
  remember / keep for later" phrase. Files that the system flags
  as containing a high-risk secret pattern stay `ephemeral` and
  are not promoted.
- **Decision**: ADR-0006.
- **Impacted docs**: PRD §12.8.3, §13.5; HLD §9.3;
  AC-STO-004, AC-STO-005.
- **Follow-up**: —
- **History**: recorded 2026-04-22.

### Q-008 — Where does an artifact's meaning and provenance live?

- **Section**: Artifact Storage
- **Status**: decided (2026-04-22).
- **Top 10 priority**: rank 4
- **Owner**: Staff Eng
- **Proposed answer**: SQLite holds all meaning via
  `storage_objects` (metadata) and `memory_artifact_links`
  (relation + provenance + caption). S3 holds only the opaque
  bytes. Object keys follow
  `objects/{yyyy}/{mm}/{dd}/{object_id}/{sha256}.{safe_ext}` and
  never carry user-readable identifiers.
- **Decision**: ADR-0004.
- **Impacted docs**: PRD §12.8, Appendix D; HLD §5.2, §6.4, §12;
  AC-SEC-002.
- **Follow-up**: —
- **History**: recorded 2026-04-22.

### Q-009 — Do we need client-side encryption for S3 uploads?

- **Section**: Artifact Storage
- **Status**: decided (2026-04-22).
- **Top 10 priority**: —
- **Owner**: Security
- **Proposed answer**: P0 relies on a private bucket, opaque
  keys, strict secret redaction, and minimal credential exposure
  (systemd `EnvironmentFile`, mode 0600). Client-side encryption
  is **not** added in P0; it is reviewed at P1 together with
  key-rotation, backup, and preview UX. The threat model is
  documented so this is a deliberate choice rather than an
  oversight.
- **Decision**: DEC-008.
- **Impacted docs**: PRD §15; HLD §12;
  05_RUNBOOK §9 (key rotation).
- **Follow-up**: Add a short threat-model note to Runbook §9 so
  the P0 posture is explicit.
- **History**: recorded 2026-04-22.

### Q-010 — What is the retention period for each retention class?

- **Section**: Artifact Storage
- **Status**: decided (2026-04-22).
- **Top 10 priority**: —
- **Owner**: Product + SRE
- **Proposed answer**:
  - `ephemeral` — deleted at the end of the owning run; never on
    S3.
  - `session` — local + optional S3; deleted 30 days after
    session end.
  - `long_term` — durable on S3; kept until the user deletes.
  - `archive` — durable on S3; default retain 1 year; ops can
    override.
  Durations are configurable at deploy time.
- **Decision**: DEC-005.
- **Impacted docs**: PRD §12.8.2; HLD §12; 05_RUNBOOK §7.
- **Follow-up**: Implement deletion automation in P1; P0 records
  retention class but does not auto-delete on schedule.
- **History**: recorded 2026-04-22.

---

## 4. Security / Privacy

### Q-011 — How is `BOOTSTRAP_WHOAMI=true` toggled on and off?

- **Section**: Security / Privacy
- **Status**: decided (2026-04-22).
- **Top 10 priority**: —
- **Owner**: Security + SRE
- **Proposed answer**: Operator enables it by editing the
  systemd `EnvironmentFile`, restarts once, runs `/whoami`, and
  flips it back. `/doctor` warns while it is on, surfaces a
  timestamp for when it was last enabled, and raises the warning
  to a failure after a 30-minute auto-expiry window.
- **Decision**: DEC-009.
- **Impacted docs**: PRD §8.3; HLD §9.2, §16.1; 05_RUNBOOK §12;
  AC-TEL-001.
- **Follow-up**: `/doctor` must report the expiry time when
  `BOOTSTRAP_WHOAMI=true`.
- **History**: recorded 2026-04-22.

### Q-012 — Which secret patterns does the P0 redactor cover?

- **Section**: Security / Privacy
- **Status**: decided (2026-04-22).
- **Top 10 priority**: —
- **Owner**: Security
- **Proposed answer**: P0 redaction is "exact-value redaction of
  known secrets + common token patterns", not a general DLP.
  Required:
  - **Exact values** from config: `TELEGRAM_BOT_TOKEN`,
    `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, and any env var
    whose name ends in `TOKEN`, `SECRET`, `KEY`, or `PASSWORD`.
  - **Patterns**: `Bearer <token>`, `sk-...`, `xoxb-...`,
    `-----BEGIN ... PRIVATE KEY-----`, `AWS_ACCESS_KEY_ID`-style
    assignments, long high-entropy strings above a threshold.
  - Redaction runs **before** persistence; unredacted provider
    stdout/stderr is never stored.
  - Every pattern has a regression test that fails if the exact
    value leaks into a durable store.
- **Decision**: DEC-010.
- **Impacted docs**: PRD §15; HLD §13.2; AC-SEC-001.
- **Follow-up**: `test/redaction.test.ts` matrix maintained by
  Security.
- **History**: recorded 2026-04-22.

### Q-013 — How are sensitive attachments handled without content inspection?

- **Section**: Security / Privacy
- **Status**: decided (2026-04-22).
- **Top 10 priority**: —
- **Owner**: Security + Product
- **Proposed answer**: P0 does not auto-classify file contents.
  Defenses are layered at the boundary:
  - Default retention is `session` (Q-007 / ADR-0006).
  - Promotion to `long_term` requires `provenance ∈
    {user_stated, user_confirmed}`.
  - A simple filename / caption pattern match (e.g. "passport",
    "contract", "invoice", "secret", "주민등록") blocks
    automatic `long_term` promotion and surfaces a warning;
    the user can confirm explicitly to override.
  - OCR / image content inspection is out of scope for P0.
- **Decision**: ADR-0006 (inherits policy); filename-pattern
  guard is an implementation detail covered by DEC-010's
  redactor module.
- **Impacted docs**: PRD §12.8.3; HLD §9.3.
- **Follow-up**: —
- **History**: recorded 2026-04-22.

---

## 5. Provider Runtime

### Q-014 — If the Claude provider session is lost, can SQLite alone recover the conversation?

- **Section**: Provider Runtime
- **Status**: decided (2026-04-22).
- **Top 10 priority**: rank 5
- **Owner**: Staff Eng
- **Proposed answer**: Yes — by construction. `provider_session_id`
  is a cache; `sessions` + `turns` + `memory_summaries` +
  `memory_items` are the source of truth. `resume_mode` is an
  optimization; `replay_mode` must always be capable of
  continuing a conversation from SQLite alone. A failed
  `--resume` does not silently fall back mid-call; the adapter
  exits and the worker re-queues the job in `replay_mode` with
  the same idempotency key.
- **Decision**: ADR-0007.
- **Impacted docs**: PRD §12.4; HLD §8.2, §10.2; SP-06.
- **Follow-up**: SP-06 must exercise a forced session-loss case
  and compare replay-mode continuation against a reference
  answer.
- **History**: recorded 2026-04-22.

### Q-015 — If Claude answers but stream-json parsing fails, does the user still get the answer?

- **Section**: Provider Runtime
- **Status**: decided (already bound in PRD §16.3 + HLD §8.3).
- **Top 10 priority**: —
- **Owner**: Staff Eng
- **Proposed answer**: Parser failure and user-reply failure are
  separate outcomes. Fallback order:
  1. Extract a final-result event from stream-json.
  2. If missing, concatenate text-like chunks into a best-effort
     `final_text`.
  3. If still missing, surface a short "provider output parse
     failed" note plus any usable text.
  `provider_runs.parser_status` records
  `parsed | fallback_used | parse_error`; a fallback-used reply
  carries `result_json.parser_warning = true`.
- **Decision**: —  (already codified in PRD §16.3 and HLD §8.3;
  kept here for audit).
- **Impacted docs**: PRD §16.3; HLD §8.3, §7.3; AC-PROV-005.
- **Follow-up**: —
- **History**: recorded 2026-04-22.

### Q-016 — What side effects does "Claude Code" have when used as a general chat runtime?

- **Section**: Provider Runtime
- **Status**: decided (locked to spike-verified lockdown).
- **Top 10 priority**: —
- **Owner**: Staff Eng + Security
- **Proposed answer**: P0 uses Claude Code only in **advisory /
  chat lockdown** configuration — `--tools ""` and
  `--permission-mode dontAsk`; any tool is disabled. SP-05 must
  verify: no interactive permission prompt under representative
  prompts, no filesystem writes outside Claude's own session
  path, and that banned flags from PRD Appendix E are never
  required to achieve the lockdown. Any deviation is a P0
  blocker (re-opens provider choice via ADR-0005).
- **Decision**: ADR-0005 (provider selection) + ADR-0007
  (session semantics); SP-05 gates the implementation.
- **Impacted docs**: PRD §11, §15; HLD §8.1, §8.4;
  03_RISK_SPIKES SP-05; AC-PROV-003.
- **Follow-up**: SP-05 results referenced here when complete.
- **History**: recorded 2026-04-22.

---

## 6. Telegram UX

### Q-017 — How does the user know the agent remembered something?

- **Section**: Telegram UX
- **Status**: decided (2026-04-22).
- **Top 10 priority**: —
- **Owner**: Product
- **Proposed answer**: A short inline footer on the assistant
  reply names what was captured, nothing more verbose. Example:
  `기억함: "Personal Agent P0는 Bun 기반"` or
  `저장함: image · art_abc123 · long_term`. No separate
  confirmation message; a listing UI for recent memories is P1+.
- **Decision**: DEC-011.
- **Impacted docs**: PRD §8.4 (response format); HLD §11.
- **Follow-up**: Decide the exact footer template during Phase 8.
- **History**: recorded 2026-04-22.

### Q-018 — What is the Telegram notification noise budget?

- **Section**: Telegram UX
- **Status**: decided (2026-04-22).
- **Top 10 priority**: —
- **Owner**: Product
- **Proposed answer**: P0 pushes only the essentials:
  `job_accepted`, `job_completed`, `job_failed`, `job_cancelled`,
  `summary`, `doctor`, and an explicit "saved" confirmation when
  the user requested a save. Silent by default:
  `job_started`, successful `storage_sync`, successful
  `notification_retry`, and any internal-only lifecycle event.
- **Decision**: DEC-012.
- **Impacted docs**: PRD §13.3; HLD §6.3, §9.4.
- **Follow-up**: —
- **History**: recorded 2026-04-22.

### Q-019 — What does `/status` show?

- **Section**: Telegram UX
- **Status**: decided (2026-04-22).
- **Top 10 priority**: —
- **Owner**: Product
- **Proposed answer**: A compact one-screen message covering:
  current short `session_id`, active `provider`, current
  `packing_mode`, running / queued job counts, failed-retryable
  counts for jobs / notifications / storage_sync, S3 health
  (`ok | degraded | unknown`), last completed job time, and
  the last user-visible issue if any. A deeper
  `/status deep` is P1+.
- **Decision**: DEC-015.
- **Impacted docs**: PRD §7 US-02, §8.1; HLD §16.5.
- **Follow-up**: Lock exact field template during Phase 10.
- **History**: recorded 2026-04-22.

### Q-020 — How do we track outbound delivery failures and duplicates?

- **Section**: Telegram UX
- **Status**: decided (2026-04-22).
- **Top 10 priority**: rank 6
- **Owner**: SRE + Product
- **Proposed answer**: Rely on `outbound_notifications` as the
  ledger (HLD §6.3) + a `stale_pending_notifications` metric in
  `/doctor` and `/status`. Per-row age cap: rows older than
  `N` minutes in `pending` / `failed` become a visible warning;
  beyond a hard cap they are moved to `failed` terminal and the
  operator is notified. Delivery is at-least-once by design;
  the `payload_hash` triple minimizes duplicates but cannot
  eliminate them. User-visible `/ack` is P1+.
- **Decision**: DEC-015 (via `/status` contract); staleness
  thresholds codified in 05_RUNBOOK §6.
- **Impacted docs**: PRD §13.3; HLD §6.3, §7.7, §16.1;
  05_RUNBOOK §6.
- **Follow-up**: Set concrete `N` during Phase 10 after real
  timing data.
- **History**: recorded 2026-04-22.

---

## 7. Operations

### Q-021 — What does the user see after a service restart?

- **Section**: Operations
- **Status**: decided (2026-04-22).
- **Top 10 priority**: —
- **Owner**: SRE + Product
- **Proposed answer**: Restart recovery notifies the user
  **only** when there is user-facing impact. Per job:
  - `interrupted → queued (safe_retry)` →
    "중단된 작업을 복구해 다시 실행합니다."
  - `interrupted → failed` →
    "작업이 중단되어 자동 재시도하지 않았습니다."
  - `provider_run` already reached `succeeded` but an outbound
    notification was pending → resume `notification_retry`
    without a separate user notice.
  Infrastructure-only interruptions (no in-flight user jobs)
  are silent; they land in `/doctor` boot log.
- **Decision**: DEC-016.
- **Impacted docs**: PRD §8.5, §13.3, AC-JOB-002; HLD §6.2, §15;
  05_RUNBOOK §4.
- **Follow-up**: —
- **History**: recorded 2026-04-22.

### Q-022 — Should `/doctor` be split into quick and deep variants?

- **Section**: Operations
- **Status**: decided (2026-04-22).
- **Top 10 priority**: —
- **Owner**: SRE
- **Proposed answer**: Single `/doctor` command for P0 with a
  typed output that separates `quick` and `deep` checks in the
  report:
  - `quick`: Bun version, config loaded, SQLite read/write,
    Telegram push, Claude version/auth lightweight.
  - `deep`: S3 smoke (put/get/stat/list/delete), Claude
    lockdown smoke, Bun.spawn process-group kill smoke,
    redaction self-check.
  Each check reports duration + status (`ok | warn | fail`).
  Once total latency exceeds the budget, split the deep checks
  into `/doctor deep`, `/doctor s3`, `/doctor claude` (P1).
- **Decision**: DEC-017.
- **Impacted docs**: PRD §8.7; HLD §16; AC-OBS-001.
- **Follow-up**: Define `budget_ms` threshold during Phase 10
  that triggers the split.
- **History**: recorded 2026-04-22.

### Q-023 — How long can the system run with S3 unreachable before something breaks?

- **Section**: Operations
- **Status**: decided (2026-04-22).
- **Top 10 priority**: rank 7
- **Owner**: SRE
- **Proposed answer**: Hard thresholds on local disk usage of
  the artifact cache, tuned for CX22:
  - Artifact dir usage **> 1 GB** or free disk **< 20%** →
    `/status` / `/doctor` warning.
  - Artifact dir usage **> 2 GB** or free disk **< 15%** →
    degraded warning; non-essential `storage_sync` backlog
    batches reduced.
  - Artifact dir usage **> 3 GB** or free disk **< 10%** →
    refuse new `long_term`-bound writes; new attachments keep
    flowing as `ephemeral` / `session` with user-visible
    explanation.
  These numbers are starting values and are tuned at deploy
  time against CX22 disk capacity.
- **Decision**: DEC-018.
- **Impacted docs**: PRD §8.7, AC-STO-001, AC-OBS-001; HLD §12.5, §16.1;
  05_RUNBOOK §7.
- **Follow-up**: —
- **History**: recorded 2026-04-22.

---

## 8. Cost / Token Budget

### Q-024 — When is a session summary generated, and on what token budget?

- **Section**: Cost / Token Budget
- **Status**: decided (2026-04-22).
- **Top 10 priority**: rank 8
- **Owner**: Product + Staff Eng
- **Proposed answer**: Explicit triggers first; automatic
  triggers only under conservative conditions.
  - **Explicit**: `/summary`, `/end`.
  - **Automatic** (only one of the following plus a throttle):
    - `turn_count ≥ 20` since the last summary.
    - `transcript_estimated_tokens ≥ 6000`.
    - `session_age ≥ 24h`.
    **Throttle**: at least 8 new user turns must have occurred
    since the previous summary before an automatic trigger may
    fire.
  Summary runs use the advisory / lockdown profile
  (`--tools ""`, `--permission-mode dontAsk`) with a dedicated
  small token budget roughly comparable to a normal reply.
- **Decision**: DEC-019.
- **Impacted docs**: PRD §12.3, §12.5; HLD §11.1.
- **Follow-up**: Settle default token budget for a summary run
  during Phase 8.
- **History**: recorded 2026-04-22.

### Q-025 — Over-budget context: which slots does the packer drop first?

- **Section**: Cost / Token Budget
- **Status**: decided (already bound in HLD §10.3).
- **Top 10 priority**: —
- **Owner**: Staff Eng
- **Proposed answer**: Absolute keeps (never dropped):
  - Current user message.
  - Minimal system identity / safety / permission constraints.
  Strongly kept: active project decision, current session
  summary, `user_stated` / `user_confirmed` preferences
  directly relevant to the request. Conditionally kept:
  recent turns, related artifact summaries, low-confidence
  memory. Dropped first: inactive project context, verbose
  transcript snippets, old recent turns, inferred memory with
  low confidence. `resume_mode` never replays full history;
  `replay_mode` is the only path that includes recent N turns.
  CJK estimation uses `ceil(char_count / 1.5)` — always prefer
  overestimation.
- **Decision**: —  (already codified in HLD §10.3; kept here
  for audit).
- **Impacted docs**: PRD §12.5, §12.6; HLD §10.3.
- **Follow-up**: —
- **History**: recorded 2026-04-22.

### Q-026 — How is provider usage recorded when the provider does not report it?

- **Section**: Cost / Token Budget
- **Status**: decided (already bound in PRD §14.3).
- **Top 10 priority**: —
- **Owner**: Staff Eng
- **Proposed answer**: Record a nullable usage shape; fill
  `duration_ms`, `stdout_bytes`, `stderr_bytes`,
  `estimated_input_tokens`, `estimated_output_tokens`. Store
  `provider_reported_usage_json` when present. Treat missing
  fields as unknown, not zero. Use for observation (which runs
  are slow / chatty / which packing mode produced better
  latency), not for billing.
- **Decision**: —  (already codified in PRD §14.3 and HLD §8.4,
  §13.3; kept here for audit).
- **Impacted docs**: PRD §14.3; HLD §8.4, §13.3.
- **Follow-up**: —
- **History**: recorded 2026-04-22.

---

## 9. Future Architecture

Reserved for P1+ architectural questions surfaced during P0 (vector
retrieval, Obsidian write-back, multi-provider routing, autonomous
task loops, client-side encryption). An entry here signals "we
expect to need this eventually"; promote to an ADR when scope is
committed for a later milestone.

### Q-027 — `memory_items`(ADR-0006)와 새 `judgment_items` 관계: 통합 / 분리 / 단계적 마이그레이션 중 무엇?

- **Section**: Future Architecture
- **Status**: open (2026-04-26).
- **Top 10 priority**: —
- **Owner**: Staff Eng + Product
- **Proposed answer**: ADR-0009 Phase 0에서는 **분리** 방향으로
  commit (memory layer는 그대로 유지, judgment layer는 별 schema로
  추가). Phase 1 schema 구현 시 다음 중 결정:
  - Option A — 영구 분리. `memory_items`는 session summary candidate
    중심, `judgment_items`는 source-grounded judgment 중심.
  - Option B — 단계적 마이그레이션. `memory_items`의 `user_stated` /
    `user_confirmed` row를 source-grounded judgment로 promotion.
    `memory_items`는 deprecation track.
  - Option C — 통합. 한 테이블로 합치고 `kind` / `epistemic_status`로
    구분.
  현 commitment는 Option A. Phase 1에서 evidence 기반 재결정.
- **Decision**: ADR-0009 (Phase 0 commit), Phase 1에서 별 ADR / DEC
  필요.
- **Impacted docs**: ADR-0006, ADR-0009; PRD §12.1a Taxonomy;
  `docs/JUDGMENT_SYSTEM.md` §Relationship to memory layer.
- **Follow-up**: Phase 1 schema PR에서 결정.
- **History**: 2026-04-26 ADR-0009 채택 시 분리 방향으로 출발점
  설정 (second-brain Ideation 노트 Open Question Q4 import).

### Q-028 — `JudgmentItem.kind` v1 enum 범위는 어디까지인가?

- **Section**: Future Architecture
- **Status**: decided (2026-04-26, 잠정 출발점).
- **Top 10 priority**: —
- **Owner**: Staff Eng + Product
- **Proposed answer**: Phase 1 schema 첫 도입은 5-6개 핵심 kind
  (`fact` / `preference` / `decision` / `current_state` /
  `procedure` / `caution`)에서 시작. 나머지 (`claim` / `principle` /
  `hypothesis` / `experiment` / `result`)는 evidence 기반 후속 추가.
- **Decision**: DEC-023.
- **Impacted docs**: `docs/JUDGMENT_SYSTEM.md` §Enum catalog.
- **Follow-up**: Phase 1 schema PR에서 enum TEXT validation 형태
  확정. Phase 2 typed tool에서 누락 kind surface 시 별 DEC.
- **History**: 2026-04-26 ADR-0009 + DEC-023과 함께 출발점 결정
  (second-brain Ideation 노트 Open Question Q3 import).

### Q-029 — Phase 1 schema에서 SQLite FTS5만 vs 처음부터 sqlite-vec leave-room?

- **Section**: Future Architecture
- **Status**: open (2026-04-26).
- **Top 10 priority**: —
- **Owner**: Staff Eng
- **Proposed answer**: Phase 1은 **FTS5만**으로 시작. embedding
  projection은 Phase 4 trigger (`source_grounding_rate` /
  `current_truth_accuracy` eval metric이 부족 evidence를 줄 때).
  단, schema와 module structure는 embedding projection이 추가되어도
  비파괴적으로 들어올 수 있는 형태로 작성 (`judgment.project` 모듈
  분리, projection table 별도 권장).
- **Decision**: ADR-0009 §6 (vector / graph는 derived projection,
  본 ADR에서 채택 결정 안 함).
- **Impacted docs**: ADR-0003; `docs/JUDGMENT_SYSTEM.md` §SQL schema
  sketch / §Phase 4.
- **Follow-up**: Phase 1 schema PR에서 projection seam 확정. Phase
  4 trigger 시 별 ADR (sqlite-vec vs pgvector vs Qdrant).
- **History**: 2026-04-26 (second-brain Ideation 노트 Open Question
  Q5 import).

### Q-030 — second-brain repo의 기존 정책 문서는 어떻게 되는가?

- **Section**: Future Architecture
- **Status**: open (2026-04-26).
- **Top 10 priority**: —
- **Owner**: Product + Staff Eng (cross-repo)
- **Proposed answer**: ADR-0009 + DEC-022는 second-brain repo의
  **canonical 역할 박탈**과 **새 4가지 역할** (seed corpus /
  human-readable export / backup / publishing layer)을 결정했지만,
  기존 정책 문서 (SOURCE_OF_TRUTH / INGESTION_RULES / PROMPTING_GUIDE
  / IDEATION_GUIDE / VAULT_MANIFEST 등)의 처분은 미정. 후보:
  - Option A — 그대로 유지 (seed corpus 운영용 문서로 남김).
  - Option B — Deprecate (Markdown vault canonical 전제 위에서만
    의미 있는 문서들을 archive).
  - Option C — actwyn judgment system으로 흡수 (개념 / 정책을
    `docs/JUDGMENT_SYSTEM.md` 또는 후속 spec으로 import).
  본 결정은 second-brain repo 측의 별 PR에서 처리. actwyn 측에서는
  ADR-0009 + DEC-022로 충분.
- **Decision**: —  (cross-repo, second-brain repo 측 결정 대기).
- **Impacted docs**: (second-brain repo) `_System/AI/*.md`,
  `_System/Schemas/*.md`. actwyn 쪽은 영향 없음.
- **Follow-up**: second-brain repo에서 별도 PR / 결정.
- **History**: 2026-04-26 (second-brain Ideation 노트 Open Question
  Q6 import; cross-ref).

### Q-031 — Eval harness 도입 시점은?

- **Section**: Future Architecture
- **Status**: open (2026-04-26).
- **Top 10 priority**: —
- **Owner**: Staff Eng + Product
- **Proposed answer**: 단계적 도입.
  - Phase 0 (지금): 평가 질문 세트만 명문화 (`docs/JUDGMENT_SYSTEM.md`
    §Eval harness — Core 10 + Security 5).
  - Phase 2 (typed tool): tool round-trip + judgment commit /
    supersede / explain 자동 평가 시작 (CI에서 기본 평가 세트
    실행).
  - Phase 4 (embedding projection): RAGAS metric 통합 + actwyn 추가
    metric (`current_truth_accuracy` / `supersede_respect_rate` /
    `source_grounding_rate` / `negative_knowledge_recall` /
    `memory_poisoning_rejection_rate` / `decision_explainability`).
  Law 12 (No eval, no intelligence) 준수 — 자동화 시점이 늦더라도
  평가 질문 세트는 Phase 0에서 명문화.
- **Decision**: ADR-0009 (Phase 0 명문화), 후속 Phase별 별 ADR /
  DEC 필요.
- **Impacted docs**: `docs/JUDGMENT_SYSTEM.md` §Eval harness.
- **Follow-up**: Phase 2 PR에서 자동화 trigger / CI 통합 결정.
- **History**: 2026-04-26 (second-brain Ideation 노트 Open Question
  Q8 import).

### Q-032 — 12-layer 중 P0.5에 들어갈 layer 우선순위는?

- **Section**: Future Architecture
- **Status**: decided (2026-04-26, 잠정 출발점).
- **Top 10 priority**: —
- **Owner**: Staff Eng + Product
- **Proposed answer**: ADR-0010 §12-layer cognitive architecture가
  12 layer를 카탈로그로 식별했다. P0.5에는 다음 6 layer만 도입:
  (1) Event Memory(이미 P0), (2) Episodic(ADR-0006 `memory_summaries`),
  (3) Semantic(`memory_items` + `judgment_items`), (4) Judgment Ledger
  (`judgment_items` 5 tables), (5) Goal / Value 최소형, (6) Working
  Memory / Workspace 최소형. Reflection 최소형은 운영 layer라기보다
  flow(turn 종료 시 lesson candidate append)이므로 6 layer에는
  포함하지 않지만 P0.5 산출물에는 들어간다. 나머지 layer(Attention /
  Deliberation / Action+Experiment / Procedural library / Forgetting
  policy 4-5)는 P1.
- **Decision**: DEC-024 (P0.5 cognitive scope).
- **Impacted docs**: `docs/JUDGMENT_SYSTEM.md` §Cognitive Architecture
  Extension §Phase 재구성; ADR-0010 §Decision 6.
- **Follow-up**: Phase 1 schema PR에서 Goal / Workspace 객체의 schema
  형태(별 table vs view vs in-memory) 결정. eval harness가 layer
  gap을 surface하면 P0.5 layer 추가 trigger.
- **History**: 2026-04-26 ADR-0010 + DEC-024와 함께 출발점 결정
  (second-brain Ideation 노트 Round 9 + Appendix A.18 import).

### Q-033 — `kind: 'procedure'` skill library 운영 형태는?

- **Section**: Future Architecture
- **Status**: open (2026-04-26).
- **Top 10 priority**: —
- **Owner**: Staff Eng + Product
- **Proposed answer**: ADR-0010 §Skill / Procedure library가 P1
  도입을 commit했다. 운영 형태 후보.
  - Option A — **단일 enum + 기존 `judgment_items`에 row.** 가장
    단순, schema 변경 없음. 검색은 FTS5 + `kind = 'procedure'`
    필터.
  - Option B — **별 schema(`procedures` table) 분리.** procedure는
    judgment보다 더 엄격한 provenance / scope / preconditions /
    expected_outcome 필드가 필요할 수 있음. 차원이 다르면 분리.
  - Option C — **LLM에 inject되는 system prompt block.** Letta
    core memory blocks 패턴. retrieval 없이 매 turn 자동 inject.
    procedure 수가 늘면 토큰 비용 폭발.
  - Hybrid — A로 시작, evidence 누적 시 B로 마이그레이션, 일부
    high-priority procedure는 C 형태로 inject.
  현 commitment는 A 출발점. P1에서 evidence 기반 결정.
- **Decision**: ADR-0010 (Phase 0 commit), Phase 1에서 별 ADR / DEC
  필요.
- **Impacted docs**: `docs/JUDGMENT_SYSTEM.md` §Skill / Procedure
  library; ADR-0010 §Decision 5.
- **Follow-up**: P1 procedure library PR에서 결정. 사용자 procedure
  활용 빈도 / hallucination 발생률이 trigger.
- **History**: 2026-04-26 (second-brain Ideation 노트 Round 9 +
  Appendix A.19 import).

### Q-034 — Attention scoring formula 가중치는 정적 vs 학습 기반?

- **Section**: Future Architecture
- **Status**: open (2026-04-26).
- **Top 10 priority**: —
- **Owner**: Staff Eng
- **Proposed answer**: ADR-0010 §Attention scoring이 10개 항목
  (semantic_relevance / current_scope_match / recency / importance /
  user_emphasis / decision_impact / risk_level / uncertainty_reduction /
  superseded_penalty / expired_penalty / low_confidence_penalty)을
  formula로 spec했다. 가중치 결정 방식 후보.
  - Option A — **정적 가중치 + 휴리스틱 튜닝.** P1 시작점으로 단순.
  - Option B — **사용자 행동 기반 학습.** 사용자가 retrieval 결과를
    explicit feedback / silent ignore로 분리해서 가중치를 점진
    조정. 단일 사용자 데이터가 적어 RL이 불안정할 수 있음.
  - Option C — **task-conditioned 가중치.** query classifier(현재
    7 task) 별로 다른 가중치 set. 단순한 다중 정적 가중치.
  현 commitment는 P1 implementation 시 A로 시작, eval metric
  (`source_grounding_rate` / `current_truth_accuracy`)가 부족 evidence를
  주면 C로 확장. B(학습 기반)는 multi-user / 풍부 telemetry가 생긴
  P2+에서 검토.
- **Decision**: —  (P1 Attention scoring PR에서 결정).
- **Impacted docs**: `docs/JUDGMENT_SYSTEM.md` §Attention scoring;
  ADR-0010 §Decision 2 (Attention layer P1).
- **Follow-up**: P1 Attention scoring PR. eval harness가 가중치 후보
  비교를 자동화.
- **History**: 2026-04-26 (second-brain Ideation 노트 Round 9 +
  Appendix A.19 import).

### Q-035 — Cognitive analogy를 사용자에게 어떻게 설명하나(psychology vs engineering terminology)?

- **Section**: Product
- **Status**: open (2026-04-26).
- **Top 10 priority**: —
- **Owner**: Product + project lead
- **Proposed answer**: ADR-0010이 actwyn judgment system을 cognitive
  architecture로 framing 확장하면서 _engineering approximation_임을
  명시했다. 그러나 사용자 communication / docs / onboarding에서 어떤
  용어를 우선할지는 미정.
  - Option A — **Engineering 용어 우선** (judgment / source / evidence /
    typed tool / projection / retrieval). 정확하지만 차별화 narrative
    약함.
  - Option B — **Psychology / cognitive 용어 우선** (memory / attention /
    reflection / metacognition / working memory / goal stack). 사용자
    framing("AI 판단 기관")과 일치하지만 anthropomorphic 오해 위험.
  - Option C — **Hybrid**: 내부 spec(본 문서)은 cognitive 용어,
    사용자-facing UI / docs는 engineering 용어. 마케팅 narrative만
    cognitive 용어("개인 AI의 판단 기관")로.
  현 출발점은 C(hybrid). 본 spec은 cognitive 용어로 작성하되 §Disclaimers
  에 anthropomorphic 한계를 명시. 사용자 product copy / onboarding은
  engineering 용어로 시작.
- **Decision**: —  (별 PR에서 결정).
- **Impacted docs**: 향후 product copy / onboarding doc / `docs/JUDGMENT_SYSTEM.md`
  §Disclaimers.
- **Follow-up**: P1 사용자-facing copy PR. 사용자 피드백 / 외부
  blog / 사용자 ideation에서 cognitive analogy 채택 빈도가 trigger.
- **History**: 2026-04-26 (second-brain Ideation 노트 Round 9 +
  Appendix A.19 import; ADR-0010 framing 확장).

### Q-036 — `rejected` vs `revoked` status 차이 — 둘 다 유지할지, 통합할지?

- **Status**: open.
- **Owner**: project lead.
- **Context**: ADR-0009의 status 6 enum에 `rejected`와 `revoked`가
  모두 있음. ADR-0011이 신규 status (dormant / stale / archived)를
  추가하면서 9 enum이 됨. 의미적으로 `rejected`(proposal 단계에서
  채택 안 됨)와 `revoked`(이미 active였다가 폐기됨)는 다르지만,
  retrieval / context packing 측면에서 동일 처리.
- **Options**:
  - (a) 둘 다 유지: lifecycle 의미 차이 보존. 단 application 코드는
    동일하게 처리.
  - (b) `rejected` 폐기 + `revoked`로 통합: enum 단순화. proposal 단계
    실패는 별 status 또는 column으로 표현.
  - (c) `rejected`를 `proposed`의 substate로: `proposed_rejected` / 혹은
    별 boolean column.
- **Recommendation**: (a) 우선 — P0.5는 둘 다 유지하되 application
  코드는 동일 처리. P1에 evidence 기반 통합 고려.
- **Trigger**: P1 schema PR / `judgment_events` event_type 정리 시.
- **History**: 2026-04-26 (ADR-0011 도입 시 부수 질문).

### Q-037 — `architecture_assumption` 구현 형태는?

- **Status**: superseded by Q-059 (ADR-0013).
- **Owner**: project lead.
- **Context**: ADR-0011이 시스템 자신의 설계 가정을 first-class judgment로
  저장하기로 함. 구현 방법이 여러 가지.
- **Options**:
  - (a) 별 `kind: 'architecture_assumption'` enum value 추가.
  - (b) 일반 judgment의 `scope: { area: "system" }` 또는
    `scope: { entity_ids: ["actwyn"] }`.
  - (c) 별 schema (`architecture_assumptions` table) — judgment_items에서
    분리.
  - (d) (a) + (b) hybrid: kind는 architecture_assumption, scope도 system.
- **Recommendation**: ~~(d) — kind enum 추가 + scope.area = system.~~
  **Updated by ADR-0013 / Q-059:** `kind = "assumption"` +
  `target_domain = "architecture"` (별 `architecture_assumption` kind는
  kind enum 폭발 위험으로 폐기). 단, `kind = "assumption"`은 P0.5
  enforced kind 6종 (fact / preference / decision / current_state /
  procedure / caution)에 포함되지 않으므로, **P0.5에서는 architecture
  assumption을 `kind = "assumption"`으로 시드하지 않는다** — ADR/DEC seed
  또는 `kind = "decision"` / `current_state` 표현을 사용하고,
  `kind = "assumption"` 도입은 P1로 deferred. retrieval default exclusion
  정책은 Q-059 권고 그대로.
- **Trigger**: P1 typed tool / kind enum 확장 시.
- **History**: 2026-04-26 (ADR-0011 도입 시 부수 질문); 2026-04-26
  Round 13에서 ADR-0013 / Q-059로 정정.

### Q-038 — `activation_score` formula 가중치 default 값은?

- **Status**: open.
- **Owner**: project lead.
- **Context**: ADR-0011이 activation_score formula를 정의 (12개 항목).
  실제 가중치 default 값은 미정. 정적 default vs domain-specific vs
  학습 기반 (Q-026 / Q-034 cross-ref).
- **Options**:
  - (a) 모든 항목 가중치 1.0 균등 시작 + evaluation으로 조정.
  - (b) domain-specific default (사용자 선호 / current state / decision
    별로 다른 가중치).
  - (c) 사용자 행동 기반 학습 (user clicks / overrides / corrections로
    가중치 갱신) — P2+.
- **Recommendation**: (a) → P1 도입, P2에 (c) 검토. (b)는 evidence 부족.
- **Trigger**: P1 attention/activation scoring 구현 시; 사용자가
  retrieval quality 불만 표시 시.
- **History**: 2026-04-26 (ADR-0011 §Decision 9; Q-026 / Q-034 trace).

### Q-039 — `research_update_protocol` 7단계 자동화 시점은?

- **Status**: open.
- **Owner**: project lead.
- **Context**: ADR-0011이 새 논문 / 서비스 등장 시 처리 프로세스를
  capture → extract → map → propose → eval → migrate → supersede 7단계로
  정의. P0.5 / P1은 사람 검토 + Claude proposal 패턴, P2+ 자동화 후보.
- **Options**:
  - (a) P2: capture / extract만 자동화 (LLM이 논문 요약), map / propose
    / eval / migrate / supersede는 사람 + Claude 검토.
  - (b) P3: map까지 자동화 (LLM이 architecture_assumption과 연결).
  - (c) 완전 자동화 (autonomous research agent) — 안 함.
- **Recommendation**: (a) — capture / extract만 P2+ 자동화. map 이상은
  사용자 검토 필수 (architecture 변경은 신중).
- **Trigger**: P2 시작 시 / 외부 연구 follow-up 빈도가 사람 검토를
  burden으로 만들 때.
- **History**: 2026-04-26 (ADR-0011 §Decision 7).

### Q-040 — `last_verified_at` 갱신 trigger는?

- **Status**: open.
- **Owner**: project lead.
- **Context**: ADR-0011이 `last_verified_at` 시간 필드를 신설. 사용자
  자연어 확인 / `/verify` 명령 / assistant 추론 / `judgment.commit`
  중 어떤 trigger로 갱신해야 하는지.
- **Options**:
  - (a) 사용자 명시 확인 (자연어 "그거 맞아" / `/verify <id>` 등)만
    `last_verified_at` 갱신.
  - (b) `judgment.commit` 시점도 갱신.
  - (c) assistant 추론도 갱신 (단 confidence 낮음 표시).
- **Recommendation**: (a) — 명시 확인만. `judgment.commit`은
  `created_at` / `updated_at`만 갱신. assistant 추론은 갱신 안 함
  (Round 8 token discipline + ADR-0006 explicit-save-first 정합).
- **Trigger**: P2 typed tool 구현 시.
- **History**: 2026-04-26 (ADR-0011 §시간 필드 8개; Q-028 second-brain
  trace).

### Q-041 — `volatility` 결정 주체는?

- **Status**: open.
- **Owner**: project lead.
- **Context**: ADR-0011이 `volatility` (low/medium/high) 신규 필드.
  누가 / 무엇이 결정하는지 미정.
- **Options**:
  - (a) `judgment.propose` 시 LLM이 추론 (kind / scope / 사용 패턴 기반).
  - (b) 사용자 명시 (자연어 "이건 변할 가능성 큼" / 명령).
  - (c) `kind` 별 default: 사용자 선호 → medium, current state → high,
    원칙 → low.
  - (d) (c) default + (a) LLM 추론 + (b) 사용자 override.
- **Recommendation**: (d) — kind default + LLM 추론 + 사용자 override
  허용. P0.5는 (c) default만, P1+ (a)/(b) 추가.
- **Trigger**: P0.5 schema 도입 시 default 매핑 결정.
- **History**: 2026-04-26 (ADR-0011 §volatility + decay_policy).

### Q-042 — `ontology_version` migration 전략은?

- **Status**: open.
- **Owner**: project lead.
- **Context**: ADR-0011이 `ontology_version`을 강제 도입 (DEC-028).
  v0.1 → v0.2로 변경 시 기존 row 처리 미정.
- **Options**:
  - (a) 자동 변환 script (v0.1 → v0.2 매핑이 deterministic할 때).
  - (b) 명시적 migration script + 사용자 검토.
  - (c) 양립 운영 (v0.1과 v0.2 row가 공존, application 코드가 둘 다
    이해).
- **Recommendation**: (b) — P2까지는 명시적 script. v0.2 도입 시 release
  notes에 migration 명시. (c)는 enum value 단순 추가일 때만 가능.
- **Trigger**: 첫 ontology 변경 발생 시.
- **History**: 2026-04-26 (ADR-0011 §ontology_version + schema_version).

### Q-043 — Reflection triage critic model 선택 (Claude Haiku vs main vs other)?

- **Status**: open.
- **Owner**: project lead.
- **Context**: ADR-0012가 reflection triage layer를 control-plane에 두고
  critic model 사용을 권장 (commit_allowed: false 강제). main model
  self-critique vs 별 cheap model vs 다른 provider 중 선택 미정.
- **Options**:
  - (a) Claude Haiku (cheap, 같은 provider, prompt cache 호환)
  - (b) Main model (Claude Opus 4.7) self-critique — 자기 답변에 self-bias
    위험
  - (c) 다른 provider cheap model (GPT-4o-mini 등) — diversity 좋지만 운영
    cost 증가
- **Recommendation**: (a) Claude Haiku — P1+ 도입 시점.
- **Trigger**: P1 typed tool 구현 시.
- **History**: 2026-04-26 (ADR-0012 §Decision 4).

### Q-044 — Critic model output JSON schema 정확한 형태?

- **Status**: open.
- **Owner**: project lead.
- **Context**: ADR-0012가 critic model 출력은 constrained JSON, `commit_allowed:
  false` 강제하라고 함. 정확한 schema (durability / novelty / risk_if_ignored
  score 0-1, source_turn_ids 필수 등) 미정.
- **Recommendation**: P1 typed tool 구현 시 결정. 초기 JSON schema 후보:
  `{ should_reflect, reflection_type, durability, novelty, risk_if_ignored,
  source_turn_ids, reason, commit_allowed: false }`.
- **Trigger**: P1.
- **History**: 2026-04-26 (ADR-0012 §Decision 4).

### Q-045 — Doubt signal 한국어 keyword 감지 방법?

- **Status**: open.
- **Owner**: project lead.
- **Context**: `interaction_signals.signal_type=doubt` 감지에 한국어 표현
  ("흠" / "아니다" / "미묘하게" / "앞뒤가 안 맞아") + LLM classifier 결합 필요.
- **Options**:
  - (a) keyword/regex만 (cheap, 정확도 낮음)
  - (b) LLM classifier만 (정확도 높지만 모든 turn에 호출은 비쌈)
  - (c) keyword/regex 1차 필터 + LLM 2차 검증
- **Recommendation**: (c) — Round 8 token discipline 정합 (cheap classifier
  gate).
- **Trigger**: P1 telemetry 구현 시.
- **History**: 2026-04-26 (ADR-0012 §Decision 8).

### Q-046 — DesignTension severity 결정 주체?

- **Status**: open.
- **Owner**: project lead.
- **Context**: critic model 자체 평가 vs 사용자 confirm vs maintainer 결정.
- **Options**:
  - (a) critic model 초기 평가 + 사용자 review (open status에서)
  - (b) 사용자 직접 입력
  - (c) maintainer가 PR review 시 결정
- **Recommendation**: (a) — critic 초기 평가 후 사용자 review로 final.
- **Trigger**: P1 design_tensions schema PR.
- **History**: 2026-04-26 (ADR-0012 §Decision 7).

### Q-047 — Critic Loop 4-7단계 자동화 시점?

- **Status**: decided as DEC-031.
- **Owner**: project lead.
- **Context**: ADR-0012가 8단계 정의. P0.5 도입 범위 미정.
- **Decision**: DEC-031 — P0.5는 1-3단계만 (capture / signal detection /
  tension proposal). 4-7단계는 P1+, 8단계는 P3+.
- **Trigger**: P1 도입 시점.
- **History**: 2026-04-26 (ADR-0012 §Decision 9; DEC-031).

### Q-048 — `critique_outcomes` artifact link 범위?

- **Status**: open.
- **Owner**: project lead.
- **Context**: outcome trace 시 git commit hash / PR number / DEC-### /
  Q-### / ADR-#### 어디까지 link?
- **Recommendation**: 모두 link 가능하게 일반 string field (`changed_artifact_ids`)
  로 둠. application 코드에서 prefix 인식 (예: `git:abc123`, `pr:10`,
  `dec:031`).
- **Trigger**: P1 critique_outcomes schema PR.
- **History**: 2026-04-26 (ADR-0012 §Decision 8).

### Q-049 — DesignTension 자기참조 깊이 제한?

- **Status**: decided.
- **Owner**: project lead.
- **Context**: DesignTension 자체가 axis_conflation에 빠질 위험 — 즉
  DesignTension on DesignTension 재귀.
- **Decision**: 깊이 제한 1 — DesignTension on DesignTension 금지.
  `target_type`에 `design_tension` 제외. 메타-critique이 필요하면 사용자
  명시 또는 별 ADR.
- **Trigger**: 깊이 제한 2 이상이 필요한 use case 발견 시.
- **History**: 2026-04-26 (ADR-0012 §Risks).

### Q-050 — Control-plane과 judgment-plane DB 분리 정도?

- **Status**: decided as DEC-030.
- **Owner**: project lead.
- **Context**: 같은 SQLite DB vs 별 DB.
- **Decision**: DEC-030 — 같은 SQLite DB, schema prefix 분리
  (`control_plane_*` vs `judgment_*`). cross-reference는 link table만,
  foreign key 없음.
- **Trigger**: storage cost가 control-plane에서 폭발할 때.
- **History**: 2026-04-26 (ADR-0012 §Decision 6; DEC-030).

### Q-051 — Tension `target_domain` P0.5 도입 범위?

- **Status**: decided as DEC-032 (P0.5 **8 enum**: design / memory / policy
  / workflow / evidence / decision / security / architecture). `architecture`
  는 Tension과 `kind=assumption`이 enum을 공유하므로 P0.5 필수 (PR #10
  codex bot P1 review 정정으로 7 → 8).
- **Trigger**: 사용자가 reserved 5 enum domain에서 tension 제기 시 enum 추가.
- **History**: 2026-04-26 (ADR-0013 §Decision 2; DEC-032). follow-up:
  codex bot 발견 — DEC-032 본문은 8 enum이지만 Q-051은 7로 stale → 정정.

### Q-052 — Tension `category` 14 enum P0.5 도입 범위?

- **Status**: open.
- **Owner**: project lead.
- **Context**: ADR-0012 11 + Round 13 신규 4 (taxonomy_gap / policy_gap /
  evidence_conflict / scope_mismatch) = 15 enum (14 unique 후 정정 — 11+3).
  P0.5 도입 범위 미정.
- **Recommendation**: P0.5는 14 모두 schema 도입 (TEXT + CHECK), 사용자
  / critic model이 실제 사용하는 것만 활용.
- **Trigger**: P1 schema PR 시.
- **History**: 2026-04-26 (ADR-0013 §Decision 2).

### Q-053 — status 3축 분리 시 ADR-0011 partial retract 형식?

- **Status**: decided as ADR-0013 (partial retract).
- **Trigger**: 추가 ADR partial retract 필요 시 동일 패턴.
- **History**: 2026-04-26 (ADR-0013 §Decision 3 partial retract ADR-0011).

### Q-054 — Reflection 5 sub-action P0.5 도입 범위?

- **Status**: decided as DEC-035 (`reflection_triage`만 P0.5).
- **Trigger**: 사용자가 critique / proposal 자동화 요구 시.
- **History**: 2026-04-26 (ADR-0013 §Decision 5; DEC-035).

### Q-055 — Workspace 3축 분리 매핑?

- **Status**: open.
- **Owner**: project lead.
- **Context**: ADR-0010의 `Workspace` 객체가 ADR-0013 3축 (Plan / Packet /
  Trace) 중 어디 매핑?
- **Recommendation**: ADR-0010 `Workspace`는 ephemeral object → P1+
  `WorkspacePlan` + `ContextPacket`. P0.5는 `WorkspaceTrace` 이벤트만.
- **Trigger**: P1 typed tool 구현 시.
- **History**: 2026-04-26 (ADR-0013 §Decision 6).

### Q-056 — `procedure_subtype` 마이그레이션 default?

- **Status**: decided as DEC-034 (default `skill`).
- **Trigger**: 기존 procedure 노트 마이그레이션 정확도 문제 시.
- **History**: 2026-04-26 (ADR-0013 §Decision 7; DEC-034).

### Q-057 — `current_truth` → `current_operating_view` 이름 변경 적용 범위?

- **Status**: decided as DEC-036 (문서/UX만, DB 필드 그대로).
- **Trigger**: 더 정확한 이름 발견 시.
- **History**: 2026-04-26 (ADR-0013 §Decision 4; DEC-036).

### Q-058 — `attention/activation/retrieval` 3 score P0.5 도입?

- **Status**: open.
- **Owner**: project lead.
- **Context**: ADR-0011 통합 partial retract. P0.5 단일 score (Round 11
  권고대로) vs 처음부터 3 score 분리.
- **Recommendation**: P0.5 단일 retrieval priority + WorkspaceTrace에
  trace만. P1+ 3 score 분리 (디버깅 evidence 기반).
- **Trigger**: 사용자 / 테스트가 retrieval 디버깅 어려움 보고 시.
- **History**: 2026-04-26 (ADR-0013 §Decision 9).

### Q-059 — `architecture_assumption` 시드 row 마이그레이션?

- **Status**: open.
- **Owner**: project lead.
- **Context**: ADR-0011이 `kind=architecture_assumption` 시드 도입.
  ADR-0013이 `kind=assumption` + `target_domain=architecture`로 정교화.
  마이그레이션 형식?
- **Recommendation**: ADR-0011 commit 시점에 시드 row 없음 (architectural
  commitment 문서만). Phase 1 schema PR에서 신규 schema (`kind=assumption`)
  로 깔끔히 적용. 마이그레이션 script 불필요.
- **Trigger**: P1 schema PR 시.
- **History**: 2026-04-26 (ADR-0013 §Decision 8).

### Q-060 — JudgmentItem 4축 분리 시 사용자 작성 default?

- **Status**: open.
- **Owner**: project lead.
- **Context**: ADR-0013이 kind + epistemic_origin + authority_source +
  lifecycle_status + activation_state 4축 분리. 사용자가 모두 입력? typed
  tool layer가 default 자동 주입?
- **Recommendation**: typed tool layer에서 default 자동 주입 (kind는 사용자
  / critic model 입력, 나머지 4축은 default + override). epistemic_origin
  default = `user_stated` 또는 `assistant_generated` (caller에 따라).
  authority_source default = `none`. lifecycle_status default =
  `proposed`. activation_state default = `eligible`.
- **Trigger**: P1 typed tool 구현 시.
- **History**: 2026-04-26 (ADR-0013).

### Q-061 — Critique Lens v0.1 LLM critic prompt 형식?

- **Status**: open.
- **Owner**: project lead.
- **Context**: ADR-0013의 5 rule을 single prompt로 결합 vs 5 separate
  critic 호출. ADR-0012의 8 failure mode와 정합.
- **Recommendation**: P1 single prompt로 시작 (5 rule + 8 failure mode
  결합). token cost vs accuracy trade-off — evidence 기반 P2+ separate
  호출 검토.
- **Trigger**: P1 critic model 구현 시.
- **History**: 2026-04-26 (ADR-0013 §Decision 1).

### Q-062 — Tension `target_domain` 확장 시점?

- **Status**: open.
- **Owner**: project lead.
- **Context**: ADR-0013이 P0.5 7 enum + reserved 5 enum (product /
  marketing / user_preference / research / tooling). 확장 시점?
- **Recommendation**: 사용자 ideation에서 해당 domain의 tension 발견될
  때마다 enum 추가 (DEC-032 trigger 정합). 예측 미루지 말고 evidence 기반.
- **Trigger**: reserved domain의 tension 등장 시.
- **History**: 2026-04-26 (ADR-0013 §Decision 2; DEC-032).

---

## Deferred

Questions that no longer block P0 but are not yet decided. Each
entry includes the dated deferral reason. Revisit at the P1 kickoff.

*No entries yet.*
