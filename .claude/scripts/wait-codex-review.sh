#!/usr/bin/env bash
# Wait for codex review on the current PR.
#
# Polls three feedback sources (issue comments, review submissions with body,
# inline review comments) and a pass reaction on the PR. Exits as soon as the
# pass reaction (newer than baseline) is observed, or when any new feedback is
# present, or on timeout.
#
# Exit codes:
#   0 → configured actor added the pass reaction (newer than baseline)
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
#   CODEX_BASELINE       ISO timestamp; activity at/before this is ignored.
#                        Default: the moment this script starts (so anything
#                        posted after that wins). Override per push:
#                        `CODEX_BASELINE=<just-before-push-ts>`.
#   CODEX_PASS_ACTOR     exact GitHub login that signals pass via reaction
#                        (default: chatgpt-codex-connector[bot])
#   CODEX_PASS_REACTION  GitHub reaction content (default: +1, i.e. 👍)

set -euo pipefail

pr="${1:-$(gh pr view --json number -q .number 2>/dev/null || true)}"
if [ -z "$pr" ]; then
  echo "ERROR: pass PR number explicitly or run inside a branch with an open PR" >&2
  exit 3
fi

interval="${CODEX_POLL_INTERVAL:-30}"
timeout="${CODEX_POLL_TIMEOUT:-3600}"
pass_actor="${CODEX_PASS_ACTOR:-chatgpt-codex-connector[bot]}"
pass_reaction="${CODEX_PASS_REACTION:-+1}"
baseline="${CODEX_BASELINE:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"

repo=$(gh repo view --json nameWithOwner -q .nameWithOwner)

echo "→ polling PR $repo#$pr (interval=${interval}s, timeout=${timeout}s, baseline=$baseline, pass_actor=$pass_actor)" >&2

# Fetch a paginated list endpoint as a single JSON array.
# Echoes the JSON on success, prints WARN to stderr and returns 1 on failure
# (caller decides whether to retry in the next poll round).
fetch_list() {
  local label="$1"; shift
  local out
  if ! out=$(gh api --paginate --slurp "$@" 2>&1); then
    echo "WARN: $label fetch failed (retrying next poll): $out" >&2
    return 1
  fi
  printf '%s' "$out"
}

started=$(date +%s)
while :; do
  now=$(date +%s)
  if [ $((now - started)) -ge "$timeout" ]; then
    echo "TIMEOUT" >&2
    exit 2
  fi

  # 1) Pass reaction wins over a same-cycle comment. Filter by baseline so a
  #    👍 left in an earlier review cycle does not falsely pass after new push.
  if reactions=$(fetch_list "reactions" "repos/$repo/issues/$pr/reactions"); then
    pass=$(printf '%s' "$reactions" | jq --arg actor "$pass_actor" --arg react "$pass_reaction" --arg base "$baseline" '
      [.[][] | select(.user.login == $actor) | select(.content == $react) | select(.created_at > $base)] | length')
    if [ "$pass" != "0" ]; then
      echo "PASSED (reaction $pass_reaction from $pass_actor)" >&2
      exit 0
    fi
  fi

  # 2) Gather any new feedback since baseline from all three sources.
  if ic=$(fetch_list "issue_comments" "repos/$repo/issues/$pr/comments") \
     && rv=$(fetch_list "reviews"        "repos/$repo/pulls/$pr/reviews") \
     && rc=$(fetch_list "review_comments" "repos/$repo/pulls/$pr/comments"); then
    new_items=$(jq -n --arg base "$baseline" \
      --argjson ic "$ic" --argjson rv "$rv" --argjson rc "$rc" '
      ($ic | [.[][] | select(.created_at > $base) | {kind:"issue_comment", at:.created_at, login:.user.login, body:.body}])
      + ($rv | [.[][] | select((.submitted_at // "") > $base) | select((.body // "") != "") | {kind:"review", at:.submitted_at, login:.user.login, body:.body}])
      + ($rc | [.[][] | select(.created_at > $base) | {kind:"review_comment", at:.created_at, login:.user.login, path:.path, line:(.line // .original_line), body:.body}])
      | sort_by(.at)')

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
  fi

  sleep "$interval"
done
