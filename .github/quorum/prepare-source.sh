#!/usr/bin/env bash
# Materialise "upstream tag + our patches" into DEST. See .github/quorum/README.md.
# Usage: prepare-source.sh <upstream tag> <base commit> <dest dir>
# Run from the hivecommons/vexa checkout (HEAD = the commit whose patches we apply).
set -euo pipefail
TAG="$1"; BASE="$2"; DEST="$3"
: "${UPSTREAM_REPO:?}"

git remote add upstream "$UPSTREAM_REPO" 2>/dev/null || git remote set-url upstream "$UPSTREAM_REPO"
# The tag always comes from upstream, never from this fork.
git fetch --no-tags --quiet --force upstream "refs/tags/$TAG:refs/tags/$TAG"
git worktree add --detach "$DEST" "refs/tags/$TAG^{commit}"

PATCH_FILE="$(mktemp)"
git diff --binary "$BASE" HEAD -- . ':(exclude).github' > "$PATCH_FILE"
if [ -s "$PATCH_FILE" ]; then
  echo "applying hivecommons patch set ($(wc -l < "$PATCH_FILE") lines) onto $TAG"
  (cd "$DEST" && git apply --3way --index "$PATCH_FILE") \
    || { echo "::error ::hivecommons patches do not apply cleanly onto $TAG"; exit 1; }
else
  echo "no hivecommons patches beyond upstream; building $TAG as released"
fi
