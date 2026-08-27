import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  MIRROR_DIRECTORY,
  SOURCE_DIRECTORY,
  SyncAgentsError,
  diffTrees,
  formatDrift,
  syncTrees,
} from "../scripts/sync-agents.mjs";

// `.agents/skills/` is where the skills are authored; `.claude/skills/` is a
// committed, generated copy of it, because Claude Code discovers project
// skills only from its own directory. The first case below is the gate that
// keeps the committed pair identical: it runs from `pnpm test`, so
// `check:quick`, `check:source` and CI all enforce it. The rest exercise the
// diff itself against temp trees.
//
// The script's API is called directly rather than through a subprocess: an
// exit status cannot tell a detected drift apart from a run that never
// started (see tests/tooling-ignores.test.ts for where that bit us).
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const workspaces: string[] = [];

function makeTrees(): { source: string; mirror: string } {
  const workspace = mkdtempSync(path.join(tmpdir(), "sync-agents-test-"));
  workspaces.push(workspace);
  const source = path.join(workspace, "source");
  const mirror = path.join(workspace, "mirror");
  mkdirSync(path.join(source, "skill", "scripts"), { recursive: true });
  writeFileSync(path.join(source, "skill", "SKILL.md"), "# Skill\n");
  writeFileSync(path.join(source, "skill", "scripts", "run.mjs"), "export {};\n");
  syncTrees(source, mirror);
  return { source, mirror };
}

afterEach(() => {
  for (const workspace of workspaces.splice(0)) {
    rmSync(workspace, { recursive: true, force: true });
  }
});

describe("the committed skill trees", () => {
  it("keeps the generated mirror byte-identical to its source", () => {
    expect(
      diffTrees(
        path.join(repoRoot, SOURCE_DIRECTORY),
        path.join(repoRoot, MIRROR_DIRECTORY),
      ),
      "run `pnpm agents:sync` and commit the result",
    ).toEqual([]);
  });
});

describe("diffTrees", () => {
  it("reports nothing for two identical trees", () => {
    const { source, mirror } = makeTrees();
    expect(diffTrees(source, mirror)).toEqual([]);
  });

  it("reports a file the mirror never received as missing", () => {
    const { source, mirror } = makeTrees();
    writeFileSync(path.join(source, "skill", "NOTES.md"), "notes\n");

    expect(diffTrees(source, mirror)).toEqual([
      { kind: "missing", relative: "skill/NOTES.md" },
    ]);
  });

  it("reports a file only the mirror has as extra", () => {
    const { source, mirror } = makeTrees();
    writeFileSync(path.join(mirror, "skill", "stale.md"), "stale\n");

    expect(diffTrees(source, mirror)).toEqual([
      { kind: "extra", relative: "skill/stale.md" },
    ]);
  });

  it("reports a hand-edited mirror file as differing", () => {
    const { source, mirror } = makeTrees();
    writeFileSync(path.join(mirror, "skill", "SKILL.md"), "# Skill (edited)\n");

    expect(diffTrees(source, mirror)).toEqual([
      { kind: "differs", relative: "skill/SKILL.md" },
    ]);
  });

  it("treats an absent mirror as missing every source file", () => {
    const { source } = makeTrees();

    expect(diffTrees(source, path.join(source, "..", "never-created"))).toEqual([
      { kind: "missing", relative: "skill/SKILL.md" },
      { kind: "missing", relative: "skill/scripts/run.mjs" },
    ]);
  });

  it("refuses a symlink instead of mirroring something a clone cannot restore", () => {
    const { source, mirror } = makeTrees();
    symlinkSync("SKILL.md", path.join(source, "skill", "LINK.md"));

    expect(() => diffTrees(source, mirror)).toThrow(SyncAgentsError);
    expect(() => diffTrees(source, mirror)).toThrow(/ERR_AGENTS_UNSUPPORTED_ENTRY/);
  });
});

describe("syncTrees", () => {
  it("repairs every kind of drift and leaves the trees identical", () => {
    const { source, mirror } = makeTrees();
    writeFileSync(path.join(source, "skill", "NOTES.md"), "notes\n");
    writeFileSync(path.join(mirror, "skill", "SKILL.md"), "# Skill (edited)\n");
    mkdirSync(path.join(mirror, "skill", "gone"), { recursive: true });
    writeFileSync(path.join(mirror, "skill", "gone", "stale.md"), "stale\n");

    const repaired = syncTrees(source, mirror);

    expect(repaired.map(({ kind }) => kind).sort()).toEqual([
      "differs",
      "extra",
      "missing",
    ]);
    expect(diffTrees(source, mirror)).toEqual([]);
  });
});

describe("formatDrift", () => {
  it("names the code, both paths, and the command that repairs it", () => {
    const message = formatDrift([{ kind: "differs", relative: "skill/SKILL.md" }]);

    expect(message).toContain("ERR_AGENTS_DRIFT");
    expect(message).toContain(`${MIRROR_DIRECTORY}/skill/SKILL.md`);
    expect(message).toContain("Next: run `pnpm agents:sync`.");
  });
});
