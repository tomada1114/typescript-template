import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { readKey } from "../scripts/lib/json.mjs";

// `.claude/settings.json` is the one enforcement layer this repository keeps
// inside Claude Code itself: a declarative permission allowlist/denylist.
// There is no hook layer alongside it any more — see AGENTS.md's
// "Enforcement layers" for why that moved to lefthook.yml, which every author
// goes through regardless of tool.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** Top-level keys of a value that came out of `JSON.parse`. */
function topLevelKeys(value: unknown): string[] {
  return typeof value === "object" && value !== null ? Object.keys(value) : [];
}

/** Read a property that must be an array of strings. */
function readStringArray(value: unknown, key: string): string[] {
  const read = readKey(value, key);
  return Array.isArray(read) ? read.filter((item) => typeof item === "string") : [];
}

describe("shared settings", () => {
  const settings: unknown = JSON.parse(
    readFileSync(path.join(repoRoot, ".claude", "settings.json"), "utf8"),
  );
  const manifest: unknown = JSON.parse(
    readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  );

  it("holds nothing but the shared configuration", () => {
    // Every repository generated from this template inherits this file, so a
    // personal preference here is a preference imposed on all of them.
    // CLAUDE.md: model, output style, marketplaces, plugins and extra
    // permissions belong in the gitignored .claude/settings.local.json.
    expect(
      topLevelKeys(settings).sort(),
      "personal preferences belong in .claude/settings.local.json (see CLAUDE.md)",
    ).toEqual(["$schema", "permissions"]);
  });

  it("allows every package script in both spellings", () => {
    // A new script must come with an allowlist decision: either it is safe to
    // run unattended and gets both entries, or it is listed here with why.
    const exceptions = new Map([
      ["test:watch", "a watcher never exits, so an agent must not start one"],
      ["changeset", "interactive TUI; only the --empty form is pre-approved"],
    ]);
    const allow = new Set(readStringArray(readKey(settings, "permissions"), "allow"));
    const scripts = topLevelKeys(readKey(manifest, "scripts"));

    expect(
      scripts.filter(
        (name) =>
          !exceptions.has(name) &&
          !(allow.has(`Bash(pnpm ${name})`) && allow.has(`Bash(pnpm run ${name})`)),
      ),
      "add `Bash(pnpm <name>)` and `Bash(pnpm run <name>)` to .claude/settings.json, or an exception with a reason",
    ).toEqual([]);
    // A script that was renamed or dropped must not leave a stale excuse here.
    expect([...exceptions.keys()].filter((name) => !scripts.includes(name))).toEqual(
      [],
    );
  });

  it("denies the Git bypasses no other layer can catch", () => {
    // `git commit --no-verify` disables lefthook's pre-commit chain along
    // with it, and a plain force-push (without --force-with-lease) overwrites
    // a remote branch outright. Neither leaves anything in a diff for
    // scripts/check-staged.mjs to see, so a declarative deny rule is the only
    // layer that can refuse them.
    const deny = new Set(readStringArray(readKey(settings, "permissions"), "deny"));
    for (const pattern of [
      "Bash(git commit --no-verify)",
      "Bash(git commit --no-verify *)",
      "Bash(git commit -n)",
      "Bash(git commit -n *)",
      "Bash(git push --force)",
      "Bash(git push --force *)",
      "Bash(git push -f)",
      "Bash(git push -f *)",
    ]) {
      expect(deny.has(pattern), `expected ${pattern} in permissions.deny`).toBe(true);
    }
  });
});
