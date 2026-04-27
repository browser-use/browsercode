# Upstream sync protocol

How to pull `anomalyco/opencode` into this fork. Read `UPSTREAM.md` first for the why (modification zones, sync log); this doc is the how.

Designed so a maintenance agent with no prior context can run it end-to-end.

## Why we do it this way

- **Merge commits, not rebase.** Forks that ingest upstream use merge commits. Our custom commits keep their SHAs; each sync is one clear point in history; rebase would force-push `main` and re-resolve every conflict N times (once per replayed commit).
- **Anchor on `upstream/dev`, not on release tags.** Upstream cuts release tags (`v1.14.22`) as sibling commits *off* `dev` — the tag commit is not an ancestor of `dev`. The matching commit *on* `dev` is `sync release versions for vX.Y.Z`. Anchoring on the dev commit keeps `script/check-upstream.sh` simple and avoids walking off-branch. Record the corresponding version tag in the `UPSTREAM.md` notes column for humans.
- **Add-only + F4 filter keeps this cheap.** Decisions.md §1 and §1b are the reason ~85 commits of upstream churn produced 2 conflicts in the first live sync (PR #3). Do not erode this property by adding upstream modifications casually.

## Prerequisites

- `upstream` remote configured: `git remote add upstream https://github.com/anomalyco/opencode.git`
- `$BROWSERCODE_DEV_PAT` available (for push + PR creation).
- `bun` on `PATH` matching or newer than the `packageManager` pin in root `package.json` (currently `1.3.13`). Older bun will fail the pre-push hook's version guard.

## The 7 steps

### 1. Start clean on `main`

```sh
git checkout main
git pull origin main
```

Missing this is the #1 way to produce a stale sync. Do not skip.

### 2. Check drift

```sh
script/check-upstream.sh
```

Reads `UPSTREAM.md`'s latest recorded `To SHA` for `anomalyco/opencode` and reports how many commits `upstream/dev` is ahead. Pick a target commit:

- **Latest release point (recommended)** — fetch upstream tags, then find the corresponding `sync release versions for vX.Y.Z` commit on `upstream/dev` using `git log upstream/dev --grep "sync release versions for"`. That's the anchor.
- **HEAD of `upstream/dev`** — fine for aggressive catch-up syncs; less stable than a release point.
- **Older tag** — if the latest release introduces a risky refactor we want to skip for now.

### 3. Create the sync branch and merge

```sh
git fetch upstream dev
git checkout -b sync/upstream-vX.Y.Z main
git merge <target-sha>
```

Expect conflicts. Typical conflict set for ~50-100 commits of upstream churn:

- `packages/opencode/package.json` — we renamed to `@browser-use/browsercode-core`; upstream bumps the version string. **Rule: keep our `name`, take their `version`.**
- `bun.lock` — never hand-edit. `git checkout --theirs bun.lock`, then `bun install` after the rest is staged. This regenerates the lockfile against our actual workspace (which includes `@browser-use/bcode-browser`, not present upstream).
- Other `package.json` files — `packages/web/`, `packages/shared/`, root. If we renamed anything there, same rule: keep our names, take their deps.

Files we might have Yellow-zone modifications in (run the audit in step 5):
- `bin/bcode` (our rename of `bin/opencode`)
- `packages/opencode/src/index.ts`, `packages/opencode/src/cli/cmd/temporary.ts` — `scriptName("bcode")` instead of `"opencode"`
- USER_AGENT sites, banner (`ui.ts`, `logo.ts`), mDNS domain

### 3a. Re-delete upstream-only workflows

Upstream ships 32 workflows we deleted in PR #14 (Discord webhooks, marketplace publishing, SaaS deploy, OPENCODE_API_KEY-gated automation, community moderation, Nix flake, upstream test surface). The merge will reintroduce them. Re-delete:

```sh
rm -f .github/workflows/{beta,close-issues,close-stale-prs,compliance-close,containers,daily-issues-recap,daily-pr-recap,deploy,docs-locale-sync,docs-update,duplicate-issues,generate,nix-eval,nix-hashes,notify-discord,opencode,pr-management,pr-standards,publish,publish-github-action,publish-vscode,release-github-action,review,stats,storybook,sync-zed-extension,test,triage,vouch-check-issue,vouch-check-pr,vouch-manage-by-issue}.yml
```

Keepers: `release.yml` (ours) and `typecheck.yml` (retargeted to `main`). If upstream adds a new workflow file we haven't classified yet, leave it on disk and flag it in the PR body for human review.

### 4. Regenerate lockfile and verify

```sh
bun install
bun run typecheck
```

`bun run typecheck` at the root is aliased to the F4 filter: `bun turbo typecheck --filter='@browser-use/browsercode-core...' --filter='@browser-use/bcode-browser'`. Runs only the 5 packages we ship; should finish in ~12 seconds on a cold cache. If it fails, upstream changed an API we depend on — fix in our code, not upstream's.

Do NOT run root-level `bun turbo typecheck` without the filter. It will try to typecheck `web`, `console`, `app`, `enterprise` — packages we deliberately do not maintain, some of which are upstream-broken. That's why the F4 filter exists.

### 5. Yellow-zone audit

```sh
git log --name-only --pretty=format: <recorded-sha>..<target-sha> \
  -- bin/ packages/opencode/src/index.ts \
     packages/opencode/src/cli/cmd/temporary.ts \
     packages/opencode/src/cli/cmd/tui/app.tsx \
     <any other Yellow files from UPSTREAM.md §1> \
  | sort -u
```

If output is empty, upstream didn't touch any file we modified — no extra work. If non-empty, open each listed file, confirm our modification survived the auto-merge, and note any that needed re-resolution in the PR body.

### 6. Update UPSTREAM.md

Append a row to the sync-log table under `### anomalyco/opencode → this repo`:

```
| YYYY-MM-DD | <from-sha> | <to-sha> | <author> | Merged upstream release point for vX.Y.Z. Conflicts: <list>. Yellow-zone: <touched or none>. |
```

### 7. Commit, push, PR

```sh
git add .
git -c core.editor=true commit    # merge message pre-populated; amend for clarity
git push -u origin sync/upstream-vX.Y.Z
```

The pre-push hook (`husky/pre-push`) runs the bun-version guard + `bun run typecheck`. With `bun >= 1.3.13` and a clean typecheck, it passes without `--no-verify`. If you must bypass, document why in the PR.

Open the PR. Our `$BROWSERCODE_DEV_PAT` is a fine-grained PAT scoped to `browser-use/browsercode` (user: `Alezander9`). It works via the REST API; `gh pr create` uses a GraphQL mutation that this PAT does not allow. Use REST:

```sh
curl -sS -X POST \
  -H "Authorization: token $BROWSERCODE_DEV_PAT" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/browser-use/browsercode/pulls \
  -d '{
    "title": "sync: upstream vX.Y.Z (<short-sha> on dev)",
    "head": "sync/upstream-vX.Y.Z",
    "base": "main",
    "body": "<PR body — see template below>"
  }'
```

(`gh api repos/browser-use/browsercode/pulls --method POST -f ...` also works, same REST path.)

### PR body template

```
## Summary
Brings anomalyco/opencode up to vX.Y.Z (<target-sha> on dev). N upstream commits since <recorded-sha>.

## Conflicts resolved
| File | Resolution |
|---|---|
| ... | ... |

## Verification
- bun install: clean
- bun run typecheck: 5/5 passed in Ns

## Yellow-zone audit
(either "no Yellow-zone files touched by upstream in this window" or a per-file list)
```

## Never push directly to `main`

The project's `AGENTS.md` rule: everything goes through a branch + PR. Merging the sync PR is always a human decision, not the agent's.

## Troubleshooting

- **Pre-push hook fails on bun version** — upgrade your bun to the version pinned in root `package.json`'s `packageManager` field. Do not modify the hook or the pin; both have merge-cost on the next upstream sync.
- **`gh pr create` errors with "Resource not accessible"** — known. Use the REST `curl` path above.
- **Typecheck fails on an upstream-owned file** — open an issue instead of patching. The failure is a signal about upstream regression; our fork is not the right place to route around it unless we're adopting the change ourselves.
- **Massive conflict count (20+)** — stop and ask. Something broke the add-only invariant, or upstream made a sweeping refactor. A huge-conflict sync should be discussed before resolving; may warrant splitting across multiple smaller target commits.
