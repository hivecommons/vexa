#!/usr/bin/env bash
# Disable every registered workflow in this repo whose file is not ours (.github/workflows/quorum-*).
# Upstream Vexa workflows need upstream secrets and publish to upstream registries; they must
# never run in hivecommons/vexa. Requires GH_TOKEN with actions: write, and GH_REPO.
set -euo pipefail
: "${GH_REPO:?}"
gh workflow list --all --json id,name,path,state -q '.[] | [.id, .state, .path, .name] | @tsv' |
while IFS=$'\t' read -r id state path name; do
  base="$(basename "$path")"
  case "$base" in
    quorum-*) echo "keep     $id $state $path" ;;
    *)
      if [ "$state" = "active" ]; then
        if gh workflow disable "$id" >/dev/null; then
          echo "disabled $id $path ($name)"
        else
          echo "::warning ::could not disable workflow $id $path"
        fi
      else
        echo "already  $id $state $path"
      fi
      ;;
  esac
done
