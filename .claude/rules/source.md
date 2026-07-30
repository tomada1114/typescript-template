---
paths:
  - "src/**/*.ts"
  - "scripts/**/*.mjs"
  - ".claude/hooks/**/*.mjs"
---

## Architecture

- `src/index.ts` is the only entry point of the public contract. Every public
  symbol is re-exported by name from it (see `src/index.ts` itself for the
  pattern).
- `src/internal/**` is private implementation detail. It must never be
  re-exported from `src/index.ts`, and nothing outside `src/**` may import it.
- Every public declaration carries a TSDoc release tag (`@public`). API
  Extractor fails the build without one (`ae-missing-release-tag`); the
  `etc/` directory must also already exist for `api-extractor run` to write
  its report at all.
- Inject I/O, environment, and the clock as parameters instead of touching
  globals directly (`src/cli.ts`'s `CliIo` is the model: `stdout`/`stderr`
  callbacks and `version` are passed in, so `runCli` is a pure function
  testable without spawning a process). `src/bin.ts` is the only place that
  binds these to the real process.
- Keep the CLI split in mind when adding commands: business logic and
  argument parsing live in `src/cli.ts` (unit-tested); `src/bin.ts` stays a
  thin shim that binds `runCli` to the real process and argv.

## Error handling

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

### Agent-facing errors (`scripts/**`)

Repository automation is read by an agent as often as by a human. An error
thrown or printed from `scripts/**` states, in this order: what failed, the
path/export/profile involved, expected vs. actual, the next safe command to
run, and an error code. It never leaks a secret or an absolute home path —
report paths relative to the repository root. See
`scripts/lib/node-tools.mjs` (`npmCliPath`, `resolveDependencyBin`) and
`scripts/smoke-package.mjs`'s `fail()` helper for the concrete shape:

```
ERR_DEPENDENCY_MISSING: eslint is not installed.
Expected: node_modules/eslint/package.json
Next: run `pnpm install --frozen-lockfile`.
```

## `.mjs` conventions

- `scripts/**/*.mjs` and `.claude/hooks/**/*.mjs` must run on plain Node before
  `pnpm install`, so they may only import `node:*` builtins and the shared
  helpers under `scripts/lib/` — never a dependency from `node_modules`. A hook
  that shells out to an installed tool resolves it at run time through
  `resolveDependencyBin` instead of importing it.
- Node globals are explicitly imported (`import process from "node:process"`,
  `import console from "node:console"`) rather than relied on as ambient.
- These files are type-checked by `checkJs`. Declare boundary types in JSDoc
  (`@param`, `@returns`, `@typedef`) with the same rigor as a `.ts` signature.
- `JSON.parse` output is received as `unknown` (see `scripts/lib/json.mjs`'s
  `parseJson`) and narrowed through `readKey`/`readString`, not cast directly
  — `noPropertyAccessFromIndexSignature` and the typed-lint `dot-notation`
  rule disagree about literal-key access on a `Record`, so reads go through
  these helpers instead of either style.
- A file that is both importable (from tests) and runnable as a CLI guards
  its CLI half with `isMain(import.meta.url)` from `scripts/lib/is-main.mjs`.
  `import.meta.url.endsWith(...)` is true on import too and cannot make this
  distinction.
- Minimum supported Node is 22.14. Do not use a Node 24-only API — concretely,
  use `isMain()` above instead of `import.meta.main`, which does not exist
  before Node 24.

## Naming and constants

- Error `code` strings use an `ERR_` prefix in `SCREAMING_SNAKE_CASE`
  (`ERR_INVALID_INPUT`, `ERR_TIMEOUT`). Script error codes are additionally
  prefixed by the stage that raised them (`ERR_SMOKE_*`, `ERR_ATTW_*`,
  `ERR_DEPENDENCY_*`) so stderr alone identifies which check failed.
- Keep a constant next to the code that uses it; do not create a shared
  `constants.ts` grab-bag that forces unrelated modules to import each other.

## Type system judgment

- Public option objects (`XOptions`) use readonly properties, mirroring
  `NormalizeIdentifierOptions` and `WithTimeoutOptions`.
- Prefer a discriminated union with a literal field (`code`, `kind`) over a
  bag of optional flags when a value has mutually exclusive shapes, and
  narrow it by branching on that field rather than checking several optional
  properties together.
- Keep exported generics narrow: accept the widest reasonable input, return
  the narrowest true output (`withTimeout` preserves the operation's own
  resolved type instead of widening it).
