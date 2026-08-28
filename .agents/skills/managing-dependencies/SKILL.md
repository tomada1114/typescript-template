---
name: managing-dependencies
description: >
  Covers whether a package may be added to this repository at all and what happens to it
  at install time: the review record a PR adding a runtime dependency must carry, SemVer
  range versus exact pin, the minimumReleaseAge cooldown and its exception process, the
  supply-chain settings in pnpm-workspace.yaml, and the typescript version ceiling. Use
  when adding or bumping a dependency, editing package.json's dependencies, an install
  fails on a peer range or the cooldown, or someone proposes raising typescript.
---

# Managing Dependencies

**Owns:** whether a package may exist in this repository at all, and what happens at
install time. **Does not own:** landing an existing bot PR (`merge-dependabot`); the
semver consequence of a bump for this package's own published version
(`release-impact`).

## The review record a new runtime dependency needs

Adding a runtime dependency is a permanent supply-chain commitment, so before adding
one, record all of the following in the PR that adds it. Missing one item is not a
detail to fill in later — it means the review has not actually happened yet.

- Why a small hand-written helper or a Node builtin cannot replace it.
- Maintainer and release continuity — actively maintained, not abandoned.
- License compatibility (MIT/BSD/Apache-class; a copyleft license needs a deliberate,
  explicit reason for a published library).
- Direct and transitive package count it pulls in — a large transitive surface is a real
  cost even behind a small direct API.
- Whether it runs an install script, ships a native binary, or does network access —
  each needs its own justification, and an install script also needs an `allowBuilds`
  entry (see below).
- Unpacked size and its effect on this package's own published tarball.
- Supported Node versions and module format (ESM/CJS) against this package's own
  `engines`/`exports` in `package.json`.
- Open security advisories and npm provenance.
- Which of `dependencies`, `devDependencies`, `peerDependencies`, or
  `optionalDependencies` it belongs in, and why.

## Range vs. pin, and how a change lands

- A runtime dependency declares a SemVer **range**, never an exact pin — the library
  does not own reproducibility here, `pnpm-lock.yaml` does.
- Add or bump through `pnpm add`, never by hand-writing a version into `package.json`. A
  hand-typed recent version can be younger than the cooldown below, and a pin has no
  older version to fall back to, so the install fails outright rather than resolving to
  something older.
- A dependency change and its `pnpm-lock.yaml` update belong in the same commit. The
  lockfile is generated, never hand-edited.
- Dev dependencies are kept current by bot PRs plus the lockfile, not by hand.
  **REQUIRED:** `merge-dependabot` to land one.

## The release-age cooldown

`pnpm-workspace.yaml` sets a `minimumReleaseAge` cooldown: a version published too
recently will not resolve, for any install. Treat this as behavior to design around, not
an obstacle to route past.

- A `^`/`~` range silently resolves to an older, already-cooled version instead of the
  newest matching one — this is expected, not a bug.
- An exact pin on a version younger than the cooldown fails the install outright, since
  there is no older matching version for a pin to fall back to.
- Before adding or bumping a dependency, check how long its target version has actually
  been published; do not assume `latest` will resolve.

### Exception process

For an urgent security fix younger than the cooldown, a human may approve an exact
`package@version` entry in `minimumReleaseAgeExclude`. The same PR must:

- cite the advisory,
- explain why waiting is riskier than skipping the cooldown,
- include the regenerated lockfile, and
- state when the exception will be removed.

Never add a wildcard entry or a package-only (unversioned) exclusion — the exception is
scoped to one exact version, not to the package forever.

## Supply-chain settings, as consequences

`pnpm-workspace.yaml` holds the values; this is what each one means when it fires. Read
the file for the current values rather than trusting a number copied here.

- `strictDepBuilds` plus `allowBuilds`: an install-time lifecycle script from a
  dependency that is not allowlisted fails the install **on purpose** — that is the
  intended outcome, not a bug to route around. `lefthook` is the one currently
  allowlisted entry, a reviewed exception because its postinstall is how its Git-hook
  binary is downloaded and linked. Adding another entry carries the same review weight
  as adding a new dependency.
- `strictPeerDependencies`: an unmet or conflicting peer range is a hard install
  failure, not a warning. This is what makes the TypeScript ceiling below an enforced
  constraint instead of an advisory one.
- `minimumReleaseAgeStrict`, `minimumReleaseAgeIgnoreMissingTime`, `trustPolicy`,
  `trustLockfile`, and `blockExoticSubdeps` each close a specific bypass of the cooldown
  above (an already-lockfiled version, missing publish-time metadata, downgraded
  provenance, and git/tarball transitive dependencies, respectively). When one of these
  fires, find out why the install is actually failing; AGENTS.md holds the prohibition
  on relaxing it.
- `verifyDepsBeforeRun: error`: a `pnpm run` whose `node_modules` no longer matches the
  lockfile fails instead of letting a gate pass against stale dependencies. The fix is
  `pnpm install`, never a weaker value. pnpm compares dependency fields and the settings
  above, so an unrelated manifest rewrite — the minimum-Node CI leg's
  `git restore package.json` — only costs a deeper check, not a failure.

## TypeScript version ceiling

`typescript` is held below the version that `typescript-eslint` and `typedoc` cap their
peer support at (see `package.json`'s `devDependencies` for the current range). With
`strictPeerDependencies` on, a bump past that ceiling fails the install rather than
merely warning.

Do not "upgrade typescript to latest." Raising this ceiling is a coordinated
multi-package upgrade — `typescript-eslint` and `typedoc` both need to raise their own
peer ranges first — not a routine dependency bump.

## Handoff

**REQUIRED:** `merge-dependabot` for landing an already-open bot PR against these rules.
