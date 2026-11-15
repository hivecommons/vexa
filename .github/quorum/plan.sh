#!/usr/bin/env bash
# Resolve what quorum-images.yml builds. See .github/quorum/README.md.
#
# Inputs (env):
#   SOURCE        "release" (upstream release tag + our patches) or "main" (a commit of THIS fork)
#   REF_INPUT     release: upstream release tag (e.g. v0.12.28) or "latest"
#                 main:    a branch of this fork or a commit SHA (default "main")
#   IMAGE_SET     release only: "bot" (vexa-meet-join-env, vexa-bot, vexa-transcription-cpu)
#                 or "all" (those plus every control-plane image). main always builds "all".
#   FORCE         "true" to rebuild even when the idempotency tag already exists
#   IMAGE_NS      e.g. ghcr.io/hivecommons
#   CATALOG       path to .github/quorum/images.json
#   UPSTREAM_REPO upstream git URL
#   UPSTREAM_API  upstream GitHub API repo path, e.g. repos/Vexa-ai/vexa
#   GH_TOKEN      token for the GitHub API (read-only use)
# Outputs (appended to $GITHUB_OUTPUT):
#   source tag base sha phash short rev version tags skip matrix repositories
#   `tags` is the space-separated tag list every image gets; `version` is the first (pin) tag.
set -euo pipefail

: "${SOURCE:=release}"
: "${FORCE:=false}"
: "${IMAGE_SET:=bot}"
: "${CATALOG:=.github/quorum/images.json}"
# Upper bound on -quorum.N probing; a tag needing more revisions than this is a mistake.
MAX_REVISIONS=200
SHORT_LEN=7
TAG_PATTERN='^v[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$'
REF_PATTERN='^[0-9A-Za-z._/-]+$'

exists() { docker buildx imagetools inspect "$1" >/dev/null 2>&1; }

git remote add upstream "$UPSTREAM_REPO" 2>/dev/null || git remote set-url upstream "$UPSTREAM_REPO"
git fetch --no-tags --quiet upstream main

case "$SOURCE" in
  release)
    : "${REF_INPUT:=latest}"
    if [ "$REF_INPUT" = "latest" ]; then
      TAG="$(gh api "$UPSTREAM_API/releases/latest" -q .tag_name)"
    else
      TAG="$REF_INPUT"
    fi
    [[ "$TAG" =~ $TAG_PATTERN ]] || { echo "::error ::'$TAG' is not an upstream release tag (expected vX.Y.Z)"; exit 1; }
    git fetch --no-tags --quiet --force upstream "refs/tags/$TAG:refs/tags/$TAG"
    SHA="$(git rev-parse HEAD)"
    BASE="$(git merge-base upstream/main "$SHA")"
    PATCH_FILE="$(mktemp)"
    git diff --binary "$BASE" "$SHA" -- . ':(exclude).github' > "$PATCH_FILE"
    PHASH="$(sha256sum "$PATCH_FILE" | cut -c1-12)"
    SHORT="$(git rev-parse --short="$SHORT_LEN" "$SHA")"
    echo "release: tag=$TAG base=$BASE patch-lines=$(wc -l < "$PATCH_FILE") phash=$PHASH head=$SHORT"
    git diff --stat "$BASE" "$SHA" -- . ':(exclude).github' | tail -20
    case "$IMAGE_SET" in
      bot) SETS='["bot"]' ;;
      all) SETS='["bot","control"]' ;;
      *) echo "::error ::images must be 'bot' or 'all', not '$IMAGE_SET'"; exit 1 ;;
    esac
    IDEMPOTENCY_TAG="$TAG-patch-$PHASH"
    ;;
  main)
    : "${REF_INPUT:=main}"
    [ "$REF_INPUT" != "latest" ] || REF_INPUT=main
    [[ "$REF_INPUT" =~ $REF_PATTERN ]] || { echo "::error ::'$REF_INPUT' is not a branch name or SHA"; exit 1; }
    # A branch of this fork (origin/<ref>) or a commit already in the clone.
    if git rev-parse --verify --quiet "refs/remotes/origin/$REF_INPUT^{commit}" >/dev/null; then
      SHA="$(git rev-parse "refs/remotes/origin/$REF_INPUT^{commit}")"
    elif git rev-parse --verify --quiet "$REF_INPUT^{commit}" >/dev/null; then
      SHA="$(git rev-parse "$REF_INPUT^{commit}")"
    else
      echo "::error ::'$REF_INPUT' is neither a branch of this fork nor a known commit"; exit 1
    fi
    TAG=main
    BASE="$SHA"
    PHASH=""
    SHORT="$(git rev-parse --short="$SHORT_LEN" "$SHA")"
    echo "main: ref=$REF_INPUT sha=$SHA short=$SHORT (built as committed, no patching)"
    SETS='["bot","control"]'
    IDEMPOTENCY_TAG="main-$SHORT-quorum"
    ;;
  *)
    echo "::error ::source must be 'release' or 'main', not '$SOURCE'"; exit 1 ;;
esac

MATRIX="$(jq -c --argjson sets "$SETS" '[.images[] | select(.set as $s | $sets | index($s))]' "$CATALOG")"
REPOS="$(jq -r '[.[].repositories[]] | join(" ")' <<<"$MATRIX")"
[ -n "$REPOS" ] || { echo "::error ::no images selected"; exit 1; }
echo "images: $REPOS"

SKIP=false
if [ "$FORCE" != "true" ]; then
  all_present=true
  for img in $REPOS; do
    exists "$IMAGE_NS/$img:$IDEMPOTENCY_TAG" || { all_present=false; break; }
  done
  if [ "$all_present" = true ]; then
    SKIP=true
    echo "::notice ::$IDEMPOTENCY_TAG is already published for every image; skipping (dispatch with force=true to rebuild)"
  fi
fi

if [ "$SOURCE" = release ]; then
  # Next free -quorum.N, probed on the bot image (all images are published together).
  REV=1
  while exists "$IMAGE_NS/vexa-bot:$TAG-quorum.$REV"; do
    REV=$((REV + 1))
    [ "$REV" -le "$MAX_REVISIONS" ] || { echo "::error ::too many revisions for $TAG"; exit 1; }
  done
  # On a skip, report the revision that is already published.
  if [ "$SKIP" = true ] && [ "$REV" -gt 1 ]; then REV=$((REV - 1)); fi
  VERSION="$TAG-quorum.$REV"
  TAGS="$VERSION $TAG-$SHORT $TAG-patch-$PHASH"
else
  REV=""
  # The immutable pin tag. `main-quorum` moves to the newest build of the main branch tip and is
  # for humans only: deployments pin main-<sha>-quorum plus its digest, never main-quorum.
  VERSION="main-$SHORT-quorum"
  TAGS="$VERSION"
  if [ "$SHA" = "$(git rev-parse refs/remotes/origin/main)" ]; then TAGS="$TAGS main-quorum"; fi
fi
echo "tags: $TAGS"

{
  echo "source=$SOURCE"
  echo "tag=$TAG"
  echo "base=$BASE"
  echo "sha=$SHA"
  echo "phash=$PHASH"
  echo "short=$SHORT"
  echo "rev=$REV"
  echo "version=$VERSION"
  echo "tags=$TAGS"
  echo "skip=$SKIP"
  echo "matrix=$MATRIX"
  echo "repositories=$REPOS"
} >> "$GITHUB_OUTPUT"
