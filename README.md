# my-package

[![CI](https://github.com/your-name/my-package/actions/workflows/ci.yml/badge.svg)](https://github.com/your-name/my-package/actions/workflows/ci.yml)

A short description.

## Install

```sh
pnpm add my-package
```

Requires Node.js 22.14 or newer. The package ships ESM only; on that range
`require(esm)` is unflagged, so a CommonJS consumer can `require("my-package")`
directly.

## Quick start

```ts
import { normalizeIdentifier } from "my-package";

console.log(normalizeIdentifier("Hello World"));
// => "hello-world"
```

All public symbols are named exports from the package root. Deep imports are
private and blocked by the package export map.

## API

- `normalizeIdentifier(input, options?)` creates a URL- and filename-safe ASCII
  identifier using `-`, `_`, `.`, or `~` as its separator.
- `withTimeout(operation, options)` runs an abortable operation with a deadline.
- `InvalidInputError` and `TimeoutError` expose stable error codes.

See [Getting started](docs/getting-started.md), the
[API reference](docs/reference.md), and the generated TypeDoc documentation from
`pnpm docs:build`.

<!-- template-only:start -->

## Use this template

Create a repository with GitHub's **Use this template** button, then run the
interactive bootstrap before installing dependencies:

```sh
node scripts/bootstrap.mjs
```

Answer the prompts for the package name, profile, author, email, GitHub user,
license, and description. For automation, pass the package name together with
the `--profile`, `--author`, `--email`, `--github-user`, and `--license` flags.

Use `node-cli` for an importable library with a command-line executable, or
`universal-library` for code that must build without Node APIs. Bootstrap removes
this section and the template implementation documents from the generated
repository.
<!-- template-only:end -->

## Development

```sh
corepack pnpm@11.18.0 install --frozen-lockfile
pnpm hooks:install
pnpm check
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the complete workflow.

## License

[MIT](LICENSE) © Your Name
