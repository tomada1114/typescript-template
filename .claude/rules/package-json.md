---
paths:
  - "package.json"
  - "pnpm-workspace.yaml"
---

## Dependency review (before adding any runtime dependency)

Record, in the PR that adds it:

- Why a small hand-written helper or a Node builtin cannot replace it.
- Maintainer and release continuity — is it actively maintained, not
  abandoned.
- License compatibility (MIT/BSD/Apache-class; a copyleft license needs a
  deliberate, explicit reason for a published library).
- Direct and transitive package count it pulls in — a large transitive
  surface is a real cost even behind a small direct API.
- Whether it runs an install script, ships a native binary, or does network
  access — each needs its own justification and, for install scripts, an
  `allowBuilds` entry (see below).
- Unpacked size and its effect on this package's own published tarball.
- Supported Node versions and module format (ESM/CJS) against this
  package's own `engines`/`exports`.
- Open security advisories and npm provenance.
- Whether it belongs in `dependencies`, `devDependencies`,
  `peerDependencies`, or `optionalDependencies`, and why.

Runtime dependencies declare a SemVer range, never an exact pin — the
library does not own reproducibility, `pnpm-lock.yaml` does. Dev
dependencies are kept current by Dependabot PRs plus the lockfile, not by
hand.

## `minimumReleaseAge` (supply-chain cooldown)

`pnpm-workspace.yaml` sets `minimumReleaseAge: 10080` (7 days): a version
published less than 7 days ago will not resolve, for any install.

- A `^`/`~` range on a dependency silently resolves to an older,
  already-cooled version instead of the newest matching one — this is
  expected, not a bug (for example `eslint` resolved to `10.7.0` while
  `10.8.0` already existed on the registry).
- An exact pin on a version younger than 7 days fails the install outright,
  since there is no older version for a pin to fall back to.
- Before adding or bumping a dependency, check how long its target version
  has been published; do not assume `latest` will resolve.

## `exports` and `files` are allowlists

- Together they are the entire public surface of the published tarball;
  anything not listed is unreachable by a consumer (the tarball smoke test's
  deep-import check enforces this).
- Adding a public entry point — a new `exports` subpath, a new `bin` — is a
  deliberate contract change, not a packaging detail. It needs the API
  Extractor report, README/API docs, and a Changeset updated in the same PR
  (`.claude/rules/docs.md`).

## Quality gates

- Never lower the coverage thresholds in `vitest.config.ts` (`lines`,
  `functions`, `statements`, `branches`, all at 80) without explicit human
  approval and a written reason.
- Never remove an ESLint rule, a `pnpm-workspace.yaml` supply-chain setting,
  or a CI security gate without explicit human approval.

## Lockfile

- `pnpm-lock.yaml` is generated; never hand-edit it.
- A dependency change and its lockfile update land in the same commit —
  never a `package.json` edit without the matching lockfile update.

## `pnpm-workspace.yaml` supply-chain policy

- `strictDepBuilds: true` plus `allowBuilds`: an install-time lifecycle
  script from a dependency not listed in `allowBuilds` fails the install on
  purpose — that is the intended outcome, not a bug to route around. Only
  `lefthook: true` is currently allowlisted, a reviewed exception because
  lefthook's postinstall is how its Git-hook binary gets downloaded and
  linked. Adding another entry carries the same review weight as adding a
  new dependency.
- `strictPeerDependencies: true`: an unmet or conflicting peer range is a
  hard install failure, not a warning. This is what makes the TypeScript
  version ceiling below an enforced constraint instead of an advisory one.
- `minimumReleaseAgeStrict`, `minimumReleaseAgeIgnoreMissingTime`,
  `trustPolicy`, `trustLockfile`, and `blockExoticSubdeps` each close a
  specific bypass of the cooldown above (an already-lockfiled version,
  missing publish-time metadata, downgraded provenance, and git/tarball
  transitive dependencies, respectively). Do not relax any of them to
  unblock a failing install — find out why the install is actually failing
  first.

## TypeScript version ceiling

- `typescript` stays at `~6.0.3`. `typescript-eslint@8.65.0` caps peer
  support below `6.1.0` and `typedoc@0.28.20` caps it at `6.0.x`; with
  `strictPeerDependencies: true`, a 7.x bump fails the install rather than
  merely warning.
- Do not "upgrade typescript to latest" — the registry's `latest` (7.x as of
  this writing) is incompatible with this toolchain until `typescript-eslint`
  and `typedoc` raise their peer ranges. Raising this ceiling is a
  coordinated multi-package upgrade, not a routine dependency bump.
