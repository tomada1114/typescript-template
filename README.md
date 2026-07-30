# my-package

A short description.

> **Note for maintainers of this template repository**
>
> This repository is the TypeScript/npm package template itself, so the package
> metadata above is still the placeholder that `scripts/bootstrap.mjs` will
> replace. Template development is tracked in
> [`docs/template-implementation/`](docs/template-implementation/README.md) —
> start there. The requirements are in
> [`docs/template-requirements/`](docs/template-requirements/README.md).
>
> **Current state: Template Phase 0 complete.** `pnpm check:quick` passes on
> Node 22.14.0 and Node 24.18.1. The full `pnpm check` gate lands in Phase 1.
> Product-specific code, including the future `zukai` implementation, does not
> belong in this repository.

## Requirements

- Node.js >= 22.14 (development uses Node 24)
- pnpm 11 (managed through Corepack)

## Install

```sh
pnpm add my-package
```

## Usage

```ts
import { normalizeIdentifier, withTimeout } from "my-package";

normalizeIdentifier("Hello World");
// "hello-world"

normalizeIdentifier("Release v2 build 30", { separator: "_", maxLength: 12 });
// "release_v2"

const value = await withTimeout((signal) => fetch("https://example.com", { signal }), {
  timeoutMs: 5_000,
});
```

Every public symbol is exported by name from the package root. There is no
default export, and paths outside `exports` are private.

## API

- `normalizeIdentifier(input, options?)` — turn arbitrary text into a URL- and
  filename-safe ASCII identifier.
- `withTimeout(operation, options)` — run an abortable operation under a
  deadline, forwarding the caller's `AbortSignal`.
- `InvalidInputError` — a caller-supplied value was rejected
  (`code: "ERR_INVALID_INPUT"`, plus the offending `field`).
- `TimeoutError` — the deadline passed (`code: "ERR_TIMEOUT"`, plus `timeoutMs`).

## Development

```sh
corepack pnpm@11.18.0 install --frozen-lockfile
pnpm check:quick   # format, lint, typecheck, tests
pnpm fix           # lint autofix, then Prettier
```

See [`docs/template-implementation/README.md`](docs/template-implementation/README.md)
for the full toolchain setup, including how to run the gates against the minimum
supported Node version.

## License

MIT
