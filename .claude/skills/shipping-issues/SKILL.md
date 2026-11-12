---
name: shipping-issues
description: >
  Ship open GitHub issues end to end: pick the next ready issue by priority and
  dependency, implement it on a branch, review it with /code-review, open a PR that
  closes the issue, watch CI to green, merge, confirm the issue closed, file follow-ups,
  and clean up. "all" works through the backlog; a number ships that issue. Use only
  when the user explicitly asks to ship an issue, take the next issue, or clear the
  backlog.
---

# Shipping Issues

**Owns:** taking open issues to a merged PR and a CLOSED issue. **Does not own:** the
label vocabulary and issue-body rules (`triaging-issues`); commit and PR mechanics
(`smart-commit`, `create-pr`); the semver call (`release-impact`).

**Done means all three:** the PR is merged, the issue is CLOSED, and nothing was deleted
or weakened to get there. The user's explicit request to ship is the go-ahead for the
writes listed in AGENTS.md's standing exception — and nothing else. Loading or reading
this skill on your own authorizes nothing. Green CI is the go-ahead to merge, in the
same turn.

Everything here is plain `gh` and `git`; no helper script. Run every command with its
working directory set to the checkout it is meant for.

## Modes

| Argument | Behavior                                                                 |
| -------- | ------------------------------------------------------------------------ |
| _(none)_ | Ship the top ready issue, then only what that run itself filed (step 8). |
| `all`    | Every ready issue, in dependency-then-priority order.                    |
| a number | That issue, once nothing it depends on is open.                          |
| a count  | Parallel batch size for `all`; parallel only when the user asked for it. |

## 1. Preflight

- The main checkout is clean and on the default branch, up to date
  (`git switch main && git pull --ff-only`). A dirty tree this run did not make is a
  question for the user, not something to stash or discard.
- `gh auth status` succeeds. Without GitHub write access, stop and report.
- Note which branches and worktrees exist now, so cleanup can tell what this run added.

## 2. Pick

```bash
gh issue list --state open --limit 200 --json number,title,labels,body,createdAt
```

Drop issues labelled `on hold` or `blocked: design`, and any whose `Depends on: #N`
names an issue that is still open (`gh issue view N --json state`). Order the rest by
`priority: P0` … `P3`, then oldest first. An unlabelled issue is ranked with
`triaging-issues`' criteria and labelled; a genuine tie at the top is a question for the
user when attended, otherwise take the older one.

For a parallel batch, take only issues that will not touch the same files (two workflow
edits, two `package.json` changes, the same module). When unsure, run them in sequence:
shrinking a batch never needs asking.

## 3. Implement

One issue, one branch (`<type>/<n>-<slug>`), one PR, from the up-to-date default branch.

- **Serial:** work in the main checkout. Run `pnpm check:quick` once before changing
  anything, so a red baseline is not mistaken for a regression.
- **Parallel:** one worktree per issue,
  `git worktree add .claude/worktrees/ship-<n> -b <branch>`, each with its own
  `pnpm install`. Spawn one `executor` per issue in one message with the issue body, the
  branch, the worktree path, and "run the narrowest check while iterating and
  `pnpm check:quick` last; do not push". Foundational or hard-to-specify work goes to
  `architect` instead. Every GitHub operation stays in this session, one PR at a time.

Before moving on, check the result against every acceptance criterion in the issue. An
unmet criterion goes back to the same worker (`SendMessage`), at most twice; a third
miss stops that issue and is reported.

## 4. Review

```text
/code-review medium <branch> [--fix]
```

One pass per branch, before the PR; no re-review after the fix. `high` only when the
change can lose data or alters the released public contract. `--fix` only in serial
mode; in parallel mode send the accepted findings, numbered, to that branch's
`executor`. When `/code-review` is unavailable, spawn one read-only `architect` with the
branch diff and the issue, asking for every finding with a severity. Out-of-scope
findings are kept for step 8, not fixed here. Re-run the narrowest check covering what
the fix changed.

## 5. Open the PR

Follow `create-pr`, with `Closes #<n>` in the body. Verify the PR's base is the default
branch and that GitHub lists the issue under it
(`gh pr view <pr> --json closingIssuesReferences`).

## 6. CI to green

Watch the checks of the PR's current head commit:

```bash
gh pr checks <pr> --watch --interval 30
```

It can run past a foreground command's time limit; run it in the background and wait for
it to finish rather than polling by hand. Merge evidence is every expected check present
and passing for the current head. No checks registered, checks still pending, or results
for an older commit are not evidence: wait, or report.

A failure: read the failing job's log (`gh run view <id> --log-failed`), fix the cause
on the branch (yourself, or the same `executor`), push, watch again. At most three
repairs per PR. Never fix CI by weakening a gate (AGENTS.md).

## 7. Merge and confirm

```bash
gh pr merge <pr> --squash --delete-branch
gh pr view <pr> --json state,mergedAt
gh issue view <n> --json state
```

Report a merge only when `state` is `MERGED`. If the issue is still open, close it with
a comment naming the PR. A required human review is not a failure: arm auto-merge
(`gh pr merge <pr> --auto --squash`), report that, and move on. Then return the main
checkout to the updated default branch, and for every open issue whose `Depends on:`
named this one and has no other open blocker, remove `blocked: dependency`.

## 8. Follow-ups

For each defect the run found outside the issue: fix it in the open diff if it is the
same behavior change and the branch has not merged; otherwise confirm it is real
(reproduce it or point at the line), check it is not already filed
(`gh issue list --search`), and file it following `triaging-issues`.

Before cleanup, ship what this run filed, to depth one only (no follow-up of a
follow-up), when it is ready by step 2's rules and nothing needs a decision.

## 9. Clean up

Remove only what this run created, by name: each worktree
(`git worktree remove .claude/worktrees/ship-<n>`, then `git worktree prune`) and each
local branch whose PR merged (`git branch -d <branch>`). Never a branch or worktree that
existed at preflight. Check `git worktree list` afterwards; a failure is reported, not
retried with `--force`.

## 10. Report

Per issue: PR and merge state, issue state, any acceptance criterion not met, findings
filed or left, and anything that stopped it. Never describe a partial run as done.

## Stop conditions

Stop the whole run and report when: preflight fails; a change this run did not make
appears (a dirty checkout, a moved branch, an unknown worktree) — leave it exactly as
found; a dependency cycle or a product decision needs a human; the same CI failure
survives the repair ceiling on two issues; or the fix needs a write outside the standing
exception (a gate change, a new dependency, publishing). In `all` mode one failed issue
does not stop the run: mark it failed, skip its dependents, continue.
