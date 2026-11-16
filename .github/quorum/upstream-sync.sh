#!/usr/bin/env bash
# Merge upstream Vexa-ai/vexa main into our main with a merge commit (never rebase, never
# force-push). On conflict, push a sync branch to sync/upstream-<date> and open or update the
# "Upstream sync conflict" PR listing the conflicting files.
#
# Our .github/workflows/ is never taken from upstream: after `git merge --no-commit`, the
# directory is reset to exactly what our main has (upstream additions dropped, upstream edits
# reverted, modify/delete conflicts resolved as deleted). So no push changes a workflow file
# and the built-in GITHUB_TOKEN is enough (it cannot push workflow-file changes).
# Env: UPSTREAM_REPO, GH_TOKEN, GH_REPO, BOT_NAME, BOT_EMAIL. Outputs: result, pulled.
set -euo pipefail
: "${UPSTREAM_REPO:?}" "${GH_REPO:?}" "${BOT_NAME:?}" "${BOT_EMAIL:?}"
CONFLICT_TITLE="Upstream sync conflict"
WORKFLOWS_DIR=".github/workflows"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=keep-our-workflows.sh
. "$HERE/keep-our-workflows.sh"

git config user.name "$BOT_NAME"
git config user.email "$BOT_EMAIL"
git remote add upstream "$UPSTREAM_REPO" 2>/dev/null || git remote set-url upstream "$UPSTREAM_REPO"
git fetch --quiet --no-tags upstream main
# Upstream release tags are fetched for the build, and mirrored best-effort below.
git fetch --quiet --force upstream 'refs/tags/*:refs/tags/*'

UP="$(git rev-parse upstream/main)"
OURS="$(git rev-parse HEAD)"
PULLED="$(git rev-list --count HEAD.."$UP")"
echo "upstream/main=$UP, commits not yet in our main: $PULLED"
if [ "$PULLED" -eq 0 ]; then
  echo "result=up-to-date" >> "$GITHUB_OUTPUT"; echo "pulled=0" >> "$GITHUB_OUTPUT"
  exit 0
fi

MSG="Merge upstream Vexa-ai/vexa main ($(git rev-parse --short=7 "$UP")) into main"
SIGNOFF="Signed-off-by: $BOT_NAME <$BOT_EMAIL>"
git merge --no-commit --no-ff "$UP" || true
# A conflicted merge still leaves MERGE_HEAD; its absence means the merge did not start.
git rev-parse -q --verify MERGE_HEAD >/dev/null || { echo "::error ::git merge did not start"; exit 1; }
keep_our_workflows "$OURS"
CONFLICTS="$(git diff --name-only --diff-filter=U | sort)"

if [ -z "$CONFLICTS" ]; then
  git commit --quiet -m "$MSG" -m "$SIGNOFF"
  assert_workflows_unchanged "$OURS" HEAD
  git push origin HEAD:main
  echo "result=merged" >> "$GITHUB_OUTPUT"; echo "pulled=$PULLED" >> "$GITHUB_OUTPUT"
  # Close a stale conflict PR, if one is open, now that main has caught up.
  for n in $(gh pr list --state open --search "\"$CONFLICT_TITLE\" in:title" --json number -q '.[].number'); do
    gh pr close "$n" --comment "Superseded: upstream main ($UP) merged cleanly into main." || true
  done
  exit 0
fi

git merge --abort
DATE="$(date -u +%Y-%m-%d)"
BRANCH="sync/upstream-$DATE"
# The branch carries upstream main plus one commit that resets .github/workflows/ to ours
# (pushing upstream main as-is would change workflow files, which GITHUB_TOKEN cannot do).
# Resolve by merging main into it on the PR.
git checkout --quiet --detach "$UP"
keep_our_workflows "$OURS"
if ! git diff --cached --quiet; then
  git commit --quiet -m "sync: keep hivecommons $WORKFLOWS_DIR on top of upstream main" \
    -m "The fork does not run upstream workflows; the sync keeps ours only." -m "$SIGNOFF"
fi
assert_workflows_unchanged "$OURS" HEAD
git push --force origin "HEAD:refs/heads/$BRANCH"
git checkout --quiet "$OURS"

BODY="$(mktemp)"
{
  echo "Upstream Vexa-ai/vexa main ($UP) does not merge cleanly into hivecommons/vexa main."
  echo
  echo "Commits pending: $PULLED. Conflicting files:"
  echo
  while read -r f; do [ -n "$f" ] && echo "- \`$f\`"; done <<<"$CONFLICTS"
  echo
  echo "\`$BRANCH\` is upstream main with \`$WORKFLOWS_DIR/\` reset to ours (the fork never"
  echo "takes upstream workflow files)."
  echo
  echo "To resolve: check out \`$BRANCH\`, run \`git merge origin/main\`, resolve, commit with"
  echo "\`git commit -s\`, push, then merge this PR with a merge commit (never squash or rebase)."
  echo
  echo "Opened by quorum-upstream-sync.yml run $GITHUB_SERVER_URL/$GH_REPO/actions/runs/$GITHUB_RUN_ID"
} > "$BODY"

EXISTING="$(gh pr list --state open --search "\"$CONFLICT_TITLE\" in:title" --json number,headRefName -q '.[0].number // empty')"
if [ -n "$EXISTING" ]; then
  OLD_HEAD="$(gh pr view "$EXISTING" --json headRefName -q .headRefName)"
  if [ "$OLD_HEAD" = "$BRANCH" ]; then
    gh pr edit "$EXISTING" --body-file "$BODY"
    echo "updated PR #$EXISTING"
  else
    gh pr close "$EXISTING" --comment "Superseded by a newer sync attempt on \`$BRANCH\`." || true
    EXISTING=""
  fi
fi
if [ -z "$EXISTING" ]; then
  gh pr create --base main --head "$BRANCH" --title "$CONFLICT_TITLE" --body-file "$BODY"
fi
echo "result=conflict" >> "$GITHUB_OUTPUT"; echo "pulled=$PULLED" >> "$GITHUB_OUTPUT"
echo "::warning ::upstream merge conflicts in: $(tr '\n' ' ' <<<"$CONFLICTS")"
