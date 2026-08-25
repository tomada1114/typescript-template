import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { classifyCopyPath, describeLinkTarget } from "../scripts/lib/symlinks.mjs";

// scripts/bootstrap.mjs and scripts/verify-bootstrap.mjs both ask this module
// whether a path belongs in the copy set, and both turn a "dangling" answer
// into their own error type. Testing the shared answer here is what keeps the
// two from drifting apart on the edge cases below.
const roots: string[] = [];

function makeRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "symlinks-test-"));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("classifyCopyPath", () => {
  it("reports a path that is not there at all as absent", () => {
    const root = makeRoot();

    expect(classifyCopyPath(path.join(root, "never-existed"))).toStrictEqual({
      kind: "absent",
    });
  });

  it("reports an ordinary file as present", () => {
    const root = makeRoot();
    const file = path.join(root, "notes.md");
    writeFileSync(file, "content", "utf8");

    expect(classifyCopyPath(file)).toStrictEqual({ kind: "present" });
  });

  it("reports a symlink whose target exists as present", () => {
    const root = makeRoot();
    writeFileSync(path.join(root, "target.md"), "content", "utf8");
    const link = path.join(root, "link.md");
    symlinkSync("target.md", link);

    expect(classifyCopyPath(link)).toStrictEqual({ kind: "present" });
  });

  it("reports a symlink to an existing directory as present", () => {
    const root = makeRoot();
    mkdirSync(path.join(root, "skills", "merge-dependabot"), { recursive: true });
    const link = path.join(root, "bridge");
    // The shape the template's own `.agents/skills/merge-dependabot` uses.
    symlinkSync("skills/merge-dependabot", link);

    expect(classifyCopyPath(link)).toStrictEqual({ kind: "present" });
  });

  it("reports a symlink whose target is missing as dangling, with its target", () => {
    const root = makeRoot();
    const link = path.join(root, "bridge");
    symlinkSync("skills/moved-away", link);

    expect(classifyCopyPath(link)).toStrictEqual({
      kind: "dangling",
      target: "skills/moved-away",
    });
  });

  it("reports a dangling symlink that points at an absolute path", () => {
    const root = makeRoot();
    const link = path.join(root, "bridge");
    const target = path.join(root, "gone", "elsewhere");
    symlinkSync(target, link);

    expect(classifyCopyPath(link)).toStrictEqual({ kind: "dangling", target });
  });
});

describe("describeLinkTarget", () => {
  it("leaves a relative target alone", () => {
    expect(describeLinkTarget("../.claude/skills/merge-dependabot")).toBe(
      "../.claude/skills/merge-dependabot",
    );
  });

  it("collapses a home-directory prefix to ~", () => {
    const target = path.join(os.homedir(), "projects", "elsewhere");

    expect(describeLinkTarget(target)).toBe(`~${path.sep}projects${path.sep}elsewhere`);
  });

  it("leaves an absolute target outside the home directory alone", () => {
    expect(describeLinkTarget(`${path.sep}opt${path.sep}shared`)).toBe(
      `${path.sep}opt${path.sep}shared`,
    );
  });

  it("does not collapse a sibling directory that merely starts with the home path", () => {
    const sibling = `${os.homedir()}-backup${path.sep}notes`;

    expect(describeLinkTarget(sibling)).toBe(sibling);
  });
});
