import path from "node:path";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import { getFileInfo } from "prettier";
import { describe, expect, it } from "vitest";

// `.agents/skills/` holds one symlink bridge into `.claude/skills/**`, and both
// tools ignore it so the real files are not checked twice. What must not come
// back is the blanket ignore: a genuinely Codex-only file added beside the
// bridge has no other path to be checked at, so it would drift unlinted and
// unformatted with CI green.
//
// Both tools are asked through their own APIs rather than by spawning their
// CLIs. A subprocess reports "ignored" and "could not run at all" with the same
// exit code, so an exit-status assertion passes on a run where the tool never
// started — which is what the minimum-Node CI leg does to a nested `pnpm exec`.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const bridge = ".agents/skills/merge-dependabot";

const eslint = new ESLint({ cwd: repoRoot });

async function ignoredByEslint(relative: string): Promise<boolean> {
  return eslint.isPathIgnored(path.join(repoRoot, relative));
}

async function ignoredByPrettier(relative: string): Promise<boolean> {
  const info = await getFileInfo(path.join(repoRoot, relative), {
    ignorePath: path.join(repoRoot, ".prettierignore"),
  });
  return info.ignored;
}

describe("the .agents/skills ignore entries", () => {
  it.each([
    ["a file directly under the directory", ".agents/skills/codex-only.mjs"],
    ["a file in a sibling skill directory", ".agents/skills/codex-only/run.mjs"],
  ])("checks %s", async (_label, relative) => {
    expect(await ignoredByEslint(relative)).toBe(false);
    expect(await ignoredByPrettier(relative)).toBe(false);
  });

  it.each([
    ["the bridge directory itself", bridge],
    ["a file inside the bridge", `${bridge}/SKILL.md`],
    ["a nested file inside the bridge", `${bridge}/scripts/survey.py`],
  ])("still ignores %s", async (_label, relative) => {
    expect(await ignoredByEslint(relative)).toBe(true);
    expect(await ignoredByPrettier(relative)).toBe(true);
  });
});
