---
name: placing-tests
description: >
  Decides where a new test file goes under tests/<module>.test.ts, which
  vitest.config.ts project (unit vs automation) it joins, and which of the three
  coverage.thresholds floors (src/**, scripts/**, scripts/lib/guard/**) govern it. Use
  when adding a *.test.ts file, choosing between `pnpm exec vitest run` and `pnpm
  test:coverage`, or a coverage run drops below a floor.
---

# Placing Tests

**Owns:** where a new test file goes, which vitest project it joins, and the coverage
floors that govern it. **Does not own:** how the test itself is written, assertion
style, and fixtures (`writing-tests`); type tests with `expectTypeOf` (`type-testing`).

## Location

- Every test file lives at `tests/<module>.test.ts`. Never co-locate a test next to the
  source file it covers.

## Choosing a project

`vitest.config.ts` splits `test.projects` into `unit` and `automation`. Placement is a
decision you make from what the file touches, never from its name or its directory — and
it is not inferred: `automation` is the default, its `include` is `tests/**/*.test.ts`
minus the `unitTests` array declared at the top of `vitest.config.ts`, and a test only
joins `unit` when you add its path to that array. Creating the file alone, whatever it
touches, puts it in `automation`. Choose between them by:

- **`unit`** — the test imports only `src/**` (plus, as a deliberate exception,
  `scripts/lib/guard/**`'s own pure-function tests) and touches no filesystem,
  subprocess, or git.
- **`automation`** — everything else: any test that shells out, reads or writes a temp
  directory, or spawns `git`/`node`.

Getting this wrong does not fail the run — the wrong project just gives the test the
wrong timeout budget, so decide it deliberately and edit the `unitTests` array when the
criteria above say `unit`, rather than leaving the default in place.

- **Why the timeouts differ:** a `unit` test has no I/O, so if it hangs the only
  possible cause is an infinite loop or an unresolved promise, and a short timeout
  surfaces that in seconds. An `automation` test legitimately needs the long budget for
  a real subprocess or temp-directory operation — giving it the short one would make
  correct tests flaky.

## Coverage floors

`coverage.include` in `vitest.config.ts` lists both `src/**/*.ts` and `scripts/**/*.mjs`
on purpose: a file with no test still counts toward the denominator at 0% instead of
vanishing from it. A new file is covered from the moment it exists — write its test in
the same PR, not as follow-up.

Three independent threshold sets exist, not one, because they answer three different
questions:

- **`src/**`** carries the package's own baseline floor — this is the public contract's
  coverage bar.
- **`scripts/**`** was never measured before it was added to `coverage.include`, so its
  floor is the last measured coverage rounded down to a clean value, not a guessed
  target — it has been raised as coverage grew (see the dated comments in
  `vitest.config.ts`). Raise it again as real coverage grows; never invent a number
  ahead of the measurement.
- **`scripts/lib/guard/**`** — the credential and path detection rule engine, the most
  security-critical code in the repository — carries its own higher floor on lines,
  functions, and statements, so it cannot regress just because it is dragged along by
  whatever number the broader `scripts/**` tree happens to sit at. Its branch floor
  currently equals `scripts/**`'s, so a branch regression there is caught only by the
  broader floor; raise the guard floor's branch number too once guard branch coverage
  grows past it.

See `vitest.config.ts`'s `coverage.thresholds` for the current numbers; this skill
deliberately does not repeat them, since a copied number goes stale the moment the
config changes.

- **Branch coverage is the one that matters.** Cover both sides of a conditional rather
  than adding a trivial test whose only effect is moving a line/statement percentage.
- **A floor is never lowered, and no file is added to `coverage.exclude` to move a
  number** — AGENTS.md's "Security and human approval" holds that prohibition for every
  agent, including one whose task is only "make CI green." What this skill owns is which
  of the three floors applies and why.

## Commands

```bash
pnpm exec vitest run tests/<name>.test.ts   # one file, fast iteration
pnpm test:coverage                          # full suite with floors enforced
```

If `pnpm test:coverage` fails on a floor, add real coverage for the uncovered branch —
do not adjust the threshold or the include list.
