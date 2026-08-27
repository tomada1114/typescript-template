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
`pnpm test:coverage`, `pnpm build`, `pnpm docs:build`, and
`pnpm package:smoke`.

## Bootstrap profiles

The template starts as the `node-library` profile. Bootstrap makes one
irreversible choice for the generated repository:

| Profile             | Runtime contract                                   | `sideEffects` |
| ------------------- | -------------------------------------------------- | ------------- |
| `node-library`      | Node.js >= 24                                      | `false`       |
| `universal-library` | ES and DOM APIs; Node built-ins fail the src build | `false`       |

The universal profile omits `engines.node`, sets build `types` to an empty
array, and is exercised by the bundler-resolution smoke consumer. The
node-library profile retains Node types.

The seven-day dependency cooldown in `pnpm-workspace.yaml` is fail-closed. If
an urgent security fix is younger than seven days, a maintainer may add the
exact package and version to `minimumReleaseAgeExclude` in the same reviewed PR
as the lockfile update. Record the advisory and why waiting is riskier, remove
the exception after the version ages out, and never use a broad package-only
or wildcard exclusion.

Development and the published contract both sit on Node 24, so there is no
second runtime to check the package against.

## Pull requests

Create a feature branch, keep commits focused, and use a Conventional Commit
PR title. Update behavior tests, type tests, and documentation when the public
contract changes, and say in the PR what the change does to the version. Run
`pnpm check` before requesting review.

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

### Cutting a prerelease

To ship a release candidate without moving the `latest` npm dist-tag, set
`package.json`'s version to a semver prerelease (`1.0.0-rc.1`,
`1.0.0-next.3`) and push a matching annotated tag (`v1.0.0-rc.1`,
`v1.0.0-next.3`). `release.yml` parses the prerelease identifier (`rc`,
`next`, …) out of the version and:

- publishes to the npm dist-tag named after that identifier instead of
  `latest`, so `npm install my-package@rc` gets the release candidate while
  a plain `npm install my-package` does not;
- creates the GitHub Release marked as a pre-release.

A version with no prerelease identifier publishes to `latest` and creates an
ordinary GitHub Release, exactly as before.
