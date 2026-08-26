# Project Guide

This file is the source of truth for every agent working in this repository.
Tool-specific files (`CLAUDE.md` and anything like it) add only what is specific
to that tool; they never restate what is here.

Machine-enforceable rules are not written down here either. `eslint.config.mjs`,
`tsconfig.json`, `.prettierrc.json`, `vitest.config.ts` and `pnpm-workspace.yaml`
are the source of truth for those, and running the gate is how you learn them.
What follows is the part a config cannot express: what this package promises,
where its boundaries are, and which decisions need a human.

## Overview

An ESM-only TypeScript package published to npm. Development runs on Node 24;
the published contract supports Node >= 22.14. pnpm 11 is the package manager,
used through Corepack.

## Quick reference

```sh
pnpm check:quick   # format check, lint, typecheck, tests — the everyday gate
pnpm check         # the full gate, including build, API report, and packaging
pnpm fix           # ESLint autofix, then Prettier
pnpm test          # tests only
pnpm test:coverage # tests with the coverage thresholds enforced
pnpm build         # emit dist/ from src/
pnpm api:update    # regenerate etc/*.api.md after an intentional API change
pnpm api:check     # fail when the API report is out of date
pnpm package:check # build and pack once, then run every artifact check
pnpm package:lint  # compatibility alias for package:check
pnpm package:smoke # install the tarball into throwaway consumers and run it
pnpm changeset:check # verify that a PR records release intent
pnpm docs:build    # TypeDoc into docs/api/
```

Run a single test file with `pnpm exec vitest run tests/<name>.test.ts`.

`pnpm check:quick` is what the pre-push hook runs, and CI runs the same four
package scripts as separate steps, so a green run here means those are green
too. Nothing — not a hook, not a workflow — defines a check of its own; they all
call these scripts.

### Verifying against the minimum supported Node

`devEngines.runtime` pins development to Node 24 and pnpm treats a mismatch as a
hard error. Checking that the package still works on the minimum supported Node
is the one case where that check is deliberately waived:

```sh
pnpm --config.runtime-on-fail=ignore run check
```

No other spelling works. Do not relax `onFail` in `package.json` to make this
easier.

`pnpm install` — and only `install`, not `run` — materializes its effective
settings back into `package.json`, so an install carrying that flag rewrites
`devEngines.runtime.onFail` to `"ignore"` on disk. Restore the manifest
(`git restore package.json`) before anything reads it. CI does this in the
minimum-Node leg, and `scripts/bootstrap.mjs` does the same around its
lockfile regeneration.

## Architecture

```
src/
├── index.ts      # the public contract: the only module consumers can import
├── internal/     # private; never re-exported from index.ts
<!-- profile:node-cli:start -->
├── cli.ts        # testable CLI logic — runCli(argv, io)
├── bin.ts        # the executable shim that binds runCli to the process
<!-- profile:node-cli:end -->
└── *.ts          # implementation modules, re-exported by name from index.ts
```

- `src/index.ts` is the single entry point of the public contract. Every public
  symbol is re-exported from it by name. There is no default export and no
  `export *`, so the published surface is always something you can read.
- `exports` and `files` in `package.json` are allowlists. A path that is not
  listed is private, and deep imports into `dist/` are expected to fail.
- `src/internal/` is private. Exporting one of its symbols from `index.ts`
  publishes it, whatever the directory name suggests, and nothing outside
  `src/**` may import it directly.
- Every public declaration carries a TSDoc release tag (`@public`). API
  Extractor fails the build without one (`ae-missing-release-tag`); the
  `etc/` directory must also already exist for `api-extractor run` to write
  its report at all.
- `scripts/*.mjs` is repository automation and never ships.

<!-- profile:node-cli:start -->

- Inject I/O, environment, and the clock as parameters instead of touching
  globals directly (`src/cli.ts`'s `CliIo` is the model: `stdout`/`stderr`
  callbacks and `version` are passed in, so `runCli` is a pure function
  testable without spawning a process). `src/bin.ts` is the only place that
  binds these to the real process.
- Keep the CLI split in mind when adding commands: business logic and
  argument parsing live in `src/cli.ts` (unit-tested); `src/bin.ts` stays a
  thin shim that binds `runCli` to the real process and argv, producing the
  executable `dist/bin.js`.

<!-- profile:node-cli:end -->

## Changing the public API

A change to the public surface is a change to a contract other people depend on.
Everything it touches lands in the **same pull request**:

1. the implementation in `src/`
2. behavior tests in `tests/`
3. type tests (`expectTypeOf`) for the new or changed signatures
4. the regenerated API report — `pnpm api:update`, with `etc/*.api.md` committed
5. the README example and any affected page under `docs/`
6. a Changeset (`pnpm changeset`) describing the change and its semver impact

A PR that adds an export without the report update fails `pnpm api:check`. That
failure is the design working, not an obstacle to route around.

Every other PR records an empty Changeset with `pnpm changeset --empty`, so CI
can distinguish an explicit "no release" decision from a forgotten Changeset.

## Filing and triaging issues

Labels carry the triage decision, so it is made once and read back rather than
re-derived every time the backlog is looked at. An issue is filed with a type
label and left untiered; triage adds the priority.

| Label                 | Means                                                                                              |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| `priority: P0`        | Ship now — other open issues are blocked on it, or damage is being taken (red main, vulnerability) |
| `priority: P1`        | Do next — leverage: CI, schema, shared types, config, the ground later issues stand on             |
| `priority: P2`        | Normal — a real, self-contained change; nothing waits on it                                        |
| `priority: P3`        | Defer — nice-to-have, docs polish, cosmetics                                                       |
| `blocked: design`     | The approach is not settled; needs a human decision before anyone implements it                    |
| `blocked: dependency` | Waits on a specific open issue named by a `Depends on: #N` line in the body                        |
| `on hold`             | Not implementable as filed — a container issue, or parked pending something outside the tracker    |

Priority here means impact on the rest of the backlog, not how interesting the
work is. Tier and design-readiness are independent: an issue carrying
`blocked: design` still gets a tier, so it ranks correctly the moment the block
clears. A label that turns out to be wrong gets corrected, not worked around —
ranking around a stale label in your head leaves the next reader to make the
same mistake.

Two things belong in the issue body because nothing else can recover them
later: what is wrong today, with a `path:line`, and what observable result
closes it — named as a test or a command, not as a feeling of doneness. An
ordering constraint between issues is written as `Depends on: #12`, which is
the spelling automation parses; prose like "after the guard work lands" is not.
An issue carrying that line also carries `blocked: dependency`; the label is
not removed automatically when the blocker closes, so whoever lands the
blocking issue clears it by hand from the issues that named it.

The type labels are `bug`, `enhancement`, `documentation`, `chore`, and
`security`. Only the first three are GitHub defaults, so `chore` and `security`
have to be created before the forms in `.github/ISSUE_TEMPLATE/` can apply
them — GitHub silently drops a label a repository does not have, rather than
reporting one.

## Repository automation (`.mjs`)

`scripts/**` and `.agents/hooks/**` must run on a plain Node before
`pnpm install` has been run, so they are authored as `.mjs` rather than
TypeScript. They may only import `node:*` builtins, the shared helpers under
`scripts/lib/`, and helpers local to their own tree (`.agents/hooks/` for
the hooks) — never a dependency from `node_modules`; a hook that
needs an installed tool resolves it at run time through
`resolveDependencyBin` instead of importing it.

- Import Node globals explicitly — `import process from "node:process"`,
  `import console from "node:console"` — rather than relying on ambient globals.
- These files are type-checked (`allowJs` + `checkJs`), so declare boundary
  types in JSDoc (`@param`, `@returns`, `@typedef`) with the same rigor as a
  `.ts` signature. Receive `JSON.parse` output as `unknown` and narrow it
  through `readKey`/`readString` in `scripts/lib/json.mjs`, not a direct
  cast — `noPropertyAccessFromIndexSignature` and the typed-lint
  `dot-notation` rule disagree about literal-key access on a `Record`, so
  reads go through these helpers instead of either style.
- A file that is both importable and runnable guards its CLI half with
  `isMain(import.meta.url)` from `scripts/lib/is-main.mjs`. `import.meta.main`
  is Node 24+ and the floor is 22.14.
- Git exports `GIT_DIR` to every hook it runs, and `git commit -- <path>` also
  exports a temporary `GIT_INDEX_FILE`; `lefthook.yml` runs this suite from two
  hooks. An inherited `GIT_DIR` outranks both a `cwd` and an explicit `-C`, so a
  `git` that names the repository it means clears `GIT_*` first, with
  `isolatedGitEnv` from `scripts/lib/git-env.mjs`. The exception is
  `scripts/check-staged.mjs`, which is the pre-commit layer and must read the
  index that hook was given; its tests clear the variables from their own
  process with `vi.stubEnv` instead, and so do `tests/bootstrap.test.ts`'s.
- An error raised by automation is read by an agent, so it says what failed, the
  path or export involved, expected versus actual, an error code, and the next
  safe command to run — and never a secret or an absolute home path.
  `scripts/lib/node-tools.mjs` has worked examples:

  ```
  ERR_DEPENDENCY_MISSING: eslint is not installed.
  Expected: node_modules/eslint/package.json
  Next: run `pnpm install --frozen-lockfile`.
  ```

## Conventions: `src/**/*.ts`

### Error handling

- Package errors (`InvalidInputError`, `TimeoutError` in `src/errors.ts`)
  subclass `Error`, set `this.name`, and carry a `readonly code` typed as a
  string literal (`"ERR_INVALID_INPUT" as const`). `code` is part of the
  published contract and is safe to branch on; `message` is for humans and
  may be reworded in a patch release, so never match on it.
- New error types follow the same shape: a stable `code`, domain-specific
  readonly fields describing what was rejected (never the rejected value
  itself when it could be sensitive), and a human `message`.
- `InvalidInputError.field` is the dotted path of the rejected argument as
  written in the public signature (`options.maxLength`), not an internal
  variable name.
- An `AbortSignal` that a function forwards an abort onto uses the same error
  instance as the promise rejection, so a cooperating caller can inspect why
  it was cancelled (see `src/timeout.ts`).

### Naming and constants

- Error `code` strings use an `ERR_` prefix in `SCREAMING_SNAKE_CASE`
  (`ERR_INVALID_INPUT`, `ERR_TIMEOUT`). Script error codes are additionally
  prefixed by the stage that raised them (`ERR_SMOKE_*`, `ERR_ATTW_*`,
  `ERR_DEPENDENCY_*`) so stderr alone identifies which check failed.
- Keep a constant next to the code that uses it; do not create a shared
  `constants.ts` grab-bag that forces unrelated modules to import each other.

### Type system judgment

- Public option objects (`XOptions`) use readonly properties, mirroring
  `NormalizeIdentifierOptions` and `WithTimeoutOptions`.
- Prefer a discriminated union with a literal field (`code`, `kind`) over a
  bag of optional flags when a value has mutually exclusive shapes, and
  narrow it by branching on that field rather than checking several optional
  properties together.
- Keep exported generics narrow: accept the widest reasonable input, return
  the narrowest true output (`withTimeout` preserves the operation's own
  resolved type instead of widening it).

## Testing

Details live in `tests/AGENTS.md` — a Codex session started at the repository
root does not read it; one started inside `tests/` does. The parts that shape
decisions from anywhere in the repo:

- Test behavior and contracts through the public interface, never private
  modules directly. Cover the happy path _and_ the error path.
- Coverage thresholds are a floor of 80% and are never lowered, and no file is
  added to the coverage exclude list to make a number move.
- Property-based testing with `fast-check` is worth reaching for when a function
  has a well-defined invariant over a large input space — a round trip, an
  idempotent normalization, an ordering guarantee. It is deliberately **not** a
  dependency today: the placeholder API does not need it, and adding it is a
  real dependency decision that goes through the review below.

## Dependencies

Every dependency is a permanent supply-chain commitment. Before adding a
runtime dependency, record in the PR that adds it:

- Why a small hand-written helper or a Node builtin cannot replace it.
- Maintainer and release continuity — is it actively maintained, not abandoned.
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
hand. A dependency change and its `pnpm-lock.yaml` update belong in the same
commit, and the lockfile is generated — never hand-edited.

### `minimumReleaseAge` (supply-chain cooldown)

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
- For an urgent security fix younger than seven days, a human may approve an
  exact `package@version` entry in `minimumReleaseAgeExclude`. The same PR must
  cite the advisory, explain why waiting is riskier, include the generated
  lockfile, and state when the exception will be removed. Never add a wildcard
  or a package-only exclusion.

### `pnpm-workspace.yaml` supply-chain policy

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
- `verifyDepsBeforeRun: error`: a `pnpm run` whose `node_modules` no longer
  matches the lockfile fails instead of letting a gate pass against stale
  dependencies. The fix is `pnpm install`, never a weaker value — pnpm
  compares dependency fields and the settings above, so an unrelated
  manifest rewrite (the minimum-Node leg's `git restore package.json`) only
  costs a deeper check, not a failure.

### TypeScript version ceiling

- `typescript` stays at `~6.0.3`. `typescript-eslint@8.65.0` caps peer
  support below `6.1.0` and `typedoc@0.28.20` caps it at `6.0.x`; with
  `strictPeerDependencies: true`, a 7.x bump fails the install rather than
  merely warning.
- Do not "upgrade typescript to latest" — the registry's `latest` (7.x as of
  this writing) is incompatible with this toolchain until `typescript-eslint`
  and `typedoc` raise their peer ranges. Raising this ceiling is a
  coordinated multi-package upgrade, not a routine dependency bump.

## Security and human approval

- **Commit, push, pull request, and publish always need a human.** They are
  outside the permission allowlist, and the guard hook hard-blocks the
  dangerous spellings: `--no-verify`, plain force-push, `npm`/`pnpm publish`,
  and workflow dispatch.
- Never read or write `.env*` (the `.example`, `.sample` and `.template`
  variants are fine) or anything under `secrets/`.
- Never write a credential into a tracked file — no registry auth token, no
  private key.
- Never weaken a gate to make a run pass: no lowered coverage threshold (the
  `lines`/`functions`/`statements`/`branches` floor in `vitest.config.ts`,
  all at 80), no deleted security workflow, no removed `--frozen-lockfile`,
  no removed ESLint rule or `pnpm-workspace.yaml` supply-chain setting, no
  `@ts-ignore`, no blanket `eslint-disable`, no skipped or deleted test. If a
  gate is wrong, say so and let a human decide.

## Enforcement layers

The rules above are enforced by four layers, from declarative to procedural.
Each layer holds only what belongs there — the rule itself lives in exactly
one place, never copied between layers:

| Layer                                        | Fires on                  | Applies to             | Holds                                                                |
| -------------------------------------------- | ------------------------- | ---------------------- | -------------------------------------------------------------------- |
| `.claude/settings.json`'s `permissions.deny` | every tool call           | Claude Code only       | Rules a path or command pattern can state declaratively              |
| `.agents/hooks/guard.mjs` (PreToolUse)       | supported local tool call | Claude Code and Codex  | Pending shell commands and edits, including multi-file Codex patches |
| `lefthook` pre-commit / pre-push             | `git commit` / `git push` | every author, any tool | Rules a staged diff or the full test suite can decide                |
| This file                                    | read at session start     | every agent            | Everything else — the reasons behind the rules above                 |

Claude's `permissions.deny` rules are a hard block, including in
`bypassPermissions` mode — they are not advisory. They are declarative pattern
matches, though, so the shared `guard.mjs` also enforces them for Codex and
catches semantic cases such as `--no-verify` inside an `&&` chain. Static shell
inspection remains best-effort, and Codex documents that specialized tool paths
may opt out of hooks; `lefthook`, CI, and this file remain the enforcement layers
when a lifecycle hook cannot observe a call.

The shared hook scripts live in `.agents/hooks/` and are wired from both
`.claude/settings.json` and `.codex/hooks.json`; start Claude Code at the
repository root because a subdirectory launch does not load root project hooks.
Codex requires a trusted project layer and exact command-definition review, so
use `/hooks` after first checkout and after a hook command changes. The rule
engine lives in `scripts/lib/guard/`, imported by `guard.mjs` and
`scripts/check-staged.mjs` alike, so the policy is not duplicated.

The lockfile rule is split on purpose, and is the clearest example of why a
rule sometimes belongs in only one layer: hand-editing `pnpm-lock.yaml` is
refused by `permissions.deny` and by `guard.mjs`, but **not** by
`check-staged.mjs`. A regenerated lockfile (`pnpm install`) is an ordinary,
expected commit, and a git diff cannot tell that apart from a hand edit —
only a layer that sees the actual tool call knows which command produced the
change.

## Conventions: `docs/**/*.md`, `README.md`, `CONTRIBUTING.md`, `CHANGELOG.md`

- Document non-obvious behavior, architecture decisions, and trade-offs. Do
  not restate what the code or the type system already says — the same
  principle TSDoc follows in `src/**` (see "Conventions: `src/**/*.ts`" above).
- Code examples must be valid TypeScript that compiles against the _current_
  public API (`src/index.ts`). A change to the public API updates the README
  example in the same commit as the code — part of the same-PR checklist in
  "Changing the public API" above.

### Purpose per file

- `README.md`: value proposition readable in 30 seconds, the install
  command, a minimal working example, supported Node/runtime versions, and
  where the full API documentation lives.
- `CONTRIBUTING.md`: local setup, the main `pnpm` commands, how to run
  tests, how to add a Changeset, and the PR process.
- `CHANGELOG.md`: Keep a Changelog categories and SemVer. It is generated by
  Changesets release tooling and is Prettier-ignored for that reason — don't
  hand-edit entries, add a changeset with `pnpm changeset` instead.

### Generated and copied trees

- `docs/api/` is TypeDoc output (`pnpm docs:build`). It is generated and
  must never be hand-edited — change the TSDoc comments in `src/**` and
  regenerate instead.

<!-- template-only:start -->

- `docs/template-requirements/` is a verbatim copy of an external source of
  truth. It is listed in `.prettierignore` on purpose: never reflow,
  retranslate, or otherwise edit it from this repository.
- `docs/template-implementation/` is working notes for this template's own
  build-out. Treat `decisions.md` in there as verified fact, not something
  to re-investigate or re-decide from a documentation change.
  The `template-only` HTML-comment markers identify guidance that bootstrap
  removes from generated repositories. A `profile:<name>` marker block is kept
  only for its matching bootstrap profile; do not edit these marker forms.

<!-- template-only:end -->

## Conventions

- All committed code, comments, configuration, and public documentation are in
  English.

- Do what was asked; nothing more. Prefer editing an existing file to creating a
  new one, and do not add documentation files that were not requested.
- Note improvements you spot outside the current scope instead of making them.
