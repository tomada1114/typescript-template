---
name: create-pr
description: >
  Open or update the pull request for the current branch: run the gate, write a
  Conventional Commit title and the PR template body with its Release impact line, check
  which docs the change owes, push, and create it with gh. Use when the user asks to
  open, create, submit, or update a PR, and as the PR step of shipping-issues.
---

# Create PR

**Owns:** taking a branch to an open, complete pull request. **Does not own:** grouping
commits (`smart-commit`); the semver level (`release-impact`); review, CI and merge
(`shipping-issues`).

## 1. Preconditions

```bash
git rev-parse --abbrev-ref HEAD          # not main
git status --short                       # clean, or commit first with smart-commit
gh pr view --json number,url,state       # an existing PR is updated, not duplicated
git log --oneline origin/main..HEAD
git diff --stat origin/main...HEAD
```

Run `pnpm check` (or `pnpm check:quick` when nothing reachable from `src/index.ts` or
packaging changed). A red gate is fixed first, never worked around.

## 2. What the change owes

Judge the diff against what a consumer can observe — a signature, a default, runtime
behavior, an error `code`, the supported Node range, an install step:

- **Release:** decide the level with `release-impact` and write one of its two literal
  lines. Nothing observable changed → `Release impact: no — <why>`.
- **Docs:** when something observable changed, update the README example, the affected
  hand-written `docs/` page, and the TSDoc of the changed symbol, in this PR.
  `docs/api/` is generated; never edit it. `tests/docs.test.ts` compiles every README
  and `@example` snippet, so a stale snippet fails the gate. `CHANGELOG.md` is written
  by release PRs, not here.
- **Gate changes:** a changed workflow or tool config states in the body what moved and
  why (`changing-gates`).

## 3. Title and body

Title: a Conventional Commit subject (`feat: …`, `fix: …`, `deps: …`), checked by the
`check-pr-title` workflow. Body: fill `.github/PULL_REQUEST_TEMPLATE.md` — summary of
why, the `Release impact:` line, `Closes #<n>` for each issue it resolves, and the
commands run under the test plan. Write the body to a file.

## 4. Create

```bash
git push -u origin HEAD
gh pr create --base main --title "<title>" --body-file <file>
```

For an existing PR, `gh pr edit <n> --title … --body-file <file>` instead. Then verify:
`gh pr view --json url,baseRefName,closingIssuesReferences` shows the right base and
every issue it should close. Report the URL.
