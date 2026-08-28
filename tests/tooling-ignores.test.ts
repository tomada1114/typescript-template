import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import { getFileInfo } from "prettier";
import ts from "typescript";
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

/**
 * Pull the quoted entries out of `typos.toml`'s `[files].extend-exclude`
 * array. Not a general TOML parser — the array is a flat list of quoted
 * strings, same shape as `scripts/lib/labels-manifest.mjs`'s hand-rolled
 * scanner for `.github/labels.yml`, for the same reason: a dependency is a
 * bigger cost than a few lines of line scanning for a fixed, small shape.
 */
function typosExtendExclude(): string[] {
  const text = readFileSync(path.join(repoRoot, "typos.toml"), "utf8");
  const match = /extend-exclude\s*=\s*\[([\s\S]*?)\]/.exec(text);
  const body = match?.[1] ?? "";
  return [...body.matchAll(/"([^"]+)"/g)].map((entry) => entry[1] ?? "");
}

describe("the generated/ignored tree stays consistent across tooling", () => {
  // Build/doc output nobody commits: .gitignore keeps it out of git
  // entirely, so there is nothing in it for ESLint, Prettier, or typos to
  // usefully check either.
  const BUILD_OUTPUT = ["dist/", "coverage/", "docs/api/"];

  // The opposite case: `.claude/skills/` IS tracked (AGENTS.md — both the
  // authored `.agents/skills/` and its generated mirror are committed real
  // files), so it must NOT appear in .gitignore. But every tool that would
  // otherwise check its content redundantly must still skip it, exactly like
  // the ESLint/Prettier describe blocks above already assert.
  const GENERATED_MIRROR = ".claude/skills/";

  const gitignoreLines = readFileSync(path.join(repoRoot, ".gitignore"), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  const typosExclude = typosExtendExclude();

  it.each(BUILD_OUTPUT)(
    "%s is ignored by git, ESLint, Prettier, and typos alike",
    async (entry) => {
      expect(gitignoreLines).toContain(entry);
      expect(await ignoredByEslint(`${entry}probe.mjs`)).toBe(true);
      expect(await ignoredByPrettier(`${entry}probe.mjs`)).toBe(true);
      expect(typosExclude).toContain(entry);
    },
  );

  it("does not gitignore the tracked .claude/skills mirror", () => {
    expect(gitignoreLines).not.toContain(GENERATED_MIRROR);
  });

  it("excludes the tracked-but-generated .claude/skills mirror from typos, like ESLint and Prettier already do", () => {
    expect(typosExclude).toContain(GENERATED_MIRROR);
  });

  it("dropped the stale .rehearsal/ entry now that publish-rehearsal.mjs is gone", () => {
    expect(gitignoreLines).not.toContain(".rehearsal/");
  });
});

describe("the .claude/skills bridge in tsconfig.json", () => {
  // `tsc --showConfig`-shaped: resolved through the compiler API's own
  // include/exclude matching rather than a file committed under
  // `.claude/skills/`, which is a generated mirror nobody may hand-edit.
  const configPath = path.join(repoRoot, "tsconfig.json");
  const configFile = ts.readConfigFile(configPath, (file) => ts.sys.readFile(file));
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, repoRoot);
  const resolved = new Set(
    parsed.fileNames.map((file) => path.relative(repoRoot, file).replace(/\\/g, "/")),
  );

  it("type-checks the authored skill source", () => {
    expect(resolved.has(`${source}/scripts/survey-prs.mjs`)).toBe(true);
  });

  it("does not double-report the byte-identical mirror", () => {
    expect(resolved.has(`${mirror}/scripts/survey-prs.mjs`)).toBe(false);
  });

  it("names .claude/skills in include and only the merge-dependabot mirror in exclude", () => {
    // The exclude entry names the mirror subdirectory specifically, not the
    // whole .claude/skills tree — a hypothetical Codex-only file added
    // directly under .claude/skills/ (outside the mirror) is still covered
    // by include and not matched by this narrower exclude glob.
    const config: unknown = configFile.config;
    const include =
      typeof config === "object" && config !== null && "include" in config
        ? config.include
        : undefined;
    const exclude =
      typeof config === "object" && config !== null && "exclude" in config
        ? config.exclude
        : undefined;
    expect(include).toContain(".claude/skills");
    expect(exclude).toEqual([mirror]);
  });
});
