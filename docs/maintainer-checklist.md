# Maintainer checklist

These settings live outside the repository. Verify them after bootstrap and
review them periodically with `pnpm repo:check`.

- [ ] Require pull requests and required CI checks on `main`
- [ ] Require conversation resolution and prohibit force-push and deletion
- [ ] Choose and enforce linear history or the documented merge strategy
- [ ] Restrict release pull requests and tags to authorized maintainers
- [ ] Enable secret scanning, push protection, Dependabot alerts, and security updates
- [ ] Enable private vulnerability reporting and CodeQL
- [ ] Create the `release` environment with a human required reviewer
- [ ] Register `.github/workflows/release.yml` as the npm trusted publisher
- [ ] Confirm npm `repository.url` exactly matches the GitHub repository
- [ ] Require 2FA for npm maintainers and prohibit token-based publishing
- [ ] Consider tag protection and immutable GitHub Releases
- [ ] Document Codecov token and fork-PR behavior if Codecov is enabled
- [ ] Run OpenSSF Scorecard for public repositories; document accepted findings
