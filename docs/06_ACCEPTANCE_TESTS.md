# Personal Agent P0 — Acceptance Tests

> Status: draft · Owner: Staff Eng (test) · Last updated: 2026-04-22
>
> One test plan per PRD §17 acceptance criterion. Each entry
> specifies the fixture, the concrete steps, the oracle, and the
> test type. The P0 Acceptance Test gate (playbook §5.7) is met
> when every P0 `Status: pending` below flips to `pass` on the
> staging host against the pinned versions.
>
> IDs use the canonical `AC-<DOMAIN>-<###>` scheme from PRD §17.
> Legacy numeric IDs (`AC01`…`AC30`) from earlier revisions are
> retained as parenthetical aliases in the `Maps to` line to ease
> transition. Only the canonical IDs are authoritative.
>
> Coverage note: this file currently enumerates the first 30 PRD
> criteria (everything through `AC-MEM-005` / legacy `AC30
> artifact`). The remaining P0 criteria introduced by the restart-
> block and the Issue 7 chunk ledger (`AC-OPS-002`, `AC-TEL-005..009`,
> `AC-PROV-007..014`, `AC-NOTIF-001..005`, `AC-SEC-003..007`,
> `AC-MEM-006`, `AC-OPS-003..004`) are tracked as **pending-to-add**
> in the backlog at the end of this file and will be written up in
> the same format before the P0 Acceptance gate.
>
> These are **acceptance** tests: each AC must be exercised end-
> to-end against a realistic environment. Unit tests for the same
> invariants live next to the module (per
> `docs/04_IMPLEMENTATION_PLAN.md`); they are necessary but not
> sufficient.

## Test environment

- Host: a CX22 (or local equivalent) with the deploy done per
  Runbook §2.
- Telegram: a disposable bot in a DM chat with the authorized
  user.
- Claude: the pinned CLI version (SP-04 / SP-05 / SP-06).
- Hetzner Object Storage: a dedicated test bucket; keys loaded
  from an env file not committed.
- A second, **unauthorized** Telegram account is configured for
  AC-TEL-001.
- A harness repository exists under `test/acceptance/` with a
  small CLI and per-AC scenario scripts.

## Conventions

Each entry uses:

```
### AC-<DOMAIN>-<###> — Title

- Maps to: PRD §N, HLD §M   (legacy AC## where applicable)
- Test type: end-to-end | state-machine | smoke | chaos
- Fixture: what is loaded before the test
- Procedure: what we do
- Oracle: how we judge pass/fail
- Status: pending | pass | fail
```

---

## AC-TEL-001 — Unauthorized Telegram user never produces a job

- **Maps to**: PRD AC-TEL-001 (legacy AC01); HLD §4.2, §9.2.
- **Test type**: end-to-end.
- **Fixture**: A clean DB, `allowed_user_ids = [U_primary]`,
  `BOOTSTRAP_WHOAMI = false`.
- **Procedure**:
  1. Send `hello` from `U_primary` (authorized).
  2. Send `hello` from `U_other` (unauthorized).
  3. Send `/whoami` from `U_other`.
- **Oracle**:
  - `telegram_updates` has rows for all three updates.
  - The `U_other` updates are `skipped` with
    `skip_reason = 'unauthorized'`.
  - `jobs` has exactly one row (for `U_primary`).
  - Nothing is sent to `U_other`.
  - Enable `BOOTSTRAP_WHOAMI = true`, repeat step 3: a
    `/whoami` reply is sent; other messages from `U_other`
    still skipped.
- **Status**: pending.

## AC-JOB-001 — Authorized DM creates exactly one job and transitions correctly

- **Maps to**: PRD AC-JOB-001 (legacy AC02); HLD §6.2, §7.2.
- **Test type**: end-to-end + state-machine.
- **Fixture**: Clean DB.
- **Procedure**:
  1. Authorized user sends a short text message.
  2. Observe `jobs` status over time.
- **Oracle**:
  - One `jobs` row with `job_type = 'provider_run'`.
  - Status transitions `queued → running → succeeded` in order;
    `started_at` and `finished_at` set.
  - A `turns` row with `role = 'assistant'` exists, tied to the
    same `session_id` as the inbound.
- **Status**: pending.

## AC-PROV-001 — Claude raw stream is persisted as redacted events

- **Maps to**: PRD AC-PROV-001 (legacy AC03), AC-SEC-001; HLD §8.3, §13.
- **Test type**: end-to-end.
- **Fixture**: Clean DB; include a deliberate `Bearer abcd1234…`
  string in the prompt.
- **Procedure**:
  1. Send the prompt.
  2. After completion, read `provider_raw_events` for that
     `provider_run_id`.
- **Oracle**:
  - All rows have `redaction_applied = true`.
  - The bearer token does not appear in `redacted_payload`.
  - `stdout` and `stderr` streams each have at least one row.
- **Status**: pending.

## AC-TEL-002 — Final response is sent to Telegram and saved as a turn

- **Maps to**: PRD AC-TEL-002 (legacy AC04); HLD §6.3, §7.2.
- **Test type**: end-to-end.
- **Fixture**: Clean DB.
- **Procedure**:
  1. Send a short prompt.
  2. Capture the Telegram reply.
- **Oracle**:
  - A Telegram message arrives within the configured timeout.
  - A `turns` row with `role = 'assistant'` matches the reply
    (or its joined chunks for a multi-message split).
  - `outbound_notifications.status = sent` and
    `telegram_message_ids_json` is populated.
- **Status**: pending.

## AC-TEL-003 — Duplicate `update_id` produces only one job

- **Maps to**: PRD AC-TEL-003 (legacy AC05); HLD §4.2, §5.3, §6.1.
- **Test type**: state-machine.
- **Fixture**: Clean DB; stub Telegram server so we can replay
  the same `update_id` intentionally.
- **Procedure**:
  1. Replay the same `update_id` twice via the stub.
- **Oracle**:
  - `telegram_updates` has exactly one row (unique
    `update_id`).
  - `jobs` has exactly one row.
- **Status**: pending.

## AC-JOB-002 — Restart reconciles running jobs to `interrupted` or `queued`

- **Maps to**: PRD AC-JOB-002 (legacy AC06); HLD §15.
- **Test type**: chaos.
- **Fixture**: Clean DB; a long-running `provider_run` (use a
  slow fake provider for determinism, then also verify with the
  real adapter).
- **Procedure**:
  1. Send a message that triggers the long-running job.
  2. While it is `running`, SIGKILL the service.
  3. Restart the service.
- **Oracle**:
  - On restart, the job moves `running → interrupted` in the
    boot doctor log.
  - If `safe_retry = true` and `attempts < max_attempts`, the
    job is re-queued and eventually succeeds; `attempts` was
    not double-charged for the interruption.
  - Otherwise the job stays `interrupted`, and a
    `job_failed`-style `outbound_notifications` row surfaces
    the event.
- **Status**: pending.

## AC-MEM-001 — `/summary` and `/end` persist summary and enqueue storage sync

- **Maps to**: PRD AC-MEM-001 (legacy AC07); HLD §7.5, §11.
- **Test type**: end-to-end.
- **Fixture**: A session with at least three turns.
- **Procedure**:
  1. Run `/summary`. Capture the reply and the DB rows.
  2. Run `/end`. Capture the reply and the DB rows.
- **Oracle**:
  - After `/summary`: one `memory_summaries` row with
    `summary_type = 'session'`; a local file under
    `memory/sessions/<id>.jsonl`; a queued `storage_sync` job
    for the snapshot.
  - After `/end`: a second summary (or session close); the
    session is marked ended (per Open Q01 resolution, once
    adopted).
  - Summary content includes `provenance` and `confidence`
    fields per PRD §12.2–12.3.
- **Status**: pending.

## AC-STO-001 — S3 outage does not block Telegram delivery

- **Maps to**: PRD AC-STO-001 (legacy AC08); HLD §12.4, §12.5.
- **Test type**: chaos.
- **Fixture**: Valid Telegram config; S3 endpoint pointed at a
  bad URL (or credentials bad).
- **Procedure**:
  1. Send a prompt.
  2. After the reply, inspect `storage_sync` jobs.
- **Oracle**:
  - The user receives the Telegram reply.
  - `provider_run` reaches `succeeded`; it is not rolled back.
  - `storage_objects` rows associated with the run are
    `pending` or `failed` (not rolled back either).
- **Status**: pending.

## AC-PROV-002 — Runtime / output / prompt limits terminate the subprocess

- **Maps to**: PRD AC-PROV-002 (legacy AC09); HLD §14.2, §14.3.
- **Test type**: chaos.
- **Fixture**: `max_runtime`, `max_output_bytes`, and
  `max_prompt_bytes` set to low values for the test session.
- **Procedure**:
  1. Trigger a run that would exceed each limit in turn
     (three sub-cases).
- **Oracle**:
  - Each run ends with the subprocess torn down within the
    grace + hard-kill budget.
  - The user receives a clear `job_failed` message naming the
    limit hit.
  - `/doctor` reports no orphan processes afterwards.
- **Status**: pending.

## AC-SEC-001 — Secrets never appear in persisted rows

- **Maps to**: PRD AC-SEC-001 (legacy AC10); HLD §13.
- **Test type**: end-to-end + grep.
- **Fixture**: Plant known patterns in the user prompt
  (Telegram token shape, bearer token, S3 key shape).
- **Procedure**:
  1. Send the seeded prompt.
  2. Dump every durable store (SQLite rows, local files,
     fresh S3 objects).
- **Oracle**:
  - None of the planted patterns appear in any dump.
  - The redactor test harness from Phase 1 passes on the
    actual dumps in addition to its own fixtures.
- **Status**: pending.

## AC-PROV-003 — Claude runs without interactive permission prompts

- **Maps to**: PRD AC-PROV-003 (legacy AC11); HLD §8.1.
- **Test type**: smoke (piggy-backs on SP-05 once in prod).
- **Fixture**: Conversational profile flags locked in config.
- **Procedure**:
  1. Run five varied prompts including file-mention language,
     shell-mention language, URL-mention language.
- **Oracle**:
  - No prompt causes Claude to emit a permission question.
  - Filesystem audit (where available) shows no unexpected
    writes during the runs.
- **Status**: pending.

## AC-STO-002 — `storage_sync` failure does not roll back `provider_run`

- **Maps to**: PRD AC-STO-002 (legacy AC12); HLD §6.4, §12.4.
- **Test type**: chaos.
- **Fixture**: Valid configuration; credentials tampered to
  force sync failures.
- **Procedure**:
  1. Run `/summary` (enqueues a sync job).
  2. Observe that the sync fails while `provider_run` status is
     already succeeded.
- **Oracle**:
  - `provider_run.status` stays `succeeded` indefinitely.
  - `storage_objects` rows move between `pending` and `failed`
    with `error_json` set.
  - Fixing credentials allows the rows to reach `uploaded`
    without any extra handholding.
- **Status**: pending.

## AC-MEM-002 — Memory summary items carry provenance and confidence

- **Maps to**: PRD AC-MEM-002 (legacy AC13); HLD §11.3.
- **Test type**: end-to-end.
- **Fixture**: A session with a mix of user-stated and
  agent-inferred items.
- **Procedure**:
  1. Run `/summary`; inspect the `memory_summaries` row.
- **Oracle**:
  - Every non-empty item has both `provenance` and
    `confidence` fields.
  - No item with provenance outside `{user_stated,
    user_confirmed}` is marked as a long-term personal
    preference candidate.
- **Status**: pending.

## AC-PROV-004 — `/cancel` terminates the whole subprocess group

- **Maps to**: PRD AC-PROV-004 (legacy AC14); HLD §7.4, §14.
- **Test type**: chaos.
- **Fixture**: A running `provider_run` using a subject that
  forks a child (via the fake provider's "stubborn" mode).
- **Procedure**:
  1. User issues `/cancel`.
- **Oracle**:
  - The `jobs` row transitions `running → cancelled`.
  - `kill(-pgid, 0)` returns `ESRCH` within the kill budget.
  - Any child processes are also gone.
- **Status**: pending.

## AC-PROV-005 — Parser fixture normalizes a sample to `final_text`

- **Maps to**: PRD AC-PROV-005 (legacy AC15); HLD §8.3.
- **Test type**: state-machine (runs in unit + acceptance).
- **Fixture**: A sample stream-json file from SP-04 plus a
  forcibly-truncated variant.
- **Procedure**:
  1. Run the parser on the full file.
  2. Run the parser on the truncated file.
- **Oracle**:
  - Full file → `final_text_reconstructed == final_text`.
  - Truncated file → parser fallback produces a plausible
    `final_text` and marks `parser_status = fallback_used`.
- **Status**: pending.

## AC-OBS-001 — `/doctor` S3 smoke passes before P0 acceptance

- **Maps to**: PRD AC-OBS-001 (legacy AC16); HLD §12, §16.1.
- **Test type**: smoke.
- **Fixture**: Configured Hetzner endpoint + credentials.
- **Procedure**:
  1. Run `/doctor` from Telegram.
- **Oracle**:
  - `s3_endpoint_smoke = ok` (put/get/stat/list/delete all
    succeed on a temp key that is cleaned up).
  - If the smoke fails, the service still starts and responds
    to DMs in degraded mode; AC-OBS-001 P0 acceptance gate is not
    met until this flips to `ok`.
- **Status**: pending.

## AC-TEL-004 — Long polling works without a bot framework

- **Maps to**: PRD AC-TEL-004 (legacy AC17); HLD §9.1.
- **Test type**: smoke.
- **Fixture**: Run the service under strict dependency
  restriction (allowlist enforced by build).
- **Procedure**:
  1. Verify no bot framework is loaded at runtime (no
     `grammy`, `telegraf`, etc. in `node_modules`).
  2. Exchange a message end-to-end.
- **Oracle**:
  - Dependency tree excludes bot frameworks.
  - `getUpdates` and `sendMessage` work via direct `fetch`.
- **Status**: pending.

## AC-PROV-006 — Provider subprocess can be terminated by timeout / AbortSignal

- **Maps to**: PRD AC-PROV-006 (legacy AC18); HLD §14.
- **Test type**: chaos.
- **Fixture**: A fake provider configured to hang.
- **Procedure**:
  1. Start the job.
  2. Exercise (a) max_runtime timeout, (b) AbortController,
     (c) stall timeout — three sub-cases.
- **Oracle**:
  - In each sub-case the process group is gone within the
    configured budget.
  - The job reaches `failed` (for timeouts) or `cancelled`
    (for explicit abort).
  - `cancelled_after_start = true` is recorded when any side
    effects occurred.
- **Status**: pending.

## AC-JOB-003 — WAL + atomic job claim stays consistent after restart

- **Maps to**: PRD AC-JOB-003 (legacy AC19); HLD §5.1, §6.2.
- **Test type**: chaos.
- **Fixture**: Clean DB; a claim loop running under a second
  process for contention.
- **Procedure**:
  1. While claims are happening, SIGKILL the service.
  2. Restart.
  3. Inspect `jobs`: no `running` rows without an owner.
- **Oracle**:
  - No double-claimed job exists.
  - `status = running` after restart is only possible before
    recovery runs; after recovery, no such row remains.
- **Status**: pending.

## AC-OPS-001 — Dependency list stays within allowlist

- **Maps to**: PRD AC-OPS-001 (legacy AC20).
- **Test type**: smoke.
- **Fixture**: PRD-declared allowlist (Appendix A / F).
- **Procedure**:
  1. Run a CI job that compares the project's declared
     dependencies (direct + transitive) against the
     allowlist.
- **Oracle**:
  - The comparison script prints a green line; any new
    dependency triggers a PR failure until listed in the
    allowlist or 08_DECISION_REGISTER.md.
- **Status**: pending.

## AC-STO-003 — Telegram attachment is captured into `storage_objects`

- **Maps to**: PRD AC-STO-003 (legacy AC21 (artifact)); HLD §9.3.
- **Test type**: end-to-end.
- **Fixture**: Clean DB; Telegram + Hetzner available.
- **Procedure**:
  1. Send a photo and a small document.
  2. Inspect `storage_objects`.
- **Oracle**:
  - Two rows with `source_channel = 'telegram'`, detected
    `mime_type`, non-null `sha256`, and
    `source_message_id` set.
  - Local file path exists and matches the hash.
  - Retention defaults to `session` (not `long_term`).
  - The Telegram `file_path` URL is never stored as the
    durable reference.
- **Status**: pending.

## AC-STO-004 — Attachment stays `session` without explicit save intent

- **Maps to**: PRD AC-STO-004 (legacy AC22 (artifact)); HLD §6.4, §9.3.
- **Test type**: end-to-end.
- **Fixture**: As AC-STO-003.
- **Procedure**:
  1. Send an attachment with a neutral caption ("here's a
     photo").
  2. Do **not** run `/save_last_attachment` or any natural-
     language save phrase.
  3. Wait for the session to end.
- **Oracle**:
  - The `storage_objects` row stays `retention_class =
    session`.
  - No `memory_artifact_links` row with
    `memory_summary_id != null` is created for it.
  - No S3 object is written (absent the session-level sync
    rule).
- **Status**: pending.

## AC-STO-005 — Explicit save promotes attachment to `long_term`

- **Maps to**: PRD AC-STO-005 (legacy AC23 (artifact)); HLD §6.4, §11.4.
- **Test type**: end-to-end.
- **Fixture**: As AC-STO-003.
- **Procedure**:
  1. Send an attachment.
  2. Run `/save_last_attachment` (or a natural-language "save
     this image").
- **Oracle**:
  - `storage_objects.retention_class = long_term`,
    `status = uploaded` (after sync).
  - A `memory_artifact_links` row references the artifact
    with `provenance ∈ {user_stated, user_confirmed}`.
  - The S3 object exists at a key that matches PRD §12.8.4.
- **Status**: pending.

## AC-SEC-002 — S3 object keys carry no user-facing semantics

- **Maps to**: PRD AC-SEC-002 (legacy AC24 (artifact)); HLD §5.2.
- **Test type**: smoke.
- **Fixture**: A handful of uploaded artifacts from AC-STO-003 /
  AC-STO-005.
- **Procedure**:
  1. List the bucket under `objects/` and inspect keys.
- **Oracle**:
  - Every key matches
    `objects/{yyyy}/{mm}/{dd}/{uuid}/{sha256}\.[a-z0-9]+`.
  - No key contains original filename, user name, chat id, or
    project name.
- **Status**: pending.

## AC-STO-006 — `storage_sync` failures retain state cleanly

- **Maps to**: PRD AC-STO-006 (legacy AC25 (artifact)); HLD §6.4, §12.3.
- **Test type**: chaos.
- **Fixture**: Pending `storage_objects` row; credentials
  broken.
- **Procedure**:
  1. Force a failure.
  2. Fix credentials.
- **Oracle**:
  - After failure: row is `failed` with `error_json` set;
    `provider_run` unaffected.
  - After fix: retry moves the row to `uploaded`; no data
    loss.
- **Status**: pending.

## AC-MEM-003 — `/forget_*` uses tombstones, never hard-deletes

- **Maps to**: PRD AC-MEM-003 (legacy AC26 (artifact)); HLD §6.4, §6.5; DEC-006.
- **Test type**: state-machine.
- **Fixture**: Session with at least one `active` `memory_items`
  row and at least one `uploaded` `storage_objects` row.
- **Procedure**:
  1. `/forget_memory <id>` on the memory row.
  2. `/forget_artifact <id>` on the artifact row.
  3. Wait for the next `storage/sync` pass.
- **Oracle**:
  - After (1): `memory_items.status = revoked`; context
    packer no longer injects the item.
  - After (2): `storage_objects.status = deletion_requested`.
  - After (3): row reaches `deleted` (S3 object gone) or
    `delete_failed` (S3 error surfaced via `/doctor`).
  - No rows are physically deleted from SQLite in any case.
- **Status**: pending.

## AC-MEM-004 — User correction inserts a new item and supersedes the prior one atomically

- **Maps to**: PRD AC-MEM-004 (legacy AC27 (artifact)); HLD §6.5; DEC-007.
- **Test type**: state-machine.
- **Fixture**: A session with one `active` `memory_items` row
  (`id = M_old`) capturing a fact.
- **Procedure**:
  1. Issue `/correct M_old` (or send the natural-language
     correction "정정: not X but Y").
  2. Inspect `memory_items` immediately after the txn commits.
- **Oracle**:
  - A new row `M_new` exists with `status = active`,
    `supersedes_memory_id = M_old`, and
    `provenance = user_stated`.
  - `M_old` has `status = superseded` with
    `status_changed_at` matching the new row's timestamp.
  - Both transitions committed in a **single transaction**
    (observable by a point-in-time read showing neither
    intermediate state).
  - Next provider_run's `injected_context_ids` excludes
    `M_old` and includes `M_new` when relevant.
- **Status**: pending.

## AC-OBS-002 — Only the notification minimal set is pushed

- **Maps to**: PRD AC-OBS-002 (legacy AC28 (artifact)); HLD §6.3, §9.4; DEC-012.
- **Test type**: end-to-end.
- **Fixture**: A session that exercises each `notification_type`
  (both pushed and silent categories).
- **Procedure**:
  1. Drive a `provider_run` to `succeeded` (triggers
     `job_accepted`, `job_completed`).
  2. Drive a `provider_run` to `failed` (triggers
     `job_failed`).
  3. Issue `/cancel` on a `running` job (triggers
     `job_cancelled`).
  4. Run `/summary` and `/doctor`.
  5. Trigger at least one successful `storage_sync` and one
     successful `notification_retry`.
- **Oracle**:
  - Telegram receives messages for every pushed type listed
    in PRD §13.3 and nothing else.
  - Silent types (`job_started`, `storage_sync_succeeded`,
    `notification_retry_succeeded`, `interrupted_then_requeued`)
    produce no Telegram traffic and no
    `outbound_notifications` rows.
- **Status**: pending.

## AC-OBS-003 — `/status` output matches the §14.1 contract

- **Maps to**: PRD AC-OBS-003 (legacy AC29 (artifact)); HLD §16.5; DEC-015.
- **Test type**: end-to-end (golden).
- **Fixture**: A controlled session state with known counts:
  1 `queued`, 1 `running`, N `pending` notifications, M
  `pending` / failed storage_sync.
- **Procedure**:
  1. Run `/status`.
  2. Capture the returned Telegram text.
  3. Compare line-by-line to the §14.1 template.
- **Oracle**:
  - Every field in §14.1 appears in the fixed order.
  - No additional fields appear.
  - Running `/status` twice back-to-back does not mutate any
    DB row (read-only verification via before/after snapshot).
- **Status**: pending.

## AC-MEM-005 — Summary auto-trigger respects conditions and throttle

- **Maps to**: PRD AC-MEM-005 (legacy AC30 (artifact)); HLD §11.1; DEC-019.
- **Test type**: state-machine + chaos.
- **Fixture**: A session with controllable
  `turn_count` / `transcript_estimated_tokens` / `session_age`.
- **Procedure**:
  1. Manipulate each trigger independently to its threshold
     with fewer than 8 new user turns since the last summary;
     confirm **no** automatic summary fires.
  2. Push past 8 new user turns with the same trigger
     conditions; confirm a `summary_generation` job enqueues.
  3. While a summary is pending, issue another trigger; confirm
     the throttle prevents a second enqueue.
  4. Issue `/summary` explicitly; confirm it always runs
     regardless of throttle.
- **Oracle**:
  - The `memory_summaries` rows written match expectations
    per sub-case (none / one / one / explicit-one).
  - Each automatic trigger logs the triggering condition and
    the throttle window in structured logs for later audit.
- **Status**: pending.

---

## Pending-to-add (backlog)

The criteria below are enumerated in PRD §17 but do not yet have a
filled-in test plan in this file. They are tracked here explicitly
so the P0 Acceptance gate is unambiguous: **each P0 AC below must
have a plan written before the gate can be called.** Plans will
follow the same template as the sections above.

| ID            | Legacy | Area                                         |
| ------------- | ------ | -------------------------------------------- |
| AC-OPS-002    | AC21 (restart) | `/doctor` shows Bun version + warning      |
| AC-TEL-005    | AC22 (restart) | Offset advance only after commit          |
| AC-TEL-006    | AC23 (restart) | Crash-before-commit re-processes update   |
| AC-PROV-007   | AC24 (restart) | `resume_mode` does not replay turns       |
| AC-PROV-008   | AC25 (restart) | Resume failure → `replay_mode` fallback   |
| AC-NOTIF-001  | AC26 (restart) | `sendMessage` failure does not roll back `provider_run` |
| AC-OPS-003    | AC27 (restart) | `notification_retry` and `storage_sync` retry independently |
| AC-PROV-009   | AC28 (restart) | `/provider` returns `not_enabled` in P0   |
| AC-TEL-007    | AC29 (restart) | `telegram_updates` records received/enqueued/skipped/failed |
| AC-TEL-008    | AC30 (restart) | Skipped updates advance offset only after commit |
| AC-TEL-009    | AC31           | `allowed_updates=["message"]`             |
| AC-PROV-010   | AC32           | `proc.exited` tracking, no `proc.unref()` |
| AC-SEC-003    | AC33           | Claude advisory lockdown smoke test       |
| AC-SEC-004    | AC34           | Claude read-only lockdown smoke test      |
| AC-SEC-005    | AC35           | Interactive permission prompt = fail      |
| AC-SEC-006    | AC36           | `BOOTSTRAP_WHOAMI=true` → `/doctor` warning |
| AC-SEC-007    | AC37           | Bootstrap `/whoami` scope                 |
| AC-NOTIF-002  | AC38           | Long response chunking                    |
| AC-NOTIF-003  | AC39           | Chunk failure does not roll back + sent chunks not resent (new test: TEST-NOTIF-CHUNK-001) |
| AC-NOTIF-004  | AC40           | `outbound_notifications` + `outbound_notification_chunks` ledger |
| AC-NOTIF-005  | AC41           | `notification_retry` chunk selection      |
| AC-PROV-011   | AC42           | Command builder `--session-id` / `--resume` |
| AC-PROV-012   | AC43           | `provider_session_id` priority            |
| AC-PROV-013   | AC44           | Prompt size / argv length guard           |
| AC-PROV-014   | AC45           | `summary_generation` uses advisory profile |
| AC-MEM-006    | AC46           | `summary_generation` output schema         |
| AC-OPS-004    | AC47           | WAL-safe DB backup                        |
| AC-SEC-ATTACH-001 | (new)      | Attachment filenames with §15 patterns stored as NULL |

Suggested additional test plans to write alongside the backlog:

- **TEST-TEL-ATTACH-001** (AC-STO-003 reinforcement): attachment
  download failure during the worker capture pass leaves the user
  turn committed and the `storage_objects` row at
  `capture_status = 'failed'` with `capture_error_json`; no corrupt
  artifact is enqueued for sync.
- **TEST-NOTIF-CHUNK-001** (AC-NOTIF-003 reinforcement): with a 4-
  chunk response, force chunk 3 to fail while chunks 1–2 succeed.
  Retry must resend only chunk 3; the user does not receive chunks
  1–2 a second time.
- **TEST-PROV-RESUME-001** (AC-PROV-008 reinforcement): resume
  failure reuses the same `jobs.id` (no duplicate insert); a second
  `provider_runs` row appears for the `replay_mode` retry; no
  duplicate assistant `turns` rows exist for the session.
- **TEST-STO-STATE-001** (AC-STO-006 reinforcement): `pending`,
  `failed`, and `uploaded` semantics match PRD §17 /
  Appendix D / HLD §6.4 exactly; `capture_status` vs `status`
  columns are independent and never conflated in queries.

---

## Status matrix

Rolled-up view for the P0 Acceptance gate.

| AC   | Status  | Depends on spike(s) | Notes                                          |
| ---- | ------- | ------------------- | ---------------------------------------------- |
| AC-TEL-001 | pending | SP-02               | Needs second Telegram account for unauth path. |
| AC-JOB-001 | pending | SP-01, SP-04, SP-06 |                                                |
| AC-PROV-001 | pending | SP-04               | Redactor must be in place.                     |
| AC-TEL-002 | pending | SP-02, SP-04        | Covers message chunking if long.               |
| AC-TEL-003 | pending | SP-03               |                                                |
| AC-JOB-002 | pending | SP-01, SP-07        | Exercise recovery twice: safe_retry and not.   |
| AC-MEM-001 | pending | SP-06, SP-08        | Summary profile + S3 sync.                     |
| AC-STO-001 | pending | SP-08               | Negative case.                                 |
| AC-PROV-002 | pending | SP-07               | Three sub-cases.                               |
| AC-SEC-001 | pending | SP-04, SP-05        | Combine DB / local / S3 grep.                  |
| AC-PROV-003 | pending | SP-05               |                                                |
| AC-STO-002 | pending | SP-08               |                                                |
| AC-MEM-002 | pending | SP-06               |                                                |
| AC-PROV-004 | pending | SP-07               |                                                |
| AC-PROV-005 | pending | SP-04               | Shared fixture.                                |
| AC-OBS-001 | pending | SP-08               | Also a P0 gate item.                           |
| AC-TEL-004 | pending | SP-02               | Dependency allowlist enforcement.              |
| AC-PROV-006 | pending | SP-07               | Three sub-cases.                               |
| AC-JOB-003 | pending | SP-01               |                                                |
| AC-OPS-001 | pending | —                   | CI script.                                     |
| AC-STO-003 | pending | SP-02, SP-08        | Attachment capture.                            |
| AC-STO-004 | pending | SP-02               | Negative: no promotion.                        |
| AC-STO-005 | pending | SP-02, SP-08        |                                                |
| AC-SEC-002 | pending | SP-08               | Key hygiene.                                   |
| AC-STO-006 | pending | SP-08               |                                                |
| AC-MEM-003 | pending | SP-08               | Tombstone semantics; DEC-006.                  |
| AC-MEM-004 | pending | SP-01               | Atomic supersede txn; DEC-007.                 |
| AC-OBS-002 | pending | SP-02               | Minimal-set push; DEC-012.                     |
| AC-OBS-003 | pending | —                   | Golden-output `/status`; DEC-015.              |
| AC-MEM-005 | pending | —                   | Trigger + throttle; DEC-019.                   |

## Entry / exit criteria for the gate

The P0 Acceptance Test gate (playbook §5.7) is met when:

- All spikes in `docs/03_RISK_SPIKES.md` are `passed`.
- Every AC above is `pass` against the pinned version set.
- `/doctor` on the staging host returns `ok` for every check,
  including `s3_endpoint_smoke`.
- No Sev-A redaction incident is open.

At that point, pass the artifacts to the Runbook-driven
operational review (playbook §5.8) before declaring P0 done.

