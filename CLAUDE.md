<!-- agents-md-sync:begin -->

@AGENTS.md
<!-- agents-md-sync:end -->

# Claude Code Specifics

The shared, tool-agnostic instructions are in `AGENTS.md`, imported above. This
file only records what Claude Code adds on top of them.

- `.claude/hooks/format.mjs` (PostToolUse) — runs ESLint's autofix and Prettier
  on the single file just edited. Do not re-run a formatter after each edit.
  Autofix can rewrite more than whitespace: adjacent string literals get folded
  together, for instance. When the exact text of an edit was the point, read the
  file back before relying on it.
- `.claude/hooks/guard.mjs` (PreToolUse) — refuses lockfile edits, `.env*` and
  `secrets/**` access, credentials written into tracked files,
  `git commit --no-verify`, plain force-pushes, `npm`/`pnpm publish`, workflow
  dispatch, and edits that remove a quality gate. It inspects each segment of a
  shell command separately, so hiding a blocked command behind `&&` does not
  work, and fires even in bypassPermissions mode. Its rule engine lives in
  `scripts/lib/guard/`, shared with `scripts/check-staged.mjs` — see
  AGENTS.md's "Enforcement layers" for the full four-layer design and why some
  of these same rules are also declared as `permissions.deny` entries below.
  Hooks are Claude Code only for now; a future Codex adapter would import the
  same `scripts/lib/guard/` modules rather than duplicate them.
- `.claude/hooks/stop-check.mjs` (Stop) — runs the `pnpm check:quick` gate
  before a turn ends, but only when the working tree has changed TypeScript,
  JavaScript, or package configuration.
- `tests/hooks.test.ts` — fixture tests for all three hooks, covering both the
  calls that must be allowed and the calls that must be blocked. A change to a
  hook belongs in the same commit as its test.
- `.claude/skills/merge-dependabot/` — the one workflow skill shipped here,
  because landing bot PRs is the recurring task whose failure modes are specific
  to _this_ toolchain (peer-range conflicts, the dependency cooldown, the
  packaging gates). Its survey script is read-only; every mutating step sits
  behind a single human approval. `.agents/skills/merge-dependabot` is a
  symlink to this directory so Codex CLI can see it too — edit the real
  files here, never the symlink.
- `.claude/settings.json` — the shared permission allowlist, limited to local
  build, lint, and test commands, plus `permissions.deny` entries for the
  rules a path or command pattern can state declaratively (`/.env*`,
  `/secrets/**`, every repository-root lockfile, `publish` on every package
  manager, workflow dispatch, `gh release create`).
  These are a hard block in every mode, including bypassPermissions — they
  are not advisory. Personal preferences (model, output style, extra
  permissions) belong in `.claude/settings.local.json`, which is gitignored,
  and never here.

When the guard blocks something, the answer is to fix what made the bypass look
necessary, or to ask. It is not to find another spelling.
