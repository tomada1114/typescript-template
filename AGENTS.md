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
pnpm package:lint  # publint + are-the-types-wrong against a real tarball
pnpm package:smoke # install the tarball into throwaway consumers and run it
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
  publishes it, whatever the directory name suggests.
- Every public declaration carries a TSDoc release tag (`@public`). API
  Extractor fails without one.
- `scripts/*.mjs` is repository automation and never ships.

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

## Repository automation (`.mjs`)

`scripts/**` and `.claude/hooks/**` must run on a plain Node before
`pnpm install` has been run, so they are authored as `.mjs` rather than
TypeScript, and they import nothing from `node_modules`.

- Import Node globals explicitly — `import process from "node:process"`,
  `import console from "node:console"` — rather than relying on ambient globals.
- These files are type-checked (`allowJs` + `checkJs`), so declare boundary
  types in JSDoc. Receive `JSON.parse` output as `unknown` and narrow it with
  the helpers in `scripts/lib/json.mjs`.
- A file that is both importable and runnable guards its CLI half with
  `isMain(import.meta.url)` from `scripts/lib/is-main.mjs`. `import.meta.main`
  is Node 24+ and the floor is 22.14.
- An error raised by automation is read by an agent, so it says what failed, the
  path or export involved, expected versus actual, an error code, and the next
  safe command to run — and never a secret or an absolute home path.
  `scripts/lib/node-tools.mjs` has worked examples.

## Testing

Details live in `.claude/rules/testing.md`. The parts that shape decisions:

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

Every dependency is a permanent supply-chain commitment. Before adding one,
check that it is actively maintained, that its license is compatible, that its
transitive surface is small, and that it runs no unreviewed install scripts.
`pnpm-workspace.yaml` enforces the last point: an unapproved lifecycle script
makes the install fail on purpose.

`minimumReleaseAge` holds every version back for seven days, so the newest
release will not resolve yet. That is the cooldown working. A dependency change
and its `pnpm-lock.yaml` update belong in the same commit, and the lockfile is
generated — never hand-edited.

## Security and human approval

- **Commit, push, pull request, and publish always need a human.** They are
  outside the permission allowlist, and the guard hook hard-blocks the
  dangerous spellings: `--no-verify`, plain force-push, `npm`/`pnpm publish`,
  and workflow dispatch.
- Never read or write `.env*` (the `.example`, `.sample` and `.template`
  variants are fine) or anything under `secrets/`.
- Never write a credential into a tracked file — no registry auth token, no
  private key.
- Never weaken a gate to make a run pass: no lowered coverage threshold, no
  deleted security workflow, no removed `--frozen-lockfile`, no `@ts-ignore`,
  no blanket `eslint-disable`, no skipped or deleted test. If a gate is wrong,
  say so and let a human decide.

## Conventions

- All committed code, comments, configuration, and public documentation are in
  English.

<!-- template-only:start -->

- `docs/template-requirements/` is a verbatim Japanese copy of an external
  source and is neither translated nor reformatted.

<!-- template-only:end -->

- Do what was asked; nothing more. Prefer editing an existing file to creating a
  new one, and do not add documentation files that were not requested.
- Note improvements you spot outside the current scope instead of making them.
