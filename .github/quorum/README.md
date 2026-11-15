# hivecommons/vexa: Quorum build and sync tooling

Everything under `.github/quorum/` and every `.github/workflows/quorum-*.yml` file belongs to
hivecommons. Upstream Vexa never ships files with these names, so upstream merges do not touch
them. All other workflows in `.github/workflows/` come from upstream Vexa-ai/vexa and are kept
DISABLED in this fork (they need upstream secrets and publish to upstream registries).

| File | Purpose |
|---|---|
| `workflows/quorum-images.yml` | Builds multi-arch (amd64 + arm64) images to `ghcr.io/hivecommons/` |
| `workflows/quorum-upstream-sync.yml` | Daily merge of upstream `main`, release mirroring, workflow disabling |
| `quorum/plan.sh` | Resolves the upstream tag, patch set, and image tags for a build |
| `quorum/prepare-source.sh` | Materialises "upstream tag + our patches" into a build directory |
| `quorum/transcription-cpu.overlay.Dockerfile` | Appended to upstream `Dockerfile.cpu`: bakes the Whisper model |
| `quorum/upstream-sync.sh` | The merge logic used by the sync workflow |
| `quorum/disable-upstream-workflows.sh` | Disables every registered workflow whose file is not `quorum-*` |

## What "upstream tag + our patches" means

Our patches are the net diff between our `main` and the upstream commit it last merged:

    BASE  = git merge-base upstream/main <our commit>
    PATCH = git diff BASE <our commit> -- . ':(exclude).github'

The build checks out the upstream release tag (fetched from Vexa-ai/vexa, not from this fork)
and applies PATCH with `git apply --3way`. If it does not apply, the build fails; nothing is
published. `.github/` is excluded because it holds only CI files, which do not go into images.

## Image tags

For upstream tag `vX.Y.Z` each image gets:

- `vX.Y.Z-quorum.N`: N starts at 1 and increments each time the patch set changes for that tag.
- `vX.Y.Z-<short sha>`: the hivecommons commit the patch set came from.
- `vX.Y.Z-patch-<sha256 of PATCH, 12 hex>`: idempotency key. If it already exists for all
  images, the build is skipped (unless dispatched with `force: true`).

Deployments pin `vX.Y.Z-quorum.N` plus its digest.
