# hivecommons/vexa: Quorum build and sync tooling

Everything under `.github/quorum/` and every `.github/workflows/quorum-*.yml` file belongs to
hivecommons. Upstream Vexa never ships files with these names, so upstream merges do not touch
them. `.github/workflows/` holds ONLY our `quorum-*` workflows: the fork does not keep or run
upstream Vexa-ai/vexa workflows (they need upstream secrets and publish to upstream registries).

## Upstream sync and workflow files

The daily sync runs with the built-in `GITHUB_TOKEN`; no extra secret is needed. GitHub refuses
a `GITHUB_TOKEN` push whose ref update changes files under `.github/workflows/`, so the sync
never takes upstream workflow files:

1. `git merge --no-commit --no-ff upstream/main`
2. `keep_our_workflows` (`quorum/keep-our-workflows.sh`) resets `.github/workflows/` in the
   index and work tree to exactly what our `main` has. Upstream-added workflows are dropped,
   upstream edits are reverted, and a modify/delete conflict on an upstream workflow we deleted
   is resolved by keeping it deleted.
3. If no other conflicts remain, commit the merge, check that it changes no
   `.github/workflows/` path, and push to `main`. Otherwise abort, push upstream main plus one
   commit that applies the same reset to `sync/upstream-<date>`, and open or update the
   "Upstream sync conflict" PR. Nothing is pushed to `main`.

Only the pushed tip's tree counts: upstream commits in the merge's history may touch their
workflows. Disabling non-`quorum-*` workflows stays in the sync as a safety net.

| File | Purpose |
|---|---|
| `workflows/quorum-images.yml` | Builds multi-arch (amd64 + arm64) images to `ghcr.io/hivecommons/` |
| `quorum/images.json` | The image catalog: build context and Dockerfile per image |
| `workflows/quorum-upstream-sync.yml` | Daily merge of upstream `main`, release mirroring, workflow disabling |
| `quorum/plan.sh` | Resolves the source (release or main), image set, and image tags for a build |
| `quorum/prepare-source.sh` | Materialises "upstream tag + our patches" into a build directory |
| `quorum/transcription-cpu.overlay.Dockerfile` | Appended to upstream `Dockerfile.cpu`: bakes the Whisper model |
| `quorum/upstream-sync.sh` | The merge logic used by the sync workflow |
| `quorum/keep-our-workflows.sh` | Resets `.github/workflows/` to our main during a sync merge |
| `quorum/disable-upstream-workflows.sh` | Safety net: disables every registered workflow whose file is not `quorum-*` |

## Two sources

`quorum-images.yml` has an input `source`:

- `release` (default for dispatch, and what `quorum-upstream-sync.yml` dispatches for a new
  upstream release): upstream tag + our patches, below. Input `images`: `bot` (default:
  vexa-meet-join-env, vexa-bot, vexa-transcription-cpu) or `all` (those plus the control plane).
- `main`: a commit of this fork as committed, no patching (input `ref`: a branch or SHA, default
  `main`). Always builds every image in `images.json`. A push to `main` (outside docs/, *.md and
  .github/) runs this for the pushed commit.

Our patches are merged on top of upstream `main`, which is ahead of the latest upstream release,
so they may not apply to a release tag. Then use `source: main`.

The image catalog (`images.json`) follows upstream's release build plan
(`node release/candidate-image-map.mjs emit-build-plan - <sha>`): bot, bot base, CPU
transcription, gateway, admin-api, meeting-api, runtime, mcp, agent-api, agent-worker,
credential-broker, flows, terminal, crm, signals. Not built: vexa-lite (not used by the Helm
chart) and the dashboard (`services/dashboard`, a separate client with an unpinned base image).
When upstream adds an image to its build plan, add it to `images.json`.

Each image x arch builds on a native runner (`ubuntu-24.04`, `ubuntu-24.04-arm`) and pushes by
digest; the publish job makes one manifest list per image and fails unless both linux/amd64 and
linux/arm64 are in it. The run's step summary and its `digests` artifact (`digests.json`) list
every image's index digest and per-platform digests.

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

For `source: main` at commit `<sha>` each image gets:

- `main-<short sha>-quorum`: immutable. Deployments pin this tag plus its digest. It is also the
  idempotency key: a commit already published is skipped unless dispatched with `force: true`.
- `main-quorum`: moves to the newest build of the tip of `main`. For people only; never deploy it.

Build from main by hand:

    gh workflow run quorum-images.yml --repo hivecommons/vexa --ref main -f source=main -f ref=main
