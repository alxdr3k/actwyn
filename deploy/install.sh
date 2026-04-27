#!/usr/bin/env bash
# Personal Agent P0 — idempotent installer for the systemd unit.
#
# Creates (if missing) the service user, the deploy directory,
# the SQLite data directory, and copies the unit file into place.
# Does NOT start the service — the operator must first populate
# /etc/actwyn/env with real secrets (see deploy/systemd/README.md).
#
# Re-running the script is safe: all mkdir/useradd/cp operations
# are idempotent, and systemd just reloads on the daemon-reload.

set -euo pipefail

SERVICE_USER="actwyn"
DEPLOY_DIR="/opt/actwyn"
STATE_DIR="/var/lib/actwyn"
ENV_DIR="/etc/actwyn"
UNIT_SRC="$(dirname "$(readlink -f "$0")")/systemd/actwyn.service"
UNIT_DST="/etc/systemd/system/actwyn.service"

if [[ $EUID -ne 0 ]]; then
  echo "install.sh must be run as root" >&2
  exit 1
fi

# 1. Service user + group (no login shell; no home dir).
if ! id "$SERVICE_USER" &>/dev/null; then
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi

# 2. Directories.
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$DEPLOY_DIR"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$STATE_DIR"
install -d -o root -g "$SERVICE_USER" -m 0750 "$ENV_DIR"

# 3. Placeholder env file. Operator must chmod 0640 and fill in.
if [[ ! -f "$ENV_DIR/env" ]]; then
  umask 0077
  cat >"$ENV_DIR/env" <<'EOF'
# Personal Agent P0 — systemd EnvironmentFile.
# See .env.example at the repo root for the full surface.
# THIS FILE MUST BE CHMOD 0640 root:actwyn.
TELEGRAM_BOT_TOKEN=
AUTHORIZED_TELEGRAM_USER_ID=
S3_ENDPOINT=
S3_BUCKET=
S3_REGION=
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
NODE_ENV=production
ACTWYN_CONFIG_PATH=/opt/actwyn/config/runtime.json
EOF
  chown root:"$SERVICE_USER" "$ENV_DIR/env"
  chmod 0640 "$ENV_DIR/env"
  echo "created $ENV_DIR/env (placeholder) — populate before starting" >&2
fi

# 4. Unit file.
install -o root -g root -m 0644 "$UNIT_SRC" "$UNIT_DST"

# 5. Reload systemd so it picks up the unit.
systemctl daemon-reload

echo "install complete."
echo "next steps:"
echo "  1. edit $ENV_DIR/env and populate the secrets"
echo "  2. deploy application code to $DEPLOY_DIR (via rsync or your CD)"
echo "  3. systemctl enable --now actwyn.service"
echo "  4. journalctl -u actwyn -f  # tail the logs"
