---
name: triaging-issues
description: >
  Covers this repository's issue vocabulary: the type and priority label taxonomy in
  .github/labels.yml, what `blocked: design`, `blocked: dependency`, and `on hold` mean,
  and what an issue body must contain (a `path:line`, an observable close condition, a
  `Depends on: #N` line). Use when filing a GitHub issue, triaging or re-prioritizing
  the backlog, picking a `priority: P0`-`P3` label, choosing between
  `bug`/`enhancement`/ `documentation`/`chore`/`security`, or running `pnpm
  repo:labels`.
---

# Triaging Issues

**Owns:** this repository's issue vocabulary — the label taxonomy, what a priority
means, and what an issue body must contain. **Does not own:** implementing an issue, or
what the resulting pull request must state (`release-impact`); any workflow beyond the
tracker.

Labels carry the triage decision, so it is made once and read back rather than
re-derived every time the backlog is looked at. An issue is filed with a type label and
left untiered; triage adds the priority.

## Priority labels

| Label                 | Means                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------- |
| `priority: P0`        | Ship now — other open issues are blocked on it, or damage is being taken (red main, vulnerability). |
| `priority: P1`        | Do next — leverage: CI, schema, shared types, config, the ground later issues stand on.             |
| `priority: P2`        | Normal — a real, self-contained change; nothing waits on it.                                        |
| `priority: P3`        | Defer — nice-to-have, docs polish, cosmetics.                                                       |
| `blocked: design`     | The approach is not settled; needs a human decision before anyone implements it.                    |
| `blocked: dependency` | Waits on a specific open issue named by a `Depends on: #N` line in the body.                        |
| `on hold`             | Not implementable as filed — a container issue, or parked pending something outside the tracker.    |

Priority ranks impact on the rest of the backlog, not how interesting the work is. Do
not tier an issue by how appealing it is to implement.

Tier and design-readiness are independent: an issue carrying `blocked: design` still
gets a tier, so it ranks correctly the moment the block clears. Never leave a
`blocked: design` issue untiered on the assumption that the tier can wait — it cannot be
re-derived later without redoing the judgement.

A label that turns out to be wrong gets corrected, not worked around. Ranking around a
stale label in your head leaves the next reader to make the same mistake — fix the label
instead of mentally overriding it.

## Type labels

`bug`, `enhancement`, `documentation`, `chore`, and `security`. Only the first three are
GitHub defaults, so `chore` and `security` have to exist in the repository before the
forms under `.github/ISSUE_TEMPLATE/` can apply them — GitHub silently drops a label the
repository does not have, rather than reporting one. Run `pnpm repo:labels` to create or
update every label in the repository from `.github/labels.yml` before relying on a form
that applies `chore` or `security`.

`.github/labels.yml` is the source for the label set itself — name, color, and
description; this skill holds only what each one _means_ for triage.
`.github/ISSUE_TEMPLATE/*.yml` is what applies a type label at filing time. Two labels
in `.github/labels.yml` — `dependencies` and `ci` — are changelog-only, applied by
`.github/workflows/pr-label.yml` from a PR's Conventional Commit type, and are never
used for issue triage. If the file and this skill disagree about a triage label, fix the
mismatch rather than choosing one.

## What an issue body must contain

Two things belong in the body because nothing else can recover them later:

- **What is wrong today**, with a `path:line`. A description of a symptom without a
  location forces whoever picks up the issue to re-find what the filer already knew.
- **What observable result closes it**, named as a test or a command — not as a feeling
  of doneness ("works correctly", "is cleaned up"). A closing condition that cannot be
  checked mechanically cannot be verified by anyone but the filer.

## Ordering constraints

Write an ordering constraint as `Depends on: #12` — this is the spelling automation
parses. Prose like "after the guard work lands" is not machine-readable and will not be
picked up.

An issue carrying a `Depends on:` line also carries `blocked: dependency`. The label is
**not** removed automatically when the blocker closes: whoever lands the blocking issue
clears `blocked: dependency` by hand from every issue that named it. Do not assume the
label update is someone else's automated job — it is a manual step in the same PR or a
prompt follow-up that closes the blocker.
