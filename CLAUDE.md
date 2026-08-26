<!-- agents-md-sync:begin -->

@AGENTS.md
<!-- agents-md-sync:end -->

# Claude Code Specifics

The shared, tool-agnostic instructions are in `AGENTS.md`, imported above. This
file only records what Claude Code adds on top of them.

- Start Claude Code at the repository root; a subdirectory launch does not load
  the root `.claude/settings.json` hooks described in AGENTS.md.
- `.claude/skills/merge-dependabot/` — the one workflow skill shipped here,
  because landing bot PRs is the recurring task whose failure modes are specific
  to _this_ toolchain (peer-range conflicts, the dependency cooldown, the
  packaging gates). Its survey script is read-only; every mutating step sits
  behind a single human approval. `.agents/skills/merge-dependabot` is a
  symlink to this directory so Codex CLI can see it too — edit the real
  files here, never the symlink.
- `.claude/settings.json` — the shared permission allowlist, limited to local
  build, lint, and test commands, plus `permissions.deny` entries for the
  rules a path or command pattern can state declaratively (`/.env`,
  `/secrets/**`, every repository-root lockfile, `publish` on every package
  manager, workflow dispatch, `gh release create`). Not `/.env.*`: a deny rule
  cannot carry an allowlist exception, so it would also block the
  `.env.example` this repository tells agents to read instead — that half of
  the rule lives in `guard.mjs`, as AGENTS.md's "Enforcement layers" explains.
  These are a hard block in every mode, including bypassPermissions — they
  are not advisory. Personal preferences (model, output style, extra
  permissions) belong in `.claude/settings.local.json`, which is gitignored,
  and never here.

When the guard blocks something, the answer is to fix what made the bypass look
necessary, or to ask. It is not to find another spelling.
