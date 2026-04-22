# Personal Agent — Open Questions Ledger

> Status: living document · Owner: project lead · Last updated: 2026-04-22
>
> This ledger records design-level questions that span PRD and HLD but
> have not yet been answered in either. Questions arrive here from
> reviews, implementation discoveries, and user feedback. They leave
> here only via (a) a `08_DECISION_REGISTER.md` / ADR entry, (b) a PRD amendment,
> or (c) an explicit deferral to P1+.
>
> If a question stops appearing actionable during P0, move it to
> `## Deferred` with a dated note.

## How to use this file

Each question uses this skeleton:

```
### Q## — Short title

- Section: <one of the sections below>
- Top 10 priority: — | rank N
- Status: open | partially-decided | decided | deferred
- Decision needed by: <gate name, per 00_PROJECT_DELIVERY_PLAYBOOK.md>
- Owner: <role(s)>
- Options:
  - a) …
  - b) …
- Current leaning: …
- Risk if unresolved: …
- Refs: PRD §…, HLD §…, 08_DECISION_REGISTER.md §…
```

Rules:

1. Add a question whenever it comes up — even if you plan to answer it
   within the hour. Unrecorded questions cause silent drift.
2. Do not delete answered questions; flip them to `Status: decided`
   and cite the authoritative doc that now owns the answer.
3. A question marked `decided` here but disputed later must be re-
   opened via a new Q## entry, not by editing the old one.

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

| Rank | Q    | Title                                                                 |
| ---- | ---- | --------------------------------------------------------------------- |
| 1    | Q03  | Boundary between memory, transcript, artifact, summary, preference, fact |
| 2    | Q07  | Default attachment save policy                                        |
| 3    | Q05  | What "forget" must actually delete                                    |
| 4    | Q08  | Where artifact meaning and provenance live                            |
| 5    | Q14  | Recovering a session when the Claude provider session is lost        |
| 6    | Q20  | Tracking outbound delivery failures and duplicates                   |
| 7    | Q23  | How long the system tolerates S3 degraded mode                       |
| 8    | Q24  | Summary generation triggers and token budget                         |
| 9    | Q04  | Long-term promotion gate (`user_stated` / `user_confirmed` only?)    |
| 10   | Q01  | What "P0 success" means, measurable                                  |

---

## 1. Product

### Q01 — What does "P0 success" mean, measurable?

- **Section**: Product
- **Top 10 priority**: rank 10
- **Status**: open
- **Decision needed by**: P0 Acceptance Test gate (playbook §5.7).
- **Owner**: Product + project lead
- **Options**:
  - a) "All AC01–AC25 pass" — narrow, technical, easy to measure.
  - b) "One real user runs the agent daily for a full week, and at
    least K sessions reuse a previously-saved memory or artifact" —
    product-centric.
  - c) Both a) and b) together as a two-step gate.
- **Current leaning**: (c). AC pass unlocks the "ready for daily use"
  flag; one calendar week of actual daily use with at least one
  successful memory-reuse event defines "P0 succeeded" for the
  project as a whole.
- **Risk if unresolved**: team declares victory at AC pass, never
  validates that the agent is actually useful, and repeats the same
  mistake at P1.
- **Refs**: PRD §17, playbook §5.7, §14.

### Q02 — What observational data must P0 collect for the digital twin?

- **Section**: Product
- **Top 10 priority**: —
- **Status**: partially-decided (PRD §14.2 lists categories; exact
  schema not frozen)
- **Decision needed by**: Walking Skeleton gate (playbook §5.5).
- **Owner**: Product + Staff Eng
- **Options**:
  - a) Only what is strictly needed to satisfy P0 ACs; defer twin-
    specific fields to P1.
  - b) Collect a broader observational set from day one: request
    category, packing mode, injected slots, memory reuse events,
    artifact references, correction events, `remember/forget`
    events, decision records, project_id.
  - c) A) now and retro-add fields later as needs surface.
- **Current leaning**: (b). The marginal cost of adding fields at
  P0 is small; the cost of realizing at P1 that we lack a full
  year of reuse/correction events is high.
- **Risk if unresolved**: the digital-twin hypothesis cannot be
  evaluated later because the data was never captured.
- **Refs**: PRD §3, §14.2; HLD §13.3.

---

## 2. Memory

### Q03 — What is the boundary between memory, transcript, artifact, summary, preference, and fact?

- **Section**: Memory
- **Top 10 priority**: rank 1
- **Status**: partially-decided (PRD §12 defines layers; no glossary
  table yet)
- **Decision needed by**: Walking Skeleton gate (playbook §5.5).
- **Owner**: Staff Eng + Product
- **Options**:
  - a) Keep the current distributed definitions across PRD §12.1,
    §12.2, §12.8 and the Appendix D tables.
  - b) Add a single taxonomy table — `concept → what it is → where
    stored → who writes it → retention` — to the HLD or PRD.
  - c) Collapse "summary" and "memory" into one concept.
- **Current leaning**: (b). Add the taxonomy table to HLD §5 before
  writing the walking skeleton. This is the cheapest fix for the
  most frequent category confusion.
- **Risk if unresolved**: every new requirement eventually becomes
  "a kind of memory", schema sprawl, and it becomes impossible to
  answer "where does this belong?" for new features.
- **Refs**: PRD §12.1, §12.2, §12.8; HLD §5, §11; Appendix D.

### Q04 — When is a piece of information promoted to long-term memory?

- **Section**: Memory
- **Top 10 priority**: rank 9
- **Status**: decided for personal preferences (PRD §12.2); open
  for other memory categories (facts, decisions, project notes).
- **Decision needed by**: Implementation Plan gate (playbook §5.4).
- **Owner**: Product + Staff Eng
- **Options**:
  - a) Follow §12.2 uniformly: only `user_stated` /
    `user_confirmed` promote to long-term for any category.
  - b) Allow `observed` / `inferred` items into long-term for
    non-preference categories (e.g. facts like "project X uses
    Bun") behind a confidence threshold.
  - c) Keep all non-`user_stated` items session-only in P0;
    revisit in P1.
- **Current leaning**: (c). P0 is explicit-save-first everywhere;
  confidence-based auto-promotion is a P1+ feature that needs
  dedicated UX for review and correction (see Q06).
- **Risk if unresolved**: inferred items leak into durable memory
  and the user finds false "facts" about themselves baked in.
- **Refs**: PRD §12.2, §12.3; HLD §11.3.

### Q05 — What does "forget" delete?

- **Section**: Memory
- **Top 10 priority**: rank 3
- **Status**: open
- **Decision needed by**: HLD finalization / before Claude vertical
  slice (playbook §5.6).
- **Owner**: Security + Product + Staff Eng
- **Options**:
  - a) `forget` = soft-delete the owning `memory_summaries` row(s)
    only; transcripts, raw events, and S3 artifacts remain.
  - b) Tiered command set: `/forget_last` (last memory item),
    `/forget_session` (everything for the current session), and
    `/forget_artifact <id>`, each with an explicit policy.
  - c) A single `/forget` command with a follow-up confirmation
    that asks what scope to forget.
- **Current leaning**: (b). A single overloaded `/forget` is
  ambiguous; P0 ships the three-command form even if the
  implementation is minimal. Each command maps to a specific state
  transition in the Q06 table.
- **Risk if unresolved**: users ask "delete my data" and we only
  half-delete; worse, we say we deleted things that remain on S3.
- **Refs**: PRD §12.2, §12.8.3; HLD §6.4 (soft-delete), §12.6
  (storage delete path).

### Q06 — How does the user correct a wrong memory?

- **Section**: Memory
- **Top 10 priority**: —
- **Status**: open
- **Decision needed by**: Claude vertical slice landing
  (playbook §5.6).
- **Owner**: Product
- **Options**:
  - a) Free-text correction that adds a new `user_stated` memory
    with `supersedes = <memory_id>`; older item stays readable but
    is excluded from context packing.
  - b) Explicit `/correct` command that targets a specific memory
    id surfaced by `/summary`.
  - c) Both a) and b); the free-text path is the UX default, the
    command path is used for precise corrections.
- **Current leaning**: (c). Natural-language corrections fit
  Telegram chat; the command path gives power users precision
  and makes the action auditable.
- **Risk if unresolved**: wrong inferences calcify into the twin
  data set and users lose trust.
- **Refs**: PRD §12.2 (`provenance`); HLD §11.3.

---

## 3. Artifact Storage

### Q07 — Is every Telegram attachment saved, or only on explicit intent?

- **Section**: Artifact Storage
- **Top 10 priority**: rank 2
- **Status**: decided (PRD §12.8.3 — explicit-save-first)
- **Decision needed by**: decided.
- **Owner**: Security + Product
- **Options**: (historical)
  - a) Save every attachment to S3 permanently.
  - b) Save every attachment as `session`; promote on explicit
    intent.
  - c) Do not save any attachment until the user says so.
- **Current leaning**: (b) is the decided policy — default is
  `retention_class = session`; `long_term` requires a user save
  intent with `provenance ∈ {user_stated, user_confirmed}`.
  `ephemeral` applies when the content carries a high-risk secret
  pattern or when explicitly scoped to one request.
- **Risk if unresolved**: N/A — kept here so reviewers can find
  the rationale.
- **Refs**: PRD §12.8.3; HLD §9.3; AC22.

### Q08 — Where does an artifact's meaning and provenance live?

- **Section**: Artifact Storage
- **Top 10 priority**: rank 4
- **Status**: decided (PRD §12.8, Appendix D `storage_objects` +
  `memory_artifact_links`)
- **Decision needed by**: decided.
- **Owner**: Staff Eng
- **Options**: (historical)
  - a) Inline the caption/summary in the S3 object key or
    metadata.
  - b) Keep the S3 object opaque; store all semantics in SQLite
    via `storage_objects` and `memory_artifact_links`.
  - c) Dual-write — S3 sidecar JSON plus SQLite.
- **Current leaning**: (b) is the decided policy. The S3 object
  in isolation never reveals why it was stored; meaning lives in
  SQLite only.
- **Risk if unresolved**: N/A — kept here so reviewers can find
  the rationale.
- **Refs**: PRD §12.8, Appendix D (`storage_objects`,
  `memory_artifact_links`); HLD §5.2.5, §6.4.

### Q09 — Do we need client-side encryption for S3 uploads?

- **Section**: Artifact Storage
- **Top 10 priority**: —
- **Status**: open
- **Decision needed by**: Security review gate (playbook §9.3)
  before P0 acceptance.
- **Owner**: Security
- **Options**:
  - a) None — rely on Hetzner bucket privacy + TLS in transit +
    opaque keys (current P0 direction).
  - b) Client-side encryption of every S3 object with a local
    master key stored outside the DB.
  - c) Selective client-side encryption for files the user marks
    as sensitive.
- **Current leaning**: (a) for P0; plan (c) for P1 once we have
  a UX story for key rotation and backup. Document the threat
  model so (a) is a deliberate choice, not an oversight.
- **Risk if unresolved**: a bucket-credential compromise reveals
  user files; Security review may block P0 acceptance if this is
  not explicitly addressed.
- **Refs**: PRD §15; HLD §12.

### Q10 — What is the retention period for each retention class?

- **Section**: Artifact Storage
- **Top 10 priority**: —
- **Status**: partially-decided (PRD §12.8.2 names the classes;
  concrete durations not set)
- **Decision needed by**: P0 Acceptance Test gate.
- **Owner**: Product + SRE
- **Options** (durations to decide):
  - `ephemeral` → delete at end of owning run (decided).
  - `session` → delete N days after session end; candidates 7d /
    30d / 90d.
  - `long_term` → retain until user deletes (decided).
  - `archive` → per ops policy; candidates 90d / 1y / indefinite.
- **Current leaning**: `session = 30 days after session end`,
  `archive = 1 year` for P0. Both become configurable in P1.
- **Risk if unresolved**: local disk or S3 fills up silently;
  privacy obligations not meetable on demand.
- **Refs**: PRD §12.8.2; HLD §12.

---

## 4. Security / Privacy

### Q11 — How is `BOOTSTRAP_WHOAMI=true` toggled on and off?

- **Section**: Security / Privacy
- **Top 10 priority**: —
- **Status**: open
- **Decision needed by**: Security review gate before P0 acceptance.
- **Owner**: Security + SRE
- **Options**:
  - a) The operator enables it by editing the systemd
    `EnvironmentFile`, restarts once, runs `/whoami`, and flips it
    back. `/doctor` warns while it is on.
  - b) Always off in code; bootstrap is a one-shot CLI subcommand
    that prints user_id/chat_id without starting the service.
  - c) Time-limited flag — enabling it sets an auto-expiry
    timestamp that `/doctor` surfaces.
- **Current leaning**: (a) + (c). Enable via systemd environment,
  add an auto-expiry (e.g. 30 minutes), and `/doctor` lists the
  expiry time prominently.
- **Risk if unresolved**: the flag stays on in steady state and
  the "unauthorized users get no response" posture (AC01) silently
  lapses.
- **Refs**: PRD §6, §8.1 `/whoami`, AC01; HLD §9.2, §16.1.

### Q12 — Which secret patterns does the P0 redactor cover?

- **Section**: Security / Privacy
- **Top 10 priority**: —
- **Status**: partially-decided (HLD §13.2 starting set)
- **Decision needed by**: Walking Skeleton gate (playbook §5.5).
- **Owner**: Security
- **Options**:
  - a) Only the HLD §13.2 starting set (Telegram, API keys, S3
    keys, JWT, bearer tokens).
  - b) a) plus PEM blocks (`-----BEGIN ... PRIVATE KEY-----`),
    `AWS_ACCESS_KEY_ID=` style assignments, cookies, and email
    addresses.
  - c) b) plus a user-extensible allow-list file of additional
    patterns specific to this user's projects.
- **Current leaning**: (b) for P0; (c) via a config file in P1.
  Ship with tests that fail if any listed pattern leaks through
  to a post-redaction row.
- **Risk if unresolved**: redaction is "mostly on", a missing
  pattern turns a routine event into a Sev-A incident.
- **Refs**: PRD §15, AC10; HLD §13.2.

### Q13 — How are sensitive attachments handled without content inspection?

- **Section**: Security / Privacy
- **Top 10 priority**: —
- **Status**: decided-by-default (PRD §12.8.3 — P0 does not
  auto-classify file contents)
- **Decision needed by**: decided, but UX for high-risk pattern
  detection in captions/filenames is open.
- **Owner**: Security + Product
- **Options**:
  - a) Current PRD default: no content inspection; default
    `session`; `long_term` needs explicit intent. Secret detector
    runs over metadata only.
  - b) Add a minimal content scan for a short list of patterns
    (e.g. passport numbers, credit cards) before `long_term`
    promotion.
  - c) Ask the user a confirmation question before any
    `long_term` promotion.
- **Current leaning**: (a) + (c). Keep the decided default;
  require a confirmation reply for `long_term` promotions so the
  user cannot accidentally persist a sensitive file via a vague
  "save this".
- **Risk if unresolved**: user sends a passport scan, says "save
  this", and it lands in long-term memory without a second look.
- **Refs**: PRD §12.8.3, §15; HLD §9.3.

---

## 5. Provider Runtime

### Q14 — If the Claude provider session is lost, can SQLite alone recover the conversation?

- **Section**: Provider Runtime
- **Top 10 priority**: rank 5
- **Status**: open (design implies yes, not yet test-verified)
- **Decision needed by**: Risk Spike gate (playbook §5.3), covered
  by spike §6.1.6.
- **Owner**: Staff Eng
- **Options**:
  - a) Rely on `--resume` and trust Claude's session persistence.
  - b) Treat `provider_session_id` as an optimization only;
    guarantee that `replay_mode` from SQLite reproduces the
    conversation regardless of Claude state.
- **Current leaning**: (b). The HLD already names SQLite
  `sessions` + `turns` as source of truth; the remaining question
  is a hard test: kill Claude's session out-of-band and confirm
  replay-mode produces an acceptable continuation.
- **Risk if unresolved**: one unlucky Claude upgrade deletes all
  active sessions and users lose their conversations.
- **Refs**: HLD §8.2, §10.2; 03_RISK_SPIKES spike §6.1.6; PRD
  §12.4.

### Q15 — If Claude answers but stream-json parsing fails, does the user still get the answer?

- **Section**: Provider Runtime
- **Top 10 priority**: —
- **Status**: decided (PRD §16.3, HLD §8.3 — parser fallback path)
- **Decision needed by**: decided; stays here to capture the test
  requirement.
- **Owner**: Staff Eng
- **Options**: (historical)
  - a) Fail the job on any parse error.
  - b) Attempt a fallback reconstruction from accumulated chunks
    / redacted raw events; mark `parser_status = fallback_used`.
- **Current leaning**: (b) is the decided policy. AC15 plus the
  parser-fixture test requirement ensure this path stays alive.
- **Risk if unresolved**: a minor Claude output change silently
  turns every run into a failure.
- **Refs**: PRD §16.3, AC15; HLD §8.3, §7.3.

### Q16 — What side effects does "Claude Code" have when used as a general chat runtime?

- **Section**: Provider Runtime
- **Top 10 priority**: —
- **Status**: open
- **Decision needed by**: Risk Spike gate (spikes §6.1.4–§6.1.6).
- **Owner**: Staff Eng + Security
- **Options**: (observations to confirm)
  - Permission prompt behavior under `--tools ""` +
    `--permission-mode dontAsk`.
  - Automatic tool discovery in the current cwd.
  - Project-level settings leakage (e.g. `.claude/` in cwd).
  - Session-persistence artifacts Claude writes to disk.
  - `stream-json` event-shape differences vs the coding-focused
    path.
  - Impact of the chosen `cwd` on Claude's behavior.
- **Current leaning**: Enumerate and verify each observation in
  spikes §6.1.4–§6.1.6; codify findings as fixtures and
  `/doctor` checks. If any item produces an unacceptable side
  effect, escalate to a provider re-evaluation.
- **Risk if unresolved**: Claude quietly writes to disk, invokes
  tools, or prompts for permission in a way the runtime cannot
  see.
- **Refs**: PRD §11, §15; HLD §8.1, §8.4, §16.1; spikes §6.1.4–
  §6.1.6.

---

## 6. Telegram UX

### Q17 — How does the user know the agent remembered something?

- **Section**: Telegram UX
- **Top 10 priority**: —
- **Status**: open
- **Decision needed by**: Claude vertical slice landing.
- **Owner**: Product
- **Options**:
  - a) Silent — rely on `/summary` to surface what was
    remembered.
  - b) Inline footer on the assistant reply: a short
    "Remembered:" line listing new facts / preferences / saved
    artifacts.
  - c) Separate confirmation message per memory write.
- **Current leaning**: (b). A short footer on the existing reply
  keeps notification count low while giving the user a live
  signal that the system captured something.
- **Risk if unresolved**: users cannot tell whether the agent
  "got it" without running `/summary` every time, and trust in
  memory erodes.
- **Refs**: PRD §7, §8.1 `/summary`; HLD §11.

### Q18 — What is the Telegram notification noise budget?

- **Section**: Telegram UX
- **Top 10 priority**: —
- **Status**: partially-decided (PRD §13.3 defines notification
  types; which ones actually push is open)
- **Decision needed by**: Walking Skeleton gate.
- **Owner**: Product
- **Options** (which notification types push to Telegram in P0):
  - a) Everything: `job_accepted`, `job_started`, `job_completed`,
    `job_failed`, `job_cancelled`, `summary`, `doctor`, plus
    storage sync success/failure.
  - b) Essentials only: `job_accepted`, `job_completed`,
    `job_failed`, `summary`, `doctor`. Skip `job_started` and
    silent-success sync events.
  - c) Minimal: only terminal states (`succeeded`/`failed`/
    `cancelled`) plus explicit command results.
- **Current leaning**: (b). `job_started` is implied by
  `job_accepted` in a single-worker system; storage sync success
  is invisible to the user by design; failures still surface.
- **Risk if unresolved**: notification fatigue, users mute the
  bot, real failures get missed.
- **Refs**: PRD §13.3; HLD §6.3.

### Q19 — What does `/status` show?

- **Section**: Telegram UX
- **Top 10 priority**: —
- **Status**: open
- **Decision needed by**: Walking Skeleton gate.
- **Owner**: Product
- **Options** (P0 content):
  - a) Queue-only: `queued` and `running` job counts.
  - b) Queue + last completed job id + timestamp.
  - c) Full: current `session_id` (short), active provider,
    queued/running counts, failed-retryable counts (jobs,
    notifications, storage_sync), last completed job summary.
- **Current leaning**: (c), but rendered as a compact one-screen
  Telegram message. Power users want a single check that tells
  them system health without running `/doctor`.
- **Risk if unresolved**: users run `/doctor` routinely and it
  becomes the de-facto status command, inflating its cost.
- **Refs**: PRD §7 US-02, §8.1; HLD §16.5.

### Q20 — How do we track outbound delivery failures and duplicates?

- **Section**: Telegram UX
- **Top 10 priority**: rank 6
- **Status**: partially-decided (HLD §6.3 + PRD §13.3 define the
  state machine; operational surface is open)
- **Decision needed by**: Walking Skeleton gate.
- **Owner**: SRE + Product
- **Options**:
  - a) Rely on `outbound_notifications` rows as the record; users
    see duplicates and report them.
  - b) Surface `stale_pending_notifications` in `/status` and
    `/doctor`; add a per-row maximum delivery age beyond which
    the row is declared `failed` and surfaced to the user.
  - c) Add a "delivery receipt" concept — the user can `/ack <id>`
    to confirm receipt; unacked pending rows surface in
    `/status`.
- **Current leaning**: (b). Duplicates cannot be made impossible
  in at-least-once delivery; the important property is that
  stuck or lost messages are visible. `/ack` is P1+.
- **Risk if unresolved**: a partial Telegram outage leaves the
  user staring at a blank chat while the runtime thinks
  everything is fine.
- **Refs**: PRD §13.3; HLD §6.3, §7.7, §16.1.

---

## 7. Operations

### Q21 — What does the user see after a service restart?

- **Section**: Operations
- **Top 10 priority**: —
- **Status**: partially-decided (HLD §15 reconciles state; user
  messaging is open)
- **Decision needed by**: Walking Skeleton gate.
- **Owner**: SRE + Product
- **Options**:
  - a) Silent recovery: `interrupted → queued` (when
    `safe_retry`) with no user message; failures surface via the
    usual `job_failed` notification.
  - b) Explicit boot summary sent to the user: "service
    restarted; N jobs resumed, M failed"; per-job notifications
    for failures.
  - c) A single message only when there is something actionable
    (at least one `job_failed` or `interrupted` remains).
- **Current leaning**: (c). Silent during normal restarts,
  noisy only when the user needs to know something.
- **Risk if unresolved**: users either get spammed on every
  restart, or discover silently-dropped work days later.
- **Refs**: PRD §16.1, AC06; HLD §15.

### Q22 — Should `/doctor` be split into quick and deep variants?

- **Section**: Operations
- **Top 10 priority**: —
- **Status**: open
- **Decision needed by**: P0 Acceptance Test gate.
- **Owner**: SRE
- **Options**:
  - a) Single `/doctor` runs everything; accept the latency cost.
  - b) `/doctor` runs quick checks only (DB, Telegram, Claude
    version); `/doctor_deep` adds S3 smoke, lockdown smoke,
    process-group kill smoke.
  - c) `/doctor` runs quick checks by default; `/doctor s3`,
    `/doctor claude`, etc. target specific deep checks.
- **Current leaning**: (a) for P0 if total latency stays within
  a few seconds; flip to (c) if `/doctor` exceeds a response-time
  threshold in real use. AC16 requires the S3 smoke to succeed
  for acceptance either way.
- **Risk if unresolved**: `/doctor` becomes too slow to be useful
  and operators stop running it.
- **Refs**: PRD §7 US-07, AC16; HLD §16.

### Q23 — How long can the system run with S3 unreachable before something breaks?

- **Section**: Operations
- **Top 10 priority**: rank 7
- **Status**: open
- **Decision needed by**: P0 Acceptance Test gate.
- **Owner**: SRE
- **Options**:
  - a) Assume rare, short outages; accept unbounded backlog.
  - b) Define a maximum backlog / disk-usage threshold; surface
    a warning in `/status` and `/doctor` when approached; at
    hard limit, refuse to accept new `long_term` writes (new
    attachments keep working as `ephemeral`/`session`).
  - c) Configure an emergency "pause attachment acceptance" flag
    the operator can set manually.
- **Current leaning**: (b). Needs concrete numbers: e.g. "warn
  at 1000 pending rows or 20% disk; hard limit at 5000 rows or
  80% disk". Set them in the implementation plan and surface in
  `/status`.
- **Risk if unresolved**: a multi-day S3 outage fills the disk,
  takes SQLite down with it, and the restart loop makes it
  worse.
- **Refs**: PRD AC08, AC16; HLD §12.5, §16.1.

---

## 8. Cost / Token Budget

### Q24 — When is a session summary generated, and on what token budget?

- **Section**: Cost / Token Budget
- **Top 10 priority**: rank 8
- **Status**: partially-decided (PRD §12.3 describes generation;
  triggers and budgets not set)
- **Decision needed by**: Claude vertical slice landing.
- **Owner**: Product + Staff Eng
- **Options** (trigger policy):
  - a) Explicit only: `/summary` and `/end`; no automatic runs.
  - b) Explicit + turn-count trigger (e.g. every 30 turns in a
    live session).
  - c) Explicit + transcript-size trigger (e.g. when packer
    estimates prompt > X% of budget).
- **Current leaning**: (a) for P0, with a conservative (c)-style
  trigger enabled if the packer reports repeated `prompt_overflow`.
  Budget for a summary run: a dedicated, small token cap
  (roughly comparable to a normal reply) to prevent runaway
  cost.
- **Risk if unresolved**: summaries fire on every turn (cost) or
  never (context overflow), depending on who implements it.
- **Refs**: PRD §12.3, §12.5; HLD §11.1, §10.3.

### Q25 — Over-budget context: which slots does the packer drop first?

- **Section**: Cost / Token Budget
- **Top 10 priority**: —
- **Status**: decided (HLD §10.3 precedence)
- **Decision needed by**: decided; kept for audit.
- **Owner**: Staff Eng
- **Options**: (historical)
  - a) Drop recent turns first (HLD current).
  - b) Drop the session summary first.
  - c) Random / first-fit.
- **Current leaning**: HLD §10.3 locks the order: drop recent
  turns, then project brief, then session summary; the user
  message and identity block are never dropped; if even those
  don't fit, fail with `prompt_overflow`.
- **Risk if unresolved**: N/A — kept for audit.
- **Refs**: HLD §10.3; PRD §12.5.

### Q26 — How is provider usage recorded when the provider does not report it?

- **Section**: Cost / Token Budget
- **Top 10 priority**: —
- **Status**: decided (PRD §14.3 — "observation metric, not
  billing")
- **Decision needed by**: decided.
- **Owner**: Staff Eng
- **Options**: (historical)
  - a) Refuse to succeed the job if usage is missing.
  - b) Record a nullable usage schema; fill `duration_ms`,
    `output_bytes`, `estimated_tokens`; treat missing values as
    unknown.
- **Current leaning**: (b) is the decided policy. `provider_runs`
  stores a nullable usage shape; downstream analysis treats
  missing fields as unknown rather than zero.
- **Risk if unresolved**: N/A — kept for audit.
- **Refs**: PRD §14.3; HLD §13.3, §8.4.

---

## 9. Future Architecture

Reserved for P1+ architectural questions surfaced during P0 (e.g.
vector retrieval, Obsidian write-back, multi-provider routing,
autonomous task loops). Keep entries here as placeholders until
they are promoted to PRD §5 non-goals → in-scope items with a
formal amendment.

*No entries yet.*

---

## Deferred

Questions moved out of the active sections because they no longer
block P0 but have not been decided.

*No entries yet.*

