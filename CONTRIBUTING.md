# Contributing

## Setup

Use Node.js 24 and pnpm 11 through Corepack:

```sh
node --version
corepack enable
corepack pnpm@11.18.0 install --frozen-lockfile
pnpm hooks:install
pnpm check
```

The first command must report Node 24.x. `devEngines.runtime.onFail` is an
intentional hard error for normal development; use the documented override
only for the minimum-Node compatibility check below.

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

The seven-day dependency cooldown in `pnpm-workspace.yaml` is fail-closed. If
an urgent security fix is younger than seven days, a maintainer may add the
exact package and version to `minimumReleaseAgeExclude` in the same reviewed PR
as the lockfile update. Record the advisory and why waiting is riskier, remove
the exception after the version ages out, and never use a broad package-only
or wildcard exclusion.

To verify the minimum supported Node version, use Node 22.14 and run:

```sh
pnpm --config.runtime-on-fail=ignore install --frozen-lockfile
git restore package.json
pnpm --config.runtime-on-fail=ignore run check
```

The `git restore` is not optional. `pnpm install` writes its effective settings
back into `package.json`, so the flag turns `devEngines.runtime.onFail` into
`"ignore"` on disk; leaving it there both dirties the working tree and fails the
tests that assert on the manifest. `pnpm run` does not write the manifest.

## Pull requests

Create a feature branch, keep commits focused, and use a Conventional Commit
PR title. Update behavior tests, type tests, documentation, and the committed
API report when the public contract changes. Run `pnpm check` before requesting
review.

Every pull request explains whether it changes the published package and keeps
the README, tests, and documentation in sync when it does. Documentation, test,
CI, and tooling changes with no release impact need no release record. During
the 0.x period, a breaking change uses a minor bump and must include migration
instructions; after 1.0 it uses a major bump.

## Release recovery

Releases are driven by a reviewed release PR and an annotated `vX.Y.Z` tag
matching `package.json`. If a workflow fails before npm publish,
fix the cause and rerun it. If npm already contains the version, never publish
that version again: verify it with `npm view my-package@X.Y.Z version`, then
repair only the GitHub Release by rerunning the release attachment job or
uploading the original workflow artifact. Do not use unpublish as a routine
rollback; release a corrected new version instead.
