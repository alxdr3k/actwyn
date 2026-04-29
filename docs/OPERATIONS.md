# Operations

> Status: thin current-state map · Owner: project lead ·
> Last updated: 2026-04-29
>
> This file is an index, not an implementation log. Replace
> current-state summaries; do not append phase history.
>
> This file covers only what is verifiable from `src/`,
> `config/`, `deploy/`, and `.env.example`. Anything not listed
> here is `TODO` or `needs audit`; do not invent operational
> procedures.

## Environment variables

Source: `.env.example`, `src/config.ts`, `src/main.ts`.

### Required at boot

| Variable                       | Purpose                                                           |
| ------------------------------ | ----------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`           | Telegram Bot API auth.                                            |
| `AUTHORIZED_TELEGRAM_USER_ID`  | The single authorized Telegram user (positive integer).           |
| `S3_ENDPOINT`                  | S3-compatible endpoint (Hetzner Object Storage in prod).          |
| `S3_BUCKET`                    | S3 bucket name.                                                   |
| `S3_REGION`                    | S3 region.                                                        |
| `S3_ACCESS_KEY_ID`             | S3 access key.                                                    |
| `S3_SECRET_ACCESS_KEY`         | S3 secret key.                                                    |

`loadConfig()` throws `ConfigError` and the process exits 1 if any
of these are missing or empty.

### Optional

| Variable                    | Default                                  | Purpose                                                                |
| --------------------------- | ---------------------------------------- | ---------------------------------------------------------------------- |
| `NODE_ENV`                  | `development`                            | One of `development | production | test`.                              |
| `ACTWYN_CONFIG_PATH`        | `config/runtime.json`                    | Path to the runtime tunables file.                                     |
| `ACTWYN_DB_PATH`            | `/var/lib/actwyn/actwyn.db`              | SQLite database file path.                                             |
| `ACTWYN_MIGRATIONS_PATH`    | `/opt/actwyn/migrations`                 | Migration directory path.                                              |
| `ACTWYN_OBJECTS_PATH`       | `/var/lib/actwyn/objects`                | Local FS root for captured attachment bytes.                           |
| `ACTWYN_MEMORY_PATH`        | `/var/lib/actwyn/memory`                 | Local FS root for memory snapshots and transcripts.                    |
| `BOOTSTRAP_WHOAMI`          | unset                                    | When `true`, allows `/whoami` to respond once for an unauthorized user (DEC-009). 30-minute auto-expiry recorded in `settings`. |

**Log level is not an env var.** `loadConfig()` in `src/config.ts`
does not read `LOG_LEVEL`. To change log level, edit
`config/runtime.json#log.level` (one of `debug | info | warn | error`).
Earlier versions of `.env.example` and `deploy/install.sh` carried a
`LOG_LEVEL=` placeholder that was silently ignored; that placeholder
has been removed.

Variables whose names end in `TOKEN` / `SECRET` / `KEY` /
`PASSWORD` are routed through the redactor's `exact_values` set so
their literal contents never appear in logs or persisted rows.

## Local run

### With Doppler (recommended)

`doppler.yaml` pins project `actwyn` / config `dev`.  Once Doppler is
configured with the required secrets, a single command starts the service:

```sh
bun install
bun run dev          # runs: doppler run -- bun run src/main.ts
```

Doppler injects all required env vars (including `ACTWYN_DB_PATH`,
`ACTWYN_MIGRATIONS_PATH`, `ACTWYN_OBJECTS_PATH`, `ACTWYN_MEMORY_PATH`,
and `AUTHORIZED_TELEGRAM_USER_ID`) from the `dev` config.

### Without Doppler (fallback)

Set env vars manually and start the service:

```sh
bun install
cp .env.example .env
# edit .env to fill in real secrets and AUTHORIZED_TELEGRAM_USER_ID
mkdir -p ./.local/objects ./.local/memory
ACTWYN_DB_PATH=./.local/actwyn.db \
ACTWYN_MIGRATIONS_PATH=./migrations \
ACTWYN_OBJECTS_PATH=./.local/objects \
ACTWYN_MEMORY_PATH=./.local/memory \
bun run src/main.ts
```

Notes:

- The process expects to be a singleton against its DB; do not run
  two copies against the same `ACTWYN_DB_PATH`.
- Without a real `TELEGRAM_BOT_TOKEN` and `AUTHORIZED_TELEGRAM_USER_ID`,
  the long-poll loop will run but cannot deliver to a real chat.
- For test runs without external dependencies, prefer `bun test` —
  see `docs/TESTING.md`.

## Schema upgrade notes

**Schema 6 (migration 006):** The boot sequence checks for running **or** queued
`provider_run` jobs before applying migration 006; if any exist, the process exits with
an error.

**Upgrade during a quiet window** (no active or pending messages):

1. Wait until the Telegram conversation is idle — no message in flight, queue empty.
   Verify:
   ```sh
   sqlite3 $ACTWYN_DB_PATH \
     "SELECT id, status FROM jobs WHERE job_type='provider_run' AND status IN ('running','queued');"
   ```
2. Stop, deploy, and restart:
   ```sh
   systemctl stop actwyn   # terminates poller + worker
   # deploy new build
   systemctl start actwyn  # migration 006 applies; service resumes
   ```

**If the guard fires** (e.g. crash left a stale `running` row):
Startup recovery runs after the guard, so a `running` row from a crash cannot be
auto-resolved before the guard fires. In that case, deploy the old build first
(to let recovery and the worker drain the queue), verify the queue is empty, then
re-deploy the schema-6 build during a quiet window.

Do not issue raw SQL `UPDATE jobs SET status=...` — this bypasses recovery accounting
(`provider_runs`, `finished_at`, `error_json`, user notifications, orphan process groups).

## Production deploy (systemd)

Source: `deploy/install.sh`, `deploy/systemd/actwyn.service`,
`deploy/systemd/README.md`.

One-time install on the host (root):

```sh
sudo ./deploy/install.sh
```

This creates the `actwyn` service user, the dirs `/opt/actwyn`,
`/var/lib/actwyn`, `/etc/actwyn`, places a placeholder
`/etc/actwyn/env`, and installs the unit file.

After install:

1. Edit `/etc/actwyn/env` and populate the secrets. File mode must
   remain `0640 root:actwyn`.
2. Rsync the application to `/opt/actwyn`. Required at runtime:
   - `package.json` and `bun.lock` (Bun engine pin + module
     resolution metadata).
   - `tsconfig.json` — defines the `~/*` → `src/*` path alias used
     throughout `src/main.ts` and its imports. **Without it, Bun
     fails module resolution at boot.**
   - `config/runtime.json` (loaded by `src/config.ts`).
   - `migrations/*.sql` (consumed by `src/db/migrator.ts` against
     `ACTWYN_MIGRATIONS_PATH`, defaulting to `/opt/actwyn/migrations`).
   - `src/*` (the application).
   - `scripts/check-single-redactor.ts` and `scripts/check-thin-docs.ts`
     (used by local validation; listed in the existing
     `deploy/systemd/README.md`).
3. As root: `systemctl enable --now actwyn.service`.
4. Tail logs: `journalctl -u actwyn -f`.

Operational invariants encoded in the unit:

- `Type=simple` — Bun runs in the foreground.
- `KillMode=control-group` — stray Claude subprocesses do not
  survive a service restart (HLD §14.3 last-resort safety net).
- `Restart=on-failure` + `RestartSec=5` — transient crashes
  auto-recover.
- `EnvironmentFile=/etc/actwyn/env` — secrets never appear in
  `systemctl show` output or unit-file diffs.
- Hardening: `NoNewPrivileges`, `ProtectSystem=strict`,
  `ProtectHome=yes`, `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`,
  etc. — bound blast radius if the process is exploited.

### CD / release pipeline

No active CD workflow deploys Actwyn. Deployment is manual systemd operation: `deploy/install.sh`, `deploy/systemd/actwyn.service`, host sync, and `systemctl`.
Release source is direct `main` during `docs/policies/TEMP_MAIN_PUSH.md`;
identify artifacts by commit SHA and smoke with `/doctor` plus `journalctl -u actwyn`. If Actions or another CD system
starts owning deploys, update this section, `docs/11_CI_CD.md`, and runbook.

## Database

- Engine: SQLite (WAL mode), single file under `ACTWYN_DB_PATH`.
- Pragmas applied by `src/db.ts` at open time
  (WAL, busy_timeout, FK enforcement).
- Migration runner: `src/db/migrator.ts`, forward-only, refuses
  gaps. Applied versions recorded in `settings.schema.migrations.<NNN>`.
- WAL-safe local snapshot:
  ```sh
  bun run scripts/backup-sqlite.ts \
    --db "$ACTWYN_DB_PATH" \
    --out "./backups/actwyn-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
  ```
  The script opens the source with `query_only`, uses `bun:sqlite`
  `serialize()` (SQLite `sqlite3_serialize`) instead of copying the
  live DB file, normalizes the snapshot to a standalone rollback-journal
  file, writes with mode `0600`, refuses overwrite unless `--force` is
  supplied, and verifies the result with `PRAGMA integrity_check`.

Inspecting the live DB:

```sh
sqlite3 /var/lib/actwyn/actwyn.db "SELECT status, COUNT(*) FROM jobs GROUP BY status;"
```

## Logs / observability

- All structured events go to stderr as one JSON line per event
  via `src/observability/events.ts`.
- Boot crashes log a `boot.crash` JSON line and exit 1.
- `/doctor` is the typed system smoke test (DEC-017). Runs at boot
  with quick checks; full deep checks are on-demand via the
  `/doctor` Telegram command.
- No external observability stack (Langfuse, Loki, Grafana) wired
  in P0; operator-side observability is `journalctl` plus the DB
  ledgers.

## Storage

- Local: `ACTWYN_OBJECTS_PATH` (default `/var/lib/actwyn/objects`)
  for captured attachment bytes; `ACTWYN_MEMORY_PATH`
  (default `/var/lib/actwyn/memory`) for memory snapshots and
  transcripts.
- Remote: Hetzner Object Storage via `BunS3Transport`
  (`src/storage/s3.ts`). Async-sync only; failures never roll back
  a job (AC-STO-002).
- `/doctor` runs `s3.ping()` against the configured bucket on demand.

### Disk / artifact capacity

`src/storage/capacity.ts` checks `ACTWYN_OBJECTS_PATH` and filesystem
free space using `config/runtime.json#storage_capacity` (DEC-018):

- warn: artifact bytes > 1 GB or free disk < 20%
- degraded: artifact bytes > 2 GB or free disk < 15%; `storage_sync`
  upload batches are reduced
- critical: artifact bytes > 3 GB or free disk < 10%; new `long_term`
  writes are blocked

`/status` and `/doctor` surface the current level. When the critical
threshold is active, `/save_last_attachment` refuses promotion,
save-intent attachment captions remain `session` retention with an
instant Telegram explanation, and memory snapshot S3 staging is skipped.

## Provider configuration

- The only enabled provider in P0 is `claude` (ADR-0005). The fake
  provider is for tests only.
- Claude binary path is set in `config/runtime.json#claude_binary`
  (default `claude`).
- Two adapter profiles are wired in `src/main.ts`:
  full (default) and `advisory` (used for `summary_generation`,
  with `--tools ""` and `dontAsk` permission mode per AC-PROV-014).
- Required Bun version comes from
  `config/runtime.json#required_bun_version`; `/doctor` flags
  mismatches.

## Troubleshooting

- **Boot fails with `ConfigError: missing required env vars`** —
  populate `/etc/actwyn/env` (or `.env` in dev) and ensure file
  mode is `0640 root:actwyn` on prod.
- **`/doctor` flags `BOOTSTRAP_WHOAMI` warning** — disable
  `BOOTSTRAP_WHOAMI` in production; the 30-minute auto-expiry
  (DEC-009) records the boot moment in `settings.bootstrap_whoami.expires_at`.
- **Jobs stuck in `running` after restart** — usually transient.
  `runStartupRecovery` reconciles them on next boot
  (`boot.recovery` event reports counts). If a job repeatedly
  reaches `interrupted` without progress, inspect `provider_runs`
  and the matching `provider_raw_events`.
- **S3 ping fails in `/doctor`** — verify `S3_ENDPOINT`,
  `S3_REGION`, and bucket policy. The runtime keeps working;
  uploads will retry per `storage_sync` schedule.
- **Telegram notification stuck in `pending`** — check
  `outbound_notification_chunks.status`; the worker dispatches a
  `notification_retry` job that picks up `pending` / `failed`
  chunks. `sent` chunks are never re-sent.
- **Schema-version mismatch warning in `/doctor`** — bump
  `expected_schema_version` in `src/main.ts` together with the new
  migration, then redeploy.

For anything else — including alerting thresholds, scheduled backup
automation, and broader DR procedures — `TODO`. Do not invent runbook
entries; promote a `TODO` here once an owner agrees.
