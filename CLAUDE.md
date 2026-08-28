<!-- agents-md-sync:begin -->

@AGENTS.md
<!-- agents-md-sync:end -->

# Claude Code Specifics

The shared, tool-agnostic instructions are in `AGENTS.md`, imported above. This file
only records what Claude Code adds on top of them.

- There are no Claude Code hooks in this repository. Formatting, linting, type-checking,
  related tests, and the staged-content checks all run from `lefthook`'s pre-commit hook
  instead, where they apply to every author — human, Claude Code, Codex, or any other
  tool — not only a Claude Code session. See AGENTS.md's "Enforcement layers" for the
  full design and why it moved there.
- Skills are authored under `.agents/skills/` — the path Codex CLI reads — and mirrored
  into `.claude/skills/`, the only path Claude Code reads. Claude Code is therefore the
  tool that sees the generated copy rather than the authored one: never hand-edit it,
  and never edit only one side. The mirror is produced by `pnpm agents:sync` and
  committed; drift fails `pnpm agents:check`, `tests/sync-agents.test.ts`, and
  lefthook's pre-commit hook. The `authoring-skills` skill holds the rest, including why
  both copies are real files rather than a symlink.
- `.claude/settings.json` — the shared permission allowlist, limited to local build,
  lint, and test commands, plus `permissions.deny` entries for the rules a path or
  command pattern can state declaratively (`/.env*`, `/secrets/**`, every
  repository-root lockfile, `publish` on every package manager, workflow dispatch,
  `gh release create`, `git commit --no-verify`, a plain force-push). These are a hard
  block in every mode, including bypassPermissions — they are not advisory. Personal
  preferences (model, output style, extra permissions) belong in
  `.claude/settings.local.json`, which is gitignored, and never here.

When `permissions.deny` blocks something, the answer is to fix what made the bypass look
necessary, or to ask. It is not to find another spelling.
