#!/usr/bin/env bash
# Wait for codex review on the current PR.
#
# Exit codes:
#   0 → PR body contains the pass emoji (review passed; loop should stop)
#   1 → a new PR comment was posted (body printed to stdout; act on it)
#   2 → timeout reached
#   3 → PR could not be detected
#
# Usage:
#   wait-codex-review.sh [PR_NUMBER]
#
# Env:
#   CODEX_POLL_INTERVAL  seconds between polls (default 30)
#   CODEX_POLL_TIMEOUT   total wait limit in seconds (default 3600)
#   CODEX_PASS_EMOJI     emoji that signals "review passed" (default 👍)
#   CODEX_BASELINE       ISO timestamp; comments at/before this are ignored
#                        (default: latest existing comment, or now if none)

set -euo pipefail

pr="${1:-$(gh pr view --json number -q .number 2>/dev/null || true)}"
if [ -z "$pr" ]; then
  echo "ERROR: pass PR number explicitly or run inside a branch with an open PR" >&2
  exit 3
fi

interval="${CODEX_POLL_INTERVAL:-30}"
timeout="${CODEX_POLL_TIMEOUT:-3600}"
pass_emoji="${CODEX_PASS_EMOJI:-👍}"

if [ -n "${CODEX_BASELINE:-}" ]; then
  baseline="$CODEX_BASELINE"
else
  baseline=$(gh pr view "$pr" --json comments -q '[.comments[].createdAt] | max // empty')
  [ -z "$baseline" ] && baseline=$(date -u +%Y-%m-%dT%H:%M:%SZ)
fi

echo "→ polling PR #$pr (interval=${interval}s, timeout=${timeout}s, baseline=$baseline)" >&2

started=$(date +%s)
while :; do
  now=$(date +%s)
  if [ $((now - started)) -ge "$timeout" ]; then
    echo "TIMEOUT" >&2
    exit 2
  fi

  body=$(gh pr view "$pr" --json body -q .body)
  if printf '%s' "$body" | grep -qF "$pass_emoji"; then
    echo "PASSED" >&2
    exit 0
  fi

  comment=$(gh pr view "$pr" --json comments \
    -q "[.comments[] | select(.createdAt > \"$baseline\")] | last")
  if [ -n "$comment" ] && [ "$comment" != "null" ]; then
    printf '%s' "$comment" | jq -r '"=== \(.author.login) @ \(.createdAt) ===\n\(.body)"'
    exit 1
  fi

  sleep "$interval"
done
