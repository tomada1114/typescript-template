import path from "node:path";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import { getFileInfo } from "prettier";
import { describe, expect, it } from "vitest";

// The skills are authored under `.agents/skills/` and mirrored into
// `.claude/skills/` by `pnpm agents:sync`. Both tools must therefore see the
// real files and ignore the generated copy: linting or reformatting the mirror
// reports the same finding twice, at a path nobody may edit, and a Prettier
// rewrite of the copy alone is drift the sync check then has to undo. What
// must not come back is the opposite ignore: a skill file that is checked
// nowhere drifts unlinted and unformatted with CI green.
//
// Both tools are asked through their own APIs rather than by spawning their
// CLIs. A subprocess reports "ignored" and "could not run at all" with the same
// exit code, so an exit-status assertion passes on a run where the tool never
// started — which is what the minimum-Node CI leg does to a nested `pnpm exec`.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const source = ".agents/skills/merge-dependabot";
const mirror = ".claude/skills/merge-dependabot";

const eslint = new ESLint({ cwd: repoRoot });

function ignoredByEslint(relative: string): Promise<boolean> {
  return eslint.isPathIgnored(path.join(repoRoot, relative));
}

async function ignoredByPrettier(relative: string): Promise<boolean> {
  const info = await getFileInfo(path.join(repoRoot, relative), {
    ignorePath: path.join(repoRoot, ".prettierignore"),
  });
  return info.ignored;
}

describe("the .claude/skills ignore entry in eslint.config.mjs", () => {
  // Every path here is `.mjs` on purpose. ESLint answers `isPathIgnored: true`
  // for anything no flat-config entry matches, so a `.md` or `.py` probe comes
  // back ignored whether or not the ignore list mentions it — see the last case
  // in this block, which pins that behavior so the trap stays visible.
  it.each([
    ["a file directly under the source directory", ".agents/skills/codex-only.mjs"],
    ["a file in a source skill directory", `${source}/scripts/survey-prs.mjs`],
    ["a nested file in a source skill", `${source}/lib/nested/helper.mjs`],
  ])("lints %s", async (_label, relative) => {
    expect(await ignoredByEslint(relative)).toBe(false);
  });

  it.each([
    ["a file inside the mirror", `${mirror}/scripts/survey-prs.mjs`],
    ["a nested file inside the mirror", `${mirror}/lib/nested/helper.mjs`],
  ])("still ignores %s", async (_label, relative) => {
    expect(await ignoredByEslint(relative)).toBe(true);
  });

  it("reports any path it has no configuration for as ignored", async () => {
    // Why the cases above are restricted to `.mjs`: this file is under the
    // linted source tree and would still answer `true` on an empty ignore list.
    await expect(ignoredByEslint(`${source}/SKILL.md`)).resolves.toBe(true);
  });
});

describe("the .claude/skills entry in .prettierignore", () => {
  // Prettier's `ignored` reflects the ignore file alone — whether it knows a
  // parser for the extension is a separate field — so any path discriminates.
  it.each([
    ["a file directly under the source directory", ".agents/skills/codex-only.mjs"],
    ["a Markdown file in a source skill", `${source}/SKILL.md`],
    ["a nested reference in a source skill", `${source}/references/failure-modes.md`],
  ])("formats %s", async (_label, relative) => {
    expect(await ignoredByPrettier(relative)).toBe(false);
  });

  it.each([
    ["the mirror directory itself", mirror],
    ["a file inside the mirror", `${mirror}/SKILL.md`],
    ["a nested file inside the mirror", `${mirror}/scripts/survey.py`],
  ])("still ignores %s", async (_label, relative) => {
    expect(await ignoredByPrettier(relative)).toBe(true);
  });
});
