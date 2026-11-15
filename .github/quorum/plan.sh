#!/usr/bin/env bash
# Resolve what quorum-images.yml builds. See .github/quorum/README.md.
#
# Inputs (env):
#   REF_INPUT     upstream release tag (e.g. v0.12.28) or "latest" (latest upstream release)
#   FORCE         "true" to rebuild even when the patch-set tag already exists
#   IMAGE_NS      e.g. ghcr.io/hivecommons
#   IMAGES        space-separated image names
#   UPSTREAM_REPO upstream git URL
#   UPSTREAM_API  upstream GitHub API repo path, e.g. repos/Vexa-ai/vexa
#   GH_TOKEN      token for the GitHub API (read-only use)
# Outputs (appended to $GITHUB_OUTPUT): tag base phash short rev version skip
set -euo pipefail

: "${REF_INPUT:=latest}"
: "${FORCE:=false}"
# Upper bound on -quorum.N probing; a tag needing more revisions than this is a mistake.
MAX_REVISIONS=200
TAG_PATTERN='^v[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$'

if [ "$REF_INPUT" = "latest" ]; then
  TAG="$(gh api "$UPSTREAM_API/releases/latest" -q .tag_name)"
else
  TAG="$REF_INPUT"
fi
if ! [[ "$TAG" =~ $TAG_PATTERN ]]; then
  echo "::error ::'$TAG' is not an upstream release tag (expected vX.Y.Z)"; exit 1
fi

git remote add upstream "$UPSTREAM_REPO" 2>/dev/null || git remote set-url upstream "$UPSTREAM_REPO"
git fetch --no-tags --quiet upstream main
git fetch --no-tags --quiet --force upstream "refs/tags/$TAG:refs/tags/$TAG"

BASE="$(git merge-base upstream/main HEAD)"
PATCH_FILE="$(mktemp)"
git diff --binary "$BASE" HEAD -- . ':(exclude).github' > "$PATCH_FILE"
PHASH="$(sha256sum "$PATCH_FILE" | cut -c1-12)"
SHORT="$(git rev-parse --short=7 HEAD)"
echo "tag=$TAG base=$BASE patch-lines=$(wc -l < "$PATCH_FILE") phash=$PHASH head=$SHORT"
git diff --stat "$BASE" HEAD -- . ':(exclude).github' | tail -20

exists() { docker buildx imagetools inspect "$1" >/dev/null 2>&1; }

SKIP=false
if [ "$FORCE" != "true" ]; then
  all_present=true
  for img in $IMAGES; do
    exists "$IMAGE_NS/$img:$TAG-patch-$PHASH" || { all_present=false; break; }
  done
  if [ "$all_present" = true ]; then
    SKIP=true
    echo "::notice ::$TAG with patch set $PHASH is already published; skipping (dispatch with force=true to rebuild)"
  fi
fi

# Next free -quorum.N, probed on the bot image (all images are published together).
REV=1
while exists "$IMAGE_NS/vexa-bot:$TAG-quorum.$REV"; do
  REV=$((REV + 1))
  [ "$REV" -le "$MAX_REVISIONS" ] || { echo "::error ::too many revisions for $TAG"; exit 1; }
done
# On a skip, report the revision that is already published.
if [ "$SKIP" = true ] && [ "$REV" -gt 1 ]; then REV=$((REV - 1)); fi

{
  echo "tag=$TAG"
  echo "base=$BASE"
  echo "phash=$PHASH"
  echo "short=$SHORT"
  echo "rev=$REV"
  echo "version=$TAG-quorum.$REV"
  echo "skip=$SKIP"
} >> "$GITHUB_OUTPUT"
