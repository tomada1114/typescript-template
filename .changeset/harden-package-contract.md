---
"my-package": minor
---

Widen the exports map and harden the published artifact: `require("my-package")`
now resolves on every supported Node (unflagged `require(esm)`), the manifest is
importable via the `./package.json` subpath, shipped source maps are
self-contained (`inlineSources`; the always-dangling declaration maps are no
longer emitted), and the npm publish contract (`access`, `provenance`,
`registry`) lives in `publishConfig` instead of CI flags.
