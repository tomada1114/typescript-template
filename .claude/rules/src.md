---
paths:
  - "src/**"
---

# Library source

ESLint and the compiler already reject `enum`, `export *`, default exports, imports into
`src/internal/` from outside `src/`, a `default` added to silence an exhaustive switch,
and an undocumented public symbol. What follows is the judgment they cannot make.

## The public surface

- `src/index.ts` is the whole contract, re-exported by name. A line added there is a
  public-API decision made at that moment; a line removed is a break. A new subpath in
  `package.json#exports` weighs the same as a new symbol.
- `src/internal/` is private because of the directory, not the file name. `src/cli.ts`
  is a command entry, tested through `argv`, exit code and output, never re-exported.
- Every public declaration carries TSDoc with `@public`. A public type that references
  an unexported type leaves consumers unable to name it.
- A surface change obliges, in the same pull request: behavior tests, type tests in
  `tests/types.test.ts`, the README example, and a `Release impact:` line. **REQUIRED:**
  `release-impact` for the semver level.

## Types at boundaries

- Take `unknown` at an untyped boundary and narrow it; `any` turns checking off for
  everything downstream. Prefer `satisfies` to `as`; an assertion gives no runtime
  safety, so narrow on runtime shape with a type guard.
- Prefer `interface X extends Y` to `type X = Y & Z`: intersections are much slower to
  check.
- `noUncheckedIndexedAccess`: treat the `undefined` branch as real. Under
  `exactOptionalPropertyTypes` a public `XOptions` interface declares `readonly` `?:`
  properties; an internal argument whose omission would be a bug takes a required
  `T | undefined`.
- Annotate the return type of every non-generic export. On a generic export, annotate
  only when the annotation is provably no wider than inference, and pin the signature
  with an `expectTypeOf` test either way: a hand-written annotation is the usual way a
  generic gets widened. Accept the widest reasonable input, return the narrowest true
  output.
- Model mutually exclusive shapes as a discriminated union on a literal field, not a bag
  of optional flags.
- Whether `node:` imports are allowed depends on the bootstrap profile: read
  `tsconfig.build.json`'s `compilerOptions.types` (`["node"]` allows them, `[]` is the
  universal profile, which rejects them).
- Keep a constant next to the code that uses it; no shared `constants.ts`.

## Errors

- **`code` is the contract; `message` is not.** Callers branch on `code`, which changes
  only in a breaking release; `message` may be reworded in a patch.
- Subclass `Error`, set `this.name`, declare `readonly code = "ERR_…" as const`. Add
  `readonly` fields describing what was rejected (a limit, the dotted option path as
  written in the public signature such as `options.maxLength`) — never the rejected
  value itself.
- `ERR_` prefix, `SCREAMING_SNAKE_CASE`, naming the failure, not the function. Several
  structurally different failures are a union keyed on `code`, not one class with
  optional fields. A `scripts/**` code also carries the prefix of the check that raised
  it (`ERR_SMOKE_*`, `ERR_ATTW_*`, `ERR_DEPENDENCY_*`); reuse an existing prefix.
- When forwarding an abort to an `AbortSignal`, abort with the same error instance the
  promise rejects with (`withTimeout` in `src/timeout.ts` does this).
- Adding, renaming or removing a `code` on a public error is a contract change.
