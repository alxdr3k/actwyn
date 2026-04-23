# systemd deploy

This directory contains the pieces needed to run Personal Agent P0
under systemd on a single Linux host (Hetzner CX22 or equivalent).

## Files

- `actwyn.service` — the unit file.
- `../install.sh` — idempotent installer (creates service user,
  dirs, env file placeholder, installs the unit file, reloads
  systemd). Run as root.

## Install (one-time)

```
sudo ./deploy/install.sh
```

Then:

1. Edit `/etc/actwyn/env` and populate the secrets
   (`TELEGRAM_BOT_TOKEN`, `S3_*`, `AUTHORIZED_TELEGRAM_USER_ID`).
   File must remain mode `0640 root:actwyn`.
2. Rsync the application to `/opt/actwyn` (including
   `bun.lock`, `config/runtime.json`, `migrations/*.sql`,
   `src/*`, `scripts/check-single-redactor.ts`).
3. As root: `systemctl enable --now actwyn.service`.
4. Tail logs: `journalctl -u actwyn -f`.

## Invariants encoded by the unit

- `KillMode=control-group` — stray Claude subprocesses do not
  survive a service restart (HLD §14.3 last line of defence).
- `Type=simple` + `Restart=on-failure` + `RestartSec=5` —
  transient crashes auto-recover. Restart-recovery Telegram
  messages (PRD §8.4) are emitted by the app on next boot.
- `EnvironmentFile=/etc/actwyn/env` — secrets never appear in
  `systemctl show` or the unit file.
- Hardening directives (`NoNewPrivileges`, `ProtectSystem=strict`,
  etc.) bound blast radius if the process is exploited.

## Uninstall

```
sudo systemctl disable --now actwyn.service
sudo rm /etc/systemd/system/actwyn.service
sudo systemctl daemon-reload
# (optional) sudo userdel actwyn
# (optional) sudo rm -rf /opt/actwyn /var/lib/actwyn /etc/actwyn
```
