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

  it("denies exactly the expected set of dangerous commands and paths", () => {
    // A marker that only checks "is the deny list present at all" cannot
    // catch a single entry being quietly dropped while the rest of the
    // array survives (e.g. `Edit(/pnpm-lock.yaml)` disappearing while
    // `Read(/.env)` etc. still match). Exact Set equality is what actually
    // catches that: it fails the instant one of these 33 entries goes
    // missing, however the rest of the array is edited around it.
    //
    // This lives here rather than behind a git hook on purpose — see
    // AGENTS.md's "Enforcement layers": a hook that blocks a reviewed
    // deletion just teaches its author to reach for `--no-verify`, which
    // disables the secret checks along with it. A test every author and
    // every CI run see is the layer that holds instead.
    //
    // Order does not matter (`toEqual` on a `Set` is value equality, not
    // array/index equality — see the "reordering" case in the describe
    // block below), so reordering these entries is not a false positive.
    // Adding, removing, or rewording one is a real, intentional change to
    // `.claude/settings.json`'s contract, and updates this list in the same
    // commit — exactly like any other assertion on checked-in state.
    const EXPECTED_DENY_ENTRIES: readonly string[] = [
      // Never read or write credentials or secrets (CLAUDE.md).
      "Read(/.env)",
      "Read(/.env.*)",
      "Read(/secrets/**)",
      "Edit(/.env)",
      "Edit(/.env.*)",
      "Edit(/secrets/**)",

      // Git internals and the personal-settings escape hatch must not be
      // rewritten by a tool call.
      "Edit(/.git/**)",
      "Edit(/.claude/settings.local.json)",

      // Every ecosystem's lockfile is generated output; hand-editing one
      // drifts it from what the package manager would produce (AGENTS.md:
      // "the lockfile is generated — never hand-edited").
      "Edit(/pnpm-lock.yaml)",
      "Edit(/package-lock.json)",
      "Edit(/npm-shrinkwrap.json)",
      "Edit(/yarn.lock)",
      "Edit(/bun.lockb)",

      // Publish always needs a human (CLAUDE.md: "Commit, push, pull
      // request, and publish always need a human"), across every package
      // manager this repo could be used with, in both the bare and
      // argument-taking spelling.
      "Bash(npm publish)",
      "Bash(npm publish *)",
      "Bash(pnpm publish)",
      "Bash(pnpm publish *)",
      "Bash(yarn publish)",
      "Bash(yarn publish *)",
      "Bash(bun publish)",
      "Bash(bun publish *)",

      // Workflow dispatch and release creation are external, user-visible
      // actions that also need a human.
      "Bash(gh workflow run)",
      "Bash(gh workflow run *)",
      "Bash(gh release create)",
      "Bash(gh release create *)",

      // `git commit --no-verify`/`-n` disables lefthook's pre-commit chain
      // along with it, and a plain force-push (without --force-with-lease)
      // overwrites a remote branch outright. Neither leaves anything in a
      // diff for scripts/check-staged.mjs to see, so a declarative deny
      // rule is the only layer that can refuse them.
      "Bash(git commit --no-verify)",
      "Bash(git commit --no-verify *)",
      "Bash(git commit -n)",
      "Bash(git commit -n *)",
      "Bash(git push --force)",
      "Bash(git push --force *)",
      "Bash(git push -f)",
      "Bash(git push -f *)",
    ];
    const deny = new Set(readStringArray(readKey(settings, "permissions"), "deny"));

    expect(
      deny,
      "permissions.deny changed: an entry was added, removed, or reworded — if that was intentional, update EXPECTED_DENY_ENTRIES in the same commit",
    ).toEqual(new Set(EXPECTED_DENY_ENTRIES));
  });

  describe("the Set-equality technique above", () => {
    // A `git log`/`git stash`-free proof that the comparison actually
    // behaves the way the test above depends on: reordering or duplicating
    // an entry is invisible to it, but removing, adding, or rewording even
    // one is not. This exercises the same `new Set(...).toEqual(new
    // Set(...))` check against a small literal fixture rather than the real
    // file.
    const fixture = ["Read(/.env)", "Edit(/pnpm-lock.yaml)", "Bash(pnpm publish)"];

    it.each([
      ["reordered", [fixture[2], fixture[0], fixture[1]]],
      ["with a duplicate entry", [...fixture, fixture[0]]],
    ])("a deny array %s still equals the original: %p", (_label, candidate) => {
      expect(new Set(candidate)).toEqual(new Set(fixture));
    });

    it.each([
      [
        "with one entry removed (the exact defect this issue reports)",
        fixture.slice(0, -1),
      ],
      ["with one entry added", [...fixture, "Bash(gh release create)"]],
      ["with one entry reworded", [fixture[0], fixture[1], "Bash(pnpm publish *)"]],
    ])("a deny array %s no longer equals the original: %p", (_label, candidate) => {
      expect(new Set(candidate)).not.toEqual(new Set(fixture));
    });
  });
});
