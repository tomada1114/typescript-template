# API reference

`normalizeIdentifier(input, options?)` converts text to an ASCII identifier.
Options control the separator, maximum length, and case normalization.

`withTimeout(operation, options)` supplies an `AbortSignal` and rejects with
`TimeoutError` when the deadline expires.

`InvalidInputError` reports rejected caller input through the stable
`ERR_INVALID_INPUT` code. `TimeoutError` uses `ERR_TIMEOUT`.

Run `pnpm docs:build` for the declaration-derived TypeDoc reference. The public
surface is also reviewed in `etc/my-package.api.md`.
