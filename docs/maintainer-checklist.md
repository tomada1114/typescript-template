# Maintainer checklist

These settings live outside the repository. Verify them after bootstrap and
review them periodically with `pnpm repo:check`.

The list below is split by whether `pnpm repo:check` actually verifies the
item. `tests/workflows.test.ts` asserts that every label the script reports a
difference under also appears in the first section, so a check the script
gains without a matching line here fails that test rather than going unread.

## Verified by `pnpm repo:check`

- [ ] main requires pull-request review
- [ ] main requires at least one approving review
- [ ] main requires status checks (every job in `REQUIRED_STATUS_CHECKS`)
- [ ] main requires conversation resolution
- [ ] main requires linear history
- [ ] main force-push is disabled
- [ ] main deletion is disabled
- [ ] main is protected by a branch-protection rule or an active ruleset
- [ ] secret scanning is enabled
- [ ] secret scanning push protection is enabled
- [ ] secret scanning non-provider patterns are enabled
- [ ] secret scanning validity checks are enabled
- [ ] Dependabot security updates are enabled
- [ ] Dependabot vulnerability alerts are enabled
- [ ] CodeQL default setup is configured
- [ ] main branch merges use squash or rebase only (no merge commits)
- [ ] branches are deleted automatically after merge
- [ ] auto-merge is enabled for pull requests
- [ ] release environment requires a human reviewer
- [ ] GitHub Actions default workflow token permissions are read-only
- [ ] GitHub Actions may create and approve pull requests
- [ ] GitHub Actions is restricted to selected actions
- [ ] GitHub Actions requires actions to be pinned to a full-length SHA
- [ ] private vulnerability reporting is enabled

## Human-only

Nothing below is checked by `pnpm repo:check`; a human confirms these.

- [ ] Register `.github/workflows/release.yml` as the npm trusted publisher
- [ ] Confirm npm `repository.url` exactly matches the GitHub repository
- [ ] Require 2FA for npm maintainers and prohibit token-based publishing
- [ ] Consider tag protection and immutable GitHub Releases
- [ ] Document Codecov token and fork-PR behavior if Codecov is enabled
- [ ] Run OpenSSF Scorecard for public repositories; document accepted
      findings
- [ ] Create a fine-grained personal access token with read-only
      `Administration`, `Actions`, `Code scanning alerts`, and `Metadata`
      repository permissions, and store it as the `REPO_SETTINGS_READ_TOKEN`
      repository secret. `Code scanning alerts` is what
      `repos/{owner}/{repo}/code-scanning/default-setup` needs; without it
      the CodeQL item above is reported as "could not be checked" rather
      than as drift. `.github/workflows/security-audit.yml`'s `repo-settings` job
      reads it to run `pnpm repo:check` on the weekly schedule — the
      default `GITHUB_TOKEN` cannot read these admin-level endpoints
      (rulesets, Actions permissions, security-and-analysis settings) on
      this repository. Rotate it the same way as any other maintainer PAT.
