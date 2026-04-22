# Personal Agent — Questions Register

> Status: living document · Owner: project lead · Last updated: 2026-04-22
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

*No entries yet.*

---

## Deferred

Questions that no longer block P0 but are not yet decided. Each
entry includes the dated deferral reason. Revisit at the P1 kickoff.

*No entries yet.*
