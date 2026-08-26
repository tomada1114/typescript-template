---
name: merge-dependabot
description: >
  Triage, verify, and land open Dependabot/Renovate dependency PRs. Surveys all
  bot PRs, classifies bump risk, checks CI and security signals, then either
  merges eligible PRs individually or builds one combined integration PR
  (regenerating pnpm-lock.yaml) and closes the superseded originals once CI is
  green. Use PROACTIVELY when: dependabot, dependency PRs, bump PRs, dependency
  update, merge dependabot, batch dependency PRs, 依存関係の更新, 依存PRのマージ.
---

# Dependabot PR Integration

All branch names, commit messages, PR titles, and PR bodies MUST be in English.

## Operating Contract

- **Input:** none required. Optionally a subset of PR numbers to restrict scope.
- **Output:** merged PRs and/or one combined PR, plus a written report of what
  was merged, held, or closed.
- **Approval:** one confirmation gate. Do the entire triage first, present the
  plan, get approval **once**, then execute the rest unattended. Never ask per
  merge; never merge before that single approval.
- **Merge policy:** green CI is the bar. Major bumps are **not** auto-held, but
  they MUST be called out explicitly in the plan so the approval is informed.

## Step 1: Survey

```bash
node .claude/skills/merge-dependabot/scripts/survey-prs.mjs
```

The script is read-only. It lists every open bot PR with its ecosystem, semver
level, check rollup, mergeability, touched files, and — importantly — which
files are contested by more than one PR.

Add `--json` when you need to compute over the rows rather than read them.

If it reports no open bot PRs, say so and stop.

## Step 2: Classify each PR

For every row, record:

| Field        | Source                                                         |
| ------------ | -------------------------------------------------------------- |
| semver level | script (`level`)                                               |
| CI state     | script (`checks`, `failingChecks`)                             |
| merge state  | script (`mergeState`) — `CLEAN`, `UNSTABLE`, `BEHIND`, `DIRTY` |
| blast radius | script (`files`)                                               |

Note that `.github/dependabot.yml` groups minor and patch bumps into a single
PR per ecosystem, so one row often carries several dependencies. Majors are
deliberately ungrouped and arrive one per PR. Read the diff of a grouped PR in
full — the row's `level` is only as precise as the title.

Then read the actual diff for anything not purely mechanical:

```bash
gh pr diff <number>
```

**Security review** (do not skip — this is the point of the gate):

- GitHub Actions bumps must remain **SHA-pinned with a version comment**. A diff
  that replaces a SHA pin with a floating tag is a regression — hold it.
  `tests/workflows.test.ts` asserts this, so such a PR should already be red.
- For a major bump, read the upstream release notes before approving:
  `gh release view <tag> --repo <owner>/<repo>` or the changelog link in the PR body.
- Treat a **minor bump of a `0.x` package as a major** one — pre-1.0 tools ship
  breaking changes in minor releases. The script labels these `minor`; you still
  read the release notes.
- Confirm the `Dependency Review` check passed on the PR — it is the advisory
  gate for new and changed dependencies.
- A bump that changes `pnpm-workspace.yaml`, `eslint.config.mjs`, or anything
  under `.github/workflows/` is changing _what_ runs rather than _which version_
  runs, and deserves a closer read.
- **Never** let a bump relax `minimumReleaseAge`, `strictDepBuilds`,
  `strictPeerDependencies`, or add an `allowBuilds` entry to make an install
  succeed. Each of those is a supply-chain decision, not a merge conflict.

If CI is failing, diagnose before deciding — see
[references/failure-modes.md](references/failure-modes.md). In this repo the
most common failure is **not** a real regression; it is a peer-range conflict or
a lockfile that no longer matches the manifest.

## Step 3: Choose the landing mode

Decide by risk, and state the reasoning in the plan.

**Merge individually** when all hold:

- 3 or fewer eligible PRs, and
- no contested files between them, and
- each is `CLEAN` with `PASSING` checks.

Note that every npm PR touches `package.json` and `pnpm-lock.yaml`, so two open
npm PRs are contested by definition. In practice, individual merges are for
GitHub Actions PRs; npm PRs almost always go through the combined path.

**Build a combined PR** when any holds:

- more than 3 eligible PRs (avoids N sequential rebase-and-wait cycles), or
- two or more PRs touch the same file (the survey prints these), or
- one or more npm PRs need a lockfile regeneration (they cannot go in as-is).

Mixed outcomes are fine: merge the clean Actions PRs directly and combine the
npm ones, for example. Say which PRs go which way.

## Step 4a: Individual merges

Process in ascending PR number, one at a time:

```bash
gh pr checks <number>          # re-confirm green immediately before merging
gh pr merge <number> --squash --delete-branch
```

After each merge the remaining PRs become `BEHIND`. Rebase the next one and wait
for its checks before merging it:

```bash
gh pr comment <number> --body "@dependabot rebase"
```

Never merge a PR whose checks you have not re-confirmed **after** its last rebase.

## Step 4b: Combined PR

```bash
git switch main && git pull --ff-only
git switch -c deps/batch-<yyyymmdd>
```

Merge each participating branch into it:

```bash
git fetch origin <branch>
git merge --no-ff origin/<branch> -m "deps: merge #<number> <title>"
```

Resolve conflicts by taking **the higher version** of each dependency unless the
release notes say otherwise. Resolve `pnpm-lock.yaml` conflicts by regenerating,
never by hand — `.agents/hooks/guard.mjs` blocks editing it, correctly:

```bash
pnpm install --lockfile-only
git add package.json pnpm-lock.yaml && git commit -m "deps: regenerate the lockfile"
```

Verify locally before pushing, on the development Node:

```bash
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` covers the packaging gates (`publint`, are-the-types-wrong, the
tarball smoke test) that a dependency bump can break without touching a single
line of source. Also confirm the minimum supported Node still works, since that
is a separate CI job:

```bash
pnpm --config.runtime-on-fail=ignore run check
```

If `pnpm check` fails, fix it on the branch when the fix is mechanical (a lint
rule renamed by a new ESLint, a new type error from a stricter TypeScript). If it
needs a judgement call, stop and report — do not merge around it, and do not
suppress the error to make the gate pass.

Then open the PR:

```bash
git push -u origin HEAD
gh pr create --title "deps: batch dependency updates" \
  --label dependencies --body "<filled PR template>"
```

Title notes: the `check-pr-title` workflow skips PRs labeled `dependencies`, but
set a valid Conventional Commits title anyway so the squashed history and the
generated release notes stay consistent. Fill
`.github/PULL_REQUEST_TEMPLATE.md` — list every rolled-up PR as
`- #<number> <title>`, and put the local verification commands in Test Plan.

A dependency bump that consumers can observe (a changed peer range, a raised
`engines.node`, a new runtime dependency) needs a Changeset. A devDependency
bump does not.

## Step 5: Land and clean up

Wait for CI on the combined PR:

```bash
gh pr checks <combined-number> --watch
```

Merge only on green:

```bash
gh pr merge <combined-number> --squash --delete-branch
```

Then close every superseded original with a pointer:

```bash
gh pr close <number> --comment "Superseded by #<combined-number>." --delete-branch
```

Close the originals **only after** the combined PR is merged. If the combined PR
is abandoned, leave the originals open.

## Step 6: Report

State plainly:

- merged (with PR numbers and what landed)
- held, and the specific reason
- closed as superseded
- any CI failure you saw, with the real error, not a summary of it

If something failed, say so with the output. Do not describe a partially
completed run as done.

## Critical Rules

- **One approval gate only** — after Step 3's plan is approved, run to completion.
- **Never** merge on `PENDING` checks; re-confirm green after every rebase.
- **Never** hand-edit `pnpm-lock.yaml`; run `pnpm install --lockfile-only`.
- **Never** close an original PR before its replacement is merged.
- **Never** use `--admin`, `--no-verify`, or force-push to bypass a failing gate.
- **Never** unpin a SHA-pinned GitHub Action to make a bump apply cleanly.
- **Never** weaken a supply-chain setting or a coverage threshold to land a bump.
- **Stay in scope** — this skill lands dependency bumps. Unrelated cleanups you
  notice go in the report as suggestions, not in the branch.
