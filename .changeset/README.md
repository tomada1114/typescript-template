# Changesets

Run `pnpm changeset` for any change visible to package consumers. Choose the
SemVer intent and write the summary from the user's perspective. For
documentation, tests, CI, or tooling changes with no release impact, run
`pnpm changeset --empty` so the pull request still records an explicit release
decision. CI enforces this with `pnpm changeset:check`.
