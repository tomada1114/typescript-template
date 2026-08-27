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
pnpm agents:sync   # regenerate .claude/skills/ from .agents/skills/
pnpm agents:check  # fail when the two skill trees have drifted apart
```

Run a single test file with `pnpm exec vitest run tests/<name>.test.ts`.

`pnpm check:quick` is the full local gate, and CI runs the same four package
scripts as separate steps, so a green run here means those are green too.
`lefthook`'s pre-commit hook runs a staged-file-scoped version of the same
tools — format applied rather than merely checked, tests limited to the ones
reachable from the staged files — before every commit. Nothing — not a hook,
not a workflow — defines a check of its own; they all call these scripts.

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
minimum-Node leg. Bootstrap does not install dependencies; run the documented
install step after the rewrite.

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

`scripts/**` must run on a plain Node before `pnpm install` has been run, so
it is authored as `.mjs` rather than TypeScript. It may only import `node:*`
builtins and the shared helpers under `scripts/lib/` — never a dependency
from `node_modules`; a script that needs an installed tool resolves it at run
time through `resolveDependencyBin` instead of importing it.

- Agent skills are authored once, under `.agents/skills/` — the path Codex CLI
  discovers project skills from — and `scripts/sync-agents.mjs` mirrors that
  tree into `.claude/skills/`, which is the only path Claude Code looks at.
  Both copies are committed real files rather than one being a symlink, so a
  fresh clone works on every platform and nothing follows a link into a
  skill's own subdirectories. Edit the `.agents/` copy, run `pnpm agents:sync`,
  and commit both sides; `pnpm agents:check` and `tests/sync-agents.test.ts`
  fail when they disagree.
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
  exports a temporary `GIT_INDEX_FILE`; `lefthook.yml` runs this suite from its
  pre-commit hook. An inherited `GIT_DIR` outranks both a `cwd` and an explicit `-C`, so a
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

Test files live in `tests/<module>.test.ts` — no co-location with `src/`.
`describe`/`it` names state behavior, not implementation
(`it("rejects a fractional timeout", …)`), one behavior per `it`.

- Test public behavior through `src/index.ts`'s exports, never through
  `src/internal/**`. Cover the happy path _and_ the error path of every
  public function.
- Assert the error class and its stable `code`, never the message text:
  `expect(() => fn()).toThrow(InvalidInputError)` for a sync throw,
  `await expect(promise).rejects.toThrow(TimeoutError)` for a rejection.
  Check that an error propagates through the whole call chain, and that
  cleanup runs on the failure path too, not only on success.
- Edge cases worth considering every time: `0`, `1`, negative, fractional
  where an integer is required, `Number.MAX_SAFE_INTEGER`; an absent optional
  property versus an explicit `undefined` (`exactOptionalPropertyTypes` makes
  those distinct); long, unicode, and emoji strings; single-element and
  duplicate-element collections; cancellation and cleanup for anything async.
  Use `it.each([...])` for input/output variations, labelled through the
  `%s`/`%p` placeholders in the title rather than a bare index.
- Prefer factory functions (`function makeX(overrides = {})`) over shared
  mutable fixtures. Filesystem tests use a fresh
  `mkdtempSync(path.join(tmpdir(), "prefix-"))` removed in `afterEach` with
  `rmSync(dir, { recursive: true, force: true })` — never write into a real
  project directory. Environment and global replacements go through
  `vi.stubEnv`/`vi.stubGlobal`, not direct mutation.
- `vitest.config.ts` sets `restoreMocks`, `clearMocks`, `unstubEnvs` and
  `unstubGlobals`, so an `afterEach` whose only body is
  `vi.restoreAllMocks()`/`vi.unstubAllEnvs()` is noise that hides the cleanup a
  test actually needs. Anything the runner does not know about — a timer, a
  listener, a temp directory, a child process — is still cleaned up explicitly,
  including after a failure.
- Mock only at boundaries (network, filesystem, clock, child process, random),
  never the module under test, and prefer a real in-memory fake to a mock for
  anything beyond a one-shot call. Assert on behavior and captured arguments
  rather than call counts, unless the count itself is the contract.
- No real `setTimeout` or sleep: `vi.useFakeTimers()` plus
  `await vi.advanceTimersByTimeAsync(ms)`, restored with `vi.useRealTimers()`.
  An abortable API is tested for the caller-visible effect of the abort and for
  the timer and listener it removes, on both outcomes (`tests/timeout.test.ts`
  is the model).
- Type tests live in `tests/types.test.ts` (`expectTypeOf`): inferred returns
  and generics, accepted and rejected inputs, discriminated-union narrowing.
  Two traps: a `@ts-expect-error` call written directly inside `it()` still
  _runs_, so wrap invalid calls in a function that is declared and never
  invoked; and `const error: A | B = new B()` narrows on the initializer, so a
  union type test must receive the value as a function parameter. This checks
  the source's own contract — the _published_ `.d.ts` is checked from a
  consumer's point of view by `pnpm package:smoke`.
- Tests are independent: no shared mutable module state, no ordering
  dependency, no dependence on timezone, locale, CPU count, or wall-clock time.
  Nothing is left as `it.skip`/`it.todo` on `main`, and a flaky test is fixed
  rather than retried.
- Coverage thresholds are a floor of 80% (lines, functions, statements,
  branches), never lowered, and no file is added to the coverage exclude list
  to make a number move. `coverage.include` is `src/**/*.ts`, so an untested
  file counts as 0% instead of vanishing from the denominator. Branch coverage
  is the one that matters — cover both sides of a conditional rather than
  writing a trivial test to move the percentage.

<!-- profile:node-cli:start -->

- `src/bin.ts` is deliberately at 0% unit coverage: it is a process-binding
  shim, all its logic lives in `src/cli.ts` (which is unit-tested), and
  `bin.ts` itself is exercised end-to-end by `tests/cli.test.ts` and the
  tarball smoke test (`pnpm package:smoke`).

<!-- profile:node-cli:end -->

- Anti-patterns: testing trivial property access while skipping business-logic
  edge cases; `toBeDefined()`/`not.toBeNull()` where a specific value is
  checkable; testing that a dependency works; mocking so much that the real
  code under test never runs.
- Property-based testing with `fast-check` is worth reaching for when a function
  has a well-defined invariant over a large input space — a round trip, an
  idempotent normalization, an ordering guarantee — not as a default. It is
  deliberately **not** a dependency today: the placeholder API does not need it,
  and adding it is a real dependency decision that goes through the review
  below.

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
  outside the permission allowlist, and `.claude/settings.json`'s
  `permissions.deny` refuses the common spellings of the dangerous ones:
  `--no-verify`, plain force-push, `npm`/`pnpm publish`, and workflow
  dispatch. Those entries are prefix patterns, so they catch the flag written
  directly after the subcommand and nothing more — the rule is the
  instruction here, not the pattern.
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

The rules above are enforced by three layers, from declarative to procedural.
Each layer holds only what belongs there — the rule itself lives in exactly
one place, never copied between layers:

| Layer                                        | Fires on              | Applies to             | Holds                                                             |
| -------------------------------------------- | --------------------- | ---------------------- | ----------------------------------------------------------------- |
| `.claude/settings.json`'s `permissions.deny` | every tool call       | Claude Code only       | Rules a path or command pattern can state declaratively           |
| `lefthook` pre-commit                        | `git commit`          | every author, any tool | Rules a staged diff, formatting, or a related-test run can decide |
| This file                                    | read at session start | every agent            | Everything else — the reasons behind the rules above              |

`permissions.deny` rules are a hard block, including in `bypassPermissions`
mode — they are not advisory. They are declarative pattern matches, though,
and the official Claude Code docs warn that a Bash pattern constraining
arguments is fragile: it cannot tell `git commit` from `git commit
--no-verify`, does not see through an `&&` chain or an `eval`, and a wrapper
like `sh -c '…'` defeats it entirely. That gap is accepted rather than closed
with a second, procedural Claude Code layer: an agent's own permission model
plus a human's approval on commit/push/PR/publish already cover a session's
realistic risk. The rules that must hold regardless of which tool or human is
committing — a staged secret, a stripped gate, a `.env` file about to land in
history — live in `lefthook`'s pre-commit hook instead, where every author
goes through the same gate.

Two consequences of that shape are worth naming rather than discovering:
`Read`/`Edit` deny rules classify a **tool call's path**, so they say nothing
about a shell command that opens the same file (`cat .env`,
`cp .env /tmp/x`); and turning the Git hooks off through the environment
(`LEFTHOOK=0 git commit …`) is invisible to both the pattern layer and the
hook it disables. Neither is enforced anywhere. "Never read or write `.env*`
or anything under `secrets/`" and "never bypass the hooks" hold as
instructions in this file, not as blocks — reaching for either spelling is
the thing being ruled out, not the spelling that happens to be caught.

`scripts/lib/guard/` is the rule engine `scripts/check-staged.mjs` (the
pre-commit layer) uses for the checks a staged diff's content, not just its
path, must decide: a credential pattern, a gate marker stripped from a config
file, a coverage threshold lowered below the floor. Its own header explains
exactly what it does and does not cover.

The lockfile rule is split on purpose, and is the clearest example of why a
rule sometimes belongs in only one layer: hand-editing `pnpm-lock.yaml` is
refused by `permissions.deny`, but **not** by `check-staged.mjs`. A
regenerated lockfile (`pnpm install`) is an ordinary, expected commit, and a
git diff cannot tell that apart from a hand edit — only a layer that sees the
actual tool call that produced the change can.

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
