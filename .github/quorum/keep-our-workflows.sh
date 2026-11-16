#!/usr/bin/env bash
# Sourced by upstream-sync.sh (and its test). Keeps .github/workflows/ exactly as on our main.

# keep_our_workflows <our commit>: set .github/workflows/ in the index and work tree to exactly
# its content at <our commit>. Drops files upstream added, reverts upstream edits, and resolves
# conflicts there (including modify/delete on a file we deleted: it stays deleted).
keep_our_workflows() {
  local ours="$1" dir=".github/workflows"
  git rm -r -q -f --ignore-unmatch -- "$dir" >/dev/null
  rm -rf -- "$dir"
  if git cat-file -e "$ours:$dir" 2>/dev/null; then
    git checkout "$ours" -- "$dir"
  fi
}

# assert_workflows_unchanged <our commit> <commit>: fail unless <commit> has the same
# .github/workflows/ tree as <our commit>.
assert_workflows_unchanged() {
  local changed
  changed="$(git diff --name-only "$1" "$2" -- .github/workflows)"
  if [ -n "$changed" ]; then
    echo "::error ::$2 changes workflow files vs $1: $changed" >&2
    return 1
  fi
}
