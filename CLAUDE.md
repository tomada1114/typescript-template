<!-- agents-md-sync:begin -->

@AGENTS.md
<!-- agents-md-sync:end -->

# Claude Code Specifics

The shared, tool-agnostic instructions are in `AGENTS.md`, imported above. This
file only records what Claude Code adds on top of them.

- There are no Claude Code hooks in this repository. Formatting, linting,
  type-checking, related tests, and the staged-content checks all run from
  `lefthook`'s pre-commit hook instead, where they apply to every author —
  human, Claude Code, Codex, or any other tool — not only a Claude Code
  session. See AGENTS.md's "Enforcement layers" for the full design and why
  it moved there.
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
  manager, workflow dispatch, `gh release create`, `git commit --no-verify`,
  a plain force-push).
  These are a hard block in every mode, including bypassPermissions — they
  are not advisory. Personal preferences (model, output style, extra
  permissions) belong in `.claude/settings.local.json`, which is gitignored,
  and never here.

When `permissions.deny` blocks something, the answer is to fix what made the
bypass look necessary, or to ask. It is not to find another spelling.
