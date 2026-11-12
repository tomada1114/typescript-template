---
name: smart-commit
description: >
  Group the working tree's changes into atomic commits with Conventional Commit
  messages, through the pre-commit hook, and push them when asked. Use when the user
  asks to commit, save, or commit and push their changes.
---

# Smart Commit

**Owns:** turning the working tree into well-grouped commits on the current branch.
**Does not own:** opening a PR (`create-pr`); what may be committed at all (AGENTS.md's
"Security and human approval", whose standing exception covers this skill only when the
user asked for it).

## 1. Look

```bash
git rev-parse --abbrev-ref HEAD
git status --short
git diff && git diff --cached
git log --oneline -5
```

Staged changes express intent: commit those first, as staged. With nothing staged, every
modified and untracked file is a candidate. On `main`, ask whether the user wants a
branch before committing when a PR is the likely next step.

## 2. Exclude what must not land

The pre-commit hook's staged check (`scripts/check-staged.mjs`) blocks secret-shaped
paths and content; do not keep a second list here. What stays with you: a harmless name
holding a real secret, personal data, generated output (`dist/`, `coverage/`,
`docs/api/` — gitignored, so one showing up means something is wrong), and anything the
user plainly did not mean to commit. Leave those unstaged and say so.

## 3. Group

One commit per concern, each meaningful on its own. Prefix by what changed:

| Change                                         | Prefix                                   |
| ---------------------------------------------- | ---------------------------------------- |
| behavior in `src/`                             | `feat:` / `fix:` / `refactor:` / `perf:` |
| tests only                                     | `test:`                                  |
| `README.md`, `docs/`, TSDoc-only edits         | `docs:`                                  |
| `package.json` dependencies + `pnpm-lock.yaml` | `deps:` (always together)                |
| `.github/`                                     | `ci:`                                    |
| `scripts/`, configs, `.claude/`                | `chore:` (or `build:` for the build)     |

Add `!` and a `BREAKING CHANGE:` footer when the public contract breaks. A change and
the test that covers it belong in the same commit.

## 4. Commit

Stage by explicit path (`git add <paths>`), never `git add -A` over unreviewed files.
Write the message to a file and commit with `git commit -F <file>`, subject in the
imperative, under 72 characters, English. The hook formats and re-stages files; if it
fails, fix the cause and commit again — never `--no-verify`.

## 5. Push (only when asked)

`git push -u origin HEAD` for a new branch, `git push` otherwise. Never force-push. A
rejected push (remote ahead) is reported, not rebased over silently.

Report the commits made (`git log --oneline <base>..HEAD`) and anything left unstaged.
