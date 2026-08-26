# Changelog

## 0.2.0

### Minor Changes

- 0127298: Widen the exports map and harden the published artifact: `require("my-package")`
  now resolves on every supported Node (unflagged `require(esm)`), the manifest is
  importable via the `./package.json` subpath, shipped source maps are
  self-contained (`inlineSources`; the always-dangling declaration maps are no
  longer emitted), and the npm publish contract (`access`, `provenance`,
  `registry`) lives in `publishConfig` instead of CI flags.

## 0.1.1

### Patch Changes

- 8a66db5: Reject path separators and other cross-platform filename-unsafe characters as
  identifier separators. Also harden template validation, release artifact reuse,
  security auditing, and generated-repository checks.

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Changesets updates this file as part of the reviewed version pull request.

## 0.1.0 - 2026-07-30

### Added

- Initial package template.
