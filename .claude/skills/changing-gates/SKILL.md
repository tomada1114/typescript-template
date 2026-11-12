---
name: changing-gates
description: >
  Covers editing a file that enforces rather than implements: hand-authoring or editing
  a .github/workflows/*.yml CI workflow, editing lefthook.yml, or changing a setting
  inside eslint.config.mjs, tsconfig*.json, vitest.config.ts, or .prettierrc.json. Use
  when a new CI job or workflow is proposed, a lefthook stage or command changes, or an
  ESLint rule or tsconfig option is added or loosened, or when asking which layer
  enforces a rule and what none of them sees.
---

# Changing Gates

**Owns:** a change to a file that enforces rather than implements — a CI workflow,
`lefthook.yml`, or a tool config (`eslint.config.mjs`, `tsconfig*.json`,
`vitest.config.ts`, `.prettierrc.json`). **Does not own:** adding a dependency the
config then configures (`managing-dependencies`); a coverage floor's value or which
project a test joins (`.claude/rules/tests.md`); a `.mjs` under `scripts/` that a gate
invokes (`writing-repo-scripts`); `.github/labels.yml` (`triaging-issues`).

## The one rule every gate change shares

A gate file may narrow _what_ a tool looks at; it may never define a rule of its own.
`lefthook.yml`'s header states this for the hook layer, and it is equally true of CI,
which runs the same package scripts as separate steps (`AGENTS.md`'s Quick reference).
Adding a check therefore means adding a package script and calling it from the gate,
never inlining a command directly into a workflow step or a hook line.

## CI workflows

`tests/workflows.test.ts` encodes the mechanical half of a workflow — SHA-pinned actions
with a release-tag comment, per-job timeouts, top-level `permissions: contents: read`,
no `persist-credentials`, concurrency groups. Point at that test rather than restating
its rules.

The judgment half it cannot encode:

- A new workflow file is warranted only when the work does not belong as a job inside
  the existing `ci.yml` — a new trigger shape or a genuinely separate permission
  footprint, not a convenience split.
- `pr-label.yml` is deliberately the only workflow granted write permission. Widening
  write access to another workflow, or adding a second workflow that writes, is a
  security-relevant change and needs the same weight of review as a new write grant
  itself, not a routine CI edit.
- A PR that deletes or narrows a security-relevant workflow step (the pin, the
  `permissions` block, `persist-credentials: false`, a timeout) must state in its own
  body why the removed protection no longer applies here — silence is not sufficient
  review for that kind of change.

## `lefthook.yml`

The hook is deliberately narrow: a hook that blocks legitimate work teaches its author
to reach for `--no-verify`, which disables the secret check along with everything else
([Enforcement layers](#enforcement-layers) below). The bar for a new or changed job is
therefore that it never fires on intended, unstaged-clean work — test it against a
normal commit before relying on it to catch a bad one.

Job ordering matters and is not incidental: `format` runs alone before the parallel
group so later jobs see formatted content, and `check:staged` must see the re-staged
blobs left behind by that formatting step, not the working tree as it stood before the
commit began. Preserve that ordering across an edit rather than parallelizing it away.

## Tool configs

`eslint.config.mjs`, `tsconfig*.json`, `vitest.config.ts`, and `.prettierrc.json` each
hold their own current values — read the file rather than trusting a copy of a rule
written elsewhere. A PR that changes one of these owes three things in its own body:
which rule or option moved, why, and what now passes (or newly fails) that did not
before. That statement is what lets a reviewer weigh the change; AGENTS.md's prohibition
on weakening a gate to make a run pass governs whether the change is allowed at all, and
this skill does not restate it.

## Enforcement layers

Two layers enforce this repository's rules, and each rule lives in exactly one of them:

| Layer                 | Fires on              | Applies to             | Holds                                                       |
| --------------------- | --------------------- | ---------------------- | ----------------------------------------------------------- |
| `lefthook` pre-commit | `git commit`          | every author, any tool | Formatting, a related-test run, and the staged secret check |
| `AGENTS.md`           | read at session start | every agent            | Everything else, as instructions                            |

No declarative, tool-call-aware layer (a Claude Code `permissions.deny` or equivalent)
ships here; an agent has one only if its operator configured it personally. So two
things are enforced nowhere and hold only as instructions: a command that reads a secret
outside a commit (`cat .env`), which the hook never sees because it inspects only what
is staged; and turning the hooks off (`LEFTHOOK=0 git commit`), which the hook cannot
see because it is the thing disabled.

`scripts/lib/guard/` is the rule engine `scripts/check-staged.mjs` uses to decide
whether a staged path or its content is secret-shaped. That is the whole of its scope,
on purpose.

The hook deliberately does **not** try to stop a commit from deleting a workflow,
relaxing a config, or lowering a threshold. Those are judgement calls, and they belong
in the pull request, where a reader can weigh them. A hook that blocks legitimate work
teaches its author to reach for `--no-verify`, which disables the secret check along
with everything else, so a narrow hook that never fires on intended work protects more
than a broad one that has to be routed around.

Hand-editing `pnpm-lock.yaml` is likewise accepted as unenforced: a git diff cannot tell
a regenerated lockfile from a hand edit, and no layer here sees the tool call that
produced it.
