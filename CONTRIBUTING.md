# Contributing

## Setup

Use Node.js 24 and pnpm 11 through Corepack:

```sh
corepack enable
corepack pnpm@11.18.0 install --frozen-lockfile
pnpm hooks:install
pnpm check
```

Useful focused commands are `pnpm check:quick`, `pnpm test`,
`pnpm test:coverage`, `pnpm build`, `pnpm api:check`, and
`pnpm package:smoke`.

## Bootstrap profiles

The template starts as the superset `node-cli` profile. Bootstrap makes one
irreversible choice for the generated repository:

| Profile             | Runtime contract                                   | CLI files and `bin` | `sideEffects`      |
| ------------------- | -------------------------------------------------- | ------------------- | ------------------ |
| `node-library`      | Node.js >= 22.14                                   | removed             | `false`            |
| `node-cli`          | Node.js >= 22.14, importable API plus executable   | retained            | `dist/bin.js` only |
| `universal-library` | ES and DOM APIs; Node built-ins fail the src build | removed             | `false`            |

The universal profile omits `engines.node`, sets build `types` to an empty
array, and is exercised by the bundler-resolution smoke consumer. The other
profiles retain Node types. Generated repositories never retain another
profile's CLI files or package metadata.

To verify the minimum supported Node version, use Node 22.14 and run:

```sh
pnpm --config.runtime-on-fail=ignore install --frozen-lockfile
pnpm --config.runtime-on-fail=ignore run check
```

## Pull requests

Create a feature branch, keep commits focused, and use a Conventional Commit
PR title. Update behavior tests, type tests, documentation, and the committed
API report when the public contract changes. Run `pnpm check` before requesting
review.

Add a Changeset with `pnpm changeset` whenever consumers can observe the change.
Documentation-only, test-only, and CI-only changes do not require one. During
the 0.x period, a breaking change uses a minor bump and must include migration
instructions; after 1.0 it uses a major bump.

## Release recovery

Releases are driven by a reviewed Changesets version PR and an annotated
`vX.Y.Z` tag matching `package.json`. If a workflow fails before npm publish,
fix the cause and rerun it. If npm already contains the version, never publish
that version again: verify it with `npm view my-package@X.Y.Z version`, then
repair only the GitHub Release by rerunning the release attachment job or
uploading the original workflow artifact. Do not use unpublish as a routine
rollback; release a corrected new version instead.
