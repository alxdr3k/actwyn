#!/usr/bin/env bash
# Verify that helper direct-push repo policy matches direct-push-repos.txt.

set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
source_file="$repo_root/direct-push-repos.txt"
helper="$repo_root/scripts/dev-cycle-helper.sh"

expected_list() {
  sed 's/^[[:space:]]*//; s/[[:space:]]*$//; /^[[:space:]]*$/d; /^#/d' "$source_file" | sort
}

expected="$(expected_list | paste -sd '|' -)"
actual="$("$helper" direct-push-list | sort | paste -sd '|' -)"

if [[ -z "$expected" ]]; then
  echo "direct-push-repos.txt is empty" >&2
  exit 1
fi

if [[ "$actual" != "$expected" ]]; then
  echo "direct-push list drift in scripts/dev-cycle-helper.sh" >&2
  echo "expected: $expected" >&2
  echo "actual:   $actual" >&2
  exit 1
fi
