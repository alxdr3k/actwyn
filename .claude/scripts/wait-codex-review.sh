#!/usr/bin/env bash
# Wait for codex review on the current PR.
#
# Polls three feedback sources (issue comments, review submissions with body,
# inline review comments) and exits when any new activity appears or when the
# configured actor adds the pass reaction on the PR itself.
#
# Exit codes:
#   0 → pass reaction (e.g. 👍) is present on the PR from the configured actor
#   1 → at least one new comment/review since baseline (all printed to stdout)
#   2 → timeout reached
#   3 → PR could not be detected
#
# Usage:
#   wait-codex-review.sh [PR_NUMBER]
#
# Env:
#   CODEX_POLL_INTERVAL  seconds between polls (default 30)
#   CODEX_POLL_TIMEOUT   total wait limit in seconds (default 3600)
#   CODEX_BASELINE       ISO timestamp; activity at/before this is ignored
#                        (default: latest existing activity, or now if none)
#   CODEX_PASS_ACTOR     bot login prefix that signals pass via reaction
#                        (default: chatgpt-codex-connector)
#   CODEX_PASS_REACTION  GitHub reaction content (default: +1, i.e. 👍)

set -euo pipefail

pr="${1:-$(gh pr view --json number -q .number 2>/dev/null || true)}"
if [ -z "$pr" ]; then
  echo "ERROR: pass PR number explicitly or run inside a branch with an open PR" >&2
  exit 3
fi

interval="${CODEX_POLL_INTERVAL:-30}"
timeout="${CODEX_POLL_TIMEOUT:-3600}"
pass_actor="${CODEX_PASS_ACTOR:-chatgpt-codex-connector}"
pass_reaction="${CODEX_PASS_REACTION:-+1}"

repo=$(gh repo view --json nameWithOwner -q .nameWithOwner)

fetch_max_ts() {
  {
    gh api "repos/$repo/issues/$pr/comments" -q '.[].created_at' 2>/dev/null || true
    gh api "repos/$repo/pulls/$pr/reviews"   -q '.[].submitted_at // empty' 2>/dev/null || true
    gh api "repos/$repo/pulls/$pr/comments"  -q '.[].created_at' 2>/dev/null || true
  } | sort -r | head -n 1
}

if [ -n "${CODEX_BASELINE:-}" ]; then
  baseline="$CODEX_BASELINE"
else
  baseline=$(fetch_max_ts)
  [ -z "$baseline" ] && baseline=$(date -u +%Y-%m-%dT%H:%M:%SZ)
fi

echo "→ polling PR $repo#$pr (interval=${interval}s, timeout=${timeout}s, baseline=$baseline)" >&2

started=$(date +%s)
while :; do
  now=$(date +%s)
  if [ $((now - started)) -ge "$timeout" ]; then
    echo "TIMEOUT" >&2
    exit 2
  fi

  new_items=$(
    {
      gh api "repos/$repo/issues/$pr/comments" \
        -q ".[] | select(.created_at > \"$baseline\") | {kind:\"issue_comment\", at:.created_at, login:.user.login, body:.body}" 2>/dev/null || true
      gh api "repos/$repo/pulls/$pr/reviews" \
        -q ".[] | select((.submitted_at // \"\") > \"$baseline\") | select((.body // \"\") != \"\") | {kind:\"review\", at:.submitted_at, login:.user.login, body:.body}" 2>/dev/null || true
      gh api "repos/$repo/pulls/$pr/comments" \
        -q ".[] | select(.created_at > \"$baseline\") | {kind:\"review_comment\", at:.created_at, login:.user.login, path:.path, line:(.line // .original_line), body:.body}" 2>/dev/null || true
    } | jq -s 'sort_by(.at)'
  )

  count=$(printf '%s' "$new_items" | jq 'length')
  if [ "$count" != "0" ]; then
    printf '%s' "$new_items" | jq -r '.[] |
      if .kind == "review_comment" then
        "=== [\(.kind)] \(.login) @ \(.at) — \(.path):\(.line) ===\n\(.body)\n"
      else
        "=== [\(.kind)] \(.login) @ \(.at) ===\n\(.body)\n"
      end'
    exit 1
  fi

  pass=$(gh api "repos/$repo/issues/$pr/reactions" \
    -q "[.[] | select(.user.login | startswith(\"$pass_actor\")) | select(.content == \"$pass_reaction\")] | length" 2>/dev/null || echo 0)
  if [ "${pass:-0}" != "0" ]; then
    echo "PASSED (reaction $pass_reaction from $pass_actor)" >&2
    exit 0
  fi

  sleep "$interval"
done
