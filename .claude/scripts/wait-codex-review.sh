#!/usr/bin/env bash
# Wait for codex review on the current PR.
#
# Polls three feedback sources (issue comments, review submissions including
# state-only APPROVED/CHANGES_REQUESTED, inline review comments) and a pass
# reaction on the PR. Exits as soon as the pass reaction (newer than baseline)
# is observed, or when any new feedback is present, or on timeout.
#
# Baseline = server-side push timestamp from the PR timeline (most accurate;
# falls back to HEAD commit committer.date if timeline lookup fails). Refreshed
# every cycle so a fresh push during polling advances baseline automatically.
# Clamped to <= now to defend against future-skewed commit dates.
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
#   CODEX_POLL_INTERVAL  seconds between polls (default 20)
#   CODEX_POLL_TIMEOUT   total wait limit in seconds (default 3600)
#   CODEX_BASELINE       ISO timestamp; activity at/before this is ignored.
#                        Default: latest push timestamp from PR timeline.
#   CODEX_REPO           owner/repo override (useful in fork workflows where
#                        local origin differs from PR base repo).
#   CODEX_PASS_ACTOR     exact GitHub login that signals pass via reaction
#                        (default: chatgpt-codex-connector[bot])
#   CODEX_PASS_REACTION  GitHub reaction content (default: +1, i.e. 👍)

set -euo pipefail

pr="${1:-$(gh pr view --json number -q .number 2>/dev/null || true)}"
if [ -z "$pr" ]; then
  echo "ERROR: pass PR number explicitly or run inside a branch with an open PR" >&2
  exit 3
fi

interval="${CODEX_POLL_INTERVAL:-20}"
timeout="${CODEX_POLL_TIMEOUT:-3600}"
pass_actor="${CODEX_PASS_ACTOR:-chatgpt-codex-connector[bot]}"
pass_reaction="${CODEX_PASS_REACTION:-+1}"

repo="${CODEX_REPO:-$(gh pr view "$pr" --json baseRepository \
  -q '.baseRepository | "\(.owner.login)/\(.name)"' 2>/dev/null || \
  gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)}"
if [ -z "$repo" ]; then
  echo "ERROR: could not determine repo for PR #$pr (set CODEX_REPO=owner/repo)" >&2
  exit 3
fi

# Fetch a paginated list endpoint and combine all pages into one flat JSON
# array on stdout. Returns 1 (with stderr WARN) on API failure so callers can
# retry on the next poll instead of crashing.
#
# `gh api --paginate` emits each page's array as a separate JSON value, so we
# collect them with `jq -s 'add // []'`. We deliberately do NOT pass `-q` to
# `gh api`, because `--paginate` + `--jq` cannot be combined with `--slurp`.
fetch_list() {
  local label="$1"; shift
  local raw
  if ! raw=$(gh api --paginate "$@" 2>&1); then
    echo "WARN: $label fetch failed (retrying next poll): $raw" >&2
    return 1
  fi
  printf '%s' "$raw" | jq -s 'add // []'
}

fetch_baseline() {
  local raw push_ts head_sha head_repo branch
  # 1) Most accurate: GitHub Events API PushEvent.created_at on the head ref
  branch=$(gh api "repos/$repo/pulls/$pr" -q .head.ref 2>/dev/null || true)
  head_repo=$(gh api "repos/$repo/pulls/$pr" -q '.head.repo.full_name // empty' 2>/dev/null || true)
  [ -z "$head_repo" ] && head_repo="$repo"
  if [ -n "$branch" ] && [ -n "$head_repo" ]; then
    if raw=$(gh api --paginate "repos/$head_repo/events" 2>/dev/null); then
      push_ts=$(printf '%s' "$raw" | jq -r -s --arg ref "refs/heads/$branch" '
        add // []
        | [.[] | select(.type == "PushEvent") | select(.payload.ref == $ref) | .created_at]
        | max // empty')
      if [ -n "$push_ts" ]; then
        echo "$push_ts"; return 0
      fi
    fi
  fi
  # 2) Timeline: max(committer.date for committed events, created_at for force-push)
  if raw=$(gh api --paginate "repos/$repo/issues/$pr/timeline" 2>/dev/null); then
    push_ts=$(printf '%s' "$raw" | jq -r -s '
      add // []
      | [.[] |
          if .event == "committed" then (.committer.date // .author.date // empty)
          elif .event == "head_ref_force_pushed" then .created_at
          else empty end ]
      | max // empty')
    if [ -n "$push_ts" ]; then
      echo "$push_ts"; return 0
    fi
  fi
  # 3) Fallback: HEAD commit committer.date
  head_sha=$(gh api "repos/$repo/pulls/$pr" -q .head.sha 2>/dev/null || true)
  [ -z "$head_sha" ] && return 1
  gh api "repos/$repo/commits/$head_sha" -q .commit.committer.date 2>/dev/null
}

clamp_to_now() {
  local ts="$1"
  local now_iso
  now_iso=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  if [[ "$ts" > "$now_iso" ]]; then
    echo "$now_iso"
  else
    echo "$ts"
  fi
}

echo "→ polling PR $repo#$pr (interval=${interval}s, timeout=${timeout}s, pass_actor=$pass_actor)" >&2

started=$(date +%s)
while :; do
  now=$(date +%s)
  if [ $((now - started)) -ge "$timeout" ]; then
    echo "TIMEOUT" >&2
    exit 2
  fi

  if [ -n "${CODEX_BASELINE:-}" ]; then
    baseline="$CODEX_BASELINE"
  else
    if ! baseline=$(fetch_baseline) || [ -z "$baseline" ]; then
      echo "WARN: could not fetch baseline; retrying next poll" >&2
      sleep "$interval"
      continue
    fi
  fi
  baseline=$(clamp_to_now "$baseline")

  # 1) Pass reaction wins (filter by baseline so old 👍 doesn't falsely pass)
  if reactions=$(fetch_list "reactions" "repos/$repo/issues/$pr/reactions"); then
    pass=$(printf '%s' "$reactions" | jq --arg actor "$pass_actor" --arg react "$pass_reaction" --arg base "$baseline" '
      [.[] | select(.user.login == $actor) | select(.content == $react) | select(.created_at > $base)] | length')
    if [ "$pass" != "0" ]; then
      echo "PASSED (reaction $pass_reaction from $pass_actor; baseline=$baseline)" >&2
      exit 0
    fi
  fi

  # 2) Gather all new feedback since baseline. Reviews are kept even with
  #    empty body so state-only APPROVED/CHANGES_REQUESTED counts as activity.
  if ic=$(fetch_list "issue_comments"  "repos/$repo/issues/$pr/comments") \
     && rv=$(fetch_list "reviews"         "repos/$repo/pulls/$pr/reviews") \
     && rc=$(fetch_list "review_comments" "repos/$repo/pulls/$pr/comments"); then
    new_items=$(jq -n --arg base "$baseline" \
      --argjson ic "$ic" --argjson rv "$rv" --argjson rc "$rc" '
      ($ic | [.[] | select(.created_at > $base) | {kind:"issue_comment", at:.created_at, login:.user.login, body:.body, state:""}])
      + ($rv | [.[] | select((.submitted_at // "") > $base) | {kind:"review", at:.submitted_at, login:.user.login, body:(.body // ""), state:(.state // "")}])
      + ($rc | [.[] | select(.created_at > $base) | {kind:"review_comment", at:.created_at, login:.user.login, path:.path, line:(.line // .original_line), body:.body, state:""}])
      | sort_by(.at)')

    count=$(printf '%s' "$new_items" | jq 'length')
    if [ "$count" != "0" ]; then
      echo "(baseline=$baseline)" >&2
      printf '%s' "$new_items" | jq -r '.[] |
        if .kind == "review_comment" then
          "=== [\(.kind)] \(.login) @ \(.at) — \(.path):\(.line) ===\n\(.body)\n"
        elif .kind == "review" then
          (if (.body | length) == 0 then
            "=== [review:\(.state)] \(.login) @ \(.at) ===\n(no body)\n"
          else
            "=== [review:\(.state)] \(.login) @ \(.at) ===\n\(.body)\n"
          end)
        else
          "=== [\(.kind)] \(.login) @ \(.at) ===\n\(.body)\n"
        end'
      exit 1
    fi
  fi

  sleep "$interval"
done
