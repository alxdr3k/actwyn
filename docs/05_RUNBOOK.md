# Personal Agent P0 — Runbook

> Status: draft · Owner: SRE / project lead · Last updated: 2026-04-22
>
> Operator procedures for the Personal Agent P0 service running on
> a Hetzner CX22 host as a single systemd unit. This runbook is the
> **last** artifact produced before P0 acceptance (playbook §5.7);
> it is expected to evolve after real incidents.
>
> Scope: one operator, one user, one host, one Telegram bot, one
> S3 bucket. Everything outside that shape is P1+.

## Conventions

- **Service name**: `actwyn.service` (systemd unit).
- **Service user**: `actwyn` (non-root, per PRD §15).
- **Paths**:
  - Config: `/etc/actwyn/config.json`, `/etc/actwyn/env`.
  - DB: `/var/lib/actwyn/db/actwyn.sqlite` (+ WAL / SHM).
  - Data: `/var/lib/actwyn/data/` (memory files, attachments,
    transcripts, fixtures).
  - Logs: `journalctl -u actwyn.service`.
- **Commands in this doc** assume `root` (or `sudo`) unless noted.
- Snippets using `actwynctl` refer to a small helper CLI that
  wraps DB queries and file paths. If absent, use `sqlite3`
  directly against the DB file — document any ad-hoc queries in
  the incident log.

## Quick reference

| Situation                              | Go to                           |
| -------------------------------------- | ------------------------------- |
| Service won't start                    | §3 Start / Stop / Restart       |
| User says the bot is silent            | §5 Triage: user-facing failure  |
| `/doctor` reports a failure            | §6 `/doctor` response table     |
| Host was rebooted                      | §4 Restart & startup recovery   |
| S3 seems down                          | §7 S3 degraded mode             |
| A secret may have leaked to a row      | §8 Redaction incident (Sev-A)   |
| Telegram token / S3 key rotation       | §9 Key rotation                 |
| DB backup / restore                    | §10 Backup and restore          |
| Planned upgrade of Bun / Claude        | §11 Dependency upgrades         |
| New operator onboarding                | §12 Bootstrap and `/whoami`     |

---

## 1. Roles and on-call

- **Operator / on-call**: project lead in P0. Single person.
- **Escalation**: none in P0; document any unresolved issue in
  `docs/08_DECISION_REGISTER.md` with dated notes.
- **Severity ladder**:
  - **Sev-A**: data exposure or loss (redaction leak, DB
    corruption, unauthorized access succeeded). Stop the service
    immediately; see §8.
  - **Sev-B**: user-visible outage > 1 hour or hung subprocess
    surviving the kill budget. Fix within the session.
  - **Sev-C**: degraded mode (S3 reachable-ish, retry backlog,
    noisy `/doctor` warnings). Fix within a week.

## 2. Deploy (fresh host or clean reinstall)

Prerequisites:

- Hetzner CX22 running Debian/Ubuntu LTS, kernel 6.x.
- DNS / network to `api.telegram.org` and the configured Hetzner
  Object Storage endpoint reachable.
- Bot token, authorized `user_id`, Hetzner bucket + keys.

Steps:

1. Create the service user and directories:
   ```
   useradd --system --home /var/lib/actwyn --shell /usr/sbin/nologin actwyn
   install -d -o actwyn -g actwyn -m 0750 \
     /etc/actwyn /var/lib/actwyn /var/lib/actwyn/db \
     /var/lib/actwyn/data
   ```
2. Install pinned Bun per PRD Appendix F and make sure
   `/usr/local/bin/bun` is the right version:
   `bun --version`.
3. Install the Claude Code CLI at the configured path; verify
   `claude --version`.
4. Check out the repo at the release tag into `/opt/actwyn`.
5. Populate config:
   - `/etc/actwyn/config.json` — non-secret config (paths,
     endpoints, retry budgets).
   - `/etc/actwyn/env` — secrets
     (`TELEGRAM_BOT_TOKEN`, `S3_ACCESS_KEY`,
     `S3_SECRET_KEY`, `ALLOWED_USER_IDS`,
     `BOOTSTRAP_WHOAMI=false`). Mode `0600`, owner `actwyn`.
6. Install the systemd unit:
   ```
   install -m 0644 /opt/actwyn/deploy/systemd/actwyn.service \
     /etc/systemd/system/
   systemctl daemon-reload
   systemctl enable actwyn.service
   ```
7. First start (pre-flight):
   ```
   systemctl start actwyn.service
   journalctl -u actwyn.service -f    # watch boot doctor
   ```
8. In Telegram DM from the authorized user, run `/doctor`. Expect
   all checks `ok`, including the S3 smoke (AC16).

Rollback: `systemctl stop actwyn.service`; re-point `/opt/actwyn`
to the previous tag; `systemctl start`.

## 3. Start, stop, restart

- Start: `systemctl start actwyn.service`.
- Stop (graceful): `systemctl stop actwyn.service` — systemd
  sends SIGTERM to the Bun process; the service propagates to
  the Claude subprocess group; full stop within the kill
  budget.
- Hard stop: `systemctl kill -s SIGKILL actwyn.service` — use
  only when a graceful stop exceeds its budget. Expect
  `interrupted` jobs on restart (§4).
- Restart: `systemctl restart actwyn.service`. Startup recovery
  runs before the worker loop resumes.

Status glance:

```
systemctl status actwyn.service
journalctl -u actwyn.service -n 200 --no-pager
```

## 4. Restart and startup recovery

On every start, the service runs HLD §15 startup recovery:

1. `jobs.status = running` → `interrupted`.
2. For each new `interrupted`, if `safe_retry = true` and
   `attempts < max_attempts` → `queued`. Otherwise stay
   `interrupted` and an `outbound_notifications` row
   (`job_failed`) is inserted.
3. Orphan Claude process groups from `provider_runs` are swept
   (best-effort `kill(-pgid, SIGKILL)`).
4. `telegram_next_offset` sanity check.
5. Structured `boot_doctor` log entry.

Operator checks after restart:

- `journalctl -u actwyn.service | grep boot_doctor` — look for
  non-zero `interrupted_count` or `orphan_killed`.
- Ask `/status` via Telegram; confirm expected queue state.
- If any user-facing anomaly appears, open `/doctor` and walk
  the checks.

## 5. Triage: user reports the bot is silent

Ask the user what they sent and when. Then:

1. `journalctl -u actwyn.service -n 500 --no-pager` — look for
   recent errors.
2. Confirm `telegram_updates` has the inbound update:
   ```
   sqlite3 /var/lib/actwyn/db/actwyn.sqlite \
     "SELECT update_id,status,skip_reason,created_at \
      FROM telegram_updates ORDER BY created_at DESC LIMIT 10;"
   ```
   - No row at all → the poller is not reaching Telegram
     (auth, DNS, proxy). Check `/doctor`.
   - Row `received` stuck → the inbound classifier is wedged.
     Restart the service (§3). If reproduced, capture the row's
     redacted payload and open an incident note.
   - Row `skipped` with `reason=unauthorized` → the user is
     not in `allowed_user_ids`; confirm IDs.
3. If the row is `enqueued`, check `jobs`:
   ```
   sqlite3 /var/lib/actwyn/db/actwyn.sqlite \
     "SELECT id,status,job_type,attempts,finished_at,error_json \
      FROM jobs ORDER BY created_at DESC LIMIT 10;"
   ```
4. If a `job_completed` notification is `pending`/`failed`,
   it's a Telegram outbound issue — see §7.5-ish
   (`notification_retry` loop is already running; confirm via
   logs).
5. If `provider_run` is `failed` with a parser error, inspect
   `provider_raw_events` by `provider_run_id` — the stream
   should still have `final_text` via fallback.

Close the loop: send a short human explanation to the user. If
the issue is structural, queue a bug in the repo with a
redacted excerpt.

## 6. `/doctor` response table

`/doctor` returns one line per check. Use this table when one
fails.

| Check                            | Likely cause                                             | Action                                                                     |
| -------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------- |
| `config_loaded`                  | Missing env key or placeholder value.                    | Edit `/etc/actwyn/env`; `systemctl restart actwyn.service`.                |
| `sqlite_open_wal`                | DB file owner/permission or WAL mode drifted.            | Verify ownership; `PRAGMA journal_mode=wal`; restart.                      |
| `migrations_applied`             | Code version mismatched with DB version.                 | Deploy the expected version or run the documented migration path.          |
| `telegram_api_reachable`         | DNS/network or expired bot token.                        | Curl `api.telegram.org`; rotate token if needed (§9).                      |
| `claude_binary_present`          | Path moved or binary uninstalled.                        | Install pinned Claude; update `config.json`.                               |
| `claude_version_pinned`          | Newer/older Claude than pinned.                          | Rerun SP-04..SP-06 against the new version; update the decision register; then deploy. |
| `s3_endpoint_smoke`              | Credentials or endpoint broken.                          | Rotate keys (§9) or verify endpoint; degraded mode policy in §7.           |
| `disk_free_ok`                   | Local disk pressure.                                     | Prune old transcripts/attachments per retention; escalate if S3 is down.   |
| `interrupted_jobs`               | Normal after a restart. Non-zero if many accumulate.     | Inspect with query in §5; re-queue or delete per policy.                   |
| `stale_pending_notifications`    | Telegram outage or stuck outbound loop.                  | Check `journalctl`; restart service.                                       |
| `stale_pending_storage_sync`     | S3 outage or credentials bad.                            | See §7.                                                                    |
| `orphan_processes`               | A prior subprocess survived teardown.                    | `kill -9 -<pgid>`; investigate; write incident note.                       |
| `redaction_boundary_quick`       | Redactor regression.                                     | Treat as Sev-A (§8).                                                       |

## 7. S3 degraded mode

Goal: the user keeps getting responses; only the archive layer
is affected (HLD §12.5, AC08, AC16).

Indicators:

- `/doctor` reports `s3_endpoint_smoke = fail`.
- `stale_pending_storage_sync` rises.
- User-visible impact is **zero** unless the issue extends to
  local disk (§7.3).

Procedure:

1. Confirm the failure class (transient / credential / endpoint)
   from `journalctl` and the `storage_objects.error_json`.
2. Short outage (< 30 min): do nothing; the sync loop will
   catch up. Note in the incident log.
3. Longer outage:
   - Verify credentials still valid against the Hetzner
     console.
   - If credentials rotated externally, see §9.
   - Check disk pressure: `df -h /var/lib/actwyn/data`.
4. Apply the **DEC-018 thresholds** (configurable in
   `config/storage.json`):
   - `artifact_dir > 1 GB` **or** `disk_free < 20%` →
     warning in `/status` / `/doctor`; `S3: degraded`.
   - `artifact_dir > 2 GB` **or** `disk_free < 15%` →
     degraded warning; `storage/sync` runs smaller backlog
     batches to reduce local-disk pressure.
   - `artifact_dir > 3 GB` **or** `disk_free < 10%` →
     the runtime refuses new `long_term` writes. New
     attachments still flow as `ephemeral` / `session` with
     a user-visible message explaining the degradation.
5. Resolution: once the endpoint is healthy again, the sync
   loop drains backlog on its normal cadence; record the
   event in the incident log.

Do **not**:

- Roll back `provider_run` succeeded status.
- Hand-delete `storage_objects` rows to clear the backlog.
- Bump retry budgets system-wide as a workaround — prefer
  targeted manual retries via `actwynctl` if available.

## 8. Redaction incident (Sev-A)

Trigger: a known secret pattern is found in a durable store
(SQLite row, local file, S3 object, systemd journal).

Order of operations — **do not skip**:

1. **Stop the service**: `systemctl stop actwyn.service`.
2. **Quarantine**: do not tail-log or `cat` the offending row;
   the goal is to avoid re-printing it. Note the rowid /
   filename only.
3. **Scope**:
   - Is the secret still valid? If yes, rotate immediately
     (§9) before anything else.
   - Which tables / files / S3 keys could contain it? Use
     `grep` against the redacted pattern variant, not the
     secret itself, to find affected rows.
4. **Remediation**:
   - SQLite: `UPDATE ... SET redacted_payload = ?` to a
     placeholder; log the rowid you touched.
   - Local files: write an all-placeholder replacement;
     truncate where the whole file was the leak.
   - S3: delete the affected objects; rely on soft-delete
     semantics plus an out-of-band `DELETE` to the bucket.
   - Journal: the systemd journal is append-only and
     compressed; rotate/expire it (`journalctl --rotate`,
     `--vacuum-time=1s`) if the leak is in recent logs and
     retention policy permits.
5. **Root cause**:
   - Identify the call site that missed redaction.
   - Add a failing test, then fix and re-run the redaction
     matrix.
   - Update HLD §13.1 / §13.2 if the pattern list expanded.
   - Record the incident in `docs/08_DECISION_REGISTER.md` with dates and
     actions.
6. **Restart** the service after the fix lands and `/doctor`
   `redaction_boundary_quick` is green.

## 9. Key rotation

Covers Telegram bot token and Hetzner S3 access/secret.

Procedure (Telegram token):

1. Revoke via `@BotFather` → create a new token.
2. Update `/etc/actwyn/env`
   (`TELEGRAM_BOT_TOKEN=...`), mode `0600`.
3. `systemctl restart actwyn.service`.
4. Run `/doctor` from Telegram; expect `telegram_api_reachable =
   ok`.
5. If the old token ever appeared in logs/DB, treat as Sev-A
   (§8).

Procedure (S3 access/secret):

1. Generate a new pair in the Hetzner console.
2. Update `/etc/actwyn/env`
   (`S3_ACCESS_KEY=...`, `S3_SECRET_KEY=...`).
3. `systemctl restart actwyn.service`.
4. Trigger `/doctor` → `s3_endpoint_smoke` passes.
5. Delete the old key pair from Hetzner.
6. Redaction sweep as in §8 if the old secret appeared in
   logs/DB.

Cadence: at least every 180 days for each secret, or
immediately on suspicion of compromise.

## 10. Backup and restore

Primary archive: S3 holds the durable artifacts that matter
(memory snapshots, transcripts, promoted attachments). PRD §12.7
treats a SQLite `.sqlite` S3 backup as optional in P0.

Recommended backup pattern (optional in P0, set up in Phase 11
deploy):

- Daily cron (under the service user) runs:
  1. `sqlite3 actwyn.sqlite ".backup /tmp/actwyn.bk"` — does
     not require quiescing WAL mode.
  2. Upload the `.bk` file to a dedicated
     `backups/yyyy/mm/dd/` prefix in the same bucket (or a
     separate bucket if configured).
  3. Delete local `.bk`.
- Retain ~30 dailies and a handful of monthlies (operator
  decides at deploy time).

Restore:

1. Stop service.
2. Move aside the current DB:
   `mv /var/lib/actwyn/db/actwyn.sqlite{,.before-restore}`.
3. Download the chosen backup, verify checksum, place at the
   DB path.
4. Start service; check `/doctor migrations_applied`.
5. Expect some `interrupted` jobs for the window between the
   backup point and the incident; review with §4.
6. Inform the user if any conversations could be affected.

## 11. Dependency upgrades

Triggers for documented re-runs (from
`docs/03_RISK_SPIKES.md` §Re-run triggers):

- Bun bump → rerun SP-01, SP-07; verify startup + recovery.
- Claude CLI bump → rerun SP-04, SP-05, SP-06; regenerate
  fixtures; expect HLD §8 updates.
- Hetzner Object Storage change → rerun SP-08.
- Telegram API policy change → rerun SP-02, SP-03.
- Kernel major bump → rerun SP-07.

Process:

1. On a staging host: install the new version, rerun the
   listed spikes, capture results in `spikes/<id>/results.md`
   with the new date.
2. Update HLD sections called out in each spike's "Fail
   response".
3. Record the dependency change in `docs/08_DECISION_REGISTER.md`.
4. Deploy to the production host per §2 (rollback path
   intact).

## 12. Bootstrap and `/whoami`

On first ever deploy the operator may need to learn the
Telegram `user_id` and `chat_id` for the authorized user.

Procedure:

1. Edit `/etc/actwyn/env`: set `BOOTSTRAP_WHOAMI=true`.
2. `systemctl restart actwyn.service`.
3. `/doctor` will now emit a warning saying the flag is on —
   this is intentional (Q11).
4. In Telegram DM: send `/whoami` from the user who will be
   authorized. Record the returned ids in
   `/etc/actwyn/config.json`.
5. Edit `/etc/actwyn/env`: set `BOOTSTRAP_WHOAMI=false`.
6. Restart; confirm `/doctor` warning clears.

If `BOOTSTRAP_WHOAMI` is left on for more than 30 minutes
without cause, treat it as a Sev-C operational issue — close
the hole.

## 13. Incident notes template

Copy into `docs/08_DECISION_REGISTER.md` when you handle something
non-trivial.

```
## Incident: <short title>
Date: <yyyy-mm-dd>
Severity: Sev-A | Sev-B | Sev-C
Impact: <what the user / operator saw>
Detection: <doctor / user report / log>
Timeline: <bullets>
Root cause: <what broke>
Mitigation: <what you did>
Follow-up: <what still needs to change; open a Q in 07>
```

Keep entries short and dated; this is an operator log, not a
postmortem artifact.

